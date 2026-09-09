# translate-chat
translates incoming chat text into another language

# Requires Caali's proxy
- https://discord.gg/maqBmJV

## Info
- Default is translate text into English.
- Ready to use, no key or token required.
- Uses DeepL's free translation (much more accurate), and automatically falls back to Google if DeepL is rate-limited, so it never breaks.
- Shows the detected source language in front of each message, for ANY language (not limited to a few) - e.g. `(Translated) [RU] ...`, `[UK] ...`, `[FR] ...`, `[DE] ...`, `[JA] ...`. The tag is whatever language the translator detects.
- Game slang and names are protected by an editable glossary (`glossary.json`) so terms like `wtb`, `lfg`, `healer`, class names, etc. are not translated.
- Repeated messages are cached, so chat spam is only translated once.
- Use language codes to set ('en' = English, 'es' = Spanish, etc.) [Click here](https://ctrlq.org/code/19899-google-translate-languages) for list of codes.
- The in-game font may not support characters for all languages.
- Translations take a second to process so if chat is getting spammed then incoming translated text may be out of order.
- Works on patch 100.02 (packet versions are auto-resolved).

## Usage
### `translate`
- Toggle off/on
- Default is on

### `translate source (language)`
- sets the source language. Default: auto

### `translate target (language)`
- sets the target language. Default: en

### `translate send (language)`
- Use this to translate outgoing messages into another language.

### `translate tag`
- Toggle the detected-language tag in front of translated messages. Works for any detected language (`[RU]`, `[UK]`, `[FR]`, `[DE]`, `[JA]`, ...), not limited to specific ones. Default: on

### `translate glossary`
- Reloads `glossary.json` after you edit it. Edit that file to add/remove terms that should never be translated.

### `translate key (deepl-key)`
- Optional. Not needed to use the mod. If you have a free DeepL API key you can set it here to use the official DeepL API instead of the free endpoint. Use `translate key none` to remove it.

## Changelog
<details>

    2.0
    - DeepL (free, no key) as primary translator, automatic Google fallback
    - editable glossary to keep game slang / names untranslated
    - detected source language tag ([RU]/[UK]/...)
    - translation cache to avoid re-translating spam
    - patch 100.02 support (packet versions resolved automatically)
    - optional DeepL API key for those who want the official endpoint

    1.0
    - remove completely unresonable dependencies


</details>

# Credits
- Original mod by teralove
- Haku for refusing to fix this shit

---

![Screenshot](https://i.imgur.com/JPngjxU.jpg)
