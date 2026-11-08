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

module.exports = { hotScore };