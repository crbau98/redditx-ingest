'use strict';
/**
 * Per-platform circuit breaker.
 *
 * When a platform starts failing systemically (blocked IP, outage, throttling)
 * hammering it with every feed makes things worse and can extend a ban. After
 * a burst of failures we stop calling that platform for a cool-down that grows
 * on repeated trips, then let a single probe request through (half-open).
 * "Not found" errors are about one target, not the platform, and never count.
 */
const THRESHOLD = 4;            // consecutive systemic failures
const BASE_COOLDOWN_MS = 3 * 60 * 1000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

const states = new Map();
const get = (p) => {
  if (!states.has(p)) states.set(p, { failures: 0, trips: 0, openUntil: 0, halfOpen: false, lastError: null, lastFailureAt: 0 });
  return states.get(p);
};

function isSystemic(err) {
  if (!err) return false;
  if (err.skip) return false;
  if (err.status === 404 || err.status === 410 || err.status === 400 || err.status === 422) return false;
  return true;
}

function canRun(platform, now = Date.now()) {
  const s = get(platform);
  if (s.openUntil && now < s.openUntil) return false;
  if (s.openUntil && now >= s.openUntil) {
    if (s.halfOpen) return false; // a probe is already in flight
    s.halfOpen = true;
  }
  return true;
}

function success(platform) {
  const s = get(platform);
  s.failures = 0; s.trips = 0; s.openUntil = 0; s.halfOpen = false; s.lastError = null;
}

function failure(platform, err, now = Date.now()) {
  if (!isSystemic(err)) { get(platform).halfOpen = false; return; }
  const s = get(platform);
  s.failures += 1; s.lastError = String(err.message || err).slice(0, 160); s.lastFailureAt = now;
  const probing = s.halfOpen;
  s.halfOpen = false;
  if (probing || s.failures >= THRESHOLD) {
    s.trips += 1;
    const retryAfter = err.retryAfter || 0;
    s.openUntil = now + Math.max(retryAfter, Math.min(BASE_COOLDOWN_MS * 2 ** (s.trips - 1), MAX_COOLDOWN_MS));
  }
}

/** Release a half-open slot without recording an outcome (e.g. run was skipped). */
function release(platform) { get(platform).halfOpen = false; }

function openUntil(platform) { return get(platform).openUntil; }

function snapshot(now = Date.now()) {
  const out = {};
  for (const [platform, s] of states) {
    out[platform] = {
      state: s.openUntil && now < s.openUntil ? 'open' : s.openUntil ? 'half-open' : 'closed',
      failures: s.failures, trips: s.trips, openUntil: s.openUntil ? new Date(s.openUntil).toISOString() : null, lastError: s.lastError,
    };
  }
  return out;
}

function reset() { states.clear(); }

module.exports = { canRun, success, failure, release, openUntil, snapshot, reset, isSystemic, THRESHOLD };
