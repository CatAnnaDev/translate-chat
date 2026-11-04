'use strict';


const DEFAULTS = {
  enabled: true,
  sourceLang: 'auto',         // legacy
  targetLang: 'en',           // legacy
  sendMode: false,            // legacy: translate outgoing messages
  sendLang: 'en',             // legacy
  deeplKey: '',               // legacy: DeepL API key (":fx" suffix = API Free)
  useGlossary: true,          // legacy
  showTag: true,              // legacy: show detected language, e.g. [RU]

  googleKey: '',              // optional Google Cloud Translation (v2) key; empty = free endpoint
  providers: ['deepl', 'google'], // order of the fallback chain
  displayMode: 'inline',      // inline | replace | separate
  separator: ' | ',           // text between original and translation (inline mode)
  color: '#9be37c',           // colour of the translated text, '' = chat default
  translateOwn: false,        // also translate your own messages
  echoOriginal: true,         // print the original text in the system tab when sending a translation
  ignoreChannels: [],         // chat channel numbers that are never translated
  minLetters: 2,              // skip messages with fewer letters than this
  maxLength: 500,             // skip messages longer than this
  localDetect: true,          // skip the API when the local detector says "already in target language"
  localDetectMinLength: 10,   // the local detector is unreliable below this length
  asciiOnly: 'auto',          // auto = only on the NA client (eme) | on | off
  holdTimeoutMs: 3000,        // a message is never held longer than this
  requestTimeoutMs: 2000,     // timeout of one HTTP request
  maxConcurrent: 4,           // parallel HTTP requests
  maxQueue: 100,              // pending translations before new ones are dropped (spam protection)
  cacheSize: 2000,            // LRU entries
  notify: true,               // tell you in game when a provider breaks (invalid key, quota...)
  logLevel: 'info',           // error | warn | info | debug
  logFile: false,              // write logs/translate-chat.log (rotated)
};

const SCHEMA = {
  enabled: { type: 'bool', desc: 'master switch' },
  sourceLang: { type: 'lang', auto: true, desc: 'source language (auto = detect)' },
  targetLang: { type: 'lang', desc: 'language incoming messages are translated to' },
  sendMode: { type: 'bool', desc: 'translate your outgoing messages' },
  sendLang: { type: 'lang', desc: 'language outgoing messages are translated to' },
  deeplKey: { type: 'secret', desc: 'DeepL API key (free keys end with :fx)' },
  googleKey: { type: 'secret', desc: 'Google Cloud Translation key (optional)' },
  providers: { type: 'list', values: ['deepl', 'google'], desc: 'provider order / fallback chain' },
  useGlossary: { type: 'bool', desc: 'protect glossary terms from translation' },
  showTag: { type: 'bool', desc: 'show detected language tag' },
  displayMode: { type: 'enum', values: ['inline', 'replace', 'separate'], desc: 'inline = same line, replace, separate = extra line' },
  separator: { type: 'string', max: 12, desc: 'separator between original and translation' },
  color: { type: 'color', desc: 'translation colour (#rrggbb or off)' },
  translateOwn: { type: 'bool', desc: 'translate your own messages too' },
  echoOriginal: { type: 'bool', desc: 'echo the original text when send mode translates' },
  ignoreChannels: { type: 'intlist', desc: 'channels that are never translated' },
  minLetters: { type: 'int', min: 1, max: 20, desc: 'minimum number of letters' },
  maxLength: { type: 'int', min: 20, max: 2000, desc: 'maximum message length' },
  localDetect: { type: 'bool', desc: 'use the local language detector to save API calls' },
  localDetectMinLength: { type: 'int', min: 3, max: 200, desc: 'minimum length for the local detector' },
  asciiOnly: { type: 'enum', values: ['auto', 'on', 'off'], desc: 'transliterate to ASCII (NA client font)' },
  holdTimeoutMs: { type: 'int', min: 200, max: 15000, desc: 'max time a message is held for translation' },
  requestTimeoutMs: { type: 'int', min: 300, max: 15000, desc: 'HTTP request timeout' },
  maxConcurrent: { type: 'int', min: 1, max: 16, desc: 'parallel HTTP requests' },
  maxQueue: { type: 'int', min: 8, max: 1000, desc: 'max pending translations' },
  cacheSize: { type: 'int', min: 0, max: 50000, desc: 'cache size (0 = off)' },
  notify: { type: 'bool', desc: 'in-game warnings about provider problems' },
  logLevel: { type: 'enum', values: ['error', 'warn', 'info', 'debug'], desc: 'log verbosity' },
  logFile: { type: 'bool', desc: 'write logs/translate-chat.log' },
};

module.exports = { DEFAULTS, SCHEMA };
