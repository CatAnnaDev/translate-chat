'use strict';

const L = require('./lang');
const { TranslateError, DeepL, Google, wrapNetworkError } = require('./providers');

let LanguageDetect = null;
try { LanguageDetect = require('../lib/language-detector'); } catch (e) {}

const LOCAL_MIN_SCORE = 0.3;
const LOCAL_MIN_MARGIN = 0.08;
const LOCAL_MIN_LENGTH = 15;
const RETRY_KINDS = new Set(['transient', 'badresponse']);

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
    this.skipKey = null;
    this.skipLangs = new Set();
    this.stats = this.freshStats();
    if (LanguageDetect) {
      try { this.detector = new LanguageDetect(); this.detector.setLanguageType('iso2'); } catch (e) { this.log.warn('local language detector unavailable', e); }
    }
  }

  freshStats() {
    return { requests: 0, cacheHits: 0, cacheMisses: 0, joined: 0, translated: 0, sameLanguage: 0, localSkips: 0, failed: 0, dropped: 0, retries: 0, probes: 0 };
  }

  key(text, source, target) { return `${source}|${target}|${text}`; }

  skipSet() {
    const list = Array.isArray(this.cfg.skipLangs) ? this.cfg.skipLangs : [];
    const key = list.join(',');
    if (this.skipKey !== key) {
      this.skipKey = key;
      this.skipLangs = new Set(list.map(l => L.baseLang(l)));
    }
    return this.skipLangs;
  }

  isSkipped(lang, target, useSkip) {
    const b = L.baseLang(lang);
    if (!b) return false;
    return b === L.baseLang(target) || (useSkip && this.skipSet().has(b));
  }

  isSame(entry, target, useSkip) {
    return !!entry && (entry.unchanged || this.isSkipped(entry.detected, target, useSkip));
  }

  peek(text, source, target) {
    if (this.cache.max !== this.cfg.cacheSize) this.cache.max = this.cfg.cacheSize;
    const e = this.cache.get(this.key(text, source, target));
    if (e === undefined) this.stats.cacheMisses++; else this.stats.cacheHits++;
    return e;
  }

  localSkip(plain, target, useSkip) {
    const cfg = this.cfg;
    if (!cfg.localDetect || !this.detector || plain.length < Math.max(LOCAL_MIN_LENGTH, cfg.localDetectMinLength)) return null;
    try {
      const d = this.detector.detect(plain, 2);
      if (!d || !d[0]) return null;
      const lang = L.baseLang(d[0][0]);
      if (!this.isSkipped(lang, target, useSkip)) return null;
      const second = d[1] ? d[1][1] : 0;
      if (d[0][1] < LOCAL_MIN_SCORE || d[0][1] - second < LOCAL_MIN_MARGIN) return null;
      this.stats.localSkips++;
      return lang;
    } catch (e) {
      return null;
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

  async attempt(name, text, source, target, deadline, quiet) {
    const cfg = this.cfg;
    const p = this.providers[name];
    for (let i = 0; ; i++) {
      const now = Date.now();
      const timeout = Math.max(500, Math.min(cfg.requestTimeoutMs, deadline - now + 500));
      p.lastAttemptAt = now;
      try {
        const r = await p.translate({ text, source, target }, cfg, timeout);
        if (!r || typeof r.text !== 'string' || !r.text.trim()) throw new TranslateError('badresponse', `${name}: empty translation`);
        const ms = Date.now() - now;
        p.recordSuccess(ms);
        this.notifier.reset(`provider:${name}`);
        const detected = L.baseLang(r.detected || (source !== 'auto' ? source : ''));
        const unchanged = sameText(r.text, text);
        if (unchanged || (detected && detected === L.baseLang(target))) this.stats.sameLanguage++; else this.stats.translated++;
        this.log.debug(`${name} ${ms}ms [${detected || '?'}->${target}]${unchanged ? ' (unchanged)' : ''}`);
        return { text: r.text, detected, unchanged, provider: name, ms };
      } catch (raw) {
        const err = wrapNetworkError(raw);
        if (i === 0 && RETRY_KINDS.has(err.kind) && deadline - Date.now() > 700) {
          this.stats.retries++;
          this.log.debug(`${p.label(cfg)} ${err.kind} (${err.message}), retrying once`);
          continue;
        }
        if (!quiet) this.reportFailure(name, p, err, p.recordFailure(err, cfg));
        throw err;
      }
    }
  }

  chain(text, source, target, deadline) {
    const cfg = this.cfg;
    let queue = [];
    const skipped = [];
    for (const name of this.order()) {
      const why = this.providers[name].check(cfg, source, target);
      if (why) skipped.push(`${name}: ${why}`); else queue.push(name);
    }
    if (!queue.length) {
      const now = Date.now();
      const probe = this.order()
        .filter(n => this.providers[n].probeable(cfg, source, target, now))
        .sort((a, b) => this.providers[a].cooldownUntil - this.providers[b].cooldownUntil);
      if (probe.length) {
        queue = probe;
        this.stats.probes++;
        this.log.debug(`all providers paused, probing ${probe.join(', ')}`);
      }
    }

    return new Promise(resolve => {
      let settled = false;
      let running = 0;
      let timer = null;
      let lastError = null;
      let lastName = null;
      let selfHedged = false;
      let dupNext = false;

      const finish = value => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (!value) {
          this.stats.failed++;
          if (lastError) this.log.debug(`all providers failed, last error: ${lastError.message}`);
          else this.log.debug(`no provider available (${skipped.join('; ')})`);
          const anyUsable = this.order().some(n => !this.providers[n].check(cfg, source, target));
          if (!anyUsable) this.notifier.notify('allfail', 'No translation provider is available right now (see "translate status")', 300000);
        }
        resolve(value);
      };

      const arm = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (settled || cfg.hedgeMs <= 0) return;
        if (!queue.length) {
          if (selfHedged || !lastName) return;
          timer = setTimeout(() => {
            timer = null;
            if (settled) return;
            selfHedged = true;
            dupNext = true;
            queue.push(lastName);
            launch();
          }, cfg.hedgeMs);
          return;
        }
        timer = setTimeout(() => { timer = null; launch(); }, cfg.hedgeMs);
      };

      const launch = () => {
        if (settled || !queue.length) return false;
        if (Date.now() >= deadline) { queue.length = 0; return false; }
        const name = queue.shift();
        const quiet = dupNext;
        dupNext = false;
        lastName = name;
        running++;
        this.attempt(name, text, source, target, deadline, quiet).then(
          entry => { running--; finish(entry); },
          err => {
            running--;
            lastError = err;
            if (!launch() && running === 0) finish(null);
          }
        );
        arm();
        return true;
      };

      if (!launch()) finish(null);
    });
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
      this.log.debug(`${label} failed (${err.kind}): ${err.message}`);
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
