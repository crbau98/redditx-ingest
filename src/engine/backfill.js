'use strict';
/**
 * Scheduling lanes and "is there more history to read" for feeds.
 *
 *   lane 0  a feed nobody has read yet, or one an admin/lookup prioritised: a creator someone is waiting for
 *   lane 1  routine refresh: the feed has caught up and only polls for new posts
 *   lane 2  backfill: the last run stopped inside the creator's history; runs again soon, but only when no lane 0/1 feed of the
 *           same platform is waiting for a slot, so it can never starve live polling
 *
 * Backfill state lives in the feed's cursor (each adapter keeps its own resume point), so it survives a crash or restart:
 * the next run starts where the stored cursor says.
 */
const parse = (c) => { if (!c) return {}; if (typeof c === 'object') return c; try { return JSON.parse(c) || {}; } catch { return {}; } };

/** Does this cursor say the creator's older history is not fully read yet? */
function pending(feed) {
  const c = parse(feed && feed.cursor);
  if (c.backfillPending === true) return true;                 // adapters that know say so (see engine: result.backfillPending)
  if (c.bfNext && !c.bfDone) return true;                       // bluesky user feed
  if (c.bfPage && !c.bfDone) return true;                       // redgifs user feed
  if (c.done === false) return true;                            // telegram preview/channel backfill
  return false;
}

/** SQL prefilter for "this cursor may hold unread history" (laneOf() makes the exact call). */
const PENDING_SQL = `(cursor IS NOT NULL AND (cursor LIKE '%"backfillPending":true%' OR (cursor LIKE '%"bfNext"%' AND cursor NOT LIKE '%"bfDone":true%') OR (cursor LIKE '%"bfPage"%' AND cursor NOT LIKE '%"bfDone":true%') OR cursor LIKE '%"done":false%'))`;

/**
 * lane 0: someone is waiting. An admin gave it priority, or it was added in the last `newFeedHours` and has not failed
 *         `newFeedAttempts` times in a row. A feed that was never read but is old, or keeps failing, is NOT lane 0 (hundreds of
 *         dead feeds must not outrank everything and skip the budget).
 * lane 1: routine refresh.   lane 2: backfill.
 */
function laneOf(feed, cfg = {}) {
  if (Number(feed.priority) > 0) return 0;
  if (!feed.last_success_at) {
    const hours = cfg.newFeedHours || 24; const attempts = cfg.newFeedAttempts || 3;
    const added = Date.parse(String(feed.created_at || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(feed.created_at || '')) ? '' : 'Z'));
    if (Number.isFinite(added) && Date.now() - added <= hours * 3600000 && (feed.consecutive_failures || 0) < attempts) return 0;
    return 1;
  }
  return pending(feed) ? 2 : 1;
}

module.exports = { pending, laneOf, parse, PENDING_SQL };
