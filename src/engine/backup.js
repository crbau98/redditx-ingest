'use strict';
/**
 * Database backups. `VACUUM INTO` writes a consistent, compacted copy while the
 * app keeps serving (safe with WAL), so there is never a window with a
 * half-written file. Old backups are pruned to `backupKeep`.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db');
const settingsStore = require('../settings');
const events = require('./events');

const dir = () => path.join(config.dataDir, 'backups');
const enabled = () => config.dbPath !== ':memory:';
let timer = null;

function list() {
  if (!enabled() || !fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter((f) => /^prism-.*\.db$/.test(f)).map((name) => {
    const st = fs.statSync(path.join(dir(), name));
    return { name, size: st.size, createdAt: st.mtime.toISOString() };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

function prune(keep) {
  for (const b of list().slice(Math.max(1, keep))) {
    try { fs.unlinkSync(path.join(dir(), b.name)); } catch { /* ignore */ }
  }
}

function run() {
  if (!enabled()) throw new Error('Backups are unavailable for an in-memory database');
  fs.mkdirSync(dir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const name = `prism-${stamp}.db`;
  const file = path.join(dir(), name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.prepare('VACUUM INTO ?').run(file);
  prune(settingsStore.get().backupKeep);
  const size = fs.statSync(file).size;
  events.log('OK', `Database backup written: ${name} (${(size / 1048576).toFixed(1)} MB)`);
  return { name, size };
}

/** Daily housekeeping: backup (if enabled), refresh query-planner stats, trim the WAL. */
function nightly() {
  try {
    if (settingsStore.get().backupEnabled) run();
    db.pragma('optimize');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) { events.log('ERR', `nightly maintenance failed: ${e.message}`); }
}

function start() {
  if (timer || !enabled()) return;
  timer = setInterval(nightly, 24 * 3600 * 1000);
  timer.unref();
  // Take the first backup shortly after boot if the newest is older than a day.
  setTimeout(() => {
    const newest = list()[0];
    if (settingsStore.get().backupEnabled && (!newest || Date.now() - new Date(newest.createdAt) > 23 * 3600 * 1000)) nightly();
  }, 90 * 1000).unref();
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { run, list, prune, nightly, start, stop, dir };
