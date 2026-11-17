'use strict';
/**
 * The boot build of the visual index on a SYNTHETIC library (scripts/seed-scale.js), as production runs it: the longest event-loop
 * block while warmIndex() runs, then the first "similar look" creator request (the per-creator profiles), then a first
 * "more like this". Read-only on DB_PATH.
 *
 *   DB_PATH=/tmp/scale.db node scripts/bench-visual-warm.js
 */
const { performance } = require('perf_hooks');
if (!process.env.DB_PATH) { console.error('set DB_PATH to a synthetic database'); process.exit(2); }
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) process.exit(1);
process.env.NODE_ENV = 'development'; process.env.SCHEDULER_ENABLED = 'false';
const repo = require('../src/db/repo');
const visual = require('../src/engine/visual');
let last = performance.now(); let worst = 0;
const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last - 2); last = t; }, 2);
const settle = () => new Promise((r) => setTimeout(r, 30));
const measure = async (fn) => {
  await settle(); worst = 0; last = performance.now();
  const t0 = performance.now(); let out = fn(); if (out && out.then) out = await out;
  for (let i = 0; i < 400; i++) { await settle(); if (!fn.until || fn.until()) break; } // background work the call started
  return { ms: Math.round(performance.now() - t0), longestBlockMs: Math.round(worst), out };
};
(async () => {
  await settle();
  const vectors = repo.db.prepare('SELECT COUNT(*) AS n FROM media_embeddings WHERE model = ?').get(visual._MODEL_ID).n;
  const rows = repo.db.prepare('SELECT MAX(seq) AS n FROM media').get().n;
  // a "more like this" request that arrives before the boot build is done (the old code built the whole index right there)
  const early = repo.db.prepare('SELECT media_id FROM media_embeddings WHERE model = ? LIMIT 1 OFFSET 5').get(visual._MODEL_ID).media_id;
  const e = await measure(() => visual.similar(early, 12));
  await visual.warmIndex(); // let a build that request started finish, so the next measurement is one build alone
  visual._reset();
  const w = await measure(() => visual.warmIndex());
  const creator = repo.db.prepare('SELECT creator_id FROM media m JOIN media_embeddings e ON e.media_id = m.id WHERE m.creator_id IS NOT NULL GROUP BY creator_id ORDER BY COUNT(*) DESC LIMIT 1').get().creator_id;
  const sc = () => visual.similarCreators(creator, 12); sc.until = () => visual.similarCreators(creator, 12) !== null;
  const p = await measure(sc);
  const mid = repo.db.prepare('SELECT media_id FROM media_embeddings WHERE model = ? LIMIT 1 OFFSET 1000').get(visual._MODEL_ID).media_id;
  const s = await measure(() => visual.similar(mid, 12));
  clearInterval(tick);
  console.log(JSON.stringify({ mediaRows: rows, vectors, similarBeforeWarm: { ms: e.ms, longestBlockMs: e.longestBlockMs, answered: Array.isArray(e.out) }, warmIndex: { ms: w.ms, longestBlockMs: w.longestBlockMs }, firstSimilarCreators: { ms: p.ms, longestBlockMs: p.longestBlockMs }, firstSimilar: { ms: s.ms, longestBlockMs: s.longestBlockMs } }));
  process.exit(0);
})();
