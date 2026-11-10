'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const http = require('../src/http');
const msg = require('../src/message');
const config = require('../src/config');
const { OrderedRelease } = require('../src/ordered');
const { Translator } = require('../src/translate');
const { Glossary } = require('../src/glossary');
const TranslateChat = require('../src/index');
const migrate = require('../src/setting_migration');

const root = path.join(__dirname, '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const silentLog = { error() {}, warn() {}, info() {}, debug() {}, recent: () => [], file: 'x', destroy() {} };
const cleanup = () => {
  try { fs.rmSync(path.join(root, 'glossary.json'), { force: true }); } catch (e) {}
  try { fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true }); } catch (e) {}
};

let handler = async () => { throw new Error('no handler'); };
const calls = [];
http.request = async (url, opts) => {
  const call = { url, opts, body: opts && opts.body ? opts.body : null };
  calls.push(call);
  return handler(url, opts, call);
};
const isDeepl = u => u.includes('deepl.com');
const deeplOk = (text, detected = 'RU') => ({ status: 200, headers: {}, body: JSON.stringify({ translations: [{ detected_source_language: detected, text }] }) });
const googleOk = (text, src = 'fr') => ({ status: 200, headers: {}, body: JSON.stringify({ sentences: [{ trans: text }], src }) });
const reset = () => { calls.length = 0; handler = async () => { throw new Error('no handler'); }; };
const count = pred => calls.filter(c => pred(c.url)).length;

function makeMod(settings) {
  const hooks = {};
  const sent = [];
  const said = [];
  const cmds = {};
  return {
    settings: Object.assign({ logFile: false, cacheSize: 100 }, settings),
    publisher: 'eu',
    hooks, sent, said, cmds,
    hook(name, version, opts, cb) { (hooks[name] = hooks[name] || []).push(cb); },
    send(name, version, ev) { sent.push({ name, ev }); },
    command: { add(name, obj) { cmds[name] = obj; }, message(t) { said.push(t); } },
    game: { me: { name: 'Me', is: id => id === 1 }, on() {}, isIngame: true, isInLoadingScreen: false },
    log() {}, warn() {}, error() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t),
    saveSettings() {},
  };
}

