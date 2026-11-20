'use strict';
/**
 * Per-platform run budgets. Counts feed runs per platform per UTC day (persisted, so a restart does not reset the day) and says
 * whether a lane may start another one. Lane 0 (someone is waiting) is never stopped by a budget; lane 2 (backfill) has its own
 * daily cap per platform; lane 1 follows the platform cap when one is set.
 *
 * Caps come from settings: `platformDailyRuns` ("x=300,telegram=600", empty = unlimited) and `backfillRunsPerDay`.
 *
 * Bytes: `platformDailyMb` ("telegram=5000") caps what one platform may download into the media store per UTC day. A source asks
 * `bytesLeft()` / `reserveBytes()` before reading a batch and `chargeBytes()` after every file it kept; lane-0 runs (someone is
 * waiting) are not blocked from starting, but their batches are still trimmed to what is left.
 *
 * Concurrent slots: `reserveBytes()` claims projected download size against a process-local reservation counter (counted in
 * `bytesLeft`) before any download starts, and the caller releases the claim when the run finishes. That way N in-flight runs
 * cannot each snapshot the same remainder and collectively overshoot the daily ceiling (Crucible w17 / v4.25.0).
 */
const repo = require('../db/repo');
const settingsStore = require('../settings');

const day = () => new Date().toISOString().slice(0, 10);
const KEY = 'budget_runs';
let mem = null;
/** In-flight projected downloads not yet charged (platform -> bytes). Process-local; a restart drops them (safe: nothing is mid-download). */
const reserved = Object.create(null);

function load() {
  if (mem && mem.day === day()) return mem;
  let stored = null;
  try { stored = JSON.parse(repo.settings.get(KEY) || 'null'); } catch { stored = null; }
  const ok = stored && typeof stored === 'object' && stored.day === day() && stored.runs && typeof stored.runs === 'object' && stored.backfill && typeof stored.backfill === 'object';
  mem = ok ? stored : { day: day(), runs: {}, backfill: {}, bytes: {} };
  if (!mem.bytes || typeof mem.bytes !== 'object') mem.bytes = {}; // a malformed stored value starts the day over instead of stalling every tick
  return mem;
}
function save() { try { repo.settings.set(KEY, JSON.stringify(mem)); } catch { /* best effort */ } }

function parseCaps(text) {
  const out = {};
  for (const part of String(text || '').split(/[,\n]/)) {
    const m = /^\s*([a-z0-9_-]+)\s*[=:]\s*(\d+)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = Number(m[2]);
  }
  return out;
}

function reservedOf(platform) {
  return reserved[platform] || 0;
}

/** May a run of this lane start on this platform now? */
function allow(platform, lane, cfg = settingsStore.get()) {
  if (lane === 0) return true;
  let b; try { b = load(); } catch { return true; } // a broken counter never stops the scheduler
  const cap = parseCaps(cfg.platformDailyRuns)[platform];
  if (cap !== undefined && (b.runs[platform] || 0) >= cap) return false;
  if (lane === 2 && (b.backfill[platform] || 0) >= (cfg.backfillRunsPerDay || 0)) return false;
  if (lane === 2 && platform === 'redgifs' && cfg.redgifsBackfillRunsPerDay !== undefined && (b.backfill[platform] || 0) >= cfg.redgifsBackfillRunsPerDay) return false;
  if (bytesLeft(platform, cfg) <= 0) return false; // the day's download budget is spent (incl. in-flight reservations)
  return true;
}

/** Bytes this platform may still download today (Infinity = no cap). Includes in-flight reservations. */
function bytesLeft(platform, cfg = settingsStore.get()) {
  const mb = parseCaps(cfg.platformDailyMb)[platform];
  if (mb === undefined) return Infinity;
  let b; try { b = load(); } catch { return Infinity; }
  return Math.max(0, mb * 1048576 - (b.bytes[platform] || 0) - reservedOf(platform));
}

/**
 * Atomically claim `want` bytes of today's download budget for an in-flight run.
 * Returns `{ ok, reserved, release }`. `release()` must run when the run ends (success or not); it is idempotent.
 * Only succeeds when the full `want` still fits — no partial claims.
 */
function reserveBytes(platform, want, cfg = settingsStore.get()) {
  const n = Math.max(0, Math.floor(Number(want) || 0));
  if (!n) return { ok: true, reserved: 0, release: () => {} };
  // Use the exported function so tests that stub `budget.bytesLeft` still drive reservations.
  const left = module.exports.bytesLeft(platform, cfg);
  if (left < n) return { ok: false, reserved: 0, release: () => {} };
  reserved[platform] = (reserved[platform] || 0) + n;
  let held = n;
  let done = false;
  return {
    ok: true,
    reserved: n,
    release() {
      if (done) return;
      done = true;
      reserved[platform] = Math.max(0, (reserved[platform] || 0) - held);
      held = 0;
    },
  };
}

function chargeBytes(platform, n) {
  if (!(n > 0)) return;
  const b = load();
  b.bytes[platform] = (b.bytes[platform] || 0) + n;
  save();
}

function charge(platform, lane) {
  const b = load();
  b.runs[platform] = (b.runs[platform] || 0) + 1;
  if (lane === 2) b.backfill[platform] = (b.backfill[platform] || 0) + 1;
  save();
}

function status() {
  const b = load();
  return { day: b.day, runs: { ...b.runs }, backfill: { ...b.backfill }, bytes: { ...b.bytes }, reserved: { ...reserved } };
}
function _reset() {
  mem = null;
  for (const k of Object.keys(reserved)) delete reserved[k];
}

module.exports = { allow, charge, bytesLeft, reserveBytes, chargeBytes, status, parseCaps, _reset };
