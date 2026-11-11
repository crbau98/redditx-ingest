'use strict';
/**
 * Removed media that still carries residue: face vectors (media_faces) or alt sources (media_alt_sources) left on rows
 * removed before the takedown purge covered them (690c331). Finds those ids and runs them through the ONE purge
 * (repo.purgeRemovedContent), in small batches with a yield between them.
 *
 * Finding them walks the residue tables (not all of media) by rowid in fixed windows, keeping ids whose media row is
 * removed: no statement sorts or scans a whole table. purgeRemovedContent re-checks publish_state = 'removed' itself, so
 * a published row is never touched; publish_state is never changed; the media rows stay. Running it again finds nothing.
 */
const repo = require('../db/repo');

const WINDOW = 20000;
const BATCH = 200;
const hasTable = (name) => !!repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const tick = () => new Promise((res) => setImmediate(res));

/** Every removed media id that still has a face or alt-source row. */
async function findResidue({ window = WINDOW } = {}) {
  const db = repo.db;
  const ids = new Set();
  for (const table of ['media_faces', 'media_alt_sources']) {
    if (!hasTable(table)) continue;
    const top = (db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() || {}).m || 0;
    const stmt = db.prepare(`SELECT DISTINCT t.media_id AS id FROM ${table} t JOIN media m ON m.id = t.media_id
      WHERE t.rowid > ? AND t.rowid <= ? AND m.publish_state = 'removed'`);
    for (let from = 0; from < top; from += window) {
      for (const r of stmt.all(from, from + window)) ids.add(r.id);
      await tick();
    }
  }
  return [...ids];
}

/**
 * @param {{dryRun?: boolean, limit?: number, batch?: number, window?: number}} opts
 * @returns {Promise<{found: number, purged: number, remaining: number, dryRun: boolean, batches: number, ms: number}>}
 */
async function purgeResidue({ dryRun = false, limit = Infinity, batch = BATCH, window = WINDOW } = {}) {
  const started = Date.now();
  const ids = await findResidue({ window });
  const todo = ids.slice(0, Math.max(0, Number.isFinite(limit) ? limit : ids.length));
  let purged = 0; let batches = 0;
  if (!dryRun) {
    for (let i = 0; i < todo.length; i += batch) {
      purged += repo.purgeRemovedContent(todo.slice(i, i + batch));
      batches++;
      await tick();
    }
    if (purged) repo.logAction('maintenance', 'residue', 'purge-removed-residue', `${purged} removed item(s): face vectors and alt sources deleted`, 'admin');
  }
  return { found: ids.length, purged, remaining: ids.length - purged, dryRun: !!dryRun, batches, ms: Date.now() - started };
}

module.exports = { purgeResidue, findResidue };
