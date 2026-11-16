'use strict';
/**
 * WAL checkpoints, off the serving thread.
 *
 * The serving connection has wal_autocheckpoint = 0 (src/db/index.js), so nothing on the event loop ever copies WAL pages into the
 * database file. This timer watches the WAL's size and, past THRESHOLD, asks a worker thread (backup-worker, task 'checkpoint') for a
 * PASSIVE checkpoint on its own connection: it copies what no reader still needs, never blocks the writer, and the next commit
 * after a full checkpoint restarts the WAL from the top (journal_size_limit then trims the file).
 *
 * A PASSIVE checkpoint cannot restart the log while writes keep arriving, so past RESTART_BYTES the pass is a RESTART (the writer waits
 * only for the tail PASSIVE left). One checkpoint at a time. If the WAL keeps growing past WARN_BYTES (a reader holds an old snapshot, or the worker keeps failing)
 * it says so once an hour in the admin log: the WAL is the thing that fills the disk.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');
const events = require('./events');

const CHECK_MS = 15 * 1000;
const THRESHOLD = Number(process.env.WAL_CHECKPOINT_MB || 24) * 1048576; // about 6000 pages
const RESTART_BYTES = Number(process.env.WAL_RESTART_MB || 1024) * 1048576; // emergency only: sustained writes can keep a PASSIVE checkpoint from catching up, but a RESTART makes writers wait (about a second under a saturating write load)
const WARN_BYTES = 768 * 1048576;
const WORKER_TIMEOUT_MS = 5 * 60 * 1000;

let timer = null; let inflight = null; let lastWarn = 0;
const stats = { runs: 0, failures: 0, lastAt: null, lastMs: 0, lastWalMb: 0 };

const walFile = () => `${config.dbPath}-wal`;
function walBytes() { try { return fs.statSync(walFile()).size; } catch { return 0; } }

/** Run one PASSIVE checkpoint on the worker. Resolves with the worker's counters; never rejects. */
function run({ mode = 'PASSIVE' } = {}) {
  if (inflight) return inflight;
  const t0 = Date.now();
  inflight = new Promise((resolve) => {
    let w; let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(kill); resolve(r); };
    const kill = setTimeout(() => { try { w && w.terminate(); } catch { /* ignore */ } finish({ ok: false, error: 'timeout' }); }, WORKER_TIMEOUT_MS);
    kill.unref?.();
    try { w = new Worker(path.join(__dirname, 'backup-worker.js'), { workerData: { dbPath: config.dbPath, task: 'checkpoint', mode } }); } catch (e) { return finish({ ok: false, error: e.message }); }
    w.on('message', (m) => finish(m || { ok: false }));
    w.on('error', (e) => finish({ ok: false, error: e.message }));
    w.on('exit', () => finish({ ok: false, error: 'exited' }));
  }).then((r) => {
    stats.runs++; stats.lastAt = new Date().toISOString(); stats.lastMs = Date.now() - t0;
    if (!r.ok) { stats.failures++; events.log('WARN', `WAL checkpoint failed: ${r.error}`); }
    inflight = null;
    return r;
  });
  return inflight;
}

function tick() {
  const bytes = walBytes();
  stats.lastWalMb = Math.round(bytes / 1048576);
  if (bytes >= WARN_BYTES && Date.now() - lastWarn > 3600 * 1000) { lastWarn = Date.now(); events.log('WARN', `WAL is ${stats.lastWalMb} MB: checkpoints are not catching up (a long read transaction?)`); }
  // Past RESTART_BYTES the next pass is a RESTART: PASSIVE has already copied most of it, so the writer waits only for the tail.
  if (bytes >= THRESHOLD && !inflight) run({ mode: bytes >= RESTART_BYTES ? 'RESTART' : 'PASSIVE' });
}

function start() {
  if (timer || config.isTest || config.dbPath === ':memory:' || process.env.PRISM_AUTOCHECKPOINT === '1') return;
  timer = setInterval(tick, CHECK_MS);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, run, tick, walBytes, stats, THRESHOLD, RESTART_BYTES };
