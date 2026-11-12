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
 * The trending refresh, written once. The main connection (repo.media.recomputeHot / recomputeHotChunked) still runs the
 * UPDATE statements. The background worker (engine/backup-worker.js) must not: an UPDATE holds the write lock while
 * SQLite scans the chunk and calls the JS functions, and that lock is what makes Discovery, Visual, Face and OCR throw
 * "database is locked". The worker reads the drifted rows first (shared read, no write lock), then writes them in short
 * batches. Same expression, so the stored hot cannot drift between the two paths.
 * Only rows whose stored score moved by more than @tol are rewritten; lean_bias folds in the owner's type preference.
 */
const HOT_EXPR = "hot_score(score, likes, views, epoch_ms(posted_at), @now) * COALESCE(lean_bias, 1.0)";
const HOT_SET = `hot = ${HOT_EXPR}`;
const HOT_DRIFT = `publish_state = 'published' AND abs(hot - ${HOT_EXPR}) > @tol * (${HOT_EXPR})`;
/** Every published row at once: @now, @tol. */
const HOT_UPDATE_SQL = `UPDATE media SET ${HOT_SET}
      WHERE ${HOT_DRIFT}`;
/** One rowid range: @now, @tol, @from, @to. Main-thread chunked refresh. */
const HOT_UPDATE_RANGE_SQL = `UPDATE media SET ${HOT_SET}
      WHERE seq > @from AND seq <= @to AND ${HOT_DRIFT}`;
/** Same range, read only. Returns the seqs that drifted and the hot value to store. */
const HOT_SELECT_RANGE_SQL = `SELECT seq, ${HOT_EXPR} AS next_hot FROM media
      WHERE seq > @from AND seq <= @to AND ${HOT_DRIFT}`;
/** One row. The worker runs this inside a transaction of at most HOT_WRITE_BATCH rows. */
const HOT_WRITE_ONE_SQL = 'UPDATE media SET hot = ? WHERE seq = ?';
const HOT_WRITE_BATCH = 250;

module.exports = { hotScore, HOT_UPDATE_SQL, HOT_UPDATE_RANGE_SQL, HOT_SELECT_RANGE_SQL, HOT_WRITE_ONE_SQL, HOT_WRITE_BATCH };