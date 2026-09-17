import { BridgeError } from './upstream.js';

export class Queue {
  active = 0;
  waiting = [];
  constructor(limit, maxQueue) {
    this.limit = limit;
    this.maxQueue = maxQueue;
  }
  get full() { return this.active >= this.limit && this.waiting.length >= this.maxQueue; }
  acquire(signal) {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.full) return Promise.reject(new BridgeError(429, 'queue_full', 'Bridge queue is full; retry later'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, signal, abort: null };
      entry.abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry);
    });
  }
  releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }
  drain() {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.abort);
        this.active++;
        next.resolve(this.releaseOnce());
      }
    }
  }
}
