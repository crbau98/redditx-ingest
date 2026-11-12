'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildRuns: feed runs: start, finish, history, scoreboards and the watchdog. Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildRuns = function buildRuns({ db, uuid, nowIso }) {
/* ---------------------------------------------------------------------- runs */
const runs = {
  start(feedId, trigger) {
    const id = uuid();
    db.prepare('INSERT INTO feed_runs (id, feed_id, trigger, started_at) VALUES (?, ?, ?, ?)').run(id, feedId, trigger, nowIso());
    return id;
  },
  finish(id, { status, fetched = 0, added = 0, dupes = 0, skipped = 0, blocked = 0, review = 0, via = null, error = null, durationMs = 0 }) {
    db.prepare(`UPDATE feed_runs SET finished_at = ?, status = ?, fetched = ?, added = ?, dupes = ?, skipped = ?, blocked = ?, review = ?, via = ?, error = ?, duration_ms = ? WHERE id = ?`)
      .run(nowIso(), status, fetched, added, dupes, skipped, blocked, review, via, error ? String(error).slice(0, 400) : null, durationMs, id);
  },
  recent({ feedId, limit = 50 } = {}) {
    const where = feedId ? 'WHERE r.feed_id = ?' : '';
    const params = feedId ? [feedId, limit] : [limit];
    return db.prepare(`SELECT r.*, f.platform, f.kind, f.target, f.label FROM feed_runs r JOIN feeds f ON f.id = r.feed_id
      ${where} ORDER BY r.started_at DESC LIMIT ?`).all(...params);
  },
  /** Hourly buckets for the dashboard activity chart. */
  activity(hours = 48) {
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    return db.prepare(`SELECT substr(started_at, 1, 13) AS hour, SUM(added) AS added, COUNT(*) AS runs,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
      FROM feed_runs WHERE started_at >= ? GROUP BY hour ORDER BY hour`).all(since);
  },
  /**
   * Per-platform scorecard over the last N days: how many runs, how often they failed, what they actually
   * brought in, how much of it was filtered, and how many creators the platform contributes.
   */
  scoreboard(days = 7) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare(`SELECT f.platform AS platform, COUNT(*) AS runs,
        SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN r.status = 'empty' THEN 1 ELSE 0 END) AS empty,
        SUM(r.fetched) AS fetched, SUM(r.added) AS added, SUM(r.dupes) AS dupes, SUM(r.skipped) AS skipped, SUM(r.blocked) AS blocked,
        AVG(r.duration_ms) AS avg_ms, MAX(CASE WHEN r.status IN ('ok','empty') THEN r.finished_at END) AS last_ok
      FROM feed_runs r JOIN feeds f ON f.id = r.feed_id WHERE r.started_at >= ? AND r.status != 'running' GROUP BY f.platform`).all(since);
    const creators = Object.fromEntries(db.prepare(`SELECT platform, COUNT(DISTINCT creator_id) AS n FROM media WHERE ingested_at >= ? AND creator_id IS NOT NULL AND publish_state = 'published' GROUP BY platform`).all(since).map((r) => [r.platform, r.n]));
    return rows.map((r) => ({
      platform: r.platform, runs: r.runs, errorRate: r.runs ? Math.round((r.errors / r.runs) * 100) : 0, emptyRate: r.runs ? Math.round((r.empty / r.runs) * 100) : 0,
      fetched: r.fetched || 0, added: r.added || 0, dupes: r.dupes || 0, filtered: (r.skipped || 0) + (r.blocked || 0), avgMs: Math.round(r.avg_ms || 0),
      yieldPerRun: r.runs ? Math.round(((r.added || 0) / r.runs) * 10) / 10 : 0, creators: creators[r.platform] || 0, lastOk: r.last_ok || null,
    }));
  },
  /** Items added by a feed's last few finished runs, newest first (for adaptive scheduling). */
  /** Yield scoreboard: how many finished runs this feed had since `sinceIso`, and how many items they fetched. */
  yieldSince(feedId, sinceIso) {
    const r = db.prepare("SELECT COUNT(*) AS runs, COALESCE(SUM(fetched), 0) AS fetched FROM feed_runs WHERE feed_id = ? AND started_at >= ? AND status != 'running'").get(feedId, sinceIso);
    return { runs: r.runs, fetched: r.fetched };
  },
  /** Admin: feeds whose runs since `sinceIso` (at least `minRuns` of them) fetched nothing at all. Read-only. */
  idleFeeds(sinceIso, { minRuns = 5, limit = 200, offset = 0 } = {}) {
    const base = `FROM feed_runs r JOIN feeds f ON f.id = r.feed_id WHERE r.started_at >= ? AND r.status != 'running'
      GROUP BY r.feed_id HAVING COUNT(*) >= ? AND COALESCE(SUM(r.fetched), 0) = 0`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT r.feed_id ${base})`).get(sinceIso, minRuns).n;
    const items = db.prepare(`SELECT f.id, f.platform, f.kind, f.target, f.enabled, f.creator_id AS creatorId, f.next_run_at AS nextRunAt,
        f.last_status AS lastStatus, f.last_error AS lastError, COUNT(*) AS runs, SUM(r.status = 'error') AS errors ${base}
      ORDER BY f.platform, f.target LIMIT ? OFFSET ?`).all(sinceIso, minRuns, limit, offset);
    return { total, items: items.map((i) => ({ ...i, enabled: !!i.enabled })) };
  },
  recentAdded(feedId, n = 4) {
    return db.prepare("SELECT added FROM feed_runs WHERE feed_id = ? AND status IN ('ok','empty') ORDER BY started_at DESC LIMIT ?").all(feedId, n).map((r) => r.added || 0);
  },
  prune(keepDays = 30) {
    db.prepare('DELETE FROM feed_runs WHERE started_at < ?').run(new Date(Date.now() - keepDays * 86400000).toISOString());
  },
  /** Runs still 'running' after maxAgeMs are marked errors (engine watchdog, every tick). Uses ix_runs_running. */
  timeoutStale(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return db.prepare("UPDATE feed_runs SET status = 'error', error = ?, finished_at = ? WHERE status = 'running' AND started_at < ?")
      .run(`timed out: still running after ${Math.round(maxAgeMs / 60000)} min (watchdog)`, nowIso(), cutoff).changes;
  },
  abandonRunning() {
    db.prepare("UPDATE feed_runs SET status = 'error', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'").run(nowIso());
  },
};
  return { runs };
};
