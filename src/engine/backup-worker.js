'use strict';
/**
 * Background SQLite work on its own thread, so the serving event loop never pays for it:
 *
 *   task 'backup' (default) nightly copy + planner optimize + WAL checkpoint. `VACUUM INTO` rewrites
 *                     the whole database in one C call and was starving a 700k-row box; SQLite's online
 *                     backup API copies pages incrementally with a page-per-second throttle instead.
 *   task 'hot'     the trending-score refresh, every ten minutes: thousands of row updates that used to
 *                     run on the main thread and showed up as multi-second loop stalls.
 */
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

/** The trending score, chunked (same SQL as repo.media.recomputeHotChunked). */
async function recomputeHot(db, { tolerance = 0.02, chunk = 2000 } = {}) {
  const stmt = db.prepare(`UPDATE media SET hot = hot_score(score, likes, views, epoch_ms(posted_at), @now)
    WHERE seq > @from AND seq <= @to AND publish_state = 'published' AND abs(hot - hot_score(score, likes, views, epoch_ms(posted_at), @now)) > @tol * hot_score(score, likes, views, epoch_ms(posted_at), @now)`);
  const max = db.prepare("SELECT MAX(seq) AS m FROM media WHERE publish_state = 'published'").get();
  const top = max && max.m ? max.m : 0;
  const now = Date.now();
  let from = 0;
  let updated = 0;
  while (from < top) {
    const to = Math.min(from + chunk, top);
    try { updated += stmt.run({ now, tol: tolerance, from, to }).changes; } catch (e) { /* a live writer held a row: take it next pass */ }
    from = to;
    await new Promise((r) => setTimeout(r, 5)); // one writer at a time in WAL: let ingest take its turn
  }
  return updated;
}

(async () => {
  let db = null;
  try {
    db = new Database(workerData.dbPath);
    db.pragma('busy_timeout = 10000');
    db.pragma('journal_mode = WAL');
    if (workerData.task === 'hot') {
      require('../db/functions').hotScore(db);
      const updated = await recomputeHot(db);
      db.close();
      db = null;
      parentPort.postMessage({ ok: true, updated });
      return;
    }
    let size = 0;
    if (workerData.file) {
      // 400 pages/s ≈ 1.6 MB/s at 4 KB pages: gentle on a 1-vCPU Railway box. The backup API yields
      // between steps and never holds the read lock continuously; previous 1500 pages/s still starved the main thread.
      await db.backup(workerData.file, { rate: 400 });
      size = require('fs').statSync(workerData.file).size;
    }
    db.pragma('optimize');
    db.pragma('wal_checkpoint(PASSIVE)');
    db.close();
    db = null;
    parentPort.postMessage({ ok: true, size });
  } catch (e) {
    try { if (db) db.close(); } catch { /* ignore */ }
    parentPort.postMessage({ ok: false, error: String(e.message || e) });
  }
})();
