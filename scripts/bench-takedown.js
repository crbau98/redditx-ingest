'use strict';
/**
 * Longest event-loop block while a takedown is applied, on a SYNTHETIC database (scripts/seed-scale.js). Works on whatever DB_PATH
 * points at and CHANGES it: give it a copy.
 *
 *   DB_PATH=/tmp/copy.db node scripts/bench-takedown.js [handle]
 *
 * Uses repo.takedowns.start() when it exists (chunked, as the admin route does), otherwise the one-shot add().
 */
const { performance } = require('perf_hooks');
if (!process.env.DB_PATH) { console.error('set DB_PATH to a copy of a synthetic database'); process.exit(2); }
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) process.exit(1);
process.env.NODE_ENV = 'test'; process.env.SCHEDULER_ENABLED = 'false';
const repo = require('../src/db/repo');
const handle = process.argv[2] || (repo.db.prepare("SELECT handle FROM creators ORDER BY media_count DESC LIMIT 1").get() || {}).handle;
let last = performance.now(); let worst = 0;
const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last - 2); last = t; }, 2);
(async () => {
  await new Promise((r) => setTimeout(r, 30)); worst = 0; last = performance.now();
  const t0 = performance.now();
  const chunked = typeof repo.takedowns.start === 'function';
  let out = chunked ? repo.takedowns.start({ kind: 'handle', value: handle, reason: 'bench' }) : repo.takedowns.add({ kind: 'handle', value: handle, reason: 'bench' });
  const returnedAfter = performance.now() - t0;
  while (chunked && !out.done) { await new Promise((r) => setTimeout(r, 20)); out = repo.takedowns.job(out.jobId); }
  const total = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 30)); clearInterval(tick);
  const rows = repo.db.prepare('SELECT COUNT(*) AS n FROM media').get().n;
  console.log(JSON.stringify({ mode: chunked ? 'chunked' : 'one-shot', rows, handle, purged: out.purged, requestReturnedMs: Math.round(returnedAfter), totalMs: Math.round(total), longestLoopBlockMs: Math.round(worst) }));
  process.exit(0);
})();
