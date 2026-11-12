'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildReports: visitor reports (abuse / takedown requests). Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildReports = function buildReports({ db, uuid }) {
/* ------------------------------------------------------------------- reports */
const reports = {
  create({ mediaId, creatorId, kind, reason, contact, reporterHash }) {
    const id = uuid();
    db.prepare('INSERT INTO reports (id, media_id, creator_id, kind, reason, contact, reporter_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, mediaId || null, creatorId || null, kind, reason ? String(reason).slice(0, 2000) : null, contact ? String(contact).slice(0, 200) : null, reporterHash || null);
    return id;
  },
  get(id) { return db.prepare('SELECT * FROM reports WHERE id = ?').get(id) || null; },
  list({ status = 'open', page = 0, limit = 50 } = {}) {
    const where = status === 'all' ? '' : 'WHERE r.status = ?';
    const params = status === 'all' ? [] : [status];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM reports r ${where}`).get(...params).n;
    const items = db.prepare(`SELECT r.*, m.title AS media_title, m.thumb_url, m.preview_url, m.thumbnail_url, m.media_url, m.media_type,
        COALESCE(m.thumb_url, m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END) AS media_thumb,
        m.publish_state AS media_state, m.source_url AS media_source, c.handle AS creator_handle
      FROM reports r LEFT JOIN media m ON m.id = r.media_id LEFT JOIN creators c ON c.id = COALESCE(r.creator_id, m.creator_id)
      ${where} ORDER BY (r.kind IN ('underage','nonconsensual')) DESC, r.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, page * limit);
    return { items, total, page, limit };
  },
  resolve(id, status, resolution, actor) {
    return db.prepare("UPDATE reports SET status = ?, resolution = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ? WHERE id = ?")
      .run(status, resolution || null, actor || 'admin', id).changes > 0;
  },
  openCount() { return db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n; },
  recentCountFrom(reporterHash, minutes = 60) {
    return db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_hash = ? AND created_at >= ?')
      .get(reporterHash, new Date(Date.now() - minutes * 60000).toISOString()).n;
  },
};
  return { reports };
};
