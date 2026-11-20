'use strict';
/**
 * WAL checkpoints, off the serving thread.
 *
 * The serving connection has wal_autocheckpoint = 0 (src/db/index.js), so nothing on the event loop ever copies WAL pages into the
 * database file. This timer watches the WAL's size and, past THRESHOLD, asks a worker thread (backup-worker, task 'checkpoint') for a
 * PASSIVE checkpoint on its own connection: it copies what no reader still needs, never waits for anyone and never blocks the writer.
 *
 * PASSIVE cannot restart the log while writes keep arriving, so a WAL under sustained writes grows. Past RESTART_BYTES a RESTART is
 * tried as well, but only ever as a try: the worker runs it with busy_timeout = 0, so when a reader holds a snapshot (the usual reason the
 * WAL is big) or a writer is mid-commit it returns `busy` at once, the writer lock is never held while waiting, and the next try waits
 * longer (RESTART_BACKOFF_MS, doubling to five minutes). A RESTART that does run waits for nobody; it copies only the tail PASSIVE left.
 * The trigger sits below the journal_size_limit (48 MB vs 64 MB), not far above it: a busy try costs almost nothing, and the 2026-11-18 patrol found
 * the WAL parked at 256 MB for hours because the old 1 GB trigger never fired while the aggregate worker kept reading. After a successful
 * reset the first commit truncates the file to the limit, so frequent safe tries are what keep the steady state small.
 *
 * Nothing escalates silently: the WAL size, the last successful checkpoint and the last busy RESTART are in `status()`, and
 * GET /api/admin/health turns them into warnings (the patrol reads those). The admin log gets at most one line an hour.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');
const events = require('./events');

const CHECK_MS = 15 * 1000;
const THRESHOLD = Number(process.env.WAL_CHECKPOINT_MB || 24) * 1048576; // about 6000 pages
const RESTART_BYTES = Number(process.env.WAL_RESTART_MB || 48) * 1048576;
const WARN_BYTES = Number(process.env.WAL_WARN_MB || 768) * 1048576;
const STALE_OK_MS = 10 * 60 * 1000; // a WAL over THRESHOLD with no successful checkpoint for this long is reported
const RESTART_BACKOFF_MS = [45 * 1000, 90 * 1000, 3 * 60 * 1000, 5 * 60 * 1000];
const WORKER_TIMEOUT_MS = 5 * 60 * 1000;

let timer = null; let inflight = null; let lastWarn = 0;
let restartBusyCount = 0; let restartNotBefore = 0;
const stats = { runs: 0, failures: 0, lastAt: null, lastOkAt: null, lastMs: 0, lastWalMb: 0, lastRestartAt: null, lastRestartBusyAt: null, restartBusy: 0 };

const walFile = () => `${config.dbPath}-wal`;
function walBytes() { try { return fs.statSync(walFile()).size; } catch { return 0; } }

/** Run one checkpoint on the worker. Resolves with the worker's counters; never rejects. */
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
    const now = new Date().toISOString();
    stats.runs++; stats.lastAt = now; stats.lastMs = Date.now() - t0;
    if (!r.ok) {
      stats.failures++;
      if (Date.now() - lastWarn > 3600 * 1000) { lastWarn = Date.now(); events.log('WARN', `WAL checkpoint failed: ${r.error}`); }
    } else if (r.mode === 'RESTART' || r.mode === 'TRUNCATE') {
      stats.lastRestartAt = now;
      if (r.busy) { // a reader or writer was in the way: nothing was waited for, nothing was held; retry later, less often
        stats.restartBusy++; stats.lastRestartBusyAt = now;
        restartNotBefore = Date.now() + RESTART_BACKOFF_MS[Math.min(restartBusyCount, RESTART_BACKOFF_MS.length - 1)];
        restartBusyCount++;
      } else { restartBusyCount = 0; restartNotBefore = 0; stats.lastOkAt = now; }
    } else stats.lastOkAt = now;
    inflight = null;
    return r;
  });
  return inflight;
}

function tick() {
  const bytes = walBytes();
  stats.lastWalMb = Math.round(bytes / 1048576);
  if (bytes >= WARN_BYTES && Date.now() - lastWarn > 3600 * 1000) { lastWarn = Date.now(); events.log('WARN', `WAL is ${stats.lastWalMb} MB: checkpoints are not catching up (a long read transaction?)`); }
  if (bytes < THRESHOLD || inflight) return;
  // PASSIVE is the normal path; a RESTART is only ever a try, and only once the previous busy one has had its back-off
  run({ mode: bytes >= RESTART_BYTES && Date.now() >= restartNotBefore ? 'RESTART' : 'PASSIVE' });
}

/** What the admin health endpoint shows, and the warnings the patrol reads. */
function status() {
  const bytes = walBytes();
  const mb = Math.round(bytes / 1048576);
  const warnings = [];
  const okAge = stats.lastOkAt ? Date.now() - Date.parse(stats.lastOkAt) : Infinity;
  if (bytes >= WARN_BYTES) warnings.push(`WAL is ${mb} MB (last successful checkpoint ${stats.lastOkAt || 'never since boot'}${stats.lastRestartBusyAt ? `; a RESTART found a reader at ${stats.lastRestartBusyAt}` : ''}): checkpoints are not catching up, a long read transaction or a failing worker`);
  else if (bytes >= THRESHOLD && okAge > STALE_OK_MS && timer && (stats.lastOkAt || process.uptime() * 1000 > STALE_OK_MS)) warnings.push(`WAL is ${mb} MB and no checkpoint has succeeded for ${okAge === Infinity ? 'this whole run' : `${Math.round(okAge / 60000)} min`}`);
  return { walMb: mb, thresholdMb: Math.round(THRESHOLD / 1048576), restartAtMb: Math.round(RESTART_BYTES / 1048576), running: !!inflight, restartRetryAt: restartNotBefore ? new Date(restartNotBefore).toISOString() : null, ...stats, warnings };
}

function start() {
  if (timer || config.isTest || config.dbPath === ':memory:' || process.env.PRISM_AUTOCHECKPOINT === '1') return;
  timer = setInterval(tick, CHECK_MS);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
/** Test seam: forget back-off state. */
function _reset() { restartBusyCount = 0; restartNotBefore = 0; lastWarn = 0; Object.assign(stats, { runs: 0, failures: 0, lastAt: null, lastOkAt: null, lastRestartAt: null, lastRestartBusyAt: null, restartBusy: 0 }); }

module.exports = { start, stop, run, tick, walBytes, stats, status, THRESHOLD, RESTART_BYTES, RESTART_BACKOFF_MS, _reset };
