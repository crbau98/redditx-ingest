'use strict';
/**
 * Which creators people actually look at. A profile view stamps `viewed.<creatorId>` in discovery_state (at most one write per
 * creator per 10 minutes). The scheduler and the coverage rotation order creators viewed in the last 7 days FIRST, so the history of
 * a creator someone is reading is filled in before that of one nobody opens. This only reorders: budgets, backfill caps, rate
 * limits and the breakers apply exactly as before.
 */
const repo = require('../db/repo');

const PREFIX = 'viewed.';
const THROTTLE_MS = 10 * 60 * 1000;
const WINDOW_DAYS = 7;

/** Record a view of a creator profile. Never throws. */
function touch(creatorId) {
  try {
    if (!creatorId) return;
    const key = `${PREFIX}${creatorId}`;
    const at = Date.parse(repo.discoveryState.touchedAt(key) || '');
    if (Number.isFinite(at) && Date.now() - at < THROTTLE_MS) return;
    repo.discoveryState.set(key, '1');
  } catch { /* a view must never fail the request */ }
}

/** Creator ids viewed in the last `days` days. */
function recentIds(days = WINDOW_DAYS) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return new Set(repo.db.prepare("SELECT substr(key, ?) AS id FROM discovery_state WHERE key LIKE 'viewed.%' AND updated_at >= ?").all(PREFIX.length + 1, since).map((r) => r.id));
}

module.exports = { touch, recentIds, PREFIX, WINDOW_DAYS };
