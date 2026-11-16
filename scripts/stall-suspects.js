'use strict';
/**
 * Event-loop stall suspects at production shape, on a SYNTHETIC database (build one with scripts/seed-scale.js).
 *
 *   DB_PATH=/tmp/scale.db node scripts/stall-suspects.js [suspect ...]
 *
 * It adds a synthetic feed_runs history (RUNS rows, default 1.5M over 45 days) to that file once, then runs each background job
 * the server runs on a timer and prints the longest event-loop block it caused (monitorEventLoopDelay max, 1 ms resolution).
 * Refuses a hosted environment. Never reads or copies a production database.
 */
const { performance } = require('perf_hooks');
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) { console.error('refusing to run on a hosted environment'); process.exit(1); }
if (!process.env.DB_PATH) { console.error('set DB_PATH to a synthetic database'); process.exit(2); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SCHEDULER_ENABLED = 'false';
const RUNS = Number(process.env.RUNS) || 1500000;
const repo = require('../src/db/repo');
const { db } = repo;

function seedRuns() {
  const have = db.prepare('SELECT COUNT(*) AS n FROM feed_runs').get().n;
  if (have >= RUNS * 0.9) return have;
  const feeds = db.prepare('SELECT id FROM feeds').all().map((f) => f.id);
  if (!feeds.length) throw new Error('the database has no feeds: run scripts/seed-scale.js first');
  const ins = db.prepare("INSERT INTO feed_runs (id, feed_id, trigger, started_at, finished_at, status, fetched, added, dupes, skipped, blocked, review, duration_ms) VALUES (?, ?, 'schedule', ?, ?, 'ok', ?, ?, 0, 0, 0, 0, 900)");
  const now = Date.now();
  db.pragma('synchronous = OFF');
  let i = have;
  while (i < RUNS) {
    db.transaction(() => { for (let k = 0; k < 20000 && i < RUNS; k++, i++) { const t = new Date(now - (i * 45 * 86400000) / RUNS).toISOString(); ins.run(`bench-run-${now}-${i}`, feeds[i % feeds.length], t, t, i % 3, i % 11 === 0 ? 1 : 0); } })();
  }
  return i;
}

const physique = require('../src/engine/physique');
const PHYS = { physiqueFilter: true, physiqueThreshold: 45, physiqueCreatorShare: 30 };
const SUSPECTS = {
  'runs.prune legacy (one DELETE)': () => db.prepare('DELETE FROM feed_runs WHERE started_at < ?').run(new Date(Date.now() - 30 * 86400000).toISOString()),
  'runs.prune(30) first pass': () => repo.runs.prune(30),
  'runs.prune(30) steady state': () => repo.runs.prune(30),
  'physique.reapply (sync)': () => physique.reapply(PHYS),
  'physique.reapplyAsync': () => physique.reapplyAsync(PHYS),
  'sourcehealth.retireDead (dry)': () => require('../src/engine/sourcehealth').retireDead({ dryRun: true }),
  'popularity.recompute': () => require('../src/engine/popularity').recompute({ force: true }),
  'maintenance.faceSweepProgress': () => require('../src/engine/maintenance').faceSweepProgress(),
  'maintenance.hashSweepProgress': () => require('../src/engine/maintenance').hashSweepProgress(),
  'maintenance.imageSweepProgress': () => require('../src/engine/maintenance').imageSweepProgress(),
  'maintenance.physiqueSweepProgress': () => require('../src/engine/maintenance').physiqueSweepProgress(),
  'repo.media.recomputeHotChunked (inline)': () => repo.media.recomputeHotChunked(),
};

async function main() {
  const want = process.argv.slice(2);
  console.log(`feed_runs rows: ${seedRuns()}, media rows: ${db.prepare('SELECT COUNT(*) AS n FROM media').get().n}`);
  const out = [];
  for (const [name, fn] of Object.entries(SUSPECTS)) {
    if (want.length && !want.some((w) => name.includes(w))) continue;
    // the longest gap between two 2 ms timer ticks while the job runs and settles: the stall every request would have waited behind
    let last = performance.now(); let worst = 0;
    const tick = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last - 2); last = n; }, 2);
    await new Promise((r) => setTimeout(r, 20)); worst = 0; last = performance.now();
    const t = performance.now(); let err = null; let syncMs;
    try { const p = fn(); syncMs = performance.now() - t; await p; } catch (e) { err = e.message; syncMs = syncMs ?? performance.now() - t; }
    const total = performance.now() - t;
    await new Promise((r) => setTimeout(r, 30));
    clearInterval(tick);
    const h = { max: worst * 1e6 };
    out.push({ suspect: name, totalMs: Math.round(total), firstSyncStretchMs: Math.round(syncMs), longestLoopBlockMs: Math.round(h.max / 1e6), err });
    console.log(JSON.stringify(out[out.length - 1]));
  }
}
main().then(() => process.exit(0));