function makeEngine(over) {
  const settings = Object.assign(config.sanitize({}) && migrate(undefined, 4, {}), over);
  const notes = [];
  const notifier = { notify: (k, t) => notes.push(k), reset() {} };
  const tr = new Translator({ cfg: settings, log: silentLog, notifier });
  return { tr, settings, notes };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('parse keeps links/urls/glossary and round-trips', () => {
  const g = new Glossary(root, silentLog);
  const html = '<FONT>wtb <ChatLinkAction param="1#####2">&lt;Item&gt;</ChatLinkAction> pls &amp; thx www.example.com</FONT>';
  const p = msg.parse(html, g);
  assert.strictEqual(p.spans.length, 4);
  assert.ok(p.letters >= 3);
  assert.strictEqual(p.plain, 'pls &');
  const back = msg.toHtml(p.text, p.spans);
  assert.strictEqual(back, 'wtb <ChatLinkAction param="1#####2">&lt;Item&gt;</ChatLinkAction> pls &amp; thx www.example.com');
});

test('glossary-only and url-only messages have no letters (skipped without API call)', () => {
  const g = new Glossary(root, silentLog);
  assert.strictEqual(msg.parse('<FONT>wtb healer</FONT>', g).letters, 0);
  assert.strictEqual(msg.parse('<FONT>https://example.com/a</FONT>', g).letters, 0);
});

test('renderInbound inline / replace / separate', () => {
  const p = msg.parse('<FONT>Привет</FONT>', null);
  const entry = { text: 'Hello <&>', detected: 'ru' };
  const cfg = { showTag: true, color: '#9be37c', separator: ' | ', displayMode: 'inline' };
  assert.strictEqual(msg.renderInbound('<FONT>Привет</FONT>', p, entry, cfg), '<FONT>Привет</FONT><FONT COLOR="#9be37c"> | [RU] Hello &lt;&amp;&gt;</FONT>');
  assert.strictEqual(msg.renderInbound('<FONT>Привет</FONT>', p, entry, Object.assign({}, cfg, { displayMode: 'replace', color: '' })), '<FONT>[RU] Hello &lt;&amp;&gt;</FONT>');
  assert.ok(msg.renderSeparate(p, entry, cfg).includes('(Translated) [RU] Hello'));
});

test('replace mode falls back to inline when a marker was lost', () => {
  const html = '<FONT>hola <ChatLinkAction param="x">&lt;I&gt;</ChatLinkAction></FONT>';
  const p = msg.parse(html, null);
  const lost = { text: 'hello', detected: 'es' };
  const out = msg.renderInbound(html, p, lost, { showTag: false, color: '', separator: ' | ', displayMode: 'replace' });
  assert.ok(out.startsWith(html), 'original kept');
});

test('OrderedRelease keeps arrival order and bounds each wait', async () => {
  const out = [];
  const q = new OrderedRelease({ setTimer: setTimeout, clearTimer: clearTimeout });
  q.add(wait(60).then(() => 'slow'), 500, v => out.push(v));
  q.add(wait(5).then(() => 'fast'), 500, v => out.push(v));
  q.add('instant', 0, v => out.push(v));
  await wait(120);
  assert.deepStrictEqual(out, ['slow', 'fast', 'instant']);

  const out2 = [];
  q.add(new Promise(() => {}), 30, (v, t) => out2.push([v, t]));
  q.add(Promise.resolve('ok'), 500, v => out2.push([v, false]));
  await wait(80);
  assert.deepStrictEqual(out2, [[null, true], ['ok', false]]);
  assert.strictEqual(q.pending, 0);
});

test('config validation, parsing and repair', () => {
  assert.strictEqual(config.parseValue('holdTimeoutMs', ['5000']).value, 5000);
  assert.ok(!config.parseValue('holdTimeoutMs', ['50']).ok);
  assert.strictEqual(config.parseValue('color', ['off']).value, '');
  assert.strictEqual(config.parseValue('color', ['9BE37C']).value, '#9be37c');
  assert.deepStrictEqual(config.parseValue('providers', ['google', 'deepl', 'google']).value, ['google', 'deepl']);
  assert.ok(!config.parseValue('providers', ['bing']).ok);
  assert.strictEqual(config.validate('targetLang', 'FR').value, 'fr');
  assert.ok(!config.validate('targetLang', 'auto').ok);
  assert.strictEqual(config.validate('sourceLang', 'auto').value, 'auto');
  assert.deepStrictEqual(config.parseValue('ignoreChannels', ['1,2', '3']).value, [1, 2, 3]);
  assert.deepStrictEqual(config.parseValue('skipLangs', ['EN,fr', 'de']).value, ['en', 'fr', 'de']);
  assert.deepStrictEqual(config.parseValue('skipLangs', ['none']).value, []);
  assert.ok(!config.parseValue('skipLangs', ['en', 'klingon']).ok);
  const s = { targetLang: 'klingon', holdTimeoutMs: 'x', deeplKey: 'a b' };
  const repaired = config.sanitize(s);
  assert.deepStrictEqual(repaired.sort(), ['deeplKey', 'holdTimeoutMs', 'targetLang']);
  assert.strictEqual(s.targetLang, 'en');
  assert.strictEqual(config.mask('abcdef123456:fx'), '***3:fx'.replace('3:fx', '6:fx'));
});

test('settings migrator keeps old values and adds new defaults', () => {
  const out = migrate(3, 4, { targetLang: 'fr', deeplKey: 'abc', sendMode: true });
  assert.strictEqual(out.targetLang, 'fr');
  assert.strictEqual(out.sendMode, true);
  assert.deepStrictEqual(out.providers, ['deepl', 'google']);
  assert.strictEqual(out.displayMode, 'inline');
  assert.strictEqual(migrate(4, 4, { targetLang: 'xx' }).targetLang, 'en');
  const old = migrate(4, 5, { requestTimeoutMs: 2000, holdTimeoutMs: 3000, localDetectMinLength: 10 });
  assert.strictEqual(old.requestTimeoutMs, 2500);
  assert.strictEqual(old.holdTimeoutMs, 4000);
  assert.strictEqual(old.localDetectMinLength, 15);
  assert.deepStrictEqual(old.skipLangs, ['en', 'fr']);
  assert.strictEqual(migrate(4, 5, { holdTimeoutMs: 6000 }).holdTimeoutMs, 6000);
});

test('DeepL success, cache and in-flight de-duplication', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'key:fx' });
  handler = async (u) => { await wait(20); return deeplOk('Hello world'); };
  const [a, b] = await Promise.all([tr.translate('Привет мир', 'auto', 'en'), tr.translate('Привет мир', 'auto', 'en')]);
  assert.strictEqual(a.text, 'Hello world');
  assert.strictEqual(a.provider, 'deepl');
  assert.strictEqual(a, b);
  assert.strictEqual(calls.length, 1, 'one HTTP call for two identical concurrent requests');
  assert.ok(calls[0].url.startsWith('https://api-free.deepl.com/'));
  assert.ok(tr.peek('Привет мир', 'auto', 'en'));
  await tr.translate('Привет мир', 'auto', 'en');
  assert.strictEqual(calls.length, 1, 'cache hit');
  const sent = JSON.parse(calls[0].body);
  assert.strictEqual(sent.target_lang, 'EN-US');
  assert.ok(!('source_lang' in sent));
  assert.strictEqual(calls[0].opts.headers.Authorization, 'DeepL-Auth-Key key:fx');
});

test('DeepL xml mode protects markers and restores them', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'key' });
  const p = msg.parse('<FONT>купи <ChatLinkAction param="p">&lt;X&gt;</ChatLinkAction> & продай</FONT>', null);
  handler = async () => deeplOk('buy <x>0</x> &amp; sell');
  const e = await tr.translate(p.text, 'auto', 'en');
  const body = JSON.parse(calls[0].body);
  assert.ok(calls[0].url.startsWith('https://api.deepl.com/'), 'Pro endpoint when the key has no :fx');
  assert.strictEqual(body.tag_handling, 'xml');
  assert.deepStrictEqual(body.ignore_tags, ['x']);
  assert.ok(body.text[0].includes('<x>0</x>') && body.text[0].includes('&amp;'));
  assert.strictEqual(msg.toHtml(e.text, p.spans), 'buy <ChatLinkAction param="p">&lt;X&gt;</ChatLinkAction> &amp; sell');
});

