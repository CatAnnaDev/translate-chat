const request = require('node-fetch');
const { normalize } = require('./normalize');
const { protectHtml, stripHtml, protectTokens, restoreTokens } = require('./glossary');
const LanguageDetect = require('../lib/language-detector');
const lngDetector = new LanguageDetect();
lngDetector.setLanguageType('iso2');

module.exports.AVAILABLE_LANGUAGES = ['af', 'sq', 'ar', 'az', 'eu', 'bn', 'be', 'bg', 'ca', 'zh-CN', 'zh-TW', 'hr', 'cs', 'da', 'nl', 'en', 'eo', 'et', 'tl', 'fi', 'fr', 'gl', 'ka', 'de', 'el', 'gu', 'ht', 'iw', 'hi', 'hu', 'is', 'id', 'ga', 'it', 'ja', 'kn', 'ko', 'la', 'lv', 'lt', 'mk', 'ms', 'mt', 'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi', 'cy', 'yi', 'any'];

const DEEPL_TARGETS = new Set(['AR', 'BG', 'CS', 'DA', 'DE', 'EL', 'EN-GB', 'EN-US', 'ES', 'ET', 'FI', 'FR', 'HU', 'ID', 'IT', 'JA', 'KO', 'LT', 'LV', 'NB', 'NL', 'PL', 'PT-BR', 'PT-PT', 'RO', 'RU', 'SK', 'SL', 'SV', 'TR', 'UK', 'ZH']);
const DEEPL_TARGET_MAP = { en: 'EN-US', 'en-us': 'EN-US', 'en-gb': 'EN-GB', pt: 'PT-BR', 'pt-br': 'PT-BR', 'pt-pt': 'PT-PT', 'zh-cn': 'ZH', 'zh-tw': 'ZH', no: 'NB', nb: 'NB' };
const DEEPL_SOURCE_MAP = { en: 'EN', pt: 'PT', 'pt-br': 'PT', 'pt-pt': 'PT', 'zh-cn': 'ZH', 'zh-tw': 'ZH', no: 'NB', nb: 'NB' };

function toDeeplTarget(code) {
  const c = DEEPL_TARGET_MAP[code.toLowerCase()] || code.toUpperCase();
  return DEEPL_TARGETS.has(c) ? c : null;
}

function toDeeplSource(code) {
  if (!code || code === 'auto') return null;
  const c = DEEPL_SOURCE_MAP[code.toLowerCase()] || code.toUpperCase();
  return c.replace(/-.*/, '');
}

