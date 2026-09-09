const fs = require('fs');
const path = require('path');

const DEFAULT_TERMS = [
  'gg', 'wp', 'gl', 'hf', 'glhf', 'brb', 'afk', 'ty', 'np', 'thx', 'gj', 'ez',
  'wtb', 'wts', 'wtt', 'lfg', 'lfm', 'lfp', 'pst', 'ping', 'dc', 'fps',
  'tank', 'heal', 'healer', 'dps', 'buff', 'debuff', 'aggro', 'proc', 'cc',
  'aoe', 'dot', 'hot', 'mob', 'boss', 'nerf', 'meta', 'pug', 'alt', 'main',
  'crit', 'cd', 'oom', 'rez', 'res', 'aggro', 'kite', 'pull', 'add', 'adds',
  'nostrum', 'crystal', 'enchant', 'masterwork', 'enigmatic', 'vanguard',
  'priest', 'mystic', 'lancer', 'berserker', 'slayer', 'warrior', 'archer',
  'sorcerer', 'gunner', 'brawler', 'ninja', 'valkyrie', 'reaper',
  'elin', 'popori', 'castanic', 'aman', 'baraka'
];

function glossaryPath(dir) {
  return path.join(dir, 'glossary.json');
}

function loadTerms(dir) {
  const p = glossaryPath(dir);
  try {
    if (fs.existsSync(p)) {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) return arr.filter(t => typeof t === 'string' && t.trim().length);
    } else {
      fs.writeFileSync(p, JSON.stringify(DEFAULT_TERMS, null, 2));
    }
  } catch (e) {}
  return DEFAULT_TERMS.slice();
}

function buildMatcher(terms) {
  if (!terms.length) return null;
  const escaped = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

function protectHtml(text, matcher) {
  if (!matcher) return text;
  return text.replace(matcher, m => `<g>${m}</g>`);
}

function stripHtml(text) {
  return text.replace(/<\/?g>/g, '');
}

function protectTokens(text, matcher) {
  if (!matcher) return { text, kept: [] };
  const kept = [];
  const out = text.replace(matcher, m => {
    const token = `x${kept.length}zq`;
    kept.push(m);
    return token;
  });
  return { text: out, kept };
}

function restoreTokens(text, kept) {
  let out = text;
  for (let i = 0; i < kept.length; i++) {
    out = out.replace(new RegExp(`x${i}zq`, 'gi'), kept[i]);
  }
  return out;
}

module.exports = { DEFAULT_TERMS, glossaryPath, loadTerms, buildMatcher, protectHtml, stripHtml, protectTokens, restoreTokens };
