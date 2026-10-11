'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const config = require('../config');
const { migrate } = require('./schema');

if (config.dbPath !== ':memory:') fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -32000');

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

const migration = migrate(db);

module.exports = { db, migration };
