'use strict';
/**
 * Subreddit taste: how much each Reddit community feed is worth to THIS library, from what it actually produced.
 *
 * Read-only. It scores and recommends; it never pauses, mutes or changes a feed. Pausing is the admin's explicit
 * click (the Subreddits page calls the existing PATCH /api/admin/feeds/:id { enabled }).
 *
 * Signals per community feed (server data only: media, feeds, feed_runs, candidates):
 *   followed30   published items from the last 30 days by a creator followed here (a creator with his own user feed,
 *                or a discovery candidate followed / linked to him) - weighted highest
 *   published14  published items from the last 14 days (items/day = published14 / 14)
 *   badShare     share of its runs in the last 30 days that came back empty or skipped (rate limited)
 *   lastUsefulAt when its newest published item was ingested
 */
const repo = require('../db/repo');

const DAY = 86400000;
const CACHE_MS = process.env.NODE_ENV === 'test' ? 0 : 10 * 60 * 1000;
/** Below this many items a day, a subreddit that carries none of your follows is suggested for a pause. */
const MIN_RATE = 0.5;

const W = { follows: 50, volume: 20, reliability: 15, recency: 15 };

/**
 * Score one feed's numbers (pure). 0-100, plus a plain-word label.
 * @param {{published14:number, published30:number, followed30:number, runs:number, badRuns:number, lastUsefulAt:string|null}} s
 */
function score(s, now = Date.now()) {
  const perDay = (s.published14 || 0) / 14;
  const badShare = s.runs ? (s.badRuns || 0) / s.runs : 0;
  const ageDays = s.lastUsefulAt ? Math.max(0, (now - Date.parse(s.lastUsefulAt)) / DAY) : Infinity;
  const follows = Math.min(1, (s.followed30 || 0) / 10) * W.follows;
  const volume = Math.min(1, perDay / 5) * W.volume;
  const reliability = (s.runs ? 1 - badShare : 0.5) * W.reliability;
  const recency = ageDays <= 2 ? W.recency : ageDays >= 30 ? 0 : W.recency * (1 - (ageDays - 2) / 28);
  const total = Math.round(follows + volume + reliability + recency);
  let label;
  if (!s.published30 || ageDays > 30) label = 'dead';
  else if (s.followed30 > 0) label = 'carries your follows';
  else if (total < 30) label = 'weak';
  else label = 'steady';
  return { score: total, label, perDay: Math.round(perDay * 100) / 100, badShare: Math.round(badShare * 100) / 100 };
}

/**
 * Recommendations (pure): pause an enabled subreddit with no followed-creator items in 30 days and fewer than MIN_RATE
 * items a day; re-enable a paused one that carried follows (in 30 days, or 3+ ever).
 */
function recommend(rows) {
  const pause = rows.filter((r) => r.enabled && !r.followed30 && r.perDay < MIN_RATE)
    .map((r) => ({ feedId: r.feedId, name: r.name, action: 'pause', enabled: 0, why: `no items from creators you follow in 30 days, ${r.perDay} items/day` }));
  const enable = rows.filter((r) => !r.enabled && (r.followed30 > 0 || r.followedTotal >= 3))
    .map((r) => ({ feedId: r.feedId, name: r.name, action: 'enable', enabled: 1, why: `${r.followed30 || r.followedTotal} items from creators you follow${r.followed30 ? ' in 30 days' : ''}` }));
  return { pause, enable };
}

let cache = null;

/** The heavy part (one read-only pass over media and runs), cached. Enabled state is joined live by `report`. */
function stats(now = Date.now()) {
  if (CACHE_MS && cache && now - cache.at < CACHE_MS) return cache.rows;
  const d14 = new Date(now - 14 * DAY).toISOString();
  const d30 = new Date(now - 30 * DAY).toISOString();
  const media = repo.db.prepare(`
    WITH followed AS (
      SELECT creator_id FROM feeds WHERE kind = 'user' AND creator_id IS NOT NULL
      UNION SELECT creator_id FROM candidates WHERE status IN ('followed', 'linked') AND creator_id IS NOT NULL
    )
    SELECT m.feed_id AS feedId,
      SUM(m.ingested_at >= @d14) AS published14,
      SUM(m.ingested_at >= @d30) AS published30,
      SUM(m.ingested_at >= @d30 AND m.creator_id IN (SELECT creator_id FROM followed)) AS followed30,
      SUM(m.creator_id IN (SELECT creator_id FROM followed)) AS followedTotal,
      MAX(m.ingested_at) AS lastUsefulAt
    FROM media m JOIN feeds f ON f.id = m.feed_id
    WHERE f.platform = 'reddit' AND f.kind = 'community' AND m.publish_state = 'published'
    GROUP BY m.feed_id`).all({ d14, d30 });
  const runs = repo.db.prepare(`
    SELECT r.feed_id AS feedId, COUNT(*) AS runs, SUM(r.status IN ('empty', 'skipped')) AS badRuns
    FROM feed_runs r JOIN feeds f ON f.id = r.feed_id
    WHERE f.platform = 'reddit' AND f.kind = 'community' AND r.started_at >= @d30 AND r.status != 'running'
    GROUP BY r.feed_id`).all({ d30 });
  const rows = new Map();
  for (const m of media) rows.set(m.feedId, { ...m });
  for (const r of runs) rows.set(r.feedId, { ...(rows.get(r.feedId) || {}), runs: r.runs, badRuns: r.badRuns });
  cache = { at: now, rows };
  return rows;
}

/** Every Reddit community feed with its numbers, score and label, plus the recommendations. Reads only. */
function report({ now = Date.now() } = {}) {
  const s = stats(now);
  const feeds = repo.db.prepare("SELECT id, target, label, enabled FROM feeds WHERE platform = 'reddit' AND kind = 'community' ORDER BY target COLLATE NOCASE").all();
  const rows = feeds.map((f) => {
    const n = { published14: 0, published30: 0, followed30: 0, followedTotal: 0, runs: 0, badRuns: 0, lastUsefulAt: null, ...(s.get(f.id) || {}) };
    return { feedId: f.id, name: f.target, enabled: !!f.enabled, ...n, ...score(n, now) };
  }).sort((a, b) => b.score - a.score);
  return { rows, recommendations: recommend(rows), minRate: MIN_RATE, computedAt: new Date(now).toISOString() };
}

module.exports = { score, recommend, report, MIN_RATE, _clear: () => { cache = null; } };
