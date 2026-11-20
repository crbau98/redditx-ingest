'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('../config');
const { migrate } = require('./schema');

if (config.dbPath !== ':memory:') fs.mkdirSync(config.dataDir, { recursive: true });

// PRISM_DB_READONLY=1: the aggregate worker thread (src/lib/aggregate-worker.js). It reads only, so it
// never migrates, writes pragmas, or runs the planner refresh below; the main thread owns all of that.
const READONLY = config.dbReadonly;
const db = READONLY
  ? new Database(config.dbPath, { readonly: true, fileMustExist: true })
  : new Database(config.dbPath);
if (!READONLY) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
}
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
// Memory per connection, tunable with SQLITE_CACHE_MB / SQLITE_MMAP_MB (main) and SQLITE_WORKER_* (read-only worker): see config.
// Was 128 MB cache + 1 GB mmap on EVERY connection, the aggregate worker included.
const { cacheMb, mmapMb } = config.sqliteMemory;
db.pragma(`cache_size = -${cacheMb * 1024}`);
db.pragma(`mmap_size = ${mmapMb * 1024 * 1024}`);
db.pragma('temp_store = MEMORY');
// WAL tuning for a write-heavy ingest on a small box. The serving connection NEVER checkpoints inline (wal_autocheckpoint = 0):
// with the default rule the commit that crossed the page threshold copied up to 4000 pages (16 MB) to the data volume before it
// returned, on the event loop, and a one-row UPDATE showed up as a 1.4 s block. engine/checkpoint.js runs the checkpoint on a worker
// thread instead (PASSIVE: it never blocks a writer), and the nightly backup worker checkpoints as well. After a checkpoint resets
// the log, the first commit truncates the WAL to journal_size_limit (64 MB, WAL_JOURNAL_LIMIT_MB): the 2026-11-18 patrol found it
// parked at the old 256 MB limit because a RESTART was only ever tried past 1 GB. Tests and :memory: keep SQLite's own rule.
if (!READONLY) {
  db.pragma(config.isTest || config.dbPath === ':memory:' || process.env.PRISM_AUTOCHECKPOINT === '1' ? 'wal_autocheckpoint = 4000' : 'wal_autocheckpoint = 0');
  db.pragma(`journal_size_limit = ${Math.max(1, Number(process.env.WAL_JOURNAL_LIMIT_MB) || 64) * 1048576}`);
}

// Deterministic pseudo-random order that is stable for a given seed, so
// "shuffle" can be paginated without repeats.
db.function('hash_seed', { deterministic: true }, (id, seed) => {
  let h = (2166136261 ^ (seed | 0)) >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
});

// Time-decayed popularity used by the "Trending" sort — shared with the maintenance worker.
require('./functions').hotScore(db);

const migration = READONLY ? null : migrate(db);

// (Read-only worker connections skip this: the PRAGMAs need a write, fail, and the catch below absorbs it.)
// Planner statistics. Without them SQLite assumes "publish_state = 'published'" is selective and
// sorts the whole library instead of walking the right index (ids / community / creator lookups
// measured 20-50x slower on a 60k-item library). optimize=0x10002 analyses whatever needs it at open
// (bounded by analysis_limit, so it stays cheap). The nightly backup worker re-runs it off the main thread
// (engine/backup-worker.js); a 6-hourly re-run here blocked the loop for 5.5 s on production.
try { db.exec('PRAGMA analysis_limit = 400; PRAGMA optimize = 0x10002;'); } catch { /* older SQLite: harmless */ }

module.exports = { db, migration };
