'use strict';

class Notifier {
  constructor({ mod, cfg, log }) {
    this.mod = mod;
    this.cfg = cfg;
    this.log = log;
    this.last = new Map();
    this.backlog = [];
  }

  inGame() {
    try { return !!(this.mod.game && this.mod.game.isIngame && !this.mod.game.isInLoadingScreen); } catch (e) { return false; }
  }

  notify(key, text, throttleMs = 300000) {
    if (!this.cfg.notify) return;
    const now = Date.now();
    if (now - (this.last.get(key) || 0) < throttleMs) return;
    this.last.set(key, now);
    if (this.inGame()) this.show(text);
    else if (this.backlog.length < 5) this.backlog.push(text);
  }

  show(text) {
    try { this.mod.command.message(`[translate] ${text}`); } catch (e) { this.log.debug('could not show in-game notice', e); }
  }

  flushBacklog() {
    const items = this.backlog.splice(0);
    for (const t of items) this.show(t);
  }

  reset(key) {
    if (key) this.last.delete(key); else this.last.clear();
  }
}

module.exports = { Notifier };
