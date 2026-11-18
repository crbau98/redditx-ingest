'use strict';
/**
 * Heal rows that used a creator banner/icon as the post preview, and dead object-store thumbs:
 *
 *   banner   preview_url / thumbnail_url path is /banners/ or /icons/ (coomer/kemono profile chrome) — cleared.
 *            thumb_url + tint are cleared too so engine/thumbs.js re-queues (or leaves the video with no still).
 *   missing  thumb_url is media.prism.invalid/th/... and the object is gone — clear thumb_url + tint so a real
 *            still can be built again (or the UI falls through to first-frame / other stills).
 *
 * Dry by default. Optional creatorId scopes the walk. Windowed like library-health.
 */
const repo = require('../db/repo');
const store = require('../lib/objectstore');
const { walkWindows } = require('../lib/windowed');

const BATCH = 200;
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
 * @param {{dryRun?: boolean, limit?: number, creatorId?: string|null, batch?: number, checkStore?: (key: string) => Promise<boolean>}} opts
 */
async function heal({ dryRun = true, limit = Infinity, creatorId = null, batch = BATCH, checkStore } = {}) {
  const started = Date.now();
  const db = repo.db;
  const top = (db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0;
  const creatorClause = creatorId ? ' AND creator_id = ?' : '';
  const params = (after, to) => (creatorId ? [after, to, creatorId] : [after, to]);
  const stmt = db.prepare(`SELECT id, creator_id, platform, media_type, preview_url, thumbnail_url, thumb_url, tint, seq
    FROM media NOT INDEXED WHERE seq > ? AND seq <= ? AND publish_state = 'published'
      AND (${BANNER_SQL} OR ${STORE_THUMB_SQL})${creatorClause}`);
  const stats = {};
  const raw = [];
  await walkWindows({
    top, stats,
    fn: (after, to) => { for (const r of stmt.all(...params(after, to))) raw.push(r); },
  });

  const exists = checkStore || ((key) => store.has(key));
  const rows = [];
  for (const r of raw) {
    const banner = isBannerUrl(r.preview_url) || isBannerUrl(r.thumbnail_url);
    let missingThumb = false;
    if (!banner && r.thumb_url) {
      const key = store.keyOf(r.thumb_url);
      if (key && key.startsWith('th/')) {
        const present = await exists(key);
        if (!present) missingThumb = true;
      }
    }
    if (!banner && !missingThumb) continue; // store thumb present and no banner: leave alone
    rows.push({
      ...r,
      action: banner ? 'clear-banner' : 'clear-missing-thumb',
      clearPreview: isBannerUrl(r.preview_url),
      clearThumbnail: isBannerUrl(r.thumbnail_url),
      clearThumb: true, // both actions drop thumb_url + tint
      missingThumb,
    });
  }

  const todo = rows.slice(0, Math.max(0, Number.isFinite(limit) ? limit : rows.length));
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
    maxChunkMs: stats.maxChunkMs,
    windows: stats.windows,
    creatorId: creatorId || null,
  };
  for (const r of rows) out.byPlatform[r.platform] = (out.byPlatform[r.platform] || 0) + 1;
  // keep wouldClear alias used by the first tests
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
    stats.maxChunkMs = Math.max(stats.maxChunkMs || 0, Date.now() - t0);
    await tick();
  }
  if (out.cleared) {
    repo.logAction('maintenance', 'banner-heal', 'heal-banner-previews',
      `${out.cleared} row(s): ${out.bannerPreviews} banner preview(s), ${out.missingThumbs} missing thumb(s)`, 'admin');
  }
  out.ms = Date.now() - started;
  out.maxChunkMs = stats.maxChunkMs;
  return out;
}

module.exports = { heal, BANNER_SQL, STORE_THUMB_SQL, isBannerUrl };
