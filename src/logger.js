'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RING = 200;
const FLUSH_MS = 1000;

class Logger {
  constructor({ mod, getLevel, fileEnabled, dir, secrets }) {
    this.mod = mod;
    this.getLevel = getLevel;
    this.fileEnabled = fileEnabled;
    this.secrets = secrets || (() => []);
    this.ring = [];
    this.queue = [];
    this.timer = null;
    this.fileFailures = 0;
    this.fileDisabled = false;
    this.file = path.join(dir, 'logs', 'translate-chat.log');
    this.fileSize = null;
  }

  redact(text) {
    let out = String(text);
    for (const s of this.secrets()) {
      if (s && s.length >= 6) out = out.split(s).join('***');
    }
    return out;
  }

  format(msg, err) {
    let line = String(msg);
    if (err) {
      const kind = err.kind ? `${err.kind}: ` : '';
      line += ` | ${kind}${err.message || err}`;
      if (err.status) line += ` (HTTP ${err.status})`;
    }
    return this.redact(line);
  }

  emit(level, msg, err) {
    const line = this.format(msg, err);
    const now = new Date();
    if (LEVELS[level] <= LEVELS.warn) {
      this.ring.push({ t: now.getTime(), level, line });
      if (this.ring.length > MAX_RING) this.ring.shift();
    }
    if (LEVELS[level] > (LEVELS[this.getLevel()] === undefined ? LEVELS.info : LEVELS[this.getLevel()])) return;

    try {
      if (level === 'error') this.mod.error(line);
      else if (level === 'warn') this.mod.warn(line);
      else this.mod.log(line);
    } catch (e) { /* console must never break the mod */ }

    if (this.fileEnabled() && !this.fileDisabled) {
      let text = line;
      if (err && err.stack && level === 'debug') text += '\n' + this.redact(err.stack);
      this.queue.push(`${now.toISOString()} [${level.toUpperCase()}] ${text}\n`);
      this.schedule();
    }
  }

  error(msg, err) { this.emit('error', msg, err); }
  warn(msg, err) { this.emit('warn', msg, err); }
  info(msg, err) { this.emit('info', msg, err); }
  debug(msg, err) { this.emit('debug', msg, err); }

  recent(n = 10) {
    return this.ring.slice(-n);
  }

  schedule() {
    if (this.timer) return;
    this.timer = this.mod.setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
  }

  prepare() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.fileSize === null) {
      try { this.fileSize = fs.statSync(this.file).size; } catch (e) { this.fileSize = 0; }
    }
    if (this.fileSize > MAX_FILE_BYTES) {
      try { fs.renameSync(this.file, this.file + '.1'); } catch (e) { /* ignore */ }
      this.fileSize = 0;
    }
  }

  flush() {
    if (!this.queue.length || this.fileDisabled) { this.queue = []; return; }
    const data = this.queue.join('');
    this.queue = [];
    try {
      this.prepare();
      fs.appendFileSync(this.file, data);
      this.fileSize += Buffer.byteLength(data);
      this.fileFailures = 0;
    } catch (e) {
      this.fileFailures++;
      if (this.fileFailures >= 3) {
        this.fileDisabled = true;
        try { this.mod.warn(`log file disabled after repeated write errors: ${e.message}`); } catch (x) { /* ignore */ }
      }
    }
  }

  destroy() {
    if (this.timer) { try { this.mod.clearTimeout(this.timer); } catch (e) { /* ignore */ } this.timer = null; }
    this.flush();
  }
}

module.exports = { Logger, LEVELS };
