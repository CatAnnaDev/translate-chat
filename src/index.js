const path = require('path');
const { translate, normalizeNa, AVAILABLE_LANGUAGES } = require('./translate');
const { loadTerms, buildMatcher, glossaryPath } = require('./glossary');

const CACHE_MAX = 2000;

module.exports = class Translator {
  constructor(mod) {
    this.mod = mod;
    this.rootDir = path.join(__dirname, '..');
    this.cache = new Map();
    this.reloadGlossary();
    this.addCommand();
    this.setupHooks();

    this.mod.game.on('leave_loading_screen', () => {
      if (mod.settings.sendMode) {
        this.mod.command.message(`Send Mode Enabled. Translating outgoing messages to ${this.mod.settings.sendLang}.`);
        this.mod.command.message('Use "/8 translate send off" to disable it.');
      }
    });
  }

  reloadGlossary() {
    this.glossaryMatcher = buildMatcher(loadTerms(this.rootDir));
  }

  cacheGet(key) {
    return this.cache.get(key);
  }

  cacheSet(key, value) {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, value);
  }

  setupHooks() {
    const incomingMsgHandler = async (packet, version, event) => {
      if (!this.mod.settings.enabled) return;
      if (this.mod.game.me.is(event.gameId)) return;

      const result = await this.translate(event.message, { target: this.mod.settings.targetLang, source: this.mod.settings.sourceLang });
      if (!result || !result.text) return;

      const tag = this.mod.settings.showTag && result.src ? `[${result.src.toUpperCase()}] ` : '';
      this.mod.send(packet, version, { ...event, message: `<FONT>(Translated) ${tag}${result.text}</FONT>` });
    };

    const outgoingMessageHandler = (packet, version, event) => {
      if (!this.mod.settings.enabled) return;
      if (!this.mod.settings.sendMode) return;

      (async () => {
        const result = await this.translate(event.message, { source: 'auto', target: this.mod.settings.sendLang });
        if (!result || !result.text) return this.mod.send(packet, version, event);

        this.mod.send(packet, version, { ...event, message: `<FONT>${result.text}</FONT>` });
        this.mod.command.message(`Original message: ${event.message.replace(/<(.+?)>|&rt;|&lt;|&gt;|/g, '').replace(/\s+$/, '')}`);
      })();

      return false;
    };

    const CHAT_SERVER_PACKETS = [['S_CHAT', '*'], ['S_WHISPER', '*'], ['S_PRIVATE_CHAT', '*']];
    for (const [packet, version] of CHAT_SERVER_PACKETS) this.mod.hook(packet, version, { order: 100 }, event => incomingMsgHandler(packet, version, event));
    const CHAT_CLIENT_PACKETS = [['C_WHISPER', '*'], ['C_CHAT', '*']];
    for (const [packet, version] of CHAT_CLIENT_PACKETS) this.mod.hook(packet, version, {}, event => outgoingMessageHandler(packet, version, event));
  }

  async translate(message, { target, source }) {
    const sanitized = message.replace(/<(.+?)>|&rt;|&lt;|&gt;|/g, '').replace(/\s+$/, '');
    if (sanitized === '') return;

    const cacheKey = `${target}|${sanitized}`;
    const cached = this.cacheGet(cacheKey);
    if (cached) return cached;

    const result = await translate(sanitized, target, source, {
      deeplKey: this.mod.settings.deeplKey,
      matcher: this.glossaryMatcher,
      useGlossary: this.mod.settings.useGlossary,
    }).catch(e => {
      this.mod.error(`Translation error, message:${message}, target:${target}, source:${source}, error:`, e);
      return undefined;
    });

    if (!result || !result.text) return;
    const text = this.mod.publisher === 'eme' ? normalizeNa(result.text) : result.text;
    if (text === sanitized) return;

    const out = { text, src: result.src };
    if (source !== 'auto' || target === this.mod.settings.targetLang) this.cacheSet(cacheKey, out);
    return out;
  }

  addCommand() {
    this.mod.command.add('translate', {
      $default: () => {
        this.mod.settings.enabled = !this.mod.settings.enabled;
        this.mod.command.message(`Module ${this.mod.settings.enabled ? 'enabled' : 'disabled'}`);
        this.mod.saveSettings();
      },
      key: apiKey => {
        if (!apiKey) {
          this.mod.command.message(this.mod.settings.deeplKey ? 'A DeepL key is set. Use "translate key none" to remove it.' : 'No DeepL key set. Use "translate key <your-key>" to add one (falls back to Google otherwise).');
          return;
        }
        this.mod.settings.deeplKey = apiKey === 'none' ? '' : apiKey;
        this.mod.command.message(this.mod.settings.deeplKey ? 'DeepL key saved. DeepL is now the primary translator.' : 'DeepL key removed. Using Google.');
        this.mod.saveSettings();
      },
      tag: () => {
        this.mod.settings.showTag = !this.mod.settings.showTag;
        this.mod.command.message(`Detected-language tag ${this.mod.settings.showTag ? 'shown' : 'hidden'}.`);
        this.mod.saveSettings();
      },
      glossary: () => {
        this.reloadGlossary();
        this.cache.clear();
        this.mod.command.message(`Glossary reloaded from ${glossaryPath(this.rootDir)}`);
      },
      source: language => {
        if (!language) {
          this.mod.command.message(`Source Language: ${this.mod.settings.sourceLang}.`);
          return;
        }
        if (!AVAILABLE_LANGUAGES.includes(language)) {
          this.mod.command.message(`Error: ${language} is not a valid language. See readme for available languages. Recommended: auto`);
          return;
        }
        this.mod.command.message(`Source Language set to: ${language}.`);
        this.mod.settings.sourceLang = language;
        this.cache.clear();
        this.mod.saveSettings();
      },
      target: language => {
        if (!language) {
          this.mod.command.message(`Target Language: ${this.mod.settings.targetLang}.`);
          return;
        }
        if (!AVAILABLE_LANGUAGES.includes(language)) {
          this.mod.command.message(`Error: ${language} is not a valid language. See readme for available languages.`);
          return;
        }
        if (language === 'auto') {
          this.mod.command.message('Error: Target Language cannot be auto.');
          return;
        }
        this.mod.command.message(`Target Language set to: ${language}.`);
        this.mod.settings.targetLang = language;
        this.cache.clear();
        this.mod.saveSettings();
      },
      send: language => {
        if (language === undefined) {
          this.mod.settings.sendMode = !this.mod.settings.sendMode;
          this.mod.command.message(`Send Mode: ${this.mod.settings.sendMode ? ('enabled. Language: ' + this.mod.settings.sendLang) : 'disabled.'}`);
        } else if (AVAILABLE_LANGUAGES.includes(language)) {
          this.mod.settings.sendMode = true;
          this.mod.settings.sendLang = language;
          this.mod.command.message(`Now translating outgoing messages to: ${language}`);
        } else if (language === 'off') {
          this.mod.settings.sendMode = false;
          this.mod.command.message('Send Mode Disabled.');
        } else if (language === 'on') {
          this.mod.settings.sendMode = true;
          this.mod.command.message(`Send Mode Enabled. Now translating outgoing messages to ${this.mod.settings.sendLang}.`);
        } else {
          this.mod.command.message(`Error: ${language} is not a valid language. See readme for available languages.`);
        }
        this.mod.saveSettings();
      },
    });
  }
};
