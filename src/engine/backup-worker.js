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

/**
 * Trending score, chunked. The scan is a read (HOT_SELECT_RANGE_SQL): the JS score functions run under a shared
 * snapshot and hold no write lock. Only the rows that actually drifted are written, 250 at a time, so the exclusive
 * lock is a short transaction instead of the whole scan.
 */
async function recomputeHot(db, { tolerance = 0.02, chunk = 2000, now = Date.now(), writeBatch = 0 } = {}) {
  const fns = require('../db/functions');
  const batchSize = writeBatch > 0 ? writeBatch : fns.HOT_WRITE_BATCH;
  const select = db.prepare(fns.HOT_SELECT_RANGE_SQL);
  const write = db.prepare(fns.HOT_WRITE_ONE_SQL);
  const apply = db.transaction((rows) => {
    let n = 0;
    for (const row of rows) n += write.run(row.next_hot, row.seq).changes;
    return n;
  });
  const max = db.prepare("SELECT MAX(seq) AS m FROM media WHERE publish_state = 'published'").get();
  const top = max && max.m ? max.m : 0;
  let from = 0;
  let updated = 0;
  while (from < top) {
    const to = Math.min(from + chunk, top);
    try {
      const rows = select.all({ now, tol: tolerance, from, to });
      for (let i = 0; i < rows.length; i += batchSize) updated += apply(rows.slice(i, i + batchSize));
    } catch { /* a live writer held a row: take it next pass */ }
    from = to;
    await new Promise((r) => setTimeout(r, 5)); // let the serving connection take a write between chunks
  }
  return updated;
}

async function main() {
  let db = null;
  try {
    db = new Database(workerData.dbPath);
    db.pragma('busy_timeout = 10000');
    db.pragma('journal_mode = WAL');
    if (workerData.task === 'hot') {
      // Checkpoints belong to the nightly backup. A hot pass that dirties thousands of pages must not
      // checkpoint mid-scan on this connection while other writers are waiting.
      db.pragma('wal_autocheckpoint = 0');
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
}

if (parentPort) main();

module.exports = { recomputeHot };
