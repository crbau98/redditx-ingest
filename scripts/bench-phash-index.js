'use strict';
/**
 * Memory and loop-block benchmark for the in-memory perceptual-hash index at library scale, on SYNTHETIC rows only.
 *
 *   node --expose-gc scripts/bench-phash-index.js [rows] [legacy-index.js]
 *
 * `legacy-index.js` is an older src/lib/phash-index.js (git show <rev>:src/lib/phash-index.js) to compare against.
 * Reports heap/rss after a full GC, the longest single synchronous stretch while loading in 5000-row chunks,
 * the longest stretch of a forced full GC (what a major collection costs with the index resident),
 * and the mean lookup time.
 */
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const rows = Number(process.argv[2]) || 1000000;
const legacy = process.argv[3];
if (!global.gc) { console.error('run with node --expose-gc'); process.exit(2); }
const { PhashIndex } = legacy ? require(require('path').resolve(legacy)) : require('../src/lib/phash-index');

const rnd = crypto.randomBytes(rows * 32); // ids (16 B) + hash (16 B) per row
const hex = (o, n) => rnd.toString('hex', o, o + n);
const uuid = (o) => { const h = hex(o, 16); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const mb = (b) => Math.round(b / 1048576);
const mem = () => { global.gc(); const m = process.memoryUsage(); return { heapMB: mb(m.heapUsed), arrayBuffersMB: mb(m.arrayBuffers), rssMB: mb(m.rss) }; };

const before = mem();
const ix = new PhashIndex();
let worst = 0; const CHUNK = 5000;
const t0 = performance.now();
for (let base = 0; base < rows; base += CHUNK) {
  const s = performance.now();
  for (let i = base; i < Math.min(rows, base + CHUNK); i++) ix.add(uuid(i * 32), hex(i * 32 + 16, 16), { type: i % 9 === 0 ? 'video' : 'image', aspect: 1 + (i % 7) / 10 });
  worst = Math.max(worst, performance.now() - s);
}
const loadMs = performance.now() - t0;
const after = mem();
const g = performance.now(); global.gc(); const gcMs = performance.now() - g;
let hits = 0; const q = performance.now();
for (let i = 0; i < 200; i++) hits += ix.find(hex(((i * 4999) % rows) * 32 + 16, 16), { max: 6, type: 'image' }).length;
const findMs = (performance.now() - q) / 200;
console.log(JSON.stringify({
  impl: legacy ? 'legacy' : 'packed', rows, size: ix.size,
  heapMB: after.heapMB - before.heapMB, arrayBuffersMB: after.arrayBuffersMB - before.arrayBuffersMB, rssMB: after.rssMB - before.rssMB,
  bytesPerRow: Math.round(((after.heapMB - before.heapMB) + (after.arrayBuffersMB - before.arrayBuffersMB)) * 1048576 / rows),
  loadSec: Math.round(loadMs / 100) / 10, worst5000RowChunkMs: Math.round(worst), fullGcMs: Math.round(gcMs), meanFindMs: Math.round(findMs * 100) / 100, hits,
}));
