'use strict';
/**
 * Worker thread for library-wide aggregates. It opens its own READ-ONLY connection to the same
 * database (WAL lets readers run beside the writer), so a multi-second scan never holds the main
 * thread's event loop. It never migrates, never writes, and never starts ingestion.
 */
const { parentPort } = require('worker_threads');

process.env.PRISM_DB_READONLY = '1'; // read by src/db/index.js before it opens the database
const { JOB_FNS } = require('./aggregate-jobs');

parentPort.on('message', ({ id, name }) => {
  const t = Date.now();
  const fn = JOB_FNS[name];
  if (!fn) { parentPort.postMessage({ id, ok: false, error: `unknown job ${name}` }); return; }
  try {
    const value = fn();
    parentPort.postMessage({ id, ok: true, value, ms: Date.now() - t });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e && e.message ? e.message : String(e), ms: Date.now() - t });
  }
});
