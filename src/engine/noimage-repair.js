'use strict';
/**
 * Published rows with no picture at all (library-health `publishedNoImage`): no preview_url, thumbnail_url or thumb_url and,
 * for an image, no media_url either. They render as empty tiles. Each one either gets a picture back or leaves the grid:
 *
 *   poster   a video whose URL has a known poster pattern (RedGIFs -poster.jpg, YouTube i.ytimg, Bluesky thumbnail.jpg; the
 *            same lib/imagefilter.deriveVideoPosterUrl the pipeline uses). The poster is read first; only a picture that
 *            downloads and decodes is stored as preview_url (its hash too, so dedupe sees it).
 *   review   anything else: moved to the review queue with reason 'no-image'. Reversible: approving it in Review publishes it
 *            again; nothing is deleted.
 *
 * dryRun reports what would happen without any network or write. Finding the rows walks media by rowid in WINDOW ranges with
 * a timer yield between them (never a whole-table statement); the work runs in batches of BATCH rows with a yield after each.
 */
const repo = require('../db/repo');
const imagefilter = require('../lib/imagefilter');

const WINDOW = 5000;
const BATCH = 25;
const REASON = 'no-image';
const tick = () => new Promise((res) => setTimeout(res, 0));
const nz = (col) => `NULLIF(TRIM(${col}), '')`;
const NO_IMAGE = `m.publish_state = 'published' AND COALESCE(${nz('m.preview_url')}, ${nz('m.thumbnail_url')}, ${nz('m.thumb_url')},
  CASE WHEN m.media_type = 'image' THEN ${nz('m.media_url')} END) IS NULL`;

/** The rows, with the action each would get. */
async function find({ window = WINDOW, stats = {} } = {}) {
  const db = repo.db;
  const top = (db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0;
  const stmt = db.prepare(`SELECT m.id, m.creator_id, m.platform, m.media_type, m.media_url, m.hls_url, m.phash FROM media m NOT INDEXED
    WHERE m.seq > ? AND m.seq <= ? AND ${NO_IMAGE}`);
  const rows = [];
  stats.maxChunkMs = stats.maxChunkMs || 0;
  for (let from = 0; from < top; from += window) {
    const t0 = Date.now();
    for (const r of stmt.all(from, from + window)) {
      const poster = r.media_type === 'video' ? imagefilter.deriveVideoPosterUrl(r.media_url || r.hls_url) : null;
      rows.push({ ...r, poster, action: poster ? 'poster' : 'review' });
    }
    stats.maxChunkMs = Math.max(stats.maxChunkMs, Date.now() - t0);
    await tick();
  }
  return rows;
}

/**
 * @param {{dryRun?: boolean, limit?: number, batch?: number, window?: number}} opts
 * @returns {Promise<{found, posterCandidates, wouldReview, postered, reviewed, posterFailed, remaining, byPlatform, sample, dryRun, batches, ms, maxChunkMs}>}
 */
async function repair({ dryRun = false, limit = Infinity, batch = BATCH, window = WINDOW } = {}) {
  const started = Date.now();
  const stats = {};
  const rows = await find({ window, stats });
  const byPlatform = {};
  for (const r of rows) byPlatform[r.platform] = (byPlatform[r.platform] || 0) + 1;
  const out = {
    found: rows.length, posterCandidates: rows.filter((r) => r.action === 'poster').length, wouldReview: rows.filter((r) => r.action === 'review').length,
    postered: 0, reviewed: 0, posterFailed: 0, byPlatform, sample: rows.slice(0, 10).map((r) => ({ id: r.id, platform: r.platform, type: r.media_type, action: r.action })),
    dryRun: !!dryRun, batches: 0,
  };
  if (!dryRun) {
    const todo = rows.slice(0, Math.max(0, Number.isFinite(limit) ? limit : rows.length));
    const setPoster = repo.db.prepare("UPDATE media SET preview_url = ?, phash = COALESCE(phash, ?) WHERE id = ? AND publish_state = 'published'");
    const touched = new Set();
    for (let i = 0; i < todo.length; i += batch) {
      for (const r of todo.slice(i, i + batch)) {
        let ok = false;
        if (r.poster) {
          let referer; try { referer = `${new URL(r.poster).origin}/`; } catch { /* none */ }
          const v = await imagefilter.analyze(r.poster, { referer, faces: false, hash: true });
          if (v && v.status === 'ok' && v.phash) { setPoster.run(r.poster, v.phash, r.id); out.postered++; ok = true; } else out.posterFailed++;
        }
        if (!ok) {
          const t0 = Date.now();
          repo.media.setState(r.id, 'review', REASON, { exact: true, deferStats: true });
          stats.maxChunkMs = Math.max(stats.maxChunkMs, Date.now() - t0);
          if (r.creator_id) touched.add(r.creator_id);
          out.reviewed++;
        }
      }
      out.batches++;
      await tick();
    }
    for (const id of touched) { repo.creators.refreshStats(id); await tick(); }
    if (out.postered || out.reviewed) repo.logAction('maintenance', 'no-image', 'repair-no-image', `${out.postered} poster(s) restored, ${out.reviewed} moved to review (no-image)`, 'admin');
  }
  out.remaining = out.found - out.postered - out.reviewed;
  out.ms = Date.now() - started; out.maxChunkMs = stats.maxChunkMs;
  return out;
}

module.exports = { repair, find, REASON };
