'use strict';
/**
 * Bounded primitives for every long-lived connection in PRISM.
 * Rule: nothing here grows without bound. New structure => give it a cap.
 */

class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError('capacity >= 1');
    this.capacity = capacity;
    this._buf = new Array(capacity);
    this._head = 0;
    this._size = 0;
    this.dropped = 0;
    this.pushed = 0;
  }
  get size() { return this._size; }
  push(v) {
    this.pushed++;
    if (this._size === this.capacity) {
      this._buf[this._head] = v;
      this._head = (this._head + 1) % this.capacity;
      this.dropped++;
      return false;
    }
    this._buf[(this._head + this._size) % this.capacity] = v;
    this._size++;
    return true;
  }
  shift() {
    if (this._size === 0) return undefined;
    const v = this._buf[this._head];
    this._buf[this._head] = undefined;
    this._head = (this._head + 1) % this.capacity;
    this._size--;
    return v;
  }
  clear() { this._buf.fill(undefined); this._head = 0; this._size = 0; }
  stats() {
    return { size: this._size, capacity: this.capacity, pushed: this.pushed, dropped: this.dropped };
  }
}

/** Insertion-ordered bounded set. ~(keyBytes + 90)B per entry in V8. */
class LruSet {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this._m = new Map();
    this.evicted = 0;
  }
  get size() { return this._m.size; }
  has(k) { return this._m.has(k); }
  /** @returns {boolean} true if k was NEW */
  add(k) {
    if (this._m.has(k)) { this._m.delete(k); this._m.set(k, 1); return false; }
    this._m.set(k, 1);
    while (this._m.size > this.capacity) {
      this._m.delete(this._m.keys().next().value);
      this.evicted++;
    }
    return true;
  }
  clear() { this._m.clear(); }
}

class TokenBucket {
  constructor({ capacity, refillPerSec, now = Date.now } = {}) {
    this.capacity = Math.max(1, capacity);
    this.tokens = this.capacity;
    this.refillPerSec = Math.max(0.0001, refillPerSec);
    this._now = now;
    this._last = now();
    this.denied = 0;
    this.granted = 0;
  }
  _refill() {
    const t = this._now();
    const dt = (t - this._last) / 1000;
    if (dt <= 0) return;
    this._last = t;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
  }
  take(n = 1) {
    this._refill();
    if (this.tokens >= n) { this.tokens -= n; this.granted++; return true; }
    this.denied++;
    return false;
  }
  waitMs(n = 1) {
    this._refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.refillPerSec) * 1000);
  }
}

/** Exponential backoff, full jitter, capped. Prevents thundering-herd reconnect. */
class Backoff {
  constructor({ baseMs = 1000, maxMs = 300000, factor = 2, jitter = 'full' } = {}) {
    Object.assign(this, { baseMs, maxMs, factor, jitter });
    this.attempt = 0;
  }
  reset() { this.attempt = 0; }
  next() {
    const raw = Math.min(this.maxMs, this.baseMs * Math.pow(this.factor, this.attempt));
    this.attempt++;
    if (this.jitter === 'none') return Math.round(raw);
    const lo = Math.min(this.baseMs / 2, raw);
    return Math.round(lo + Math.random() * (raw - lo));
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }
  });
}

/** JSON.parse that never throws and refuses oversized payloads. */
function safeJson(buf, maxBytes = 512 * 1024) {
  try {
    const len = typeof buf === 'string' ? Buffer.byteLength(buf) : buf.length;
    if (len > maxBytes) return null;
    return JSON.parse(typeof buf === 'string' ? buf : buf.toString('utf8'));
  } catch { return null; }
}

function optionalRequire(name) {
  try { return require(name); }
  catch (err) { if (err && err.code === 'MODULE_NOT_FOUND') return null; throw err; }
}

function envNum(key, dflt) {
  const raw = process.env[key];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function envBool(key, dflt) {
  const raw = process.env[key];
  if (raw == null || raw === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}
function envList(key, dflt) {
  const raw = process.env[key];
  if (!raw) return dflt;
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : dflt;
}

/** Resolve a WebSocket constructor: injected > global (Node 22+) > `ws` package. */
function resolveWebSocket(injected) {
  if (injected) return injected;
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  const ws = optionalRequire('ws');
  return ws ? (ws.WebSocket || ws) : null;
}

module.exports = {
  RingBuffer, LruSet, TokenBucket, Backoff,
  sleep, safeJson, optionalRequire, envNum, envBool, envList, resolveWebSocket,
};
