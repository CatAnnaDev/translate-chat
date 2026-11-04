'use strict';

const config = require('./config');
const L = require('./lang');
const { LEVELS } = require('./logger');

const PROVIDER_NAMES = ['deepl', 'google'];

function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

module.exports = function registerCommands(app) {
  const { mod, cfg, log, translator, glossary } = app;
  const say = text => app.say(text);
  const lines = arr => arr.forEach(l => say(l));
  const onOff = v => (v ? 'on' : 'off');

  function apply(key, parsed, label) {
    if (!parsed.ok) { say(`Error: ${parsed.error}`); return false; }
    cfg[key] = parsed.value;
    say(`${label || key} set to: ${config.describe(key, parsed.value)}`);
    return true;
  }

  function setEnabled(value) {
    cfg.enabled = value;
    say(`Module ${value ? 'enabled' : 'disabled'}`);
  }

  function showStatus() {
    const s = translator.status();
    const stats = s.stats;
    const head = `translate v${app.version} [${cfg.enabled ? 'ON' : 'OFF'}] ${cfg.sourceLang} -> ${cfg.targetLang}`
      + ` | send: ${cfg.sendMode ? cfg.sendLang : 'off'} | display: ${cfg.displayMode} | tag: ${onOff(cfg.showTag)} | glossary: ${cfg.useGlossary ? glossary.size + ' terms' : 'off'}`;
    const out = [head];
    for (const p of s.providers) {
      const perf = p.ok || p.fail ? ` - ${p.ok} ok / ${p.fail} failed${p.avgMs ? `, ~${p.avgMs} ms` : ''}` : '';
      out.push(`${p.label}: ${p.state}${perf}`);
      if (p.lastError) out.push(`   last error: ${p.lastError}`);
    }
    out.push(`Cache ${s.cache.size}/${s.cache.max} (${s.cache.hitRate}% hits) | in flight ${s.inflight}, queued ${s.limiter.queued}`
      + ` | held in: ${app.inbound.pending}, out: ${app.outbound.pending}`);
    out.push(`Translated ${stats.translated}, same language ${stats.sameLanguage}, local skips ${stats.localSkips}, failed ${stats.failed}, dropped ${stats.dropped}`
      + `${s.detector ? '' : ' | local detector unavailable'}`);
    lines(out);
  }

  function showConfig() {
    const keys = Object.keys(config.SCHEMA);
    const out = ['Settings (use "translate set <name> <value>"):'];
    let row = [];
    for (const k of keys) {
      row.push(`${k}=${config.describe(k, cfg[k])}`);
      if (row.length === 3) { out.push(row.join(' | ')); row = []; }
    }
    if (row.length) out.push(row.join(' | '));
    lines(out);
  }

  function showHelp() {
    lines([
      'translate - toggle on/off | on | off | status | config | help',
      'translate source <lang|auto> | target <lang> | send [lang|on|off] | mode <inline|replace|separate>',
      'translate tag [on|off] | color <#rrggbb|off> | providers <deepl google> | ignore [channel] | unignore <channel>',
      'translate key <deepl-key|none> | gkey <google-key|none> | usage | test [deepl|google] <text>',
      'translate glossary (reload) | cache [clear] | reset | errors [n] | log <error|warn|info|debug|file on|off>',
      'translate set <name> <value> | get <name>   (see "translate config")',
    ]);
  }

  function verifyDeepl() {
    translator.deeplUsage().then(u => {
      const pct = u.limit ? ` (${Math.round(100 * u.used / u.limit)}%)` : '';
      say(`DeepL key OK. Usage: ${Number(u.used).toLocaleString('en-US')} / ${Number(u.limit).toLocaleString('en-US')} characters${pct}`);
    }).catch(e => {
      say(`DeepL check failed: ${e.message}${e.kind === 'auth' ? ' - the key looks invalid' : ''}`);
      log.warn('DeepL key check failed', e);
    });
  }

  const commands = {
    $none() { setEnabled(!cfg.enabled); },
    $default(...args) {
      if (!args.length) return setEnabled(!cfg.enabled);
      say(`Unknown option "${args[0]}". Type "translate help".`);
    },

    on() { setEnabled(true); },
    off() { setEnabled(false); },
    status() { showStatus(); },
    config() { showConfig(); },
    help() { showHelp(); },

    source(language) {
      if (!language) return say(`Source language: ${cfg.sourceLang}`);
      apply('sourceLang', config.validate('sourceLang', language), 'Source language');
    },

    target(language) {
      if (!language) return say(`Target language: ${cfg.targetLang}`);
      apply('targetLang', config.validate('targetLang', language), 'Target language');
    },

    send(arg) {
      if (arg === undefined) {
        cfg.sendMode = !cfg.sendMode;
        return say(`Send mode: ${cfg.sendMode ? `enabled, outgoing messages are translated to ${cfg.sendLang}` : 'disabled'}`);
      }
      const a = String(arg).toLowerCase();
      if (a === 'off') { cfg.sendMode = false; return say('Send mode disabled.'); }
      if (a === 'on') { cfg.sendMode = true; return say(`Send mode enabled. Outgoing messages are translated to ${cfg.sendLang}.`); }
      const r = config.validate('sendLang', arg);
      if (!r.ok) return say(`Error: ${r.error}`);
      cfg.sendLang = r.value;
      cfg.sendMode = true;
      say(`Now translating outgoing messages to: ${r.value}`);
    },

    mode(m) {
      if (!m) return say(`Display mode: ${cfg.displayMode} (inline, replace, separate)`);
      apply('displayMode', config.parseValue('displayMode', [m]), 'Display mode');
    },

    tag(v) {
      if (v === undefined) { cfg.showTag = !cfg.showTag; return say(`Detected-language tag ${cfg.showTag ? 'shown' : 'hidden'}.`); }
      apply('showTag', config.parseValue('showTag', [v]), 'Language tag');
    },

    color(c) {
      if (!c) return say(`Translation colour: ${config.describe('color', cfg.color)}`);
      apply('color', config.parseValue('color', [c]), 'Colour');
    },

    providers(...names) {
      if (!names.length) return say(`Provider order: ${cfg.providers.join(' > ')}`);
      apply('providers', config.parseValue('providers', names), 'Provider order');
    },

    key(k) {
      if (!k) {
        return say(cfg.deeplKey
          ? `A DeepL key is set (${config.mask(cfg.deeplKey)}). Use "translate key none" to remove it.`
          : 'No DeepL key set. Use "translate key <your-key>" (free keys end with :fx); Google is used otherwise.');
      }
      const r = config.parseValue('deeplKey', [k]);
      if (!r.ok) return say(`Error: ${r.error}`);
      cfg.deeplKey = r.value;
      if (!r.value) return say('DeepL key removed. Using Google.');
      say(`DeepL key saved (${config.mask(r.value)}); checking it...`);
      verifyDeepl();
    },

    gkey(k) {
      if (!k) {
        return say(cfg.googleKey
          ? `A Google Cloud key is set (${config.mask(cfg.googleKey)}). Use "translate gkey none" to remove it.`
          : 'No Google Cloud key set: the free Google endpoint is used. Use "translate gkey <key>" for the official API.');
      }
      const r = config.parseValue('googleKey', [k]);
      if (!r.ok) return say(`Error: ${r.error}`);
      cfg.googleKey = r.value;
      say(r.value ? `Google Cloud key saved (${config.mask(r.value)}).` : 'Google Cloud key removed. Using the free endpoint.');
    },

    usage() {
      if (!cfg.deeplKey) return say('No DeepL key set, nothing to check.');
      verifyDeepl();
    },

    glossary() {
      const n = glossary.reload();
      translator.clearCache();
      say(`Glossary reloaded: ${n} terms from ${glossary.file}`);
    },

    cache(action) {
      if (action === 'clear') { translator.clearCache(); return say('Translation cache cleared.'); }
      const s = translator.status();
      say(`Cache: ${s.cache.size}/${s.cache.max} entries, ${s.cache.hitRate}% hit rate. "translate cache clear" empties it.`);
    },

    reset() {
      translator.resetProviders();
      translator.resetStats();
      say('Providers re-enabled and statistics reset.');
    },

    errors(n) {
      const count = Math.max(1, Math.min(20, parseInt(n, 10) || 8));
      const items = log.recent(count);
      if (!items.length) return say('No warnings or errors recorded since the proxy started.');
      lines(items.map(i => `${fmtAge(Date.now() - i.t)} [${i.level}] ${i.line}`));
    },

    log(a, b) {
      if (!a) return say(`Log level: ${cfg.logLevel} | file: ${onOff(cfg.logFile)} (${log.file})`);
      if (a === 'file') {
        const r = config.parseValue('logFile', [b || '']);
        if (!r.ok) return say(`Error: ${r.error}`);
        cfg.logFile = r.value;
        log.fileDisabled = false;
        log.fileFailures = 0;
        return say(`Log file ${onOff(r.value)}.`);
      }
      if (LEVELS[a] === undefined) return say('Usage: translate log <error|warn|info|debug> | translate log file <on|off>');
      cfg.logLevel = a;
      say(`Log level set to ${a}.`);
    },

    ignore(ch) {
      if (ch === undefined) return say(`Ignored channels: ${config.describe('ignoreChannels', cfg.ignoreChannels)}`);
      const n = Number(ch);
      const r = config.validate('ignoreChannels', cfg.ignoreChannels.concat([n]));
      if (!r.ok) return say(`Error: ${r.error}`);
      cfg.ignoreChannels = r.value;
      say(`Channel ${n} is no longer translated.`);
    },

    unignore(ch) {
      const n = Number(ch);
      if (!Number.isInteger(n)) return say('Usage: translate unignore <channel number>');
      cfg.ignoreChannels = cfg.ignoreChannels.filter(c => c !== n);
      say(`Channel ${n} is translated again.`);
    },

    set(name, ...value) {
      if (!name) return showConfig();
      if (!config.SCHEMA[name]) return say(`Unknown setting "${name}". Type "translate config" for the list.`);
      if (!value.length) return say(`${name}=${config.describe(name, cfg[name])} - ${config.SCHEMA[name].desc}`);
      apply(name, config.parseValue(name, value));
    },

    get(name) {
      if (!name || !config.SCHEMA[name]) return say('Usage: translate get <setting> (see "translate config")');
      say(`${name}=${config.describe(name, cfg[name])} - ${config.SCHEMA[name].desc}`);
    },

    test(...words) {
      let provider = null;
      if (words.length > 1 && PROVIDER_NAMES.includes(String(words[0]).toLowerCase())) provider = String(words.shift()).toLowerCase();
      const text = words.join(' ').trim();
      if (!text) return say('Usage: translate test [deepl|google] <text>');

      const run = provider
        ? translator.test(provider, text, cfg.sourceLang, cfg.targetLang).then(r => ({ r, name: provider }))
        : translator.translate(text, cfg.sourceLang, cfg.targetLang, { deadline: Date.now() + 6000 }).then(e => {
          if (!e) throw new Error('no provider could translate this (see "translate status")');
          return { r: { text: e.text, detected: e.detected, ms: e.ms }, name: e.provider };
        });
      run.then(({ r, name }) => {
        const src = r.detected ? L.baseLang(r.detected).toUpperCase() : '?';
        say(`[${name}${typeof r.ms === 'number' ? ` ${r.ms}ms` : ''}] ${src} -> ${cfg.targetLang}: ${r.text}`);
      }).catch(e => say(`Test failed: ${e.message}`));
    },
  };

  mod.command.add('translate', commands, app);
};
