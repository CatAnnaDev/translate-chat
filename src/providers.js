'use strict';

const http = require('./http');
const L = require('./lang');
const { OPEN, CLOSE, MARKER_RE } = require('./message');

class TranslateError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'TranslateError';
    this.kind = kind;
    if (extra) Object.assign(this, extra);
  }
}

function retryAfterMs(headers) {
  const v = headers && headers['retry-after'];
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
}

function parseJson(body, what) {
  try { return JSON.parse(body); } catch (e) { throw new TranslateError('badresponse', `${what}: response is not valid JSON`); }
}

function wrapNetworkError(e) {
  if (e instanceof TranslateError) return e;
  const code = e && e.code ? `${e.code}: ` : '';
  return new TranslateError('transient', `${code}${e && e.message ? e.message : e}`);
}

class Provider {
  constructor(name) {
    this.name = name;
    this.reset();
  }

  reset() {
    this.stats = { ok: 0, fail: 0, avgMs: 0 };
    this.streak = 0;
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.disabledReason = '';
    this.disabledKey = null;
    this.lastError = '';
    this.lastErrorAt = 0;
    this.unsupported = new Set();
  }

  keyId() { return ''; }
  configured() { return true; }

  check(cfg, source, target, now = Date.now()) {
    if (!this.configured(cfg)) return 'not configured';
    if (this.disabledReason) {
      if (this.disabledKey !== this.keyId(cfg)) { this.disabledReason = ''; this.disabledKey = null; this.streak = 0; }
      else return this.disabledReason;
    }
    if (now < this.cooldownUntil) return `cooldown ${Math.ceil((this.cooldownUntil - now) / 1000)}s (${this.cooldownReason})`;
    if (this.unsupported.has('T:' + target)) return `target language ${target} not supported`;
    if (source && source !== 'auto' && this.unsupported.has('S:' + source)) return `source language ${source} not supported`;
    return null;
  }

  recordSuccess(ms) {
    this.stats.ok++;
    this.streak = 0;
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.stats.avgMs = this.stats.avgMs ? Math.round(this.stats.avgMs * 0.8 + ms * 0.2) : ms;
  }

  cooldown(ms, reason) {
    this.cooldownUntil = Date.now() + ms;
    this.cooldownReason = reason;
  }

  recordFailure(err, cfg) {
    if (err.kind === 'unsupported') {
      if (err.langKey) this.unsupported.add(err.langKey);
      return { event: null };
    }
    this.stats.fail++;
    this.lastError = `${err.kind}: ${err.message}`;
    this.lastErrorAt = Date.now();
    if (err.kind === 'auth') {
      this.disabledReason = 'invalid key / access denied';
      this.disabledKey = this.keyId(cfg);
      return { event: 'disabled' };
    }
    let ms;
    let reason;
    if (err.kind === 'quota') { ms = 30 * 60e3; reason = 'quota exceeded'; }
    else if (err.kind === 'ratelimit') { this.streak++; ms = err.retryAfterMs || Math.min(10 * 60e3, 15e3 * Math.pow(2, this.streak - 1)); reason = 'rate limited'; }
    else { this.streak++; ms = Math.min(60e3, 1000 * Math.pow(2, this.streak)); reason = err.kind; }
    this.cooldown(ms, reason);
    return { event: 'cooldown', ms, reason };
  }

  state(cfg, now = Date.now()) {
    const why = this.check(cfg, 'auto', cfg.targetLang, now);
    return why || 'ready';
  }
}

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');

function toXml(marked) {
  let out = '';
  let last = 0;
  for (const m of marked.matchAll(MARKER_RE)) {
    out += xmlEscape(marked.slice(last, m.index)) + `<x>${m[1]}</x>`;
    last = m.index + m[0].length;
  }
  return out + xmlEscape(marked.slice(last));
}