test('Google free endpoint parsing and marker round-trip', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: '' });
  const p = msg.parse('<FONT>salut <ChatLinkAction param="p">&lt;X&gt;</ChatLinkAction> les gars</FONT>', null);
  handler = async (u, o, c) => googleOk('hi [ [ 0 ] ] guys');
  const e = await tr.translate(p.text, 'auto', 'en');
  assert.strictEqual(e.provider, 'google');
  assert.strictEqual(e.detected, 'fr');
  assert.strictEqual(msg.toHtml(e.text, p.spans), 'hi <ChatLinkAction param="p">&lt;X&gt;</ChatLinkAction> guys');
  assert.ok(decodeURIComponent(calls[0].body).includes('[[0]]'));
});

test('fallback to Google on 429, and the circuit breaker skips DeepL afterwards', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'key:fx' });
  handler = async (u) => (isDeepl(u) ? { status: 429, headers: { 'retry-after': '30' }, body: '{"message":"Too many requests"}' } : googleOk('hello', 'de'));
  const a = await tr.translate('hallo welt', 'auto', 'en');
  assert.strictEqual(a.provider, 'google');
  assert.strictEqual(count(isDeepl), 1);
  const b = await tr.translate('wie geht es dir', 'auto', 'en');
  assert.strictEqual(b.provider, 'google');
  assert.strictEqual(count(isDeepl), 1, 'DeepL is not retried during its cooldown');
  const st = tr.status().providers.find(p => p.name === 'deepl');
  assert.ok(/cooldown/.test(st.state));
  tr.resetProviders();
  await tr.translate('noch ein satz', 'auto', 'en');
  assert.strictEqual(count(isDeepl), 2, 'reset re-enables the provider');
});

test('invalid key disables DeepL until the key changes', async () => {
  reset();
  const { tr, settings, notes } = makeEngine({ deeplKey: 'bad:fx' });
  handler = async (u) => (isDeepl(u) ? { status: 403, headers: {}, body: '{"message":"Forbidden"}' } : googleOk('hello'));
  await tr.translate('один', 'auto', 'en');
  await tr.translate('два', 'auto', 'en');
  assert.strictEqual(count(isDeepl), 1);
  assert.ok(notes.includes('provider:deepl'), 'user is notified in game');
  assert.ok(/invalid key/.test(tr.status().providers[0].state));
  settings.deeplKey = 'good:fx';
  handler = async (u) => (isDeepl(u) ? deeplOk('three') : googleOk('x'));
  const e = await tr.translate('три', 'auto', 'en');
  assert.strictEqual(e.provider, 'deepl');
});

test('quota exceeded (456) pauses DeepL for a long time', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'k:fx' });
  handler = async (u) => (isDeepl(u) ? { status: 456, headers: {}, body: '{"message":"Quota exceeded"}' } : googleOk('ok'));
  await tr.translate('текст', 'auto', 'en');
  const p = tr.providers.deepl;
  assert.ok(p.cooldownUntil - Date.now() > 25 * 60e3);
  assert.strictEqual(p.cooldownReason, 'quota exceeded');
});

test('unsupported target language is remembered without penalising the provider', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'k:fx' });
  handler = async (u) => (isDeepl(u) ? { status: 400, headers: {}, body: '{"message":"Value for \'target_lang\' not supported."}' } : googleOk('ok'));
  await tr.translate('hello there', 'auto', 'sw');
  await tr.translate('another one', 'auto', 'sw');
  assert.strictEqual(count(isDeepl), 1);
  assert.strictEqual(tr.providers.deepl.stats.fail, 0);
  assert.strictEqual(tr.providers.deepl.cooldownUntil, 0);
});

test('network errors fall back and trigger a short cooldown', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'k:fx' });
  handler = async (u) => { if (isDeepl(u)) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; } return googleOk('fine'); };
  const e = await tr.translate('сообщение', 'auto', 'en');
  assert.strictEqual(e.provider, 'google');
  assert.strictEqual(tr.providers.deepl.cooldownUntil, 0, 'a single failure never pauses a provider');
  await tr.translate('сообщение два', 'auto', 'en');
  await tr.translate('сообщение три', 'auto', 'en');
  const ms = tr.providers.deepl.cooldownUntil - Date.now();
  assert.ok(ms > 0 && ms <= 4000);
});

test('all providers failing returns null (never throws) and notifies', async () => {
  reset();
  const { tr, notes } = makeEngine({ deeplKey: 'k:fx' });
  handler = async () => { throw Object.assign(new Error('boom'), { code: 'ENOTFOUND' }); };
  assert.strictEqual(await tr.translate('что-то', 'auto', 'en'), null);
  assert.strictEqual(await tr.translate('что-то два', 'auto', 'en'), null);
  assert.strictEqual(await tr.translate('что-то три', 'auto', 'en'), null);
  assert.ok(notes.includes('allfail'));
  assert.strictEqual(tr.stats.failed, 3);
});

