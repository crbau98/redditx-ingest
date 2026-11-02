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
// A half-open probe that never reports back (crash between canRun() and the run's outcome) must not
// wedge the platform forever: after this long the slot is considered lost and another probe may go.
const PROBE_STALE_MS = 10 * 60 * 1000;

const states = new Map();
const get = (p) => {
  if (!states.has(p)) states.set(p, { failures: 0, trips: 0, openUntil: 0, halfOpen: false, halfOpenAt: 0, lastError: null, lastFailureAt: 0 });
  return states.get(p);
};

function isSystemic(err) {
  if (!err) return false;
  if (err.skip) return false;
  if (err.perTarget) return false; // e.g. a private/quarantined subreddit: about one target, not the platform
  if (err.status === 404 || err.status === 410 || err.status === 400 || err.status === 422) return false;
  return true;
}

function canRun(platform, now = Date.now()) {
  const s = get(platform);
  if (s.openUntil && now < s.openUntil) return false;
  if (s.openUntil && now >= s.openUntil) {
    if (s.halfOpen && now - s.halfOpenAt < PROBE_STALE_MS) return false; // a probe is already in flight
    s.halfOpen = true; s.halfOpenAt = now;
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

/* ------------------------------------------------------------------ per-host breaker
 * A gateway error (502/503/504, Cloudflare 52x) from ONE instance (lemmynsfw.com, a Mastodon server...) says nothing about
 * the platform, so it must not open the platform breaker and stall every other instance; it trips a breaker for that host
 * instead, and trips it after two failures, not four: an instance that answers 502 twice in a row is down, and every further
 * attempt only adds load to a server that is already struggling. */
const HOST_THRESHOLD = 2;
const HOST_BASE_COOLDOWN_MS = 15 * 60 * 1000;
const HOST_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const hostStates = new Map();
const hostGet = (h) => {
  const k = String(h || '').toLowerCase();
  if (!hostStates.has(k)) hostStates.set(k, { failures: 0, trips: 0, openUntil: 0, lastError: null });
  return hostStates.get(k);
};

/** A gateway-class failure of the server itself (not of a target on it). */
const isGateway = (err) => !!err && [502, 503, 504, 520, 521, 522, 523, 524].includes(Number(err.status));

/** The server a feed talks to, when it is not the platform's own: "community@host", "@user@host", or a URL. */
function feedHost(feed) {
  const t = String((feed && feed.target) || '');
  const at = /@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(t);
  if (at) return at[1].toLowerCase();
  try { const u = new URL(t); return u.hostname.toLowerCase(); } catch { return null; }
}

function hostFailure(host, err, now = Date.now()) {
  if (!host || !isGateway(err)) return false;
  const s = hostGet(host);
  s.failures += 1; s.lastError = String(err.message || err).slice(0, 160);
  if (s.failures >= HOST_THRESHOLD) {
    s.trips += 1;
    s.openUntil = now + Math.max(err.retryAfter || 0, Math.min(HOST_BASE_COOLDOWN_MS * 2 ** (s.trips - 1), HOST_MAX_COOLDOWN_MS));
    return true;
  }
  return false;
}
function hostSuccess(host) { if (host && hostStates.has(String(host).toLowerCase())) { const s = hostGet(host); s.failures = 0; s.trips = 0; s.openUntil = 0; s.lastError = null; } }
/** Epoch ms until which the host is skipped, or 0. After it passes, one feed probes the host again. */
function hostOpenUntil(host, now = Date.now()) {
  if (!host || !hostStates.has(String(host).toLowerCase())) return 0;
  const s = hostGet(host);
  return s.openUntil && now < s.openUntil ? s.openUntil : 0;
}
function hostSnapshot(now = Date.now()) {
  const out = {};
  for (const [h, s] of hostStates) if (s.failures || s.openUntil) out[h] = { state: s.openUntil && now < s.openUntil ? 'open' : 'closed', failures: s.failures, trips: s.trips, openUntil: s.openUntil ? new Date(s.openUntil).toISOString() : null, lastError: s.lastError };
  return out;
}

function reset() { states.clear(); hostStates.clear(); }

module.exports = { canRun, success, failure, release, openUntil, snapshot, reset, isSystemic, THRESHOLD, isGateway, feedHost, hostFailure, hostSuccess, hostOpenUntil, hostSnapshot, HOST_THRESHOLD };
