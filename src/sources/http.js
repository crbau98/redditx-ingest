'use strict';
/**
 * Per-platform HTTP client: every call is spaced by the shared limiter, and a
 * 429 pushes the whole platform's next call out by the server's Retry-After.
 */
const net = require('../lib/net');
const limiter = require('../lib/limiter');

function forPlatform(key, minIntervalMs = 500) {
  const wrap = (fn) => (url, opts = {}) =>
    limiter.schedule(key, opts.minIntervalMs ?? minIntervalMs, () => fn(url, opts)).catch((e) => {
      if (e && e.status === 429) limiter.penalize(key, e.retryAfter || 30000);
      throw e;
    });
  return {
    key,
    json: wrap(net.fetchJSON),
    text: wrap(net.fetchText),
    raw: wrap(net.request),
  };
}

module.exports = { forPlatform };
