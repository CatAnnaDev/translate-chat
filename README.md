# translate-chat

Translates TERA chat (say, party, guild, whispers, private channels...) and, optionally, your own outgoing messages.
The translation is added **on the same chat line** as the original message.

# Requires Caali's proxy

- [https://discord.gg/maqBmJV](https://discord.gg/maqBmJV)

## How it works

- **DeepL API Free** is the default translator (Pro keys work too), **Google Translate** is the automatic fallback.
  Without a DeepL key the mod simply uses Google until you add one.
- A DeepL **API Free** key costs nothing (500 000 characters / month): create a free account at deepl.com, copy the key (it ends with `:fx`) and run `translate key <your-key>` in game. The key is checked immediately and the Free endpoint is selected automatically.
- Messages are held for a moment, translated, then re-emitted as a single packet: `original | [RU] translation`.
  Arrival order is always preserved and no message is ever held longer than `holdTimeoutMs` (3 s by default). If every provider fails, the original message is delivered unchanged: **a message is never lost**.
- Smart savings: repeated messages are cached (LRU), identical in-flight requests are merged, text already in your language is skipped (local detector + provider detection), glossary-only / link-only / very short messages never hit the network.
- Item links, URLs and glossary terms (`wtb`, `lfg`, class names...) are protected from translation (`glossary.json`).
- Resilient: per-provider **circuit breaker** (cool-down with exponential back-off, `Retry-After` honoured, long pause on quota exceeded, provider disabled while its key is rejected), request timeouts, concurrency limit, queue limit against spam, in-game warnings when a provider breaks.
- Logs: leveled console output + rotated `logs/translate-chat.log` (API keys are always masked), `translate errors` shows the latest problems in game.

## Usage

Type in chat with the proxy prefix, e.g. `/8 translate status`.

| Command | Description |
| --- | --- |
| `translate` | Toggle on/off (also `on` / `off`) |
| `translate status` | Providers state, latency, cache, queue, counters |
| `translate config` | Show every setting (keys are masked) |
| `translate set <name> <value>` / `get <name>` | Change / read any setting (validated) |
| `translate source <lang\|auto>` | Source language (default `auto`) |
| `translate target <lang>` | Target language (default `en`) |
| `translate send [lang\|on\|off]` | Translate your outgoing messages |
| `translate mode <inline\|replace\|separate>` | Same line / replace the line / extra line |
| `translate tag [on\|off]` | Show the detected language (`[RU]`, `[FR]`, ...) |
| `translate color <#rrggbb\|off>` | Colour of the translated text |
| `translate providers deepl google` | Provider order (fallback chain) |
| `translate key <deepl-key\|none>` | DeepL key (verified right away) |
| `translate gkey <google-key\|none>` | Optional Google Cloud Translation key (official API) |
| `translate usage` | DeepL character usage |
| `translate test [deepl\|google] <text>` | Translate a text with a given provider (diagnostics) |
| `translate glossary` | Reload `glossary.json` |
| `translate skip [lang...\|none]` / `unskip <lang...>` | Languages you understand, left untouched (default `en`, `fr`) |
| `translate lfg [on\|off]` | Translate party finder listings and party links |
| `translate why [n]` | Outcome counters and the last decisions (translated, skipped language, timeout...) |
| `translate ignore [channel]` / `unignore <channel>` | Channels that are never translated |
| `translate cache [clear]` | Cache info / clear |
| `translate reset` | Re-enable providers and reset counters |
| `translate errors [n]` | Last warnings / errors |
| `translate log <level>` / `log file on\|off` | Log verbosity / file logging |

Language codes: `en`, `fr`, `es`, `de`, `ru`, `pt`, `pt-BR`, `zh-CN`, ... ([list](https://ctrlq.org/code/19899-google-translate-languages)).

## Settings (`config.json`)

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `sourceLang` / `targetLang` | `auto` / `en` | Languages for incoming messages |
| `sendMode` / `sendLang` | `false` / `en` | Outgoing translation |
| `deeplKey` / `googleKey` | empty | API keys |
| `providers` | `["deepl","google"]` | Fallback order |
| `displayMode` | `inline` | `inline`, `replace` or `separate` (zero added latency, translation arrives as an extra line) |
| `separator`, `color`, `showTag` | `" \| "`, `#9be37c`, `true` | Look of the translated text |
| `useGlossary` | `true` | Protect glossary terms |
| `translateOwn` | `false` | Translate your own messages |
| `echoOriginal` | `true` | Print the original text when send mode translates |
| `ignoreChannels` | `[]` | Channel numbers to skip |
| `partyMatch` | `true` | Translate party finder (LFG) listings and party links (plain text, same separator/tag settings) |
| `skipLangs` | `["en","fr"]` | Messages detected in these languages (or in the target language) are left untouched; never applied to your outgoing messages |
| `lateTranslation` | `true` | A translation that arrives after `holdTimeoutMs` is shown as an extra line instead of being lost |
| `hedgeMs` | `1200` | Start the next provider (or a second request) in parallel when the first one is slow, `0` = only on failure |
| `minLetters`, `maxLength` | `2`, `500` | Message size limits |
| `localDetect`, `localDetectMinLength` | `true`, `15` | Local "already in my language" check (strict: only when the detector is clearly confident) |
| `asciiOnly` | `auto` | Transliterate to ASCII (automatic on the NA client) |
| `holdTimeoutMs`, `requestTimeoutMs` | `4000`, `2500` | Latency bounds |
| `maxConcurrent`, `maxQueue`, `cacheSize` | `4`, `100`, `2000` | Performance |
| `notify` | `true` | In-game warnings about provider problems |
| `logLevel`, `logFile` | `info`, `true` | Logging |

Invalid values in `config.json` are repaired automatically at startup (and logged).

## Updates

The proxy updates the mod from this repository using `manifest.json` (SHA-256 of every file). The "newer version" notice appears when the files on GitHub and the manifest do not match what is installed, so before every push:

```
npm run manifest   # regenerate manifest.json
npm run check      # verify manifest, versions, line endings, no comments, run the tests
```

`.gitattributes` forces LF line endings so hashes are identical on Windows. Always push the whole folder (including `manifest.json` and `module.json`) in the same commit.

## Tests

`npm test` (or `node test/run.js`) runs the offline test suite: no network and no game needed.

## Changelog

```
3.4
- party finder: listings (`S_SHOW_PARTY_MATCH_INFO`) and party links (`S_PARTY_MATCH_LINK`) are translated as plain text
  (`original | [RU] translation`), your own listing is left alone; `translate lfg [on|off]` / setting `partyMatch`

3.3
- compatible with ColoredChat and other colour mods: text wrapped in a coloured `ChatLinkAction` (item id 0) is translated,
  and your outgoing translated messages keep the exact same colour frame; plain `<FONT color>` messages keep their colour too
  (real item/quest links are still protected)

3.2
- `skipLangs`: languages you understand are left untouched (default en, fr), `translate skip` / `unskip`
- far fewer untranslated messages: a provider is only paused after 3 consecutive failures (short pause, max 20 s),
  one automatic retry on network errors/timeouts, a second request on a fresh connection when the only provider hangs,
  the least penalised provider is still probed when all are paused, idle connections closed after 10 s
- translations arriving after the hold timeout are shown as an extra line (`lateTranslation`)
- stricter local language detection, longer default timeouts (hold 4 s, request 2.5 s)
- `translate why`: outcome counters and the last decisions

3.1
- manifest generator and checker (`npm run manifest` / `npm run check`), version read from module.json, LF enforced
- no comments in the source code

3.0
- translation on the same line as the message (packet held, then re-emitted), arrival order preserved
- official DeepL API (Free/Pro, key required) + Google fallback; optional Google Cloud Translation key
  (the unofficial key-less DeepL web endpoint was removed: it was fragile and against DeepL's terms)
- circuit breaker, timeouts, retry-after, quota handling, in-flight de-duplication, LRU cache, spam protection
- leveled logging with rotated log file and secret masking, in-game warnings, `translate errors`
- full in-game configuration (`config`, `set`, `get`, `mode`, `color`, `providers`, `ignore`, `test`, `usage`, ...)
- settings validated and repaired, no more runtime dependency (node-fetch removed)
- offline test suite

2.0
- DeepL (free, no key) as primary translator, automatic Google fallback
- editable glossary, detected source language tag, translation cache, patch 100.02 support

1.0
- remove completely unresonable dependencies
```

# Credits

- Original mod by teralove
- Haku for refusing to fix this shit
