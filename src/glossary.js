'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TERMS = [
  'gg', 'wp', 'gl', 'hf', 'glhf', 'brb', 'afk', 'ty', 'np', 'thx', 'gj', 'ez',
  'wtb', 'wts', 'wtt', 'lfg', 'lfm', 'lfp', 'pst', 'ping', 'dc', 'fps',
  'tank', 'heal', 'healer', 'dps', 'buff', 'debuff', 'aggro', 'proc', 'cc',
  'aoe', 'dot', 'hot', 'mob', 'boss', 'nerf', 'meta', 'pug', 'alt', 'main',
  'crit', 'cd', 'oom', 'rez', 'res', 'kite', 'pull', 'add', 'adds',
  'nostrum', 'crystal', 'enchant', 'masterwork', 'enigmatic', 'vanguard',
  'priest', 'mystic', 'lancer', 'berserker', 'slayer', 'warrior', 'archer',
  'sorcerer', 'gunner', 'brawler', 'ninja', 'valkyrie', 'reaper',
  'elin', 'popori', 'castanic', 'aman', 'baraka',
];

const MAX_TERMS = 5000;

function glossaryPath(dir) {
  return path.join(dir, 'glossary.json');
}

function buildMatcher(terms) {
  if (!terms.length) return null;
  const escaped = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

class Glossary {
  constructor(dir, log) {
    this.dir = dir;
    this.log = log;
    this.terms = [];
    this.matcher = null;
    this.reload();
  }

  get file() { return glossaryPath(this.dir); }
  get size() { return this.terms.length; }

  reload() {
    let terms = DEFAULT_TERMS.slice();
    const p = this.file;
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const arr = Array.isArray(data) ? data : data && Array.isArray(data.terms) ? data.terms : null;
        if (arr) terms = arr.filter(t => typeof t === 'string' && t.trim().length);
        else this.log.warn(`glossary.json must be a JSON array of strings; using built-in defaults (file left untouched)`);
      } else {
        fs.writeFileSync(p, JSON.stringify(DEFAULT_TERMS, null, 2));
        this.log.info(`created ${p}`);
      }
    } catch (e) {
      this.log.warn('could not read glossary.json, using built-in defaults (file left untouched)', e);
    }
    const seen = new Set();
    this.terms = [];
    for (const t of terms) {
      const k = t.trim();
      const lk = k.toLowerCase();
      if (!k || seen.has(lk)) continue;
      seen.add(lk);
      this.terms.push(k);
      if (this.terms.length >= MAX_TERMS) { this.log.warn(`glossary truncated to ${MAX_TERMS} terms`); break; }
    }
    this.matcher = buildMatcher(this.terms);
    return this.terms.length;
  }

  protect(text, addSpan) {
    return this.matcher ? text.replace(this.matcher, m => addSpan(m)) : text;
  }
}

module.exports = { DEFAULT_TERMS, glossaryPath, buildMatcher, Glossary };
