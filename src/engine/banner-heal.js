'use strict';
/**
 * Heal rows that used a creator banner/icon as the post preview, and dead object-store thumbs:
 *
 *   banner   preview_url / thumbnail_url path is /banners/ or /icons/ (coomer/kemono profile chrome) — cleared.
 *            thumb_url + tint are cleared too so engine/thumbs.js re-queues (or leaves the video with no still).
 *   missing  thumb_url is media.prism.invalid/th/... and the object is gone — clear thumb_url + tint so a real
 *            still can be built again (or the UI falls through to first-frame / other stills).
 *
 * Dry by default. Optional creatorId scopes the walk. Chunked/resumable via afterSeq + limit: each call walks
 * from `afterSeq` and stops after `limit` candidate rows (or the table end), returning `nextAfter` so a full
 * ~400k-media pass can be resumed without timing out on one HTTP request.
 */
const repo = require('../db/repo');
const store = require('../lib/objectstore');

const BATCH = 200;
const WINDOW = 200;
const tick = () => new Promise((r) => setTimeout(r, 0));
const BANNER_SQL = `(
  (preview_url IS NOT NULL AND preview_url LIKE '%/banners/%')
  OR (preview_url IS NOT NULL AND preview_url LIKE '%/icons/%')
  OR (thumbnail_url IS NOT NULL AND thumbnail_url LIKE '%/banners/%')
  OR (thumbnail_url IS NOT NULL AND thumbnail_url LIKE '%/icons/%')
)`;
const STORE_THUMB_SQL = `(thumb_url IS NOT NULL AND (
  thumb_url LIKE 'https://media.prism.invalid/th/%' OR thumb_url LIKE 'http://media.prism.invalid/th/%'
))`;

function isBannerUrl(url) {
  return !!url && /\/(?:banners|icons)\//i.test(String(url));
}

/**
 * @param {{dryRun?: boolean, limit?: number, creatorId?: string|null, batch?: number,
 *          afterSeq?: number, checkStore?: (key: string) => Promise<boolean>}} opts
 *   afterSeq — resume cursor (exclusive); next call uses returned nextAfter.
 *   limit    — max candidate rows to clear/report this chunk (Infinity = rest of table from afterSeq).
 */
async function heal({
  dryRun = true,
  limit = Infinity,
  creatorId = null,
  batch = BATCH,
  afterSeq = 0,
  checkStore,
} = {}) {
  const started = Date.now();
  const db = repo.db;
  const top = (db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0;
  const start = Math.max(0, Number(afterSeq) || 0);
  // limit <= 0 means "no cap" (matches the HTTP route's limit=0 → Infinity); a positive limit chunks the walk.
  const cap = !Number.isFinite(Number(limit)) || Number(limit) <= 0 ? Infinity : Number(limit);
  const creatorClause = creatorId ? ' AND creator_id = ?' : '';
  const params = (after, to) => (creatorId ? [after, to, creatorId] : [after, to]);
  const stmt = db.prepare(`SELECT id, creator_id, platform, media_type, preview_url, thumbnail_url, thumb_url, tint, seq
    FROM media NOT INDEXED WHERE seq > ? AND seq <= ? AND publish_state = 'published'
      AND (${BANNER_SQL} OR ${STORE_THUMB_SQL})${creatorClause}`);

  const exists = checkStore || ((key) => store.has(key));
  const rows = [];
  let scannedTo = start;
  let windows = 0;
  let maxChunkMs = 0;
  let hitCap = false;

  let after = start;
  while (after < top && !hitCap) {
    const to = Math.min(after + WINDOW, top);
    const t0 = Date.now();
    const batchRows = stmt.all(...params(after, to));
    maxChunkMs = Math.max(maxChunkMs, Date.now() - t0);
    windows++;
    for (const r of batchRows) {
      const banner = isBannerUrl(r.preview_url) || isBannerUrl(r.thumbnail_url);
      let missingThumb = false;
      if (!banner && r.thumb_url) {
        const key = store.keyOf(r.thumb_url);
        if (key && key.startsWith('th/')) {
          const present = await exists(key);
          if (!present) missingThumb = true;
        }
      }
      scannedTo = r.seq;
      if (!banner && !missingThumb) continue;
      rows.push({
        ...r,
        action: banner ? 'clear-banner' : 'clear-missing-thumb',
        clearPreview: isBannerUrl(r.preview_url),
        clearThumbnail: isBannerUrl(r.thumbnail_url),
        clearThumb: true,
        missingThumb,
      });
      if (rows.length >= cap) { hitCap = true; break; }
    }
    if (!hitCap) scannedTo = to;
    after = to;
    await tick();
  }

  const todo = rows;
  // done only when the table end was reached without filling the chunk (more work would find nothing new).
  const done = !hitCap && scannedTo >= top;
  const out = {
    found: rows.length,
    bannerPreviews: rows.filter((r) => r.action === 'clear-banner').length,
    missingThumbs: rows.filter((r) => r.missingThumb).length,
    wouldClear: todo.length,
    cleared: 0,
    dryRun: !!dryRun,
    byPlatform: {},
    sample: todo.slice(0, 15).map((r) => ({
      id: r.id, creatorId: r.creator_id, platform: r.platform, type: r.media_type,
      action: r.action, preview: r.preview_url, thumb: r.thumb_url, missingThumb: r.missingThumb,
    })),
    ms: 0,
    maxChunkMs,
    windows,
    creatorId: creatorId || null,
    afterSeq: start,
    nextAfter: scannedTo,
    done,
    limit: Number.isFinite(cap) ? cap : null,
  };
  for (const r of rows) out.byPlatform[r.platform] = (out.byPlatform[r.platform] || 0) + 1;
  if (dryRun) { out.ms = Date.now() - started; return out; }

  const clear = db.prepare(`UPDATE media SET
    preview_url = CASE WHEN @clearPreview THEN NULL ELSE preview_url END,
    thumbnail_url = CASE WHEN @clearThumbnail THEN NULL ELSE thumbnail_url END,
    thumb_url = CASE WHEN @clearThumb THEN NULL ELSE thumb_url END,
    tint = CASE WHEN @clearThumb THEN NULL ELSE tint END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id AND publish_state = 'published'`);
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    const t0 = Date.now();
    db.transaction(() => {
      for (const r of chunk) {
        clear.run({
          id: r.id,
          clearPreview: r.clearPreview ? 1 : 0,
          clearThumbnail: r.clearThumbnail ? 1 : 0,
          clearThumb: r.clearThumb ? 1 : 0,
        });
        out.cleared++;
      }
    })();
    maxChunkMs = Math.max(maxChunkMs, Date.now() - t0);
    await tick();
  }
  if (out.cleared) {
    repo.logAction('maintenance', 'banner-heal', 'heal-banner-previews',
      `${out.cleared} row(s): ${out.bannerPreviews} banner preview(s), ${out.missingThumbs} missing thumb(s) (afterSeq ${start}→${scannedTo})`, 'admin');
  }
  out.ms = Date.now() - started;
  out.maxChunkMs = maxChunkMs;
  return out;
}

module.exports = { heal, BANNER_SQL, STORE_THUMB_SQL, isBannerUrl };
