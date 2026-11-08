'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('../config');
const { migrate } = require('./schema');

if (config.dbPath !== ':memory:') fs.mkdirSync(config.dataDir, { recursive: true });

// PRISM_DB_READONLY=1: the aggregate worker thread (src/lib/aggregate-worker.js). It reads only, so it
// never migrates, writes pragmas, or runs the planner refresh below; the main thread owns all of that.
const READONLY = process.env.PRISM_DB_READONLY === '1';
const db = READONLY
  ? new Database(config.dbPath, { readonly: true, fileMustExist: true })
  : new Database(config.dbPath);
if (!READONLY) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
}
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -131072'); // 128 MB page cache (was 32 MB: cold searches paid for disk reads)
db.pragma('mmap_size = 1073741824');
db.pragma('temp_store = MEMORY');
// WAL tuning for a write-heavy ingest on a small box: checkpoint less often (fewer I/O pauses) and cap the
// WAL at 256 MB so a long ingestion cannot grow it without bound (the nightly worker checkpoints it anyway).
if (!READONLY) {
  db.pragma('wal_autocheckpoint = 4000');
  db.pragma('journal_size_limit = 268435456');
}

// Deterministic pseudo-random order that is stable for a given seed, so
// "shuffle" can be paginated without repeats.
db.function('hash_seed', { deterministic: true }, (id, seed) => {
  let h = (2166136261 ^ (seed | 0)) >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
});

// Time-decayed popularity used by the "Trending" sort.
db.function('hot_score', { deterministic: true }, (score, likes, views, postedAtMs, nowMs) => {
  const ageDays = Math.max(0, (nowMs - postedAtMs) / 86400000);
  const pop = Math.log1p(Math.max(0, score || 0)) + 1.5 * Math.log1p((likes || 0) * 5 + (views || 0) * 0.2) + 1;
  return pop / Math.pow(ageDays + 1.5, 0.9);
});
db.function('epoch_ms', { deterministic: true }, (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
});

const migration = READONLY ? null : migrate(db);

// (Read-only worker connections skip this: the PRAGMAs need a write, fail, and the catch below absorbs it.)
// Planner statistics. Without them SQLite assumes "publish_state = 'published'" is selective and
// sorts the whole library instead of walking the right index (ids / community / creator lookups
// measured 20-50x slower on a 60k-item library). optimize=0x10002 analyses whatever needs it at open
// (bounded by analysis_limit, so it stays cheap); a light re-run every 6 hours keeps it current.
try { db.exec('PRAGMA analysis_limit = 400; PRAGMA optimize = 0x10002;'); } catch { /* older SQLite: harmless */ }
setInterval(() => { try { db.exec('PRAGMA optimize;'); } catch { /* ignore */ } }, 6 * 3600 * 1000).unref();

module.exports = { db, migration };