test('same-language results are flagged and cached', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('good morning', 'EN');
  const e = await tr.translate('good morning', 'auto', 'en');
  assert.strictEqual(e.unchanged, true);
  assert.strictEqual(tr.isSame(e, 'en', false), true);
  assert.strictEqual(tr.isSame(tr.peek('good morning', 'auto', 'en'), 'en', false), true);
});

test('queue overflow drops instead of piling up', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'k:fx', maxConcurrent: 1, maxQueue: 8 });
  handler = async () => { await wait(30); return deeplOk('ok'); };
  const all = [];
  for (let i = 0; i < 14; i++) all.push(tr.translate('сообщение ' + i, 'auto', 'en'));
  const res = await Promise.all(all);
  assert.ok(tr.stats.dropped > 0);
  assert.ok(res.filter(Boolean).length < 14);
});

function boot(settings) {
  const mod = makeMod(settings);
  const app = new TranslateChat(mod);
  const fire = (name, event) => mod.hooks[name][0](event);
  return { mod, app, fire };
}
const chat = (text, extra) => Object.assign({ channel: 1, gameId: 5, name: 'Bob', message: `<FONT>${text}</FONT>` }, extra);

test('hooks: inline translation on the same line, re-emitted as one packet', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => { await wait(15); return deeplOk('Hello everyone', 'RU'); };
  const ev = chat('Привет всем');
  assert.strictEqual(fire('S_CHAT', ev), false, 'packet is held');
  assert.strictEqual(mod.sent.length, 0);
  await wait(60);
  assert.strictEqual(mod.sent.length, 1);
  assert.strictEqual(mod.sent[0].name, 'S_CHAT');
  const m = mod.sent[0].ev.message;
  assert.ok(m.startsWith('<FONT>Привет всем</FONT>'));
  assert.ok(m.includes('[RU] Hello everyone'));
  assert.strictEqual(mod.sent[0].ev.name, 'Bob', 'other fields are preserved');
});

test('hooks: cache hit modifies the packet in place with zero delay', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Hello everyone', 'RU');
  fire('S_CHAT', chat('Привет всем'));
  await wait(30);
  const ev = chat('Привет всем');
  assert.strictEqual(fire('S_CHAT', ev), true);
  assert.ok(ev.message.includes('Hello everyone'));
  assert.strictEqual(mod.sent.length, 1, 'no extra packet for the cached message');
});

test('hooks: messages stay in order even when translations finish out of order', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async (u, o, c) => {
    const text = JSON.parse(c.body).text[0];
    await wait(text.includes('first') ? 80 : 5);
    return deeplOk('T:' + text, 'RU');
  };
  fire('S_CHAT', chat('first message'.replace('first', 'первый first')));
  fire('S_CHAT', chat('второй second'));
  fire('S_CHAT', chat('wtb healer'));
  await wait(200);
  const texts = mod.sent.map(s => s.ev.message);
  assert.strictEqual(texts.length, 3);
  assert.ok(texts[0].includes('первый'));
  assert.ok(texts[1].includes('второй'));
  assert.ok(texts[2].includes('wtb healer'));
});

test('hooks: own messages, glossary-only, ignored channels and local-language text pass through', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', ignoreChannels: [7] });
  handler = async () => deeplOk('x');
  assert.strictEqual(fire('S_CHAT', chat('Привет всем', { gameId: 1 })), undefined, 'own message (gameId)');
  assert.strictEqual(fire('S_CHAT', chat('Привет всем', { gameId: 5, name: 'Me' })), undefined, 'own message (name)');
  assert.strictEqual(fire('S_CHAT', chat('wtb healer')), undefined, 'glossary only');
  assert.strictEqual(fire('S_CHAT', chat('Привет всем', { channel: 7 })), undefined, 'ignored channel');
  assert.strictEqual(fire('S_CHAT', chat('this is a perfectly normal english sentence that nobody needs translated')), undefined, 'local detector');
  assert.strictEqual(calls.length, 0, 'no HTTP request was made');
  assert.strictEqual(mod.sent.length, 0);
});

test('hooks: a provider failure never loses the message', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => { throw Object.assign(new Error('down'), { code: 'ECONNRESET' }); };
  const ev = chat('Привет всем');
  assert.strictEqual(fire('S_CHAT', ev), false);
  await wait(40);
  assert.strictEqual(mod.sent.length, 1);
  assert.strictEqual(mod.sent[0].ev.message, ev.message, 'original delivered unchanged');
});

test('hooks: hold timeout delivers the original, late result is cached', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', holdTimeoutMs: 200, requestTimeoutMs: 2000 });
  handler = async () => { await wait(350); return deeplOk('Late hello', 'RU'); };
  const ev = chat('Привет всем');
  fire('S_CHAT', ev);
  await wait(260);
  assert.strictEqual(mod.sent.length, 1);
  assert.strictEqual(mod.sent[0].ev.message, ev.message);
  await wait(200);
  const again = chat('Привет всем');
  assert.strictEqual(fire('S_CHAT', again), true);
  assert.ok(again.message.includes('Late hello'));
});

