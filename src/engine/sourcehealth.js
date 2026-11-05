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
const { classify, KINDS } = require('./errorclass');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const kindOf = (text) => (text ? classify(text).kind : null);
const tally = (m, key, n = 1) => { m[key] = (m[key] || 0) + n; };

function feedRow(f, extra = {}) {
  return {
    errorKind: kindOf(f.last_error),
    id: f.id, platform: f.platform, kind: f.kind, target: f.target, label: f.label || f.target, creatorId: f.creator_id || null,
    trusted: !!f.trusted, origin: f.origin || null, lastRunAt: f.last_run_at || null, lastSuccessAt: f.last_success_at || null,
    failures: f.consecutive_failures || 0, lastError: f.last_error || null, itemsTotal: f.items_total || 0, ...extra,
  };
}

/**
 * What went wrong in the runs of the last `days` days, by cause: { days, runs, total: {kind: n}, byPlatform: {platform: {kind: n}} }.
 * Failed and skipped runs are classified from their stored message (engine/errorclass); a run that found nothing counts as `empty`.
 * Runs are grouped by their message first, so the cost follows the number of distinct messages, not the number of runs.
 */
const CAUSE_GROUPS = 3000;
function runCauses(now, days = 7) {
  const rows = repo.db.prepare(`SELECT f.platform AS platform, r.status AS status, substr(COALESCE(r.error, ''), 1, 200) AS err, COUNT(*) AS n
      FROM feed_runs r JOIN feeds f ON f.id = r.feed_id
      WHERE r.started_at >= ? AND r.status IN ('error', 'skipped', 'empty')
      GROUP BY f.platform, r.status, err ORDER BY n DESC LIMIT ?`).all(iso(now - days * DAY), CAUSE_GROUPS + 1);
  const total = {}; const byPlatform = {}; let runs = 0;
  for (const r of rows.slice(0, CAUSE_GROUPS)) {
    const kind = r.status === 'empty' ? 'empty' : (classify(r.err).kind);
    tally(total, kind, r.n); tally(byPlatform[r.platform] || (byPlatform[r.platform] = {}), kind, r.n); runs += r.n;
  }
  return { days, runs, kinds: [...KINDS, 'empty'], total, byPlatform, truncated: rows.length > CAUSE_GROUPS };
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

  // Every enabled feed that is failing right now, by cause (the `failing` list above is capped at `limit`).
  const failingByKind = {};
  for (const r of db.prepare(`SELECT substr(COALESCE(last_error, ''), 1, 200) AS err, COUNT(*) AS n FROM feeds
      WHERE enabled = 1 AND consecutive_failures >= ? GROUP BY err`).all(failingAfter)) tally(failingByKind, kindOf(r.err) || 'other', r.n);

  // Feeds the engine (or the library sweep) switched off on its own, with why. A pause by a person leaves no such error.
  const disabledRows = db.prepare(`SELECT * FROM feeds WHERE enabled = 0 AND last_error LIKE '%disabled%' AND consecutive_failures > 0
      ORDER BY COALESCE(last_run_at, '') DESC LIMIT ?`).all(limit);
  const disabledCount = db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE enabled = 0 AND last_error LIKE '%disabled%' AND consecutive_failures > 0").get().n;

  // Items waiting for a human: how many, how old, and why. Nothing expires them, so a queue nobody reads only grows.
  const rq = db.prepare(`SELECT COUNT(*) AS n, MIN(ingested_at) AS oldest, SUM(CASE WHEN ingested_at < ? THEN 1 ELSE 0 END) AS stale
      FROM media WHERE publish_state = 'review'`).get(iso(now - 7 * DAY));
  const reviewQueue = {
    total: rq.n || 0, olderThan7d: rq.stale || 0, oldestAt: rq.oldest || null,
    byReason: db.prepare(`SELECT COALESCE(NULLIF(substr(review_reason, 1, 40), ''), 'unspecified') AS reason, COUNT(*) AS n FROM media
        WHERE publish_state = 'review' GROUP BY reason ORDER BY n DESC LIMIT 12`).all(),
  };

  return {
    totals: { feeds: totals.feeds || 0, enabled: totals.enabled || 0, neverRun: totals.never || 0, failing: failing.length, stale: stale.length, dead: dead.length, disabledByEngine: disabledCount },
    failing, stale, dead, top, failingByKind, reviewQueue,
    disabled: disabledRows.map((f) => feedRow(f)),
    causes: runCauses(now),
    rules: { failingAfter, staleDays, deadDays, deadMinRuns },
  };
}

/* ------------------------------------------------------------------------------------------------ auto-retire */
// Feeds that people made (origin admin / import) are never touched. Everything the app made itself (seed, discovered,
// ingest, search, linked, expand, post, telegram-sync) is paused, not deleted, when it has clearly stopped working, so it
// stops taking scheduler slots and clogging the failing / dead lists. A pause is one row in the action log and one click
// to undo; an admin's later "enable" is respected for RESPECT_DAYS.
const PERSONAL_ORIGINS = ['admin', 'import'];
const RETIRE = { failingAfter: 20, notWorkingDays: 14, deadDays: 45, deadMinRuns: 12 };
const RESPECT_DAYS = 90;

/**
 * Pause the app's own feeds that failed `failingAfter` runs in a row with no success for `notWorkingDays`, or that ran
 * `deadMinRuns`+ times in `deadDays` and added nothing. At most `max` per call, so a bad day cannot empty the library.
 * @returns {{paused: Array<{id: string, platform: string, target: string, why: string}>, skipped: number, capped: boolean}}
 */
function retireDead({ now = Date.now(), max = 50, dryRun = false } = {}) {
  const rep = report({ failingAfter: RETIRE.failingAfter, deadDays: RETIRE.deadDays, deadMinRuns: RETIRE.deadMinRuns, limit: 1000, now });
  const why = new Map();
  for (const f of rep.failing) {
    if (!f.lastSuccessAt || f.lastSuccessAt < iso(now - RETIRE.notWorkingDays * DAY)) {
      why.set(f.id, `failed ${f.failures} runs in a row, no success in ${RETIRE.notWorkingDays}+ days${f.lastError ? ` (${String(f.lastError).slice(0, 80)})` : ''}`);
    }
  }
  for (const f of rep.dead) if (!why.has(f.id)) why.set(f.id, `${f.runs} runs in ${RETIRE.deadDays} days added nothing (${f.why})`);

  const out = { paused: [], skipped: 0, capped: false };
  const lastAction = repo.db.prepare("SELECT action, actor, created_at FROM moderation_actions WHERE target_type = 'feed' AND target_id = ? ORDER BY id DESC LIMIT 1");
  for (const [id, reason] of why) {
    const feed = repo.feeds.get(id);
    if (!feed || !feed.enabled || PERSONAL_ORIGINS.includes(feed.origin)) { out.skipped++; continue; }
    const last = lastAction.get(String(id));
    // someone enabled it by hand not long ago: that decision stands
    if (last && last.actor !== 'system' && last.created_at > iso(now - RESPECT_DAYS * DAY)) { out.skipped++; continue; }
    if (out.paused.length >= max) { out.capped = true; break; }
    if (!dryRun) {
      repo.feeds.update(id, { enabled: false });
      repo.logAction('feed', id, 'auto-retire', reason, 'system');
    }
    out.paused.push({ id, platform: feed.platform, target: feed.target, why: reason });
  }
  return out;
}

module.exports = { report, retireDead, RETIRE };
