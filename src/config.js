'use strict';

const { DEFAULTS, SCHEMA } = require('./defaults');
const L = require('./lang');

const TRUE = new Set(['on', 'true', 'yes', 'y', '1', 'enable', 'enabled']);
const FALSE = new Set(['off', 'false', 'no', 'n', '0', 'disable', 'disabled']);

function fail(error) { return { ok: false, error }; }
function ok(value) { return { ok: true, value }; }

function validate(key, value) {
  const s = SCHEMA[key];
  if (!s) return fail(`unknown setting "${key}"`);
  switch (s.type) {
    case 'bool':
      return typeof value === 'boolean' ? ok(value) : fail('expected on/off');
    case 'int':
      if (!Number.isInteger(value)) return fail('expected an integer');
      if (value < s.min || value > s.max) return fail(`expected a value between ${s.min} and ${s.max}`);
      return ok(value);
    case 'enum':
      return s.values.includes(value) ? ok(value) : fail(`expected one of: ${s.values.join(', ')}`);
    case 'string':
      if (typeof value !== 'string') return fail('expected text');
      return value.length <= (s.max || 64) ? ok(value) : fail(`max ${s.max || 64} characters`);
    case 'color':
      if (value === '') return ok('');
      return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? ok(value.toLowerCase()) : fail('expected #rrggbb or off');
    case 'lang': {
      const l = L.normalizeLang(value, { allowAuto: !!s.auto });
      return l ? ok(l) : fail(`"${value}" is not a valid language code${s.auto ? '' : ' (auto is not allowed here)'}`);
    }
    case 'secret': {
      if (typeof value !== 'string') return fail('expected text');
      const v = value.trim();
      if (v.length > 256 || /\s/.test(v)) return fail('invalid key format');
      return ok(v);
    }
    case 'list': {
      if (!Array.isArray(value) || !value.length) return fail(`expected a non-empty list of: ${s.values.join(', ')}`);
      const out = [];
      for (const v of value) {
        const n = String(v).toLowerCase();
        if (!s.values.includes(n)) return fail(`"${v}" is not valid (allowed: ${s.values.join(', ')})`);
        if (!out.includes(n)) out.push(n);
      }
      return ok(out);
    }
    case 'intlist': {
      if (!Array.isArray(value)) return fail('expected a list of numbers');
      const out = [];
      for (const v of value) {
        if (!Number.isInteger(v) || v < 0 || v > 999) return fail(`"${v}" is not a valid channel number`);
        if (!out.includes(v)) out.push(v);
      }
      return ok(out);
    }
    default:
      return fail('unsupported setting type');
  }
}

function parseValue(key, args) {
  const s = SCHEMA[key];
  if (!s) return fail(`unknown setting "${key}"`);
  const list = Array.isArray(args) ? args : [args];
  const raw = list.join(' ').trim();
  switch (s.type) {
    case 'bool': {
      const w = raw.toLowerCase();
      if (TRUE.has(w)) return validate(key, true);
      if (FALSE.has(w)) return validate(key, false);
      return fail('expected on/off');
    }
    case 'int':
      return validate(key, raw === '' ? NaN : Number(raw));
    case 'enum':
      return validate(key, raw.toLowerCase());
    case 'string':
      return validate(key, raw);
    case 'color': {
      const w = raw.toLowerCase();
      return validate(key, (w === 'off' || w === 'none' || w === 'default') ? '' : (w.startsWith('#') ? w : '#' + w));
    }
    case 'lang':
      return validate(key, raw);
    case 'secret':
      return validate(key, raw.toLowerCase() === 'none' ? '' : raw);
    case 'list':
      return validate(key, raw.split(/[\s,]+/).filter(Boolean));
    case 'intlist':
      return validate(key, raw.toLowerCase() === 'none' || raw === '' ? [] : raw.split(/[\s,]+/).filter(Boolean).map(Number));
    default:
      return fail('unsupported setting type');
  }
}

function clone(v) { return Array.isArray(v) ? v.slice() : v; }

function sanitize(settings) {
  const repaired = [];
  for (const key of Object.keys(SCHEMA)) {
    const r = validate(key, settings[key]);
    if (r.ok) settings[key] = r.value;
    else {
      if (settings[key] !== undefined) repaired.push(key);
      settings[key] = clone(DEFAULTS[key]);
    }
  }
  return repaired;
}

function describe(key, value) {
  const s = SCHEMA[key];
  if (s && s.type === 'secret') return value ? mask(value) : '(none)';
  if (Array.isArray(value)) return value.length ? value.join(',') : '(none)';
  if (value === '') return '(none)';
  return String(value);
}

function mask(secret) {
  const v = String(secret || '');
  if (!v) return '(none)';
  return v.length <= 6 ? '***' : `***${v.slice(-4)}`;
}

module.exports = { validate, parseValue, sanitize, describe, mask, DEFAULTS, SCHEMA };
