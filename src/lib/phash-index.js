'use strict';
/**
 * In-memory nearest-neighbour index over stored perceptual hashes (lib/phash).
 *
 * "Which stored picture is within k bits of this one?" must answer in microseconds because it runs for every ingested
 * item. Multi-index hashing does it: the 64-bit pHash is cut into 8 bytes; two hashes within 7 bits of each other must
 * share at least one identical byte (pigeonhole), so a lookup only inspects the few ids that share a byte value, and then
 * verifies them with the exact distance test.
 *
 * Storage is packed, not one JS object per picture. At 1.07M rows the old layout (a Map of objects, each with two typed
 * arrays, the hex string and a posting array entry per byte) held ~1 GB of V8 heap, and every major GC had to walk it
 * (multi-second loop blocks). Now a picture is a slot in a few parallel typed arrays (off the V8 heap, never scanned by
 * the GC): 16 B hash, 16 B packed id, 4 B aspect, 1 B flags, 4 B visit stamp, ~8 B id table, 8 posting ints (32 B).
 * About 85-110 B per picture instead of ~1 KB.
 *
 *   - ids shaped like a UUID (36 chars with dashes, or 32 hex) are packed to 128 bits; any other id string falls back to a Map.
 *   - the 8 key bytes are read back out of the hash words, never stored.
 *   - posting lists are Int32Arrays that double when full; remove() swap-pops.
 */
const MAX_DISTANCE = 7; // the pigeonhole guarantee ends here (8 chunks)

const F_VIDEO = 1; const F_ALIVE = 2; const F_DASHED = 4; const F_PACKED = 8;
const TOMB = 0xffffffff;

