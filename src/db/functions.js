'use strict';
/**
 * The SQL functions the hot-score maintenance needs, registered on ANY connection that runs that SQL:
 * the main connection (src/db/index.js) and the background worker that opens the same file with its own
 * better-sqlite3 handle (engine/backup-worker.js). Pure and deterministic, so SQLite may fold them.
 */
function hotScore(db) {
  /** Time-decayed popularity used by the "Trending" sort. */
  db.function('hot_score', { deterministic: true }, (score, likes, views, postedAtMs, nowMs) => {
    const ageDays = Math.max(0, (nowMs - postedAtMs) / 86400000);
    const pop = Math.log1p(Math.max(0, score || 0)) + 1.5 * Math.log1p((likes || 0) * 5 + (views || 0) * 0.2) + 1;
    return pop / Math.pow(ageDays + 1.5, 0.9);
  });
  db.function('epoch_ms', { deterministic: true }, (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  });
}

/**
 * The trending refresh, written once. Every connection that runs it (repo.media.recomputeHot / recomputeHotChunked on the
 * main connection, engine/backup-worker.js on its own) uses these strings, so the ranking cannot drift between them.
 * Only rows whose stored score moved by more than @tol are rewritten; lean_bias folds in the owner's type preference.
 */
const HOT_SET = "hot = hot_score(score, likes, views, epoch_ms(posted_at), @now) * COALESCE(lean_bias, 1.0)";
const HOT_DRIFT = "publish_state = 'published' AND abs(hot - hot_score(score, likes, views, epoch_ms(posted_at), @now) * COALESCE(lean_bias, 1.0)) > @tol * (hot_score(score, likes, views, epoch_ms(posted_at), @now) * COALESCE(lean_bias, 1.0))";
/** Every published row at once: @now, @tol. */
const HOT_UPDATE_SQL = `UPDATE media SET ${HOT_SET}
      WHERE ${HOT_DRIFT}`;
/** One rowid range: @now, @tol, @from, @to. */
const HOT_UPDATE_RANGE_SQL = `UPDATE media SET ${HOT_SET}
      WHERE seq > @from AND seq <= @to AND ${HOT_DRIFT}`;

module.exports = { hotScore, HOT_UPDATE_SQL, HOT_UPDATE_RANGE_SQL };