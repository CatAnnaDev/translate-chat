'use strict';

const L = require('./lang');
const { TranslateError, DeepL, Google, wrapNetworkError } = require('./providers');

let LanguageDetect = null;
try { LanguageDetect = require('../lib/language-detector'); } catch (e) { /* optional: the engine works without it */ }

class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get size() { return this.map.size; }
  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key, value) {
    if (this.max <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
}

class Limiter {
  constructor(getMax) { this.getMax = getMax; this.active = 0; this.queue = []; }
  get queued() { return this.queue.length; }
  run(fn) {
    return new Promise(resolve => {
      this.queue.push({ fn, resolve });
      this.pump();
    });
  }
  pump() {
    while (this.active < this.getMax() && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      Promise.resolve().then(job.fn).then(job.resolve, () => job.resolve(null)).then(() => { this.active--; this.pump(); });
    }
  }
}

const sameText = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

class Translator {
  constructor({ cfg, log, notifier }) {
    this.cfg = cfg;
    this.log = log;
    this.notifier = notifier;
    this.providers = { deepl: new DeepL(), google: new Google() };
    this.cache = new LRU(cfg.cacheSize);
    this.limiter = new Limiter(() => cfg.maxConcurrent);
    this.inflight = new Map();
    this.detector = null;
    this.stats = this.freshStats();
    if (LanguageDetect) {
      try { this.detector = new LanguageDetect(); this.detector.setLanguageType('iso2'); } catch (e) { this.log.warn('local language detector unavailable', e); }
    }
  }

  freshStats() {
    return { requests: 0, cacheHits: 0, cacheMisses: 0, joined: 0, translated: 0, sameLanguage: 0, localSkips: 0, failed: 0, dropped: 0 };
  }

  key(text, source, target) { return `${source}|${target}|${text}`; }

  peek(text, source, target) {
    if (this.cache.max !== this.cfg.cacheSize) this.cache.max = this.cfg.cacheSize;
    const e = this.cache.get(this.key(text, source, target));
    if (e === undefined) this.stats.cacheMisses++; else this.stats.cacheHits++;
    return e;
  }

  localSame(plain, target) {
    const cfg = this.cfg;
    if (!cfg.localDetect || !this.detector || plain.length < cfg.localDetectMinLength) return false;
    try {
      const d = this.detector.detect(plain, 1);
      const same = !!(d && d[0] && L.baseLang(d[0][0]) === L.baseLang(target));
      if (same) this.stats.localSkips++;
      return same;
    } catch (e) {
      return false;
    }
  }

  order() {
    const wanted = Array.isArray(this.cfg.providers) ? this.cfg.providers : ['deepl', 'google'];
    const out = wanted.filter((n, i) => this.providers[n] && wanted.indexOf(n) === i);
    return out.length ? out : ['deepl', 'google'];
  }

  translate(text, source, target, { deadline } = {}) {
    const key = this.key(text, source, target);
    const cached = this.cache.get(key);
    if (cached !== undefined) { this.stats.cacheHits++; return Promise.resolve(cached); }

    const running = this.inflight.get(key);
    if (running) { this.stats.joined++; return running; }

    if (this.limiter.queued >= this.cfg.maxQueue) {
      this.stats.dropped++;
      this.log.debug(`queue full (${this.limiter.queued}), message not translated`);
      this.notifier.notify('queue', 'Translation queue is full (chat spam?) - some messages are left untranslated', 120000);
      return Promise.resolve(null);
    }

    const dl = deadline || Date.now() + this.cfg.holdTimeoutMs;
    this.stats.requests++;
    const p = this.limiter.run(() => this.chain(text, source, target, dl))
      .then(entry => { if (entry) this.cache.set(key, entry); return entry; })
      .catch(e => { this.log.error('unexpected translation error', e); return null; })
      .then(entry => { this.inflight.delete(key); return entry; });
    this.inflight.set(key, p);
    return p;
  }

  async chain(text, source, target, deadline) {
    const cfg = this.cfg;
    let tried = 0;
    let lastError = null;
    const skipped = [];

    for (const name of this.order()) {
      const p = this.providers[name];
      const now = Date.now();
      if (now >= deadline) { this.log.debug(`deadline reached before trying ${name}`); break; }
      const why = p.check(cfg, source, target, now);
      if (why) { skipped.push(`${name}: ${why}`); continue; }

      tried++;
      const timeout = Math.max(500, Math.min(cfg.requestTimeoutMs, deadline - now + 500));
      const t0 = Date.now();
      try {
        const r = await p.translate({ text, source, target }, cfg, timeout);
        if (!r || typeof r.text !== 'string' || !r.text.trim()) throw new TranslateError('badresponse', `${name}: empty translation`);
        const ms = Date.now() - t0;
        p.recordSuccess(ms);
        this.notifier.reset(`provider:${name}`);
        const detected = L.baseLang(r.detected || (source !== 'auto' ? source : ''));
        const same = (!!detected && detected === L.baseLang(target)) || sameText(r.text, text);
        if (same) this.stats.sameLanguage++; else this.stats.translated++;
        this.log.debug(`${name} ${ms}ms [${detected || '?'}->${target}]${same ? ' (same language)' : ''}`);
        return { text: r.text, detected, same, provider: name, ms };
      } catch (raw) {
        const err = wrapNetworkError(raw);
        lastError = err;
        const res = p.recordFailure(err, cfg);
        this.reportFailure(name, p, err, res);
      }
    }

    this.stats.failed++;
    if (tried === 0 && skipped.length) this.log.debug(`no provider available (${skipped.join('; ')})`);
    else if (lastError) this.log.debug(`all providers failed, last error: ${lastError.message}`);
    const anyUsable = this.order().some(n => !this.providers[n].check(cfg, source, target));
    if (!anyUsable) this.notifier.notify('allfail', 'No translation provider is available right now (see "translate status")', 300000);
    return null;
  }

  reportFailure(name, provider, err, res) {
    const label = provider.label(this.cfg);
    if (res.event === 'disabled') {
      this.log.error(`${label} disabled: ${err.message}`, null);
      this.notifier.notify(`provider:${name}`, `${label}: key rejected (${err.message}). Fix it with "translate ${name === 'deepl' ? 'key' : 'gkey'} <key>"`, 3600000);
    } else if (res.event === 'cooldown') {
      const secs = Math.round(res.ms / 1000);
      const quota = err.kind === 'quota';
      (quota ? this.log.error : this.log.warn).call(this.log, `${label} ${res.reason}, paused for ${secs}s`, err);
      if (quota) this.notifier.notify(`provider:${name}`, `${label}: monthly quota exceeded, falling back to the next provider`, 3600000);
    } else {
      this.log.debug(`${label} rejected the request: ${err.message}`);
    }
  }

  async test(name, text, source, target) {
    const p = this.providers[name];
    if (!p) throw new TranslateError('unsupported', `unknown provider "${name}"`);
    if (!p.configured(this.cfg)) throw new TranslateError('auth', `${name} is not configured`);
    const t0 = Date.now();
    try {
      const r = await p.translate({ text, source, target }, this.cfg, Math.max(this.cfg.requestTimeoutMs, 4000));
      return { text: r.text, detected: r.detected, ms: Date.now() - t0 };
    } catch (e) {
      throw wrapNetworkError(e);
    }
  }

  async deeplUsage() {
    try {
      return await this.providers.deepl.usage(this.cfg, Math.max(this.cfg.requestTimeoutMs, 4000));
    } catch (e) {
      throw wrapNetworkError(e);
    }
  }

  clearCache() { this.cache.clear(); }

  resetProviders() {
    for (const p of Object.values(this.providers)) p.reset();
    this.notifier.reset();
  }

  resetStats() { this.stats = this.freshStats(); }

  status() {
    const cfg = this.cfg;
    const now = Date.now();
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    return {
      providers: this.order().map(name => {
        const p = this.providers[name];
        return {
          name, label: p.label(cfg), state: p.state(cfg, now),
          ok: p.stats.ok, fail: p.stats.fail, avgMs: p.stats.avgMs, lastError: p.lastError,
        };
      }),
      cache: { size: this.cache.size, max: cfg.cacheSize, hitRate: total ? Math.round(100 * this.stats.cacheHits / total) : 0 },
      limiter: { active: this.limiter.active, queued: this.limiter.queued },
      inflight: this.inflight.size,
      stats: Object.assign({}, this.stats),
      detector: !!this.detector,
    };
  }
}

module.exports = { Translator, LRU, Limiter };
