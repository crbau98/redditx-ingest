'use strict';
/**
 * Database backups. `VACUUM INTO` writes a consistent, compacted copy while the app keeps serving
 * (safe with WAL), so there is never a window with a half-written file. Old backups are pruned to
 * `backupKeep`.
 *
 * In production the whole nightly job (backup, planner optimize, WAL checkpoint) runs on a worker
 * thread: it is synchronous SQLite work and used to freeze the serving event loop. Tests and
 * in-memory databases keep the inline path so they stay deterministic.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');
const { db } = require('../db');
const settingsStore = require('../settings');
const events = require('./events');

const dir = () => path.join(config.dataDir, 'backups');
const enabled = () => config.dbPath !== ':memory:';
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;
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

function stamp() {
  const s = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  return `prism-${s}.db`;
}

/** The old path: one connection, all work inline. Tests and `:memory:` use it. */
function runInline(file) {
  if (file) db.prepare('VACUUM INTO ?').run(file);
  db.pragma('optimize');
  db.pragma('wal_checkpoint(PASSIVE)');
  return file ? { name: path.basename(file), size: fs.statSync(file).size } : { name: null, size: 0 };
}

/** Production path: backup + optimize + checkpoint on their own connection and thread. */
function runOnWorker(file, task = 'backup') {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'backup-worker.js'), { workerData: { dbPath: config.dbPath, file, task } });
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      w.terminate().catch(() => {});
      finish(reject, new Error('backup worker did not finish within 10 minutes'));
    }, WORKER_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    w.on('message', (msg) => {
      if (!msg || !msg.ok) return finish(reject, new Error((msg && msg.error) || 'backup worker failed'));
      finish(resolve, { name: file ? path.basename(file) : null, size: msg.size || 0, updated: msg.updated || 0 });
    });
    w.on('error', (e) => finish(reject, e));
    w.on('exit', (code) => { if (code !== 0) finish(reject, new Error(`backup worker exited ${code}`)); });
  });
}

/**
 * Run the nightly job. In production this resolves only after the worker finished; in tests it
 * returns the result synchronously (await still works).
 */
function run({ backup = true } = {}) {
  if (!backup) {
    if (!enabled()) return { name: null, size: 0 };
    if (config.isTest || process.env.PRISM_BACKUP_INLINE === '1') return runInline(null);
    return runOnWorker(null);
  }
  if (!enabled()) throw new Error('Backups are unavailable for an in-memory database');
  if (require('../lib/diskguard').paused()) throw new Error('Backup skipped: the data volume is nearly full');
  fs.mkdirSync(dir(), { recursive: true });
  const name = stamp();
  const file = path.join(dir(), name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  if (config.isTest || process.env.PRISM_BACKUP_INLINE === '1') {
    const out = runInline(file);
    prune(settingsStore.get().backupKeep);
    events.log('OK', `Database backup written: ${out.name} (${(out.size / 1048576).toFixed(1)} MB)`);
    return out;
  }
  return runOnWorker(file).then((out) => {
    prune(settingsStore.get().backupKeep);
    events.log('OK', `Database backup written: ${out.name} (${(out.size / 1048576).toFixed(1)} MB)`);
    return out;
  });
}

/** The trending-score refresh, off the serving thread (engine/engine.js calls this every ten minutes). */
function hotScore() {
  if (!enabled() || config.isTest || process.env.PRISM_BACKUP_INLINE === '1') return Promise.resolve({ updated: 0 });
  return runOnWorker(null, 'hot');
}

/** Daily housekeeping: backup (if enabled), planner stats and WAL trim on the worker. */
async function nightly() {
  try {
    if (settingsStore.get().backupEnabled) await run();
    else await run({ backup: false });
  } catch (e) { events.log('ERR', `nightly maintenance failed: ${e.message}`); }
}

function start() {
  if (timer || !enabled()) return;
  timer = setInterval(() => { nightly().catch(() => {}); }, 24 * 3600 * 1000);
  timer.unref();
  // First backup not shortly after boot: the deploy itself already restarted SQLite and the first backup
  // with ONLINE BACKUP still holds a read transaction that makes every main-thread query wait up to busy_timeout
  // (10s). That showed as a 55s stall on the 700k-row prod DB. Wait 30 min, then only if the newest is older than a day.
  setTimeout(() => {
    const newest = list()[0];
    if (settingsStore.get().backupEnabled && (!newest || Date.now() - new Date(newest.createdAt) > 23 * 3600 * 1000)) {
      nightly().catch(() => {});
    }
  }, 30 * 60 * 1000).unref();
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { run, hotScore, list, prune, nightly, start, stop, dir };
