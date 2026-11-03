'use strict';
/**
 * Per-platform run budgets. Counts feed runs per platform per UTC day (persisted, so a restart does not reset the day) and says
 * whether a lane may start another one. Lane 0 (someone is waiting) is never stopped by a budget; lane 2 (backfill) has its own
 * daily cap per platform; lane 1 follows the platform cap when one is set.
 *
 * Caps come from settings: `platformDailyRuns` ("x=300,telegram=600", empty = unlimited) and `backfillRunsPerDay`.
 */
const repo = require('../db/repo');
const settingsStore = require('../settings');

const day = () => new Date().toISOString().slice(0, 10);
const KEY = 'budget_runs';
let mem = null;

function load() {
  if (mem && mem.day === day()) return mem;
  let stored = null;
  try { stored = JSON.parse(repo.settings.get(KEY) || 'null'); } catch { stored = null; }
  const ok = stored && typeof stored === 'object' && stored.day === day() && stored.runs && typeof stored.runs === 'object' && stored.backfill && typeof stored.backfill === 'object';
  mem = ok ? stored : { day: day(), runs: {}, backfill: {} }; // a malformed stored value starts the day over instead of stalling every tick
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

/** May a run of this lane start on this platform now? */
function allow(platform, lane, cfg = settingsStore.get()) {
  if (lane === 0) return true;
  let b; try { b = load(); } catch { return true; } // a broken counter never stops the scheduler
  const cap = parseCaps(cfg.platformDailyRuns)[platform];
  if (cap !== undefined && (b.runs[platform] || 0) >= cap) return false;
  if (lane === 2 && (b.backfill[platform] || 0) >= (cfg.backfillRunsPerDay || 0)) return false;
  return true;
}

function charge(platform, lane) {
  const b = load();
  b.runs[platform] = (b.runs[platform] || 0) + 1;
  if (lane === 2) b.backfill[platform] = (b.backfill[platform] || 0) + 1;
  save();
}

function status() { const b = load(); return { day: b.day, runs: { ...b.runs }, backfill: { ...b.backfill } }; }
function _reset() { mem = null; }

module.exports = { allow, charge, status, parseCaps, _reset };
