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
const VERSION = '3.0';

module.exports = class TranslateChat {
  constructor(mod) {
    this.mod = mod;
    this.rootDir = path.join(__dirname, '..');
    this.version = VERSION;
    this.saveTimer = null;

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

    this.log.info(`v${VERSION} ready: ${this.cfg.enabled ? 'enabled' : 'disabled'}, target=${this.cfg.targetLang}, providers=${this.cfg.providers.join('>')}, glossary=${this.glossary.size} terms`);
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
    } catch (e) { /* not logged in yet */ }
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
    const pass = () => (separate ? undefined : this.passthrough(seq, packet, version, event));

    if (!cfg.translateOwn && this.isOwn(event)) return pass();
    if (event.channel !== undefined && cfg.ignoreChannels.includes(event.channel)) return pass();

    const source = cfg.sourceLang;
    const target = cfg.targetLang;
    if (source !== 'auto' && L.baseLang(source) === L.baseLang(target)) return pass();

    const parsed = msg.parse(event.message, cfg.useGlossary ? this.glossary : null);
    if (parsed.letters < cfg.minLetters || parsed.text.length > cfg.maxLength) return pass();

    const tr = this.translator;
    const cached = tr.peek(parsed.text, source, target);
    if (cached === undefined && tr.localSame(parsed.plain, target)) return pass();

    const transform = this.transform();

    if (separate) {
      const show = e => {
        if (e && !e.same) this.send(packet, version, Object.assign({}, event, { message: msg.renderSeparate(parsed, e, cfg, transform) }));
      };
      if (cached !== undefined) show(cached);
      else tr.translate(parsed.text, source, target, { deadline: Date.now() + cfg.holdTimeoutMs }).then(show).catch(e => this.log.error('separate display failed', e));
      return undefined;
    }

    const render = e => (e && !e.same ? msg.renderInbound(event.message, parsed, e, cfg, transform) : null);
    const deliver = e => {
      const m = render(e);
      this.send(packet, version, m === null ? event : Object.assign({}, event, { message: m }));
    };

    if (cached !== undefined) {
      if (seq.pending === 0) {
        const m = render(cached);
        if (m === null) return undefined;
        event.message = m;
        return true;
      }
      seq.add(cached, 0, deliver);
      return false;
    }

    const promise = tr.translate(parsed.text, source, target, { deadline: Date.now() + cfg.holdTimeoutMs });
    seq.add(promise, cfg.holdTimeoutMs, (e, timedOut) => {
      if (timedOut) this.log.debug(`translation timed out after ${cfg.holdTimeoutMs}ms, original message delivered`);
      deliver(e);
    });
    return false;
  }

  onOutgoing(packet, version, event) {
    const cfg = this.cfg;
    if (!cfg.enabled || !cfg.sendMode || typeof event.message !== 'string' || !event.message) return undefined;

    const seq = this.outbound;
    const pass = () => this.passthrough(seq, packet, version, event);
    const target = cfg.sendLang;

    const parsed = msg.parse(event.message, cfg.useGlossary ? this.glossary : null);
    if (parsed.letters < cfg.minLetters || parsed.text.length > cfg.maxLength) return pass();

    const tr = this.translator;
    const cached = tr.peek(parsed.text, 'auto', target);
    if (cached === undefined && tr.localSame(parsed.plain, target)) return pass();

    const deliver = e => {
      if (e && !e.same) {
        this.send(packet, version, Object.assign({}, event, { message: msg.renderOutbound(parsed, e) }));
        if (cfg.echoOriginal) this.say(`Original message: ${parsed.plain}`);
      } else {
        this.send(packet, version, event);
      }
    };

    if (cached !== undefined) {
      if (seq.pending === 0 && (!cached || cached.same)) return undefined;
      seq.add(cached, 0, deliver);
      return false;
    }

    const promise = tr.translate(parsed.text, 'auto', target, { deadline: Date.now() + cfg.holdTimeoutMs });
    seq.add(promise, cfg.holdTimeoutMs, (e, timedOut) => {
      if (timedOut) this.log.warn(`outgoing translation timed out after ${cfg.holdTimeoutMs}ms, message sent untranslated`);
      deliver(e);
    });
    return false;
  }
};
