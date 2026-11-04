'use strict';

class OrderedRelease {
  constructor({ setTimer, clearTimer, onError }) {
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError || (() => {});
    this.queue = [];
  }

  get pending() { return this.queue.length; }

  add(valueOrPromise, timeoutMs, release) {
    const item = { done: false, value: null, release, timer: null, timedOut: false };
    this.queue.push(item);
    const finish = (value, timedOut) => {
      if (item.done) return;
      item.done = true;
      item.value = value;
      item.timedOut = !!timedOut;
      if (item.timer) { this.clearTimer(item.timer); item.timer = null; }
      this.flush();
    };
    if (valueOrPromise && typeof valueOrPromise.then === 'function') {
      item.timer = this.setTimer(() => finish(null, true), timeoutMs);
      valueOrPromise.then(v => finish(v, false), () => finish(null, false));
    } else {
      finish(valueOrPromise, false);
    }
  }

  flush() {
    while (this.queue.length && this.queue[0].done) {
      const item = this.queue.shift();
      try { item.release(item.value, item.timedOut); } catch (e) { this.onError(e); }
    }
  }

  clear() {
    for (const item of this.queue) if (item.timer) this.clearTimer(item.timer);
    this.queue = [];
  }
}

module.exports = { OrderedRelease };
