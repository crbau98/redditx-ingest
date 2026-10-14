'use strict';
/**
 * Source health (v5 A3): which feeds earn their keep, and which need a look.
 *
 * Admin → Sources already shows each platform's 7-day scoreboard. This goes one level down, to the feeds:
 *   - failing: enabled feeds whose last runs all failed (with the error), so a broken login or a renamed account is seen;
 *   - stale:   enabled feeds that have not had a good run for days (rested by backoff or a circuit breaker);
 *   - dead:    enabled feeds that ran often over the last month and added nothing (a pause frees their slot for a better one);
 *   - top:     the feeds that added the most this week.
 * Pure SQL over feeds and feed_runs; nothing is changed here (the panel pauses a feed through the normal feed edit).
 */
const repo = require('../db/repo');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

function feedRow(f, extra = {}) {
  return {
    id: f.id, platform: f.platform, kind: f.kind, target: f.target, label: f.label || f.target, creatorId: f.creator_id || null,
    trusted: !!f.trusted, origin: f.origin || null, lastRunAt: f.last_run_at || null, lastSuccessAt: f.last_success_at || null,
    failures: f.consecutive_failures || 0, lastError: f.last_error || null, itemsTotal: f.items_total || 0, ...extra,
  };
}

/**
 * @param {{failingAfter?: number, staleDays?: number, deadDays?: number, deadMinRuns?: number, limit?: number, now?: number}} opts
 */
function report({ failingAfter = 3, staleDays = 3, deadDays = 30, deadMinRuns = 8, limit = 40, now = Date.now() } = {}) {
  const db = repo.db;
  const failing = db.prepare(`SELECT * FROM feeds WHERE enabled = 1 AND consecutive_failures >= ?
      ORDER BY consecutive_failures DESC, last_run_at DESC LIMIT ?`).all(failingAfter, limit).map((f) => feedRow(f));

  const stale = db.prepare(`SELECT * FROM feeds WHERE enabled = 1 AND last_run_at IS NOT NULL AND consecutive_failures < ?
      AND (last_success_at IS NULL OR last_success_at < ?) ORDER BY COALESCE(last_success_at, '') ASC LIMIT ?`)
    .all(failingAfter, iso(now - staleDays * DAY), limit).map((f) => feedRow(f));

  const dead = db.prepare(`SELECT f.*, COUNT(r.id) AS runs, COALESCE(SUM(r.fetched), 0) AS fetched, COALESCE(SUM(r.blocked + r.skipped), 0) AS filtered
      FROM feeds f JOIN feed_runs r ON r.feed_id = f.id AND r.started_at >= @since AND r.status != 'running'
      WHERE f.enabled = 1 AND f.created_at < @since
      GROUP BY f.id HAVING runs >= @minRuns AND COALESCE(SUM(r.added), 0) = 0
      ORDER BY runs DESC LIMIT @limit`)
    .all({ since: iso(now - deadDays * DAY), minRuns: deadMinRuns, limit })
    .map((f) => feedRow(f, { runs: f.runs, fetched: f.fetched, filtered: f.filtered,
      // fetched plenty but kept nothing: the gates reject it (wrong audience); fetched nothing: the source is quiet or gone
      why: f.fetched > 0 ? 'everything it found was filtered out' : 'it found nothing new' }));

  const top = db.prepare(`SELECT f.*, COUNT(r.id) AS runs, SUM(r.added) AS added FROM feeds f
      JOIN feed_runs r ON r.feed_id = f.id AND r.started_at >= ? AND r.status != 'running'
      WHERE f.enabled = 1 GROUP BY f.id HAVING added > 0 ORDER BY added DESC LIMIT ?`)
    .all(iso(now - 7 * DAY), Math.min(limit, 15)).map((f) => feedRow(f, { runs: f.runs, added: f.added }));

  const totals = db.prepare(`SELECT COUNT(*) AS feeds, SUM(enabled) AS enabled,
      SUM(CASE WHEN enabled = 1 AND last_run_at IS NULL THEN 1 ELSE 0 END) AS never FROM feeds`).get();
  return {
    totals: { feeds: totals.feeds || 0, enabled: totals.enabled || 0, neverRun: totals.never || 0, failing: failing.length, stale: stale.length, dead: dead.length },
    failing, stale, dead, top,
    rules: { failingAfter, staleDays, deadDays, deadMinRuns },
  };
}

module.exports = { report };
