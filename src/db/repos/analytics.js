'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildAnalytics: public stats, the admin overview and the discover page. Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildAnalytics = function buildAnalytics({ db, cachedCount, media, creators, feeds, runs, reports, candidates, blockQ }) {
/* -------------------------------------------------------------- stats / home */
function publicStats() {
  const [s] = cachedCount.rows(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videos
    FROM media INDEXED BY ix_media_pub_count WHERE publish_state = 'published' AND scope != 'excluded'`);
  const c = cachedCount("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND media_count > 0", []);
  return { total: s.total || 0, images: s.images || 0, videos: s.videos || 0, creators: c };
}

/** The daily ingest chart: a range on ix_media_ingested_plat (v34), never a full scan. */
const INGEST_DAILY_SQL = `SELECT substr(ingested_at, 1, 10) AS day, platform, COUNT(*) AS n FROM media
      WHERE ingested_at >= ? GROUP BY day, platform ORDER BY day`;
/** Start of the UTC day 14 days ago, as a full ISO timestamp (the same instant the bare date meant). */
const ingestDailySince = (now = Date.now()) => `${new Date(now - 14 * 86400000).toISOString().slice(0, 10)}T00:00:00.000Z`;

function adminOverview() {
  const states = media.countByState();
  const pubByPlatform = media.platforms();
  return {
    media: { ...states, total: states.published + states.review + states.hidden },
    creators: {
      total: db.prepare('SELECT COUNT(*) AS n FROM creators').get().n,
      active: db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND media_count > 0").get().n,
      blocked: db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'blocked'").get().n,
    },
    feeds: {
      total: db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n,
      enabled: feeds.countEnabled(),
      failing: db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE enabled = 1 AND last_status = 'error'").get().n,
      byPlatform: feeds.counts(),
    },
    queues: { review: states.review, reports: reports.openCount() },
    pubByPlatform,
    activity: runs.activity(48),
    last24h: db.prepare(`SELECT COALESCE(SUM(added),0) AS added, COALESCE(SUM(dupes),0) AS dupes, COALESCE(SUM(skipped),0) AS skipped,
        COALESCE(SUM(blocked),0) AS blocked, COUNT(*) AS runs FROM feed_runs WHERE started_at >= ?`).get(new Date(Date.now() - 86400000).toISOString()),
    blocklist: blockQ.count.get().c,
    discovery: candidates.counts(),
    ingestDaily: db.prepare(INGEST_DAILY_SQL).all(ingestDailySince()),
  };
}

function discover() {
  const pageOf = (f) => media.list({ ...f, noCount: true }).items;
  // Suggested creators, in the order a visitor should meet them: the stored popularity rank first
  // (engagement + breadth + volume + freshness, engine/popularity.js), with the 90-day activity
  // floor the Creators page uses. When the ranked pool is empty (a brand-new library), the old
  // media-count order answers instead.
  const featured = creators.list({ sort: 'popular', limit: 16, minMedia: 2 }).items;
  const ofTrending = pageOf({ paidHost: 'onlyfans', sort: 'trending', limit: 20 });
  const ofVideos = pageOf({ type: 'video', paidHost: 'onlyfans', sort: 'recent', limit: 14 });
  return {
    stats: publicStats(),
    trending: ofTrending.length >= 8 ? ofTrending : pageOf({ sort: 'trending', limit: 20 }),
    freshVideos: ofVideos.length >= 6 ? ofVideos : pageOf({ type: 'video', sort: 'recent', limit: 14 }),
    topCreators: featured.length ? featured : creators.list({ sort: 'media', limit: 16, minMedia: 2 }).items,
    newCreators: creators.list({ sort: 'new', limit: 12, minMedia: 2 }).items,
    rising: creators.rising(12),
    tags: media.tags(36, 2),
    communities: media.communities(24),
    platforms: media.platforms(),
  };
}
  return { publicStats, adminOverview, discover, INGEST_DAILY_SQL, ingestDailySince };
};
