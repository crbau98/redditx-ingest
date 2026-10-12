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

function schedule(key, minIntervalMs, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const now = Date.now();
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

module.exports = { schedule, penalize, reset };
