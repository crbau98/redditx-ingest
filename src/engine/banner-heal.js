'use strict';
/**
 * Heal coomer (and kemono) rows that used a creator banner/icon as the post preview, and the object-store thumbs that
 * were rendered from those banners. Dry by default. Clearing preview/thumbnail leaves videos with no still (the UI shows
 * the first frame); clearing thumb_url + tint re-queues real thumbs when a proper preview exists.
 *
 * Match: preview_url or thumbnail_url path is /banners/ or /icons/ on img.coomer.st / img.kemono.su (and their CDN hosts).
 */
const repo = require('../db/repo');
const { walkWindows } = require('../lib/windowed');

const BATCH = 200;
const tick = () => new Promise((r) => setTimeout(r, 0));
const BANNER_SQL = `(
  (preview_url IS NOT NULL AND preview_url LIKE '%/banners/%')
  OR (preview_url IS NOT NULL AND preview_url LIKE '%/icons/%')
  OR (thumbnail_url IS NOT NULL AND thumbnail_url LIKE '%/banners/%')
  OR (thumbnail_url IS NOT NULL AND thumbnail_url LIKE '%/icons/%')
)`;

/**
 * @param {{dryRun?: boolean, limit?: number, creatorId?: string|null, batch?: number}} opts
 */
async function heal({ dryRun = true, limit = Infinity, creatorId = null, batch = BATCH } = {}) {
  const started = Date.now();
  const db = repo.db;
  const top = (db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0;
  const creatorClause = creatorId ? ' AND creator_id = ?' : '';
  const params = (after, to) => (creatorId ? [after, to, creatorId] : [after, to]);
  const stmt = db.prepare(`SELECT id, creator_id, platform, media_type, preview_url, thumbnail_url, thumb_url, tint, seq
    FROM media NOT INDEXED WHERE seq > ? AND seq <= ? AND publish_state = 'published' AND ${BANNER_SQL}${creatorClause}`);
  const stats = {};
  const rows = [];
  await walkWindows({
    top, stats,
    fn: (after, to) => { for (const r of stmt.all(...params(after, to))) rows.push(r); },
  });
  const todo = rows.slice(0, Math.max(0, Number.isFinite(limit) ? limit : rows.length));
  const out = {
    found: rows.length, wouldClear: todo.length, cleared: 0, dryRun: !!dryRun,
    byPlatform: {}, sample: todo.slice(0, 15).map((r) => ({
      id: r.id, creatorId: r.creator_id, platform: r.platform, type: r.media_type,
      preview: r.preview_url, thumb: r.thumb_url,
    })),
    ms: 0,
  };
  for (const r of rows) out.byPlatform[r.platform] = (out.byPlatform[r.platform] || 0) + 1;
  if (dryRun) { out.ms = Date.now() - started; return out; }

  const clear = db.prepare(`UPDATE media SET
    preview_url = CASE WHEN preview_url LIKE '%/banners/%' OR preview_url LIKE '%/icons/%' THEN NULL ELSE preview_url END,
    thumbnail_url = CASE WHEN thumbnail_url LIKE '%/banners/%' OR thumbnail_url LIKE '%/icons/%' THEN NULL ELSE thumbnail_url END,
    thumb_url = NULL,
    tint = NULL
    WHERE id = ? AND publish_state = 'published'`);
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch);
    db.transaction(() => { for (const r of chunk) { clear.run(r.id); out.cleared++; } })();
    await tick();
  }
  out.ms = Date.now() - started;
  return out;
}

module.exports = { heal, BANNER_SQL };
