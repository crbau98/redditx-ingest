'use strict';
/**
 * Disk watchdog for the data volume.
 *
 * On 2026-11-03 the 50 GB volume filled in about five hours (media written under /data/store, no bucket configured), SQLite then
 * failed to open its WAL (SQLITE_IOERR_SHMSIZE) and the site was down for 28 minutes. Nothing noticed until the disk was full.
 *
 *   ok       below `warnAtPct`
 *   warn     at or above `warnAtPct`: logged once, nothing is stopped
 *   paused   at or above `pauseAtPct`, or less than `minFreeMb` free: everything that writes bulk data to the volume stops
 *            (the scheduler starts no feed, the object store refuses disk writes, videos are not kept, the image cache and the
 *            database backup are skipped). The site keeps serving and the database keeps its headroom for the WAL.
 *            It resumes by itself once usage is back under `resumeAtPct` (hysteresis: no flapping at the line).
 *
 * `budgetGb` caps the volume PRISM may use below what the platform reports (0 = the whole volume). Capacity comes from
 * statfs(); if the platform does not report it, the guard stays out of the way (fail-open) and says so once.
 */
const fs = require('fs');
const config = require('../config');

const GB = 1024 ** 3;
const TTL_MS = 10 * 1000; // statfs is cheap, but not worth one call per file written

const state = { level: 'ok', since: Date.now(), checkedAt: 0, snap: null, timer: null, warnedUnknown: false, listeners: [] };
let statfs = (dir) => fs.statfsSync(dir); // replaced in tests
let overridden = false; // tests read a fake volume; the real one (the developer's disk) must never pause the suite

const cfg = () => ({ ...config.disk });

/** Raw numbers for the data volume, or null when the platform does not report them. */
function measure() {
  const c = cfg();
  let s;
  if (config.isTest && !overridden) return null;
  try { s = statfs(config.dataDir); } catch { s = null; }
  if (!s || !(Number(s.blocks) > 0) || !(Number(s.bsize) > 0)) return null;
  const bsize = Number(s.bsize);
  const volumeTotal = Number(s.blocks) * bsize;
  const free = Number(s.bavail) * bsize;
  const used = volumeTotal - Number(s.bfree) * bsize;
  const total = c.budgetGb > 0 ? Math.min(volumeTotal, c.budgetGb * GB) : volumeTotal;
  const effectiveFree = c.budgetGb > 0 ? Math.min(free, Math.max(0, total - used)) : free;
  return { total, used, free: effectiveFree, usedPct: Math.min(100, (100 * (total - effectiveFree)) / total) };
}

function decide(snap, prev) {
  const c = cfg();
  const low = snap.free < c.minFreeMb * 1024 * 1024;
  if (snap.usedPct >= c.pauseAtPct || low) return 'paused';
  if (prev === 'paused' && snap.usedPct >= c.resumeAtPct) return 'paused'; // hysteresis
  if (snap.usedPct >= c.warnAtPct) return 'warn';
  return 'ok';
}

function describe(snap) {
  return `${snap.usedPct.toFixed(1)}% used, ${(snap.free / GB).toFixed(1)} GB free of ${(snap.total / GB).toFixed(1)} GB`;
}

/** Re-read the volume (at most once per TTL unless forced) and move the state machine. */
function refresh({ force = false } = {}) {
  if (!force && Date.now() - state.checkedAt < TTL_MS) return state.level;
  state.checkedAt = Date.now();
  const snap = measure();
  if (!snap) {
    if (!state.warnedUnknown) { state.warnedUnknown = true; try { require('../engine/events').log('WARN', 'Disk guard: the data volume does not report its size, so it cannot protect it'); } catch { /* early boot */ } }
    state.snap = null;
    return state.level;
  }
  const prev = state.level;
  const next = decide(snap, prev);
  state.snap = snap;
  if (next !== prev) {
    state.level = next; state.since = Date.now();
    try {
      const events = require('../engine/events');
      if (next === 'paused') events.log('ERR', `Disk guard: PAUSED ingestion, ${describe(snap)}. New feeds, video copies, image cache and backups are stopped until usage is under ${cfg().resumeAtPct}%.`);
      else if (next === 'warn') events.log('WARN', `Disk guard: ${describe(snap)} (warning at ${cfg().warnAtPct}%, pause at ${cfg().pauseAtPct}%)`);
      else events.log('OK', `Disk guard: back to normal, ${describe(snap)}`);
    } catch { /* early boot */ }
    for (const fn of state.listeners) { try { fn(next, prev); } catch { /* a listener must not break the guard */ } }
  }
  return state.level;
}

/** True while bulk writes to the volume must not happen. */
function paused() { return refresh() === 'paused'; }

/** Throw (with a status the engine understands as "skip, try later") when the volume has no room for `bytes` more. */
function assertRoom(bytes = 0) {
  refresh();
  const room = state.snap && state.snap.free - bytes < cfg().minFreeMb * 1024 * 1024;
  if (state.level === 'paused' || room) throw Object.assign(new Error(`data volume is nearly full (${state.snap ? describe(state.snap) : 'disk guard'}): not writing`), { diskFull: true, skip: true });
}

function status() {
  refresh();
  const s = state.snap;
  // "known": the volume reports its size. Unknown means the guard cannot protect it (reported as degraded, never as a silent ok);
  // tests read no real volume and count as known.
  const known = !!s || (config.isTest && !overridden);
  return {
    known, level: state.level, since: new Date(state.since).toISOString(),
    usedPct: s ? Math.round(s.usedPct * 10) / 10 : null,
    freeGb: s ? Math.round((s.free / GB) * 10) / 10 : null,
    totalGb: s ? Math.round((s.total / GB) * 10) / 10 : null,
    pauseAtPct: cfg().pauseAtPct, resumeAtPct: cfg().resumeAtPct, warnAtPct: cfg().warnAtPct, minFreeMb: cfg().minFreeMb, budgetGb: cfg().budgetGb,
  };
}

function onChange(fn) { state.listeners.push(fn); }

function start() {
  if (state.timer || config.isTest) return;
  refresh({ force: true });
  state.timer = setInterval(() => refresh({ force: true }), 30 * 1000);
  state.timer.unref();
}
function stop() { if (state.timer) clearInterval(state.timer); state.timer = null; }

/** Test hooks. */
function _setStatfs(fn) { statfs = fn || ((dir) => fs.statfsSync(dir)); overridden = !!fn; state.checkedAt = 0; }
function _reset() { state.level = 'ok'; state.since = Date.now(); state.checkedAt = 0; state.snap = null; state.warnedUnknown = false; state.listeners = []; _setStatfs(null); }

module.exports = { paused, assertRoom, status, refresh, onChange, start, stop, measure, _setStatfs, _reset };
