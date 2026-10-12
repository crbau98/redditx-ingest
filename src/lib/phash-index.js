'use strict';
/**
 * In-memory nearest-neighbour index over stored perceptual hashes (lib/phash).
 *
 * "Which stored picture is within k bits of this one?" must answer in microseconds because it runs for every ingested
 * item. Multi-index hashing does it: the 64-bit pHash is cut into 8 bytes; two hashes within 7 bits of each other must
 * share at least one identical byte (pigeonhole), so a lookup only inspects the few ids that share a byte value, and then
 * verifies them with the exact distance test. Memory is a few dozen bytes per picture, so a million-item library fits.
 */
const phash = require('./phash');

const MAX_DISTANCE = 7; // the pigeonhole guarantee ends here (8 chunks)

function pop32(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
const words = (hex) => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0, parseInt(hex.slice(16, 24), 16) >>> 0, parseInt(hex.slice(24, 32), 16) >>> 0];

class PhashIndex {
  constructor() { this.entries = new Map(); this.buckets = new Map(); }

  get size() { return this.entries.size; }

  static chunks(hex) { const out = new Array(8); for (let i = 0; i < 8; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }

  /** @param {{type?: string, aspect?: number}} meta type groups comparison (image vs video poster); aspect = width/height */
  add(id, hex, meta = {}) {
    if (!hex || hex.length !== 32) return;
    this.remove(id);
    // compact entry: the four 32-bit words, a type flag and the aspect ratio (chunks are re-derived from the hash when needed)
    this.entries.set(id, { w: Uint32Array.from(words(hex)), hex, t: meta.type === 'video' ? 1 : 0, a: meta.aspect || 0 });
    const ch = PhashIndex.chunks(hex);
    for (let i = 0; i < 8; i++) {
      const k = i * 256 + ch[i];
      const arr = this.buckets.get(k);
      if (arr) arr.push(id); else this.buckets.set(k, [id]);
    }
  }

  remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    const ch = PhashIndex.chunks(e.hex);
    for (let i = 0; i < 8; i++) {
      const k = i * 256 + ch[i];
      const arr = this.buckets.get(k);
      if (!arr) continue;
      const at = arr.indexOf(id);
      if (at >= 0) { arr[at] = arr[arr.length - 1]; arr.pop(); }
      if (!arr.length) this.buckets.delete(k);
    }
    this.entries.delete(id);
  }

  /**
   * @returns {Array<{id: string, p: number, d: number}>} matches, closest first
   * @param {{max?: number, type?: string, aspect?: number}} opts aspect: reject candidates whose aspect ratio differs by > 15%
   */
  find(hex, { max = 6, type, aspect } = {}) {
    if (!hex || hex.length !== 32) return [];
    const limit = Math.min(Math.max(max, 0), MAX_DISTANCE);
    const seen = new Set(); const out = [];
    const q = words(hex);
    PhashIndex.chunks(hex).forEach((c, i) => {
      const set = this.buckets.get(i * 256 + c);
      if (!set) return;
      for (const id of set) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = this.entries.get(id);
        if (type && (e.t === 1 ? 'video' : 'image') !== type) continue;
        if (aspect && e.a && Math.abs(Math.log(aspect / e.a)) > 0.15) continue;
        const p = pop32((q[0] ^ e.w[0]) >>> 0) + pop32((q[1] ^ e.w[1]) >>> 0);
        if (p > limit) continue;
        const d = pop32((q[2] ^ e.w[2]) >>> 0) + pop32((q[3] ^ e.w[3]) >>> 0);
        if (d <= limit + 6) out.push({ id, p, d });
      }
    });
    return out.sort((a, b) => a.p + a.d - (b.p + b.d));
  }
}

module.exports = { PhashIndex, MAX_DISTANCE };
