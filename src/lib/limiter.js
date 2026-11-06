'use strict';
/**
 * Tiny per-key politeness limiter: calls sharing a key are serialised and
 * spaced at least `minIntervalMs` apart. Used so a burst of feed runs can
 * never hammer one origin (the usual reason scrapers get 429/403 banned).
 */
const tails = new Map();   // key -> Promise
const lastRun = new Map(); // key -> timestamp
const cooldown = new Map(); // key -> timestamp until which we must wait (429/Retry-After)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Milliseconds `key` is still held after a 429 (0 = free). */
function coolingDown(key, now = Date.now()) {
  const until = cooldown.get(key) || 0;
  return until > now ? until - now : 0;
}

/** The error a caller gets instead of a long wait: a 429 that carries how long the hold still lasts. */
function cooldownError(key, left) {
  return Object.assign(new Error(`${key} is rate-limited: cooling down for ${Math.ceil(left / 1000)} s (no request was sent)`), { status: 429, retryAfter: left, cooldown: true });
}

/**
 * Serialise and space calls that share `key`. A call normally waits for a cooldown to end. With `maxWaitMs` a call that would
 * have to wait longer than that for a cooldown fails at once with a 429 error (`cooldown: true`, `retryAfter` = the wait left)
 * and sends nothing: a feed run must not sit in this queue until its own timeout fires and then be counted as a failure.
 */
function schedule(key, minIntervalMs, fn, { maxWaitMs = Infinity } = {}) {
  const left0 = coolingDown(key);
  if (left0 > maxWaitMs) return Promise.reject(cooldownError(key, left0));
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const now = Date.now();
    const left = coolingDown(key, now);
    if (left > maxWaitMs) throw cooldownError(key, left); // the hold was set while this call waited in line
    const readyAt = Math.max((lastRun.get(key) || 0) + minIntervalMs, cooldown.get(key) || 0);
    if (readyAt > now) await sleep(readyAt - now);
    lastRun.set(key, Date.now());
    return fn();
  });
  tails.set(key, run.catch(() => {}));
  return run;
}

/** Push the next allowed call for `key` out by `ms` (e.g. after a 429). */
function penalize(key, ms) {
  cooldown.set(key, Math.max(cooldown.get(key) || 0, Date.now() + ms));
}

function reset() { tails.clear(); lastRun.clear(); cooldown.clear(); }

module.exports = { schedule, penalize, reset, coolingDown };