function fromXml(s) {
  return xmlUnescape(s.replace(/<x>\s*(\d+)\s*<\/x>/g, (m, n) => OPEN + n + CLOSE));
}

class DeepL extends Provider {
  constructor() { super('deepl'); }

  keyId(cfg) { return String(cfg.deeplKey || '').trim(); }
  configured(cfg) { return !!this.keyId(cfg); }

  label(cfg) {
    const k = this.keyId(cfg);
    if (!k) return 'DeepL (no key)';
    return k.endsWith(':fx') ? 'DeepL API Free' : 'DeepL API Pro';
  }

  base(key) { return key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'; }

  classify(res, req) {
    const s = res.status;
    let msg = `HTTP ${s}`;
    try { const j = JSON.parse(res.body); if (j && j.message) msg += `: ${j.message}`; } catch (e) { /* keep generic message */ }
    const extra = { status: s };
    if (s === 400) {
      if (/target_lang/i.test(msg)) throw new TranslateError('unsupported', msg, Object.assign(extra, { langKey: 'T:' + (req && req.target) }));
      if (/source_lang/i.test(msg)) throw new TranslateError('unsupported', msg, Object.assign(extra, { langKey: 'S:' + (req && req.source) }));
      throw new TranslateError('unsupported', msg, extra);
    }
    if (s === 401 || s === 403) throw new TranslateError('auth', msg, extra);
    if (s === 413 || s === 414) throw new TranslateError('unsupported', msg, extra);
    if (s === 429 || s === 529) throw new TranslateError('ratelimit', msg, Object.assign(extra, { retryAfterMs: retryAfterMs(res.headers) }));
    if (s === 456) throw new TranslateError('quota', msg, extra);
    throw new TranslateError('transient', msg, extra);
  }

  async translate(req, cfg, timeout) {
    const key = this.keyId(cfg);
    const xml = req.text.indexOf(OPEN) !== -1;
    const body = { text: [xml ? toXml(req.text) : req.text], target_lang: L.deeplTarget(req.target), preserve_formatting: true };
    const src = L.deeplSource(req.source);
    if (src) body.source_lang = src;
    if (xml) { body.tag_handling = 'xml'; body.ignore_tags = ['x']; }

    let res;
    try {
      res = await http.request(`${this.base(key)}/v2/translate`, {
        method: 'POST',
        timeout,
        headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'translate-chat/3.0' },
        body: JSON.stringify(body),
      });
    } catch (e) { throw wrapNetworkError(e); }

    if (res.status !== 200) this.classify(res, req);
    const json = parseJson(res.body, 'DeepL');
    const first = json && json.translations && json.translations[0];
    if (!first || typeof first.text !== 'string') throw new TranslateError('badresponse', 'DeepL: unexpected response shape');
    return { text: xml ? fromXml(first.text) : first.text, detected: first.detected_source_language || '' };
  }

  async usage(cfg, timeout) {
    const key = this.keyId(cfg);
    if (!key) throw new TranslateError('auth', 'no DeepL key set');
    let res;
    try {
      res = await http.request(`${this.base(key)}/v2/usage`, { timeout, headers: { Authorization: `DeepL-Auth-Key ${key}`, 'User-Agent': 'translate-chat/3.0' } });
    } catch (e) { throw wrapNetworkError(e); }
    if (res.status !== 200) this.classify(res, null);
    const j = parseJson(res.body, 'DeepL usage');
    return { used: j.character_count, limit: j.character_limit };
  }
}

const toGoogle = marked => marked.replace(MARKER_RE, (m, n) => `[[${n}]]`);
const fromGoogle = s => s.replace(/\[\s*\[\s*(\d+)\s*\]\s*\]/g, (m, n) => OPEN + n + CLOSE);

class Google extends Provider {
  constructor() { super('google'); }

  keyId(cfg) { return String(cfg.googleKey || '').trim(); }

  label(cfg) { return this.keyId(cfg) ? 'Google Cloud Translation' : 'Google Translate (free)'; }