test('hooks: separate mode keeps the original untouched and adds a line', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', displayMode: 'separate' });
  handler = async () => deeplOk('Hello all', 'RU');
  assert.strictEqual(fire('S_CHAT', chat('Привет всем')), undefined);
  await wait(30);
  assert.strictEqual(mod.sent.length, 1);
  assert.ok(mod.sent[0].ev.message.includes('(Translated) [RU] Hello all'));
});

test('hooks: whisper and private chat packets are handled too', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Hello', 'RU');
  fire('S_WHISPER', { gameId: 9, player: 'Al', message: '<FONT>Привет</FONT>' });
  fire('S_PRIVATE_CHAT', { channel: 3, authorName: 'Bo', message: '<FONT>Привет</FONT>' });
  await wait(50);
  assert.deepStrictEqual(mod.sent.map(s => s.name), ['S_WHISPER', 'S_PRIVATE_CHAT']);
});

test('hooks: outgoing messages are translated, held, and the original is echoed', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', sendMode: true, sendLang: 'fr' });
  handler = async () => deeplOk('Bonjour mes amis', 'EN');
  const ev = { channel: 1, message: '<FONT>hello my friends</FONT>' };
  assert.strictEqual(fire('C_CHAT', ev), false);
  await wait(40);
  assert.strictEqual(mod.sent.length, 1);
  assert.strictEqual(mod.sent[0].name, 'C_CHAT');
  assert.strictEqual(mod.sent[0].ev.message, '<FONT>Bonjour mes amis</FONT>');
  assert.strictEqual(mod.sent[0].ev.channel, 1);
  assert.ok(mod.said.some(s => s.includes('Original message: hello my friends')));
});

test('hooks: outgoing failure still sends the message untranslated', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', sendMode: true, sendLang: 'fr' });
  handler = async () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); };
  const ev = { target: 'Bob', message: '<FONT>hello my friends</FONT>' };
  assert.strictEqual(fire('C_WHISPER', ev), false);
  await wait(40);
  assert.strictEqual(mod.sent.length, 1);
  assert.deepStrictEqual(mod.sent[0].ev, ev);
});

test('hooks: an exception inside the handler passes the packet through', () => {
  reset();
  const { mod, app, fire } = boot({ deeplKey: 'k:fx' });
  app.translator.peek = () => { throw new Error('bug'); };
  assert.strictEqual(fire('S_CHAT', chat('Привет всем')), undefined);
  assert.strictEqual(mod.sent.length, 0);
});

test('hooks: invalid config.json values are repaired at startup', () => {
  const { app } = boot({ targetLang: 'klingon', holdTimeoutMs: 1 });
  assert.strictEqual(app.cfg.targetLang, 'en');
  assert.strictEqual(app.cfg.holdTimeoutMs, 4000);
});

test('hooks: NA client transliteration only touches plain text', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  mod.publisher = 'eme';
  handler = async () => deeplOk('Привет мир <3', 'ES');
  fire('S_CHAT', chat('hola a todos'));
  await wait(30);
  assert.ok(mod.sent[0].ev.message.includes('Privet mir &lt;3'), mod.sent[0].ev.message);
});

test('a flaky Google request is retried once and never pauses the provider', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: '' });
  let n = 0;
  handler = async () => {
    n++;
    if (n === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return googleOk('hello', 'ru');
  };
  const e = await tr.translate('привет', 'auto', 'en');
  assert.strictEqual(e.provider, 'google');
  assert.strictEqual(n, 2);
  assert.strictEqual(tr.providers.google.cooldownUntil, 0);
  assert.strictEqual(tr.stats.retries, 1);
});

test('when every provider is paused the least penalised one is still probed', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: '' });
  handler = async () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); };
  for (let i = 0; i < 3; i++) await tr.translate('текст ' + i, 'auto', 'en');
  assert.ok(tr.providers.google.cooldownUntil > Date.now());
  handler = async () => googleOk('recovered', 'ru');
  await wait(1100);
  const e = await tr.translate('новый текст', 'auto', 'en');
  assert.strictEqual(e.text, 'recovered');
  assert.strictEqual(tr.stats.probes, 1);
  assert.strictEqual(tr.providers.google.cooldownUntil, 0);
});

test('a slow provider is hedged with the next one', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: 'k:fx', hedgeMs: 100 });
  handler = async (u) => {
    if (isDeepl(u)) { await wait(800); return deeplOk('slow', 'RU'); }
    await wait(20);
    return googleOk('quick', 'ru');
  };
  const t0 = Date.now();
  const e = await tr.translate('привет мир', 'auto', 'en');
  assert.strictEqual(e.provider, 'google');
  assert.ok(Date.now() - t0 < 500);
  await wait(800);
});

test('a hanging request is doubled on a fresh connection when no other provider exists', async () => {
  reset();
  const { tr } = makeEngine({ deeplKey: '', hedgeMs: 100 });
  let n = 0;
  handler = async () => {
    n++;
    if (n === 1) { await wait(900); return googleOk('slow', 'ru'); }
    await wait(10);
    return googleOk('fast', 'ru');
  };
  const t0 = Date.now();
  const e = await tr.translate('привет мир', 'auto', 'en');
  assert.strictEqual(e.text, 'fast');
  assert.ok(Date.now() - t0 < 500);
  assert.strictEqual(n, 2);
  await wait(900);
  assert.strictEqual(tr.providers.google.stats.fail, 0);
});

