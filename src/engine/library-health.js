'use strict';
/**
 * Library health (admin, read-only): four counts the admin JSON could not answer. Nothing is written or repaired.
 *
 *   publishedNoImage       published rows with no usable picture: no preview_url, thumbnail_url or thumb_url, and (for an
 *                          image) no media_url either; empty strings count as missing.
 *   redditPhashNull        reddit image rows that are not removed and have no perceptual hash (dedupe cannot see them).
 *   removedWithFacesOrAlt  removed rows that still have a media_faces or media_alt_sources row (residue the takedown
 *                          purge should have deleted; the purge covers both since 690c331).
 *   creatorCountDrift      creators whose stored media_count differs from a live count of their published rows (the
 *                          same definition the counter uses), with the largest offenders.
 *
 * One pass over media by rowid in WINDOW-sized ranges with a timer yield between them: no statement sorts or scans the whole
 * table, so the event loop keeps answering while it runs. WINDOW was 20,000 rows (about 230 ms of synchronous work per
 * window on production, 14.7 s in all); `maxChunkMs` in the answer is the longest synchronous chunk this run took.
 *
 * redditPhashNull is split (schema v38): `pending` (the hash sweep or its retry will still try it), `unhashable` (given up
 * on, phash_error says why) and `hidden` (hidden rows are not swept: dedupe compares published and waiting rows only).
 */
const repo = require('../db/repo');

const WINDOW = 5000;
const yieldLoop = () => new Promise((res) => setTimeout(res, 0)); // a timer, so pending HTTP is answered between windows
const nz = (col) => `NULLIF(TRIM(${col}), '')`;

async function report({ window = WINDOW, top = 20 } = {}) {
  const db = repo.db;
  const started = Date.now();
  const hasFaces = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_faces'").get();
  const hasAlt = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_alt_sources'").get();
  const residue = [hasFaces && 'EXISTS (SELECT 1 FROM media_faces f WHERE f.media_id = m.id)', hasAlt && 'EXISTS (SELECT 1 FROM media_alt_sources a WHERE a.media_id = m.id)'].filter(Boolean).join(' OR ') || '0';
  const counts = db.prepare(`SELECT
      COALESCE(SUM(m.publish_state = 'published' AND COALESCE(${nz('m.preview_url')}, ${nz('m.thumbnail_url')}, ${nz('m.thumb_url')},
        CASE WHEN m.media_type = 'image' THEN ${nz('m.media_url')} END) IS NULL), 0) AS noImage,
      COALESCE(SUM(m.platform = 'reddit' AND m.media_type = 'image' AND m.publish_state != 'removed' AND m.phash IS NULL), 0) AS redditPhashNull,
      COALESCE(SUM(m.platform = 'reddit' AND m.media_type = 'image' AND m.publish_state IN ('published','review') AND m.phash IS NULL AND m.phash_error IS NULL), 0) AS rpPending,
      COALESCE(SUM(m.platform = 'reddit' AND m.media_type = 'image' AND m.publish_state != 'removed' AND m.phash IS NULL AND m.phash_error IS NOT NULL), 0) AS rpUnhashable,
      COALESCE(SUM(m.platform = 'reddit' AND m.media_type = 'image' AND m.publish_state = 'hidden' AND m.phash IS NULL AND m.phash_error IS NULL), 0) AS rpHidden,
      COALESCE(SUM(m.publish_state = 'removed' AND (${residue})), 0) AS removedResidue
    FROM media m NOT INDEXED WHERE m.seq > ? AND m.seq <= ?`);
  const perCreator = db.prepare(`SELECT creator_id AS id, COUNT(*) AS n FROM media NOT INDEXED
    WHERE seq > ? AND seq <= ? AND publish_state = 'published' AND creator_id IS NOT NULL GROUP BY creator_id`);
  const topSeq = (db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0;
  const live = new Map();
  const out = { publishedNoImage: 0, redditPhashNull: 0, redditPhash: { pending: 0, unhashable: 0, hidden: 0 }, removedWithFacesOrAlt: 0 };
  let maxChunkMs = 0;
  for (let from = 0; from < topSeq; from += window) {
    const t0 = Date.now();
    const c = counts.get(from, from + window);
    out.publishedNoImage += c.noImage; out.redditPhashNull += c.redditPhashNull; out.removedWithFacesOrAlt += c.removedResidue;
    out.redditPhash.pending += c.rpPending; out.redditPhash.unhashable += c.rpUnhashable; out.redditPhash.hidden += c.rpHidden;
    for (const r of perCreator.all(from, from + window)) live.set(r.id, (live.get(r.id) || 0) + r.n);
    maxChunkMs = Math.max(maxChunkMs, Date.now() - t0);
    await yieldLoop();
  }
  const t1 = Date.now();
  const drift = [];
  for (const c of db.prepare('SELECT id, handle, media_count FROM creators').all()) {
    const actual = live.get(c.id) || 0;
    if ((c.media_count || 0) !== actual) drift.push({ id: c.id, handle: c.handle, stored: c.media_count || 0, actual, diff: actual - (c.media_count || 0) });
  }
  drift.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  maxChunkMs = Math.max(maxChunkMs, Date.now() - t1);
  return {
    ...out,
    creatorCountDrift: { creators: drift.length, top: drift.slice(0, top) },
    definitions: {
      publishedNoImage: "publish_state='published' and no non-empty preview_url, thumbnail_url, thumb_url (nor media_url for an image)",
      redditPhashNull: "platform='reddit', media_type='image', publish_state!='removed', phash IS NULL",
      redditPhash: 'of those: pending = published/review, not given up (the sweep or its retry will try it); unhashable = phash_error set (given up, with the reason); hidden = hidden and not given up (hidden rows are not swept)',
      removedWithFacesOrAlt: "publish_state='removed' with any media_faces or media_alt_sources row",
      creatorCountDrift: "creators.media_count != live COUNT of their publish_state='published' rows",
    },
    scannedThroughSeq: topSeq, ms: Date.now() - started, maxChunkMs, window, generatedAt: new Date().toISOString(),
  };
}

module.exports = { report };