  async translate(req, cfg, timeout) {
    return this.keyId(cfg) ? this.cloud(req, cfg, timeout) : this.free(req, timeout);
  }

  async free(req, timeout) {
    const tl = L.googleCode(req.target);
    const url = 'https://translate.google.com/translate_a/single'
      + '?client=at&dt=t&dt=ld&dt=qca&dt=rm&dt=bd&dj=1&hl=' + encodeURIComponent(tl) + '&ie=UTF-8'
      + '&oe=UTF-8&inputm=2&otf=2&iid=1dd3b944-fa62-4b55-b330-74909a99969e';
    const params = new URLSearchParams();
    params.append('sl', L.googleCode(req.source));
    params.append('tl', tl);
    params.append('q', toGoogle(req.text));

    let res;
    try {
      res = await http.request(url, {
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          'User-Agent': 'AndroidTranslate/5.3.0.RC02.130475354-53000263 5.1 phone TRANSLATE_OPM5_TEST_1',
        },
        body: params.toString(),
      });
    } catch (e) { throw wrapNetworkError(e); }

    const extra = { status: res.status };
    if (res.status === 429 || res.status === 403) throw new TranslateError('ratelimit', `HTTP ${res.status} (blocked by Google)`, Object.assign(extra, { retryAfterMs: retryAfterMs(res.headers) }));
    if (res.status >= 500) throw new TranslateError('transient', `HTTP ${res.status}`, extra);
    if (res.status !== 200) throw new TranslateError('transient', `HTTP ${res.status}`, extra);
    if (/^\s*</.test(res.body)) throw new TranslateError('ratelimit', 'Google returned an HTML page (captcha/consent)', extra);

    const json = parseJson(res.body, 'Google');
    if (!json || !Array.isArray(json.sentences)) throw new TranslateError('badresponse', 'Google: unexpected response shape', extra);
    const text = json.sentences.map(s => s.trans || '').join('');
    const detected = json.src || (json.ld_result && json.ld_result.srclangs && json.ld_result.srclangs[0]) || '';
    return { text: fromGoogle(text), detected };
  }

  async cloud(req, cfg, timeout) {
    const key = this.keyId(cfg);
    const body = { q: toGoogle(req.text), target: L.googleCode(req.target), format: 'text' };
    if (req.source && req.source !== 'auto') body.source = L.googleCode(req.source);

    let res;
    try {
      res = await http.request('https://translation.googleapis.com/language/translate/v2', {
        method: 'POST',
        timeout,
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key, 'User-Agent': 'translate-chat/3.0' },
        body: JSON.stringify(body),
      });
    } catch (e) { throw wrapNetworkError(e); }

    if (res.status !== 200) {
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(res.body); if (j && j.error && j.error.message) msg += `: ${j.error.message}`; } catch (e) { /* generic */ }
      const extra = { status: res.status };
      if (res.status === 429) throw new TranslateError('ratelimit', msg, Object.assign(extra, { retryAfterMs: retryAfterMs(res.headers) }));
      if (res.status === 401 || res.status === 403 || (res.status === 400 && /API key/i.test(msg))) {
        throw new TranslateError(/quota|limit/i.test(msg) ? 'quota' : 'auth', msg, extra);
      }
      if (res.status === 400) throw new TranslateError('unsupported', msg, extra);
      throw new TranslateError('transient', msg, extra);
    }
    const json = parseJson(res.body, 'Google Cloud');
    const first = json && json.data && json.data.translations && json.data.translations[0];
    if (!first || typeof first.translatedText !== 'string') throw new TranslateError('badresponse', 'Google Cloud: unexpected response shape');
    return { text: fromGoogle(first.translatedText), detected: first.detectedSourceLanguage || '' };
  }
}

module.exports = { TranslateError, Provider, DeepL, Google, wrapNetworkError };