test('hooks: languages in skipLangs are left untouched, others translated', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', targetLang: 'de' });
  handler = async (u, o, c) => (JSON.parse(c.body).text[0].includes('bonjour') ? deeplOk('Hallo', 'FR') : deeplOk('Hallo', 'RU'));
  const fr = chat('bonjour amis');
  assert.strictEqual(fire('S_CHAT', fr), false);
  fire('S_CHAT', chat('привет друзья'));
  await wait(60);
  assert.strictEqual(mod.sent.length, 2);
  assert.strictEqual(mod.sent[0].ev.message, fr.message);
  assert.ok(mod.sent[1].ev.message.includes('Hallo'));
});

test('hooks: skipLangs never blocks outgoing translation', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', sendMode: true, sendLang: 'en' });
  handler = async () => deeplOk('Hello my friends', 'FR');
  fire('C_CHAT', { channel: 1, message: '<FONT>bonjour amis</FONT>' });
  await wait(40);
  assert.strictEqual(mod.sent[0].ev.message, '<FONT>Hello my friends</FONT>');
});

test('hooks: strict local detection translates short or ambiguous text, skips clear French', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Crystals cheap', 'ES');
  assert.strictEqual(fire('S_CHAT', chat('salut tout le monde, qui veut faire le donjon ?')), undefined);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(fire('S_CHAT', chat('vendo cristales baratos')), false);
  await wait(40);
  assert.strictEqual(calls.length, 1);
  assert.ok(mod.sent[0].ev.message.includes('Crystals cheap'));
});

const COLORED = (text, color = '#FF00DC') => `<FONT color="${color}"><ChatLinkAction param="1#####0@0@name">${text}</ChatLinkAction>`;

test('ColoredChat messages: the wrapper is a text frame, real item links stay protected', () => {
  const p = msg.parse(COLORED('hola amigos'), null);
  assert.strictEqual(p.plain, 'hola amigos');
  assert.ok(p.letters >= 9);
  assert.ok(p.frame);
  assert.strictEqual(p.spans.length, 0);
  const item = msg.parse('<FONT><ChatLinkAction param="1#####5000@4000@name">&lt;Item&gt;</ChatLinkAction> gracias</FONT>', null);
  assert.strictEqual(item.frame, null);
  assert.strictEqual(item.spans.length, 1);
  const mixed = msg.parse('<FONT>hola <ChatLinkAction param="1#####0@0@name">amigos</ChatLinkAction></FONT>', null);
  assert.strictEqual(mixed.frame, null);
  const out = msg.renderOutbound(p, { text: 'Hello <friends>' });
  assert.strictEqual(out, COLORED('Hello &lt;friends&gt;'));
  const lead = msg.parse('<FONT COLOR="#123456">hola amigos</FONT>', null);
  assert.strictEqual(msg.renderOutbound(lead, { text: 'hello friends' }), '<FONT COLOR="#123456">hello friends</FONT>');
  const single = msg.parse(`<FONT color="#FF00DC"><ChatLinkAction param='1#####0@0@name'>hola</ChatLinkAction>`, null);
  assert.ok(single.frame);
});

test('hooks: outgoing ColoredChat message is translated and keeps its colour frame', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', sendMode: true, sendLang: 'en' });
  handler = async () => deeplOk('Hello my friends', 'ES');
  const ev = { channel: 1, message: COLORED('hola mis amigos') };
  assert.strictEqual(fire('C_CHAT', ev), false);
  await wait(40);
  assert.strictEqual(mod.sent.length, 1);
  assert.strictEqual(mod.sent[0].ev.message, COLORED('Hello my friends'));
  assert.strictEqual(mod.sent[0].ev.channel, 1);
  assert.ok(mod.said.some(s => s.includes('Original message: hola mis amigos')));
});

test('hooks: incoming ColoredChat message is translated on the same line', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Hello everyone', 'RU');
  const ev = chat('x');
  ev.message = COLORED('Привет всем', '#56B4E9');
  assert.strictEqual(fire('S_CHAT', ev), false);
  await wait(40);
  assert.strictEqual(mod.sent.length, 1);
  const m = mod.sent[0].ev.message;
  assert.ok(m.startsWith(COLORED('Привет всем', '#56B4E9')));
  assert.ok(m.includes('[RU] Hello everyone'));
  assert.strictEqual(JSON.parse(calls[0].body).text[0], 'Привет всем');
});

const LFG = (messages, extra) => ({
  pageCurrent: 0,
  pageCount: 0,
  listings: messages.map((message, i) => Object.assign({ leaderId: 100 + i, isRaid: 0, playerCount: 1, message, leader: 'Leader' + i }, extra)),
});

