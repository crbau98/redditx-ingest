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

// 5,000 (was 20,000): the dry run took 20.6 s on production in windows of a few hundred ms each.
const WINDOW = 5000;
const BATCH = 200;
const hasTable = (name) => !!repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const tick = () => new Promise((res) => setTimeout(res, 0)); // a timer, so pending HTTP is answered between windows

/** Every removed media id that still has a face or alt-source row. */
async function findResidue({ window = WINDOW, stats = {} } = {}) {
  const db = repo.db;
  const ids = new Set();
  stats.maxChunkMs = stats.maxChunkMs || 0;
  for (const table of ['media_faces', 'media_alt_sources']) {
    if (!hasTable(table)) continue;
    const top = (db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() || {}).m || 0;
    const stmt = db.prepare(`SELECT DISTINCT t.media_id AS id FROM ${table} t JOIN media m ON m.id = t.media_id
      WHERE t.rowid > ? AND t.rowid <= ? AND m.publish_state = 'removed'`);
    for (let from = 0; from < top; from += window) {
      const t0 = Date.now();
      for (const r of stmt.all(from, from + window)) ids.add(r.id);
      stats.maxChunkMs = Math.max(stats.maxChunkMs, Date.now() - t0);
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
  const stats = {};
  const ids = await findResidue({ window, stats });
  const todo = ids.slice(0, Math.max(0, Number.isFinite(limit) ? limit : ids.length));
  let purged = 0; let batches = 0;
  if (!dryRun) {
    for (let i = 0; i < todo.length; i += batch) {
      const t0 = Date.now();
      purged += repo.purgeRemovedContent(todo.slice(i, i + batch));
      stats.maxChunkMs = Math.max(stats.maxChunkMs, Date.now() - t0);
      batches++;
      await tick();
    }
    if (purged) repo.logAction('maintenance', 'residue', 'purge-removed-residue', `${purged} removed item(s): face vectors and alt sources deleted`, 'admin');
  }
  return { found: ids.length, purged, remaining: ids.length - purged, dryRun: !!dryRun, batches, ms: Date.now() - started, maxChunkMs: stats.maxChunkMs };
}

module.exports = { purgeResidue, findResidue };
