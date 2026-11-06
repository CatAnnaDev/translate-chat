'use strict';

const { DEFAULTS } = require('./defaults');
const config = require('./config');

module.exports = function MigrateSettings(from_ver, to_ver, settings) {
  if (from_ver === null) return clone(DEFAULTS);

  const merged = Object.assign(clone(DEFAULTS), settings || {});
  if (from_ver < 5 && settings) {
    if (settings.requestTimeoutMs === 2000) merged.requestTimeoutMs = DEFAULTS.requestTimeoutMs;
    if (settings.holdTimeoutMs === 3000) merged.holdTimeoutMs = DEFAULTS.holdTimeoutMs;
    if (settings.localDetectMinLength === 10) merged.localDetectMinLength = DEFAULTS.localDetectMinLength;
  }
  config.sanitize(merged);
  return merged;
};

function clone(o) {
  const out = {};
  for (const k of Object.keys(o)) out[k] = Array.isArray(o[k]) ? o[k].slice() : o[k];
  return out;
}