test('plain text mode keeps raw characters, urls and glossary terms', () => {
  const g = new Glossary(root, silentLog);
  const p = msg.parsePlain('купи healer & <3 www.example.com', g);
  assert.ok(p.letters >= 4);
  assert.strictEqual(msg.toPlain(p.text, p.spans), 'купи healer & <3 www.example.com');
  assert.strictEqual(msg.parsePlain('wtb healer', g).letters, 0);
});

test('hooks: party finder listings are translated in place, other fields kept', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async (u, o, c) => {
    const t = JSON.parse(c.body).text[0];
    return t.includes('Привет') ? deeplOk('Hello all & <3', 'RU') : deeplOk('Hello', 'FR');
  };
  const ev = LFG(['Привет всем & <3', 'Bonjour de la france', 'cAndies x3']);
  assert.strictEqual(fire('S_SHOW_PARTY_MATCH_INFO', ev), false);
  assert.strictEqual(mod.sent.length, 0);
  await wait(60);
  assert.strictEqual(mod.sent.length, 1);
  const out = mod.sent[0].ev;
  assert.strictEqual(mod.sent[0].name, 'S_SHOW_PARTY_MATCH_INFO');
  assert.strictEqual(out.listings[0].message, 'Привет всем & <3 | [RU] Hello all & <3');
  assert.strictEqual(out.listings[1].message, 'Bonjour de la france');
  assert.strictEqual(out.listings[0].leaderId, 100);
  assert.strictEqual(out.listings[0].leader, 'Leader0');
  assert.strictEqual(out.pageCount, 0);
  assert.strictEqual(out.listings.length, 3);
});

test('hooks: a cached party finder list is modified in place without delay', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Hello all', 'RU');
  fire('S_SHOW_PARTY_MATCH_INFO', LFG(['Привет всем']));
  await wait(40);
  const ev = LFG(['Привет всем', 'x3']);
  assert.strictEqual(fire('S_SHOW_PARTY_MATCH_INFO', ev), true);
  assert.strictEqual(ev.listings[0].message, 'Привет всем | [RU] Hello all');
  assert.strictEqual(ev.listings[1].message, 'x3');
  assert.strictEqual(mod.sent.length, 1);
});

test('hooks: your own listing, nothing-to-translate lists and disabled option pass through', async () => {
  reset();
  const { mod, app, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Hello', 'RU');
  assert.strictEqual(fire('S_SHOW_PARTY_MATCH_INFO', LFG(['Привет всем'], { leader: 'Me' })), undefined);
  assert.strictEqual(fire('S_SHOW_PARTY_MATCH_INFO', LFG(['x3', 'wtb healer'])), undefined);
  assert.strictEqual(fire('S_SHOW_PARTY_MATCH_INFO', { listings: [] }), undefined);
  app.cfg.partyMatch = false;
  assert.strictEqual(fire('S_SHOW_PARTY_MATCH_INFO', LFG(['Привет всем'])), undefined);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(mod.sent.length, 0);
});

test('hooks: a failing provider delivers the party finder list unchanged', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => { throw Object.assign(new Error('down'), { code: 'ECONNRESET' }); };
  const ev = LFG(['Привет всем']);
  assert.strictEqual(fire('S_SHOW_PARTY_MATCH_INFO', ev), false);
  await wait(60);
  assert.strictEqual(mod.sent.length, 1);
  assert.strictEqual(mod.sent[0].ev.listings[0].message, 'Привет всем');
});

test('hooks: S_PARTY_MATCH_LINK message is translated', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Hello all', 'RU');
  const ev = { id: 5, unk: 0, raid: 0, unk2: 65, name: 'Bob', message: 'Привет всем' };
  assert.strictEqual(fire('S_PARTY_MATCH_LINK', ev), false);
  await wait(40);
  assert.strictEqual(mod.sent.length, 1);
  assert.strictEqual(mod.sent[0].name, 'S_PARTY_MATCH_LINK');
  assert.strictEqual(mod.sent[0].ev.message, 'Привет всем | [RU] Hello all');
  assert.strictEqual(mod.sent[0].ev.name, 'Bob');
  assert.strictEqual(mod.sent[0].ev.unk2, 65);
  const again = Object.assign({}, ev);
  assert.strictEqual(fire('S_PARTY_MATCH_LINK', again), true);
  assert.strictEqual(again.message, 'Привет всем | [RU] Hello all');
});

test('commands: lfg toggles the party finder translation', () => {
  const { mod, app } = boot({ deeplKey: '' });
  const c = mod.cmds.translate;
  c.lfg(); assert.strictEqual(app.cfg.partyMatch, false);
  c.lfg('on'); assert.strictEqual(app.cfg.partyMatch, true);
  c.lfg('maybe'); assert.strictEqual(app.cfg.partyMatch, true);
});

test('hooks: a translation arriving after the hold timeout is shown as an extra line', async () => {
  reset();
  const { mod, fire } = boot({ deeplKey: 'k:fx', holdTimeoutMs: 200 });
  handler = async () => { await wait(350); return deeplOk('Late hello', 'RU'); };
  const ev = chat('Привет всем');
  fire('S_CHAT', ev);
  await wait(500);
  assert.strictEqual(mod.sent.length, 2);
  assert.strictEqual(mod.sent[0].ev.message, ev.message);
  assert.ok(mod.sent[1].ev.message.includes('(Translated) [RU] Late hello'));
});

