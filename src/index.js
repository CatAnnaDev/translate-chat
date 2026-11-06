'use strict';

const path = require('path');
const { DEFAULTS } = require('./defaults');
const config = require('./config');
const L = require('./lang');
const msg = require('./message');
const { normalize } = require('./normalize');
const { Logger } = require('./logger');
const { Glossary } = require('./glossary');
const { Translator } = require('./translate');
const { Notifier } = require('./notifier');
const { OrderedRelease } = require('./ordered');
const registerCommands = require('./commands');

const INCOMING = ['S_CHAT', 'S_WHISPER', 'S_PRIVATE_CHAT'];
const OUTGOING = ['C_CHAT', 'C_WHISPER'];
const VERSION = require('../module.json').version;
const JOURNAL_SIZE = 40;

module.exports = class TranslateChat {
  constructor(mod) {
    this.mod = mod;
    this.rootDir = path.join(__dirname, '..');
    this.version = VERSION;
    this.saveTimer = null;
    this.reasons = {};
    this.journal = [];

    const self = this;
    this.cfg = new Proxy({}, {
      get(_, key) {
        const v = mod.settings[key];
        return v === undefined ? DEFAULTS[key] : v;
      },
      set(_, key, value) {
        mod.settings[key] = value;
        self.scheduleSave();
        return true;
      },
    });

    this.log = new Logger({
      mod,
      getLevel: () => this.cfg.logLevel,
      fileEnabled: () => this.cfg.logFile,
      dir: this.rootDir,
      secrets: () => [this.cfg.deeplKey, this.cfg.googleKey],
    });

    const repaired = config.sanitize(mod.settings);
    if (repaired.length) {
      this.log.warn(`invalid settings reset to defaults: ${repaired.join(', ')}`);
      this.scheduleSave();
    }

    this.glossary = new Glossary(this.rootDir, this.log);
    this.notifier = new Notifier({ mod, cfg: this.cfg, log: this.log });
    this.translator = new Translator({ cfg: this.cfg, log: this.log, notifier: this.notifier });

    const onError = e => this.log.error('error while delivering a message', e);
    const timers = { setTimer: (fn, ms) => mod.setTimeout(fn, ms), clearTimer: t => mod.clearTimeout(t), onError };
    this.inbound = new OrderedRelease(timers);
    this.outbound = new OrderedRelease(timers);

    registerCommands(this);
    this.setupHooks();

    mod.game.on('leave_loading_screen', () => {
      this.notifier.flushBacklog();
      if (this.cfg.sendMode) {
        this.say(`Send mode enabled. Translating outgoing messages to ${this.cfg.sendLang}.`);
        this.say('Use "/8 translate send off" to disable it.');
      }
    });

    this.log.info(`v${VERSION} ready: ${this.cfg.enabled ? 'enabled' : 'disabled'}, target=${this.cfg.targetLang}, skip=${this.cfg.skipLangs.join(',') || 'none'}, providers=${this.cfg.providers.join('>')}, glossary=${this.glossary.size} terms`);
    if (!this.cfg.deeplKey) this.log.info('no DeepL key set: Google is used (get a free key at deepl.com, then "translate key <key>")');

    this.destructor = () => {
      this.inbound.clear();
      this.outbound.clear();
      this.log.destroy();
    };
  }

  say(text) {
    try { this.mod.command.message(text); } catch (e) { this.log.debug('command.message failed', e); }
  }

  note(reason, html, detail) {
    this.reasons[reason] = (this.reasons[reason] || 0) + 1;
    const text = String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    this.journal.push({ t: Date.now(), reason, detail: detail || '', text });
    if (this.journal.length > JOURNAL_SIZE) this.journal.shift();
    this.log.debug(`${reason}${detail ? ` [${detail}]` : ''}: ${text}`);
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = this.mod.setTimeout(() => {
      this.saveTimer = null;
      try { this.mod.saveSettings(); } catch (e) { this.log.error('could not save settings', e); }
    }, 300);
  }

  send(packet, version, event) {
    try { this.mod.send(packet, version, event); } catch (e) { this.log.error(`failed to send ${packet}`, e); }
  }

  asciiOnly() {
    const v = this.cfg.asciiOnly;
    return v === 'on' || (v === 'auto' && this.mod.publisher === 'eme');
  }

  transform() {
    return this.asciiOnly() ? s => normalize(s).replace(/[^\x00-\x7F]/g, '') : null;
  }

  isOwn(event) {
    try {
      if (event.gameId !== undefined && this.mod.game.me.is(event.gameId)) return true;
    } catch (e) {}
    const name = event.name || event.author || event.authorName || event.player;
    const me = this.mod.game.me;
    return !!(name && me && me.name && name === me.name);
  }

  passthrough(seq, packet, version, event) {
    if (seq.pending === 0) return undefined;
    seq.add(null, 0, () => this.send(packet, version, event));
    return false;
  }

  setupHooks() {
    const opts = { order: 100, filter: { fake: false } };
    for (const packet of INCOMING) this.hookPacket(packet, opts, (event, version) => this.onIncoming(packet, version, event));
    for (const packet of OUTGOING) this.hookPacket(packet, opts, (event, version) => this.onOutgoing(packet, version, event));
  }

  hookPacket(packet, opts, handler) {
    const version = '*';
    try {
      this.mod.hook(packet, version, opts, event => {
        try {
          return handler(event, version);
        } catch (e) {
          this.log.error(`${packet} handler failed, message passed through unchanged`, e);
          return undefined;
        }
      });
    } catch (e) {
      this.log.error(`cannot hook ${packet} (not supported by this protocol map)`, e);
    }
  }

  onIncoming(packet, version, event) {
    const cfg = this.cfg;
    if (!cfg.enabled || typeof event.message !== 'string' || !event.message) return undefined;

    const separate = cfg.displayMode === 'separate';
    const seq = this.inbound;
    const pass = (reason, detail) => {
      this.note(reason, event.message, detail);
      return separate ? undefined : this.passthrough(seq, packet, version, event);
    };

    if (!cfg.translateOwn && this.isOwn(event)) return pass('own message');
    if (event.channel !== undefined && cfg.ignoreChannels.includes(event.channel)) return pass('ignored channel');

    const source = cfg.sourceLang;
    const target = cfg.targetLang;
    if (source !== 'auto' && L.baseLang(source) === L.baseLang(target)) return pass('source = target');

    const parsed = msg.parse(event.message, cfg.useGlossary ? this.glossary : null);
    if (parsed.letters < cfg.minLetters) return pass('nothing to translate');
    if (parsed.text.length > cfg.maxLength) return pass('too long');

    const tr = this.translator;
    const useSkip = source === 'auto';
    const cached = tr.peek(parsed.text, source, target);
    if (cached === undefined) {
      const lang = tr.localSkip(parsed.plain, target, useSkip);
      if (lang) return pass('skipped language (local)', lang);
    }

    const transform = this.transform();

    const decide = (e, timedOut, hit) => {
      if (!e) {
        this.note(timedOut ? 'timeout' : 'no provider answer', event.message);
        return null;
      }
      if (e.unchanged) {
        this.note('unchanged by provider', event.message, e.detected);
        return null;
      }
      if (tr.isSame(e, target, useSkip)) {
        this.note('skipped language (provider)', event.message, e.detected);
        return null;
      }
      this.note(hit ? 'translated (cache)' : 'translated', event.message, `${e.detected || '?'} via ${e.provider}`);
      return e;
    };

    const showSeparate = e => {
      this.send(packet, version, Object.assign({}, event, { message: msg.renderSeparate(parsed, e, cfg, transform) }));
    };

    if (separate) {
      const show = (e, hit) => {
        const d = decide(e, false, hit);
        if (d) showSeparate(d);
      };
      if (cached !== undefined) show(cached, true);
      else tr.translate(parsed.text, source, target, { deadline: Date.now() + cfg.holdTimeoutMs }).then(e => show(e, false)).catch(e => this.log.error('separate display failed', e));
      return undefined;
    }

    const deliver = (e, timedOut, hit) => {
      const d = decide(e, timedOut, hit);
      this.send(packet, version, d ? Object.assign({}, event, { message: msg.renderInbound(event.message, parsed, d, cfg, transform) }) : event);
    };

    if (cached !== undefined) {
      if (seq.pending === 0) {
        const d = decide(cached, false, true);
        if (!d) return undefined;
        event.message = msg.renderInbound(event.message, parsed, d, cfg, transform);
        return true;
      }
      seq.add(cached, 0, e => deliver(e, false, true));
      return false;
    }

    const promise = tr.translate(parsed.text, source, target, { deadline: Date.now() + cfg.holdTimeoutMs });
    const late = { timedOut: false, entry: undefined };
    const showLate = e => {
      if (!cfg.lateTranslation || !e || e.unchanged || tr.isSame(e, target, useSkip)) return;
      this.note('translated (late)', event.message, `${e.detected || '?'} via ${e.provider}`);
      showSeparate(e);
    };
    promise.then(e => {
      late.entry = e;
      if (late.timedOut) showLate(e);
    }).catch(() => {});
    seq.add(promise, cfg.holdTimeoutMs, (e, timedOut) => {
      if (timedOut) {
        late.timedOut = true;
        if (late.entry !== undefined) showLate(late.entry);
      }
      deliver(e, timedOut, false);
    });
    return false;
  }

  onOutgoing(packet, version, event) {
    const cfg = this.cfg;
    if (!cfg.enabled || !cfg.sendMode || typeof event.message !== 'string' || !event.message) return undefined;

    const seq = this.outbound;
    const pass = reason => {
      this.note(`out: ${reason}`, event.message);
      return this.passthrough(seq, packet, version, event);
    };
    const target = cfg.sendLang;

    const parsed = msg.parse(event.message, cfg.useGlossary ? this.glossary : null);
    if (parsed.letters < cfg.minLetters) return pass('nothing to translate');
    if (parsed.text.length > cfg.maxLength) return pass('too long');

    const tr = this.translator;
    const cached = tr.peek(parsed.text, 'auto', target);
    if (cached === undefined && tr.localSkip(parsed.plain, target, false)) return pass('already in target language');

    const deliver = (e, timedOut) => {
      if (e && !e.unchanged && !tr.isSame(e, target, false)) {
        this.note('out: translated', event.message, `${e.detected || '?'} via ${e.provider}`);
        this.send(packet, version, Object.assign({}, event, { message: msg.renderOutbound(parsed, e) }));
        if (cfg.echoOriginal) this.say(`Original message: ${parsed.plain}`);
      } else {
        this.note(e ? 'out: already in target language' : (timedOut ? 'out: timeout' : 'out: no provider answer'), event.message);
        this.send(packet, version, event);
      }
    };

    if (cached !== undefined) {
      if (seq.pending === 0 && (cached.unchanged || tr.isSame(cached, target, false))) {
        this.note('out: already in target language', event.message);
        return undefined;
      }
      seq.add(cached, 0, e => deliver(e, false));
      return false;
    }

    const promise = tr.translate(parsed.text, 'auto', target, { deadline: Date.now() + cfg.holdTimeoutMs });
    seq.add(promise, cfg.holdTimeoutMs, (e, timedOut) => {
      if (timedOut) this.log.warn(`outgoing translation timed out after ${cfg.holdTimeoutMs}ms, message sent untranslated`);
      deliver(e, timedOut);
    });
    return false;
  }
};
