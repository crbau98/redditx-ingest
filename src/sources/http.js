'use strict';
/**
 * Per-platform HTTP client: every call is spaced by the shared limiter, and a
 * 429 pushes the whole platform's next call out.
 *
 * Penalty: by default a 429 waits the server's Retry-After (or 30 s when it sends none). A platform can
 * ask for more: `penalty: { ms, repeatMs, repeatWindowMs }` waits at least `ms` after a 429 (a longer
 * Retry-After still wins), and a second 429 within `repeatWindowMs` of the last one waits `repeatMs`
 * instead, so a throttled hour cannot turn into a throttled day.
 */
const net = require('../lib/net');
const limiter = require('../lib/limiter');

const DEFAULT_PENALTY_MS = 30000;

/** How long to hold the platform after a 429, given the server's Retry-After and the platform's penalty policy. */
function penaltyFor(e, penalty, state, now = Date.now()) {
  const retry = e.retryAfter || 0;
  if (!penalty) return retry || DEFAULT_PENALTY_MS;
  const repeat = state.lastStrike && now - state.lastStrike < (penalty.repeatWindowMs || 0);
  state.lastStrike = now;
  return Math.max(retry, repeat ? penalty.repeatMs : penalty.ms);
}

function forPlatform(key, minIntervalMs = 500, { penalty = null } = {}) {
  const state = { lastStrike: 0 };
  const wrap = (fn) => (url, opts = {}) =>
    limiter.schedule(key, opts.minIntervalMs ?? minIntervalMs, () => fn(url, opts)).catch((e) => {
      if (e && e.status === 429) limiter.penalize(key, penaltyFor(e, penalty, state));
      throw e;
    });
  return {
    key,
    json: wrap(net.fetchJSON),
    text: wrap(net.fetchText),
    raw: wrap(net.request),
  };
}

module.exports = { forPlatform, penaltyFor };