async function deepl(text, target, source, { deeplKey, matcher, useGlossary }) {
  const deeplTarget = toDeeplTarget(target);
  if (!deeplKey || !deeplTarget) return null;

  const endpoint = deeplKey.trim().endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  let payload = text;
  const protectedText = useGlossary && matcher ? protectHtml(text, matcher) : text;
  const usedTags = protectedText !== text;
  payload = protectedText;

  const params = new URLSearchParams();
  params.append('text', payload);
  params.append('target_lang', deeplTarget);
  const deeplSource = toDeeplSource(source);
  if (deeplSource) params.append('source_lang', deeplSource);
  if (usedTags) {
    params.append('tag_handling', 'xml');
    params.append('ignore_tags', 'g');
  }

  const response = await request(endpoint, {
    method: 'post',
    body: params,
    headers: {
      'Authorization': `DeepL-Auth-Key ${deeplKey.trim()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  if (!response.ok) return null;

  const json = await response.json();
  const first = json.translations && json.translations[0];
  if (!first) return null;
  return {
    text: usedTags ? stripHtml(first.text) : first.text,
    src: (first.detected_source_language || '').toLowerCase(),
  };
}

const DEEPL_FREE_TARGETS = new Set(['AR', 'BG', 'CS', 'DA', 'DE', 'EL', 'EN', 'ES', 'ET', 'FI', 'FR', 'HU', 'ID', 'IT', 'JA', 'KO', 'LT', 'LV', 'NB', 'NL', 'PL', 'PT', 'RO', 'RU', 'SK', 'SL', 'SV', 'TR', 'UK', 'ZH']);
const DEEPL_FREE_MAP = { en: 'EN', 'en-us': 'EN', 'en-gb': 'EN', pt: 'PT', 'pt-br': 'PT', 'pt-pt': 'PT', 'zh-cn': 'ZH', 'zh-tw': 'ZH', no: 'NB', nb: 'NB' };

function toFreeLang(code) {
  const c = DEEPL_FREE_MAP[code.toLowerCase()] || code.toUpperCase().replace(/-.*/, '');
  return DEEPL_FREE_TARGETS.has(c) ? c : null;
}

function countI(text) {
  return (text.match(/i/gi) || []).length;
}

function freeTimestamp(iCount) {
  const t = Date.now();
  const n = iCount + 1;
  return t - (t % n) + n;
}

async function deeplFree(text, target, source, { matcher, useGlossary }) {
  const targetLang = toFreeLang(target);
  if (!targetLang) return null;
  const sourceLang = source && source !== 'auto' ? (toFreeLang(source) || 'auto') : 'auto';

  let payload = text;
  let kept = [];
  if (useGlossary && matcher) {
    const r = protectTokens(text, matcher);
    payload = r.text;
    kept = r.kept;
  }

  const iCount = countI(payload) + 1;
  const id = Math.floor(Math.random() * 100000) + 8300000;
  const bodyObj = {
    jsonrpc: '2.0',
    method: 'LMT_handle_jobs',
    id,
    params: {
      jobs: [{ kind: 'default', sentences: [{ text: payload, id: 1, prefix: '' }], raw_en_context_before: [], raw_en_context_after: [], preferred_num_beams: 4 }],
      lang: { source_lang_user_selected: sourceLang, target_lang: targetLang },
      priority: 1,
      commonJobParams: { mode: 'translate' },
      timestamp: freeTimestamp(iCount),
    },
  };
  let body = JSON.stringify(bodyObj);
  body = ((id + 5) % 29 === 0 || (id + 3) % 13 === 0)
    ? body.replace('"method":"', '"method" : "')
    : body.replace('"method":"', '"method": "');

  const response = await request('https://www2.deepl.com/jsonrpc', {
    method: 'post',
    body,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'DeepLBrowserExtension/1.3.0 Mozilla/5.0',
      'Accept': '*/*',
    },
  });
  if (!response.ok) return null;

  const json = await response.json();
  const translations = json.result && json.result.translations;
  if (!translations || !translations.length) return null;
  const out = translations
    .map(t => (t.beams && t.beams[0] && t.beams[0].sentences ? t.beams[0].sentences.map(s => s.text).join('') : ''))
    .join(' ')
    .trim();
  if (!out) return null;
  return { text: restoreTokens(out, kept), src: (json.result.source_lang || '').toLowerCase() };
}

async function google(text, target, source, { matcher, useGlossary }) {
  let payload = text;
  let kept = [];
  if (useGlossary && matcher) {
    const r = protectTokens(text, matcher);
    payload = r.text;
    kept = r.kept;
  }

  const url = 'https://translate.google.com/translate_a/single'
    + '?client=at&dt=t&dt=ld&dt=qca&dt=rm&dt=bd&dj=1&hl=' + target + '&ie=UTF-8'
    + '&oe=UTF-8&inputm=2&otf=2&iid=1dd3b944-fa62-4b55-b330-74909a99969e';

  const params = new URLSearchParams();
  params.append('sl', source);
  params.append('tl', target);
  params.append('q', payload);

  const response = await request(url, {
    method: 'post',
    body: params,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'User-Agent': 'AndroidTranslate/5.3.0.RC02.130475354-53000263 5.1 phone TRANSLATE_OPM5_TEST_1',
    },
  });
  const body = await response.text();
  try {
    const jsonBody = JSON.parse(body);
    const trans = jsonBody.sentences.map(s => s.trans || '').join('');
    const src = jsonBody.src || (jsonBody.ld_result && jsonBody.ld_result.srclangs && jsonBody.ld_result.srclangs[0]);
    return { text: restoreTokens(trans, kept), src };
  } catch (e) {
    return null;
  }
}

async function translate(text, translateTo, translateFrom = 'auto', opts = {}) {
  const detected = lngDetector.detect(text, 1);
  if (detected[0] && detected[0][0] === translateTo) return { text, src: detected[0][0] };

  if (opts.deeplKey) {
    const viaKey = await deepl(text, translateTo, translateFrom, opts).catch(() => null);
    if (viaKey && viaKey.text) return viaKey;
  } else {
    const viaFree = await deeplFree(text, translateTo, translateFrom, opts).catch(() => null);
    if (viaFree && viaFree.text) return viaFree;
  }

  return google(text, translateTo, translateFrom, opts);
}

module.exports.translate = translate;

const normalizeNa = (str) => {
  return normalize(str)
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/\s+$/, '');
};
module.exports.normalizeNa = normalizeNa;
