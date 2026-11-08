'use strict';
/**
 * Backup and nightly SQLite maintenance on a worker thread. `VACUUM INTO` rewrites the whole
 * database in one C call and was starving a 700k-row box; SQLite's online backup API copies pages
 * incrementally with a page-per-second throttle, so live requests keep their CPU and locks short.
 */
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

(async () => {
  let db = null;
  try {
    db = new Database(workerData.dbPath);
    db.pragma('busy_timeout = 10000');
    db.pragma('journal_mode = WAL');
    let size = 0;
    if (workerData.file) {
      // 1500 pages/s is roughly 6 MB/s at 4 KB pages: a multi-GB backup takes minutes, not a
      // minute of CPU starvation. The backup API yields between steps.
      await db.backup(workerData.file, { rate: 1500 });
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