function pop32(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

function hexNib(c) { return c <= 57 ? c - 48 : (c | 32) - 87; }
function hexRun(s, o, len) { let v = 0; for (let i = o; i < o + len; i++) v = (v * 16) + (hexNib(s.charCodeAt(i)) & 15); return v; } // len <= 8: stays an exact integer
const word = (s, o) => hexRun(s, o, 8) >>> 0;

const UUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const h8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

/** @returns {number} 0 = not packable, F_PACKED (+F_DASHED) otherwise; the four words are written to out */
function packId(id, out) {
  if (typeof id !== 'string') return 0;
  if (id.length === 36 && UUID_DASHED.test(id)) {
    out[0] = word(id, 0);
    out[1] = ((hexRun(id, 9, 4) << 16) | hexRun(id, 14, 4)) >>> 0;
    out[2] = ((hexRun(id, 19, 4) << 16) | hexRun(id, 24, 4)) >>> 0;
    out[3] = word(id, 28);
    return F_PACKED | F_DASHED;
  }
  if (id.length === 32 && HEX32.test(id)) {
    out[0] = word(id, 0); out[1] = word(id, 8); out[2] = word(id, 16); out[3] = word(id, 24);
    return F_PACKED;
  }
  return 0;
}
function unpackId(k, o, dashed) {
  const a = h8(k[o]); const b = h8(k[o + 1]); const c = h8(k[o + 2]); const d = h8(k[o + 3]);
  return dashed ? `${a}-${b.slice(0, 4)}-${b.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}${d}` : a + b + c + d;
}
const mix = (k0, k1, k2, k3) => (Math.imul(k0, 0x9e3779b1) ^ Math.imul(k1 + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul(k2 + 0x165667b1, 0xc2b2ae35) ^ Math.imul(k3 + 0x27d4eb2f, 0x9e3779b1)) >>> 0;

class PhashIndex {
  constructor(capacity = 1024) { this._alloc(capacity); }

  _alloc(cap) {
    this.cap = cap;
    this.hw = 0;                       // slots ever handed out (high-water mark)
    this.live = 0;
    this.w = new Uint32Array(cap * 4); // the hash words
    this.k = new Uint32Array(cap * 4); // packed id
    this.flags = new Uint8Array(cap);
    this.asp = new Float32Array(cap);
    this.stamp = new Uint32Array(cap);
    this.gen = 0;
    this.free = [];
    this.sslot = new Map();            // unpackable id -> slot
    this.sid = new Map();              // slot -> unpackable id
    this.tcap = 0; this.table = new Uint32Array(0); this.tused = 0; // open-addressing id table: slot + 1 | 0 empty | TOMB
    this._tableGrow(Math.max(16, cap * 2));
    this.bk = new Array(2048).fill(null); // bucket -> Int32Array postings
    this.bn = new Uint32Array(2048);      // bucket -> used length
    this.buckets = { size: 0 };           // buckets in use (the old Map's size; kept for callers that check it is empty)
  }

  clear() { this._alloc(1024); }

  get size() { return this.live; }

  /** Bytes held by the packed arrays (the figure /api/health could show). */
  get bytes() {
    let b = this.w.byteLength + this.k.byteLength + this.flags.byteLength + this.asp.byteLength + this.stamp.byteLength + this.table.byteLength + this.bn.byteLength;
    for (const a of this.bk) if (a) b += a.byteLength;
    return b;
  }

  static chunks(hex) { const out = new Array(8); for (let i = 0; i < 8; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }

  _grow() {
    const cap = this.cap * 2;
    const copy = (A, n) => { const x = new A.constructor(cap * n); x.set(A); return x; };
    this.w = copy(this.w, 4); this.k = copy(this.k, 4);
    this.flags = copy(this.flags, 1); this.asp = copy(this.asp, 1); this.stamp = copy(this.stamp, 1);
    this.cap = cap;
  }

  _tableGrow(tcap) {
    const old = this.table; const oldCap = this.tcap;
    this.table = new Uint32Array(tcap); this.tcap = tcap; this.tused = 0;
    for (let i = 0; i < oldCap; i++) {
      const v = old[i];
      if (v && v !== TOMB) this._tableSet(v - 1);
    }
  }
  _tableSet(slot) {
    const k = this.k; const o = slot * 4; const mask = this.tcap - 1;
    let i = mix(k[o], k[o + 1], k[o + 2], k[o + 3]) & mask;
    while (this.table[i] && this.table[i] !== TOMB) i = (i + 1) & mask;
    if (!this.table[i]) this.tused++;
    this.table[i] = slot + 1;
  }
  /** @returns {number} slot or -1; leaves the probe position in this._at for the delete */
  _tableFind(q) {
    const k = this.k; const mask = this.tcap - 1; const t = this.table;
    let i = mix(q[0], q[1], q[2], q[3]) & mask;
    for (;;) {
      const v = t[i];
      if (v === 0) return -1;
      if (v !== TOMB) {
        const o = (v - 1) * 4;
        if (k[o] === q[0] && k[o + 1] === q[1] && k[o + 2] === q[2] && k[o + 3] === q[3]) { this._at = i; return v - 1; }
      }
      i = (i + 1) & mask;
    }
  }

  _slotOf(id, q) {
    if (packId(id, q)) return this._tableFind(q);
    const s = this.sslot.get(id);
    return s === undefined ? -1 : s;
  }

  has(id) { return this._slotOf(id, this._q || (this._q = new Uint32Array(4))) >= 0; }

  _post(bucket, slot) {
    let a = this.bk[bucket]; const n = this.bn[bucket];
    if (!a) { a = this.bk[bucket] = new Int32Array(4); this.buckets.size++; }
    else if (n === a.length) { const b = new Int32Array(n * 2); b.set(a); a = this.bk[bucket] = b; }
    a[n] = slot; this.bn[bucket] = n + 1;
  }
  _unpost(bucket, slot) {
    const a = this.bk[bucket]; if (!a) return;
    const n = this.bn[bucket];
    for (let j = 0; j < n; j++) {
      if (a[j] === slot) { a[j] = a[n - 1]; this.bn[bucket] = n - 1; break; }
    }
    if (this.bn[bucket] === 0) { this.bk[bucket] = null; this.buckets.size--; }
  }
  _byte(slot, i) { return (this.w[slot * 4 + (i >> 2)] >>> (24 - 8 * (i & 3))) & 255; }

  /** @param {{type?: string, aspect?: number}} meta type groups comparison (image vs video poster); aspect = width/height */
  add(id, hex, meta = {}) {
    if (!hex || hex.length !== 32) return;
    const q = this._q || (this._q = new Uint32Array(4));
    this.remove(id);
    let slot;
    if (this.free.length) slot = this.free.pop();
    else { if (this.hw === this.cap) this._grow(); slot = this.hw++; }
    const o = slot * 4;
    const w = this.w;
    w[o] = word(hex, 0); w[o + 1] = word(hex, 8); w[o + 2] = word(hex, 16); w[o + 3] = word(hex, 24);
    let f = F_ALIVE | (meta.type === 'video' ? F_VIDEO : 0);
    const packed = packId(id, q);
    if (packed) {
      f |= packed;
      this.k[o] = q[0]; this.k[o + 1] = q[1]; this.k[o + 2] = q[2]; this.k[o + 3] = q[3];
      if ((this.tused + 1) * 10 > this.tcap * 6) this._tableGrow(this.tcap * 2); // tombstones count as used: a rebuild also clears them
      this._tableSet(slot);
    } else { this.sslot.set(id, slot); this.sid.set(slot, id); }
    this.flags[slot] = f;
    this.asp[slot] = meta.aspect || 0;
    for (let i = 0; i < 8; i++) this._post(i * 256 + this._byte(slot, i), slot);
    this.live++;
  }

  remove(id) {
    const q = this._q || (this._q = new Uint32Array(4));
    const slot = this._slotOf(id, q);
    if (slot < 0) return;
    const f = this.flags[slot];
    for (let i = 0; i < 8; i++) this._unpost(i * 256 + this._byte(slot, i), slot);
    if (f & F_PACKED) { this.table[this._at] = TOMB; } else { this.sslot.delete(id); this.sid.delete(slot); }
    this.flags[slot] = 0;
    this.free.push(slot);
    this.live--;
  }

  _id(slot) {
    const f = this.flags[slot];
    return (f & F_PACKED) ? unpackId(this.k, slot * 4, f & F_DASHED) : this.sid.get(slot);
  }

  /**
   * @returns {Array<{id: string, p: number, d: number}>} matches, closest first
   * @param {{max?: number, type?: string, aspect?: number}} opts aspect: reject candidates whose aspect ratio differs by > 15%
   */
  find(hex, { max = 6, type, aspect } = {}) {
    if (!hex || hex.length !== 32) return [];
    const limit = Math.min(Math.max(max, 0), MAX_DISTANCE);
    if (++this.gen === 0xffffffff) { this.stamp.fill(0); this.gen = 1; }
    const gen = this.gen; const stamp = this.stamp; const w = this.w; const flags = this.flags; const asp = this.asp;
    const q0 = word(hex, 0); const q1 = word(hex, 8); const q2 = word(hex, 16); const q3 = word(hex, 24);
    const qw = [q0, q1, q2, q3];
    const wantVideo = type === 'video' ? 1 : (type ? 0 : -1);
    const out = [];
    for (let i = 0; i < 8; i++) {
      const qb = (qw[i >> 2] >>> (24 - 8 * (i & 3))) & 255;
      const b = i * 256 + qb;
      const a = this.bk[b]; if (!a) continue;
      const n = this.bn[b];
      for (let j = 0; j < n; j++) {
        const s = a[j];
        if (stamp[s] === gen) continue;
        stamp[s] = gen;
        if (wantVideo >= 0 && (flags[s] & F_VIDEO ? 1 : 0) !== wantVideo) continue;
        const ea = asp[s];
        if (aspect && ea && Math.abs(Math.log(aspect / ea)) > 0.15) continue;
        const o = s * 4;
        const p = pop32((q0 ^ w[o]) >>> 0) + pop32((q1 ^ w[o + 1]) >>> 0);
        if (p > limit) continue;
        const d = pop32((q2 ^ w[o + 2]) >>> 0) + pop32((q3 ^ w[o + 3]) >>> 0);
        if (d <= limit + 6) out.push({ id: this._id(s), p, d });
      }
    }
    return out.sort((x, y) => x.p + x.d - (y.p + y.d));
  }
}

module.exports = { PhashIndex, MAX_DISTANCE };
