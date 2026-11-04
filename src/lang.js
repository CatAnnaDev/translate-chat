'use strict';

const AVAILABLE_LANGUAGES = ['af', 'sq', 'ar', 'az', 'eu', 'bn', 'be', 'bg', 'ca', 'zh-CN', 'zh-TW', 'hr', 'cs', 'da', 'nl', 'en', 'en-GB', 'en-US', 'eo', 'et', 'tl', 'fi', 'fr', 'gl', 'ka', 'de', 'el', 'gu', 'ht', 'iw', 'hi', 'hu', 'is', 'id', 'ga', 'it', 'ja', 'kn', 'ko', 'la', 'lv', 'lt', 'mk', 'ms', 'mt', 'no', 'fa', 'pl', 'pt', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sw', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'vi', 'cy', 'yi'];

const BY_LOWER = new Map(AVAILABLE_LANGUAGES.map(l => [l.toLowerCase(), l]));
const ALIASES = { jp: 'ja', kr: 'ko', cn: 'zh-CN', tw: 'zh-TW', ua: 'uk', he: 'iw', nb: 'no', br: 'pt-BR', gb: 'en-GB' };

function normalizeLang(input, { allowAuto = false } = {}) {
  const s = String(input === undefined || input === null ? '' : input).trim().toLowerCase().replace(/_/g, '-');
  if (!s) return null;
  if (s === 'auto' || s === 'any') return allowAuto ? 'auto' : null;
  if (BY_LOWER.has(s)) return BY_LOWER.get(s);
  if (ALIASES[s]) return ALIASES[s];
  return null;
}

function baseLang(code) {
  const b = String(code || '').toLowerCase().split(/[-_]/)[0];
  const map = { iw: 'he', nb: 'no', nn: 'no', jw: 'jv', fil: 'tl' };
  return map[b] || b;
}

function deeplTarget(code) {
  const c = String(code).toLowerCase();
  const b = baseLang(c);
  if (b === 'en') return c === 'en-gb' ? 'EN-GB' : 'EN-US';
  if (b === 'pt') return c === 'pt-pt' ? 'PT-PT' : 'PT-BR';
  if (b === 'zh') return c === 'zh-tw' ? 'ZH-HANT' : 'ZH';
  if (b === 'no') return 'NB';
  return b.toUpperCase();
}

function deeplSource(code) {
  if (!code || code === 'auto') return null;
  const b = baseLang(code);
  return b === 'no' ? 'NB' : b.toUpperCase();
}

function googleCode(code) {
  if (!code || code === 'auto') return 'auto';
  const c = String(code).toLowerCase();
  const b = baseLang(c);
  if (b === 'zh') return c === 'zh-tw' ? 'zh-TW' : 'zh-CN';
  if (b === 'he') return 'iw';
  return b;
}

module.exports = { AVAILABLE_LANGUAGES, normalizeLang, baseLang, deeplTarget, deeplSource, googleCode };
