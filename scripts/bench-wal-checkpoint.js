'use strict';
/**
 * Longest single write while a WAL builds up, with and without inline checkpoints, on a SYNTHETIC database (it WRITES to it).
 *
 *   DB_PATH=/tmp/copy.db node scripts/bench-wal-checkpoint.js inline|offthread [updates]
 *
 * inline      wal_autocheckpoint = 4000, as the serving connection ran before: the commit that crosses the threshold copies the pages.
 * offthread   wal_autocheckpoint = 0 and engine/checkpoint.js (a worker thread) checkpoints when the WAL passes its threshold.
 * The workload is face-sweep-shaped: single-row UPDATEs on random rows (each dirties its own pages) in small transactions.
 */
const fs = require('fs');
const { performance } = require('perf_hooks');
if (!process.env.DB_PATH) { console.error('set DB_PATH to a copy of a synthetic database'); process.exit(2); }
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) process.exit(1);
process.env.NODE_ENV = 'development'; process.env.SCHEDULER_ENABLED = 'false';
const mode = process.argv[2] === 'offthread' ? 'offthread' : 'inline';
const N = Number(process.argv[3]) || 30000;
const PAUSE_MS = Number(process.env.PAUSE_MS === undefined ? 20 : process.env.PAUSE_MS); // a pause after every 50 writes: a sweep or feed batch, not a saturating loop
if (mode === 'inline') process.env.PRISM_AUTOCHECKPOINT = '1';
const { db } = require('../src/db');
const cp = require('../src/engine/checkpoint');
const ids = db.prepare('SELECT id FROM media ORDER BY random() LIMIT ?').all(N).map((r) => r.id);
const upd = db.prepare('UPDATE media SET face_at = ? WHERE id = ?');
db.pragma('wal_checkpoint(TRUNCATE)');
let worst = 0; let slow = 0; const times = [];
(async () => {
  const t0 = performance.now();
  for (let i = 0; i < ids.length; i++) {
    const s = performance.now();
    upd.run(new Date().toISOString(), ids[i]); // autocommit: one commit per row, like the face sweep
    const ms = performance.now() - s;
    times.push(ms); worst = Math.max(worst, ms); if (ms > 100) slow++;
    if (mode === 'offthread' && i % 200 === 0) cp.tick();
    if (i % 50 === 49) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, updates: N, walMbAtEnd: Math.round((fs.existsSync(`${process.env.DB_PATH}-wal`) ? fs.statSync(`${process.env.DB_PATH}-wal`).size : 0) / 1048576), p99Ms: +times[Math.floor(N * 0.99)].toFixed(2), worstMs: Math.round(worst), writesOver100ms: slow, totalSec: Math.round((performance.now() - t0) / 100) / 10, checkpointRuns: cp.stats.runs }));
  process.exit(0);
})();