test('commands: why lists outcomes, skip and unskip edit the list', async () => {
  reset();
  const { mod, app, fire } = boot({ deeplKey: 'k:fx' });
  handler = async () => deeplOk('Hello', 'RU');
  fire('S_CHAT', chat('Привет'));
  fire('S_CHAT', chat('wtb healer'));
  await wait(40);
  const c = mod.cmds.translate;
  c.why();
  assert.ok(mod.said.some(s => /translated 1/.test(s) && /nothing to translate 1/.test(s)));
  c.skip('es', 'de');
  assert.deepStrictEqual(app.cfg.skipLangs, ['en', 'fr', 'es', 'de']);
  c.unskip('fr');
  assert.deepStrictEqual(app.cfg.skipLangs, ['en', 'es', 'de']);
  c.skip('klingon');
  assert.deepStrictEqual(app.cfg.skipLangs, ['en', 'es', 'de']);
  c.skip('none');
  assert.deepStrictEqual(app.cfg.skipLangs, []);
});

test('commands: settings, validation, keys are masked, status/test/usage work', async () => {
  reset();
  const { mod, app } = boot({ deeplKey: '' });
  const c = mod.cmds.translate;
  const last = () => mod.said[mod.said.length - 1];

  c.$none(); assert.strictEqual(app.cfg.enabled, false); c.$default(); assert.strictEqual(app.cfg.enabled, true);
  c.target('fr'); assert.strictEqual(app.cfg.targetLang, 'fr');
  c.target('auto'); assert.ok(/Error/.test(last()));
  c.source('auto'); assert.strictEqual(app.cfg.sourceLang, 'auto');
  c.send('de'); assert.strictEqual(app.cfg.sendMode, true); assert.strictEqual(app.cfg.sendLang, 'de');
  c.send('off'); assert.strictEqual(app.cfg.sendMode, false);
  c.mode('replace'); assert.strictEqual(app.cfg.displayMode, 'replace');
  c.mode('nope'); assert.ok(/Error/.test(last()));
  c.set('holdTimeoutMs', '4000'); assert.strictEqual(app.cfg.holdTimeoutMs, 4000);
  c.set('holdTimeoutMs', '1'); assert.strictEqual(app.cfg.holdTimeoutMs, 4000);
  c.set('bogus', '1'); assert.ok(/Unknown setting/.test(last()));
  c.ignore('4'); assert.deepStrictEqual(app.cfg.ignoreChannels, [4]);
  c.unignore('4'); assert.deepStrictEqual(app.cfg.ignoreChannels, []);
  c.providers('google', 'deepl'); assert.deepStrictEqual(app.cfg.providers, ['google', 'deepl']);
  c.providers('google', 'deepl');
  c.providers('deepl', 'google');

  handler = async (u) => (isDeepl(u) ? { status: 200, headers: {}, body: '{"character_count":1234,"character_limit":500000}' } : googleOk('ok'));
  mod.said.length = 0;
  c.key('0123456789abcdef0123:fx');
  assert.strictEqual(app.cfg.deeplKey, '0123456789abcdef0123:fx');
  assert.ok(mod.said.every(s => !s.includes('0123456789abcdef')), 'the key is never echoed in full');
  await wait(30);
  assert.ok(mod.said.some(s => /DeepL key OK.*1,234/.test(s)));
  c.key('has space'); assert.ok(/Error/.test(last()));

  handler = async () => deeplOk('Bonjour', 'EN');
  c.test('deepl', 'hello'); await wait(30);
  assert.ok(/\[deepl .*\] EN -> fr: Bonjour/.test(last()));

  mod.said.length = 0; c.status();
  assert.ok(mod.said.length >= 4 && mod.said[0].includes('ON'));
  c.config(); assert.ok(mod.said.some(s => s.includes('deeplKey=***')));
  c.key('none'); assert.strictEqual(app.cfg.deeplKey, '');
  c.log('debug'); assert.strictEqual(app.cfg.logLevel, 'debug');
  c.log('bogus'); assert.ok(/Usage/.test(last()));
  c.reset(); c.cache('clear'); c.errors(); c.help(); c.glossary();
});

test('release: versions agree, manifest is up to date, no CRLF', () => {
  const mj = require('../module.json');
  const pj = require('../package.json');
  assert.strictEqual(pj.version.replace(/\.0$/, ''), mj.version);
  const tools = require('../tools/manifest');
  const { manifest, problems } = tools.build();
  assert.deepStrictEqual(problems, []);
  const onDisk = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  assert.strictEqual(onDisk, tools.render(manifest), 'run "npm run manifest"');
  const keys = Object.keys(manifest.files);
  for (const f of ['module.json', 'package.json', 'src/index.js', 'src/setting_migration.js']) assert.ok(keys.includes(f), f);
});

test('release: source files contain no comments', () => {
  const dirs = ['src', 'test', 'tools'];
  const offenders = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(root, d, f), 'utf8');
      if (/^\s*\/\/|\s\/\/\s|\/\*\s/m.test(src)) offenders.push(`${d}/${f}`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok   ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${t.name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`);
    }
  }
  cleanup();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
