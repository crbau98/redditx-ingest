'use strict';
/**
 * Backup and nightly SQLite maintenance on a worker thread. `VACUUM INTO` plus `PRAGMA optimize`
 * and a WAL checkpoint are all synchronous C calls: on a 700k-row database they can freeze the
 * serving event loop for tens of seconds. This worker opens its own connection, does the work, and
 * posts the result back; the main thread keeps answering requests.
 */
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');

let db = null;
try {
  db = new Database(workerData.dbPath);
  db.pragma('busy_timeout = 10000');
  db.pragma('journal_mode = WAL');
  let size = 0;
  if (workerData.file) {
    db.prepare('VACUUM INTO ?').run(workerData.file);
    size = require('fs').statSync(workerData.file).size;
  }
  db.pragma('optimize');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  db = null;
  parentPort.postMessage({ ok: true, size });
} catch (e) {
  try { if (db) db.close(); } catch { /* ignore */ }
  parentPort.postMessage({ ok: false, error: String(e.message || e) });
}
