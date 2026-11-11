'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildTakedowns: takedowns (opt-outs) and what applying one removes. Built by repo.js with the helpers it uses; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildTakedowns = function buildTakedowns({ db, clampInt, blocklist, purgeRemovedContent, purgeRemovedFor, rememberRemovedHashes, logAction, creatorQ, notifyBlocked, notifyState }) {
const takedownLib = require('../../lib/takedowns');
const takedowns = {
  all() {
    return db.prepare('SELECT * FROM takedowns ORDER BY id DESC').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM takedowns WHERE id = ?').get(Number(id)) || null;
  },
  find(kind, value) {
    const norm = takedownLib.normalize(kind, value);
    return db.prepare('SELECT * FROM takedowns WHERE kind = ? AND value = ? COLLATE NOCASE').get(norm.kind, norm.value) || null;
  },
  list({ kind, page = 0, limit = 100 } = {}) {
    const lim = clampInt(limit, 1, 500, 100);
    const pg = clampInt(page, 0, 100000, 0);
    const where = kind && takedownLib.KINDS.includes(String(kind).toLowerCase()) ? 'WHERE kind = ?' : '';
    const params = where ? [String(kind).toLowerCase()] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM takedowns ${where}`).get(...params).n;
    const items = db.prepare(`SELECT * FROM takedowns ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, lim, pg * lim);
    return { items, total, page: pg, limit: lim };
  },
  check(item, feed = null) {
    return takedownLib.checkItem(item, feed, takedowns.all());
  },
  add({ kind, value, reason = null, actor = 'admin' } = {}) {
    const norm = takedownLib.normalize(kind, value);
    const why = reason ? String(reason).trim() : 'takedown';
    let td = null;
    let purgedMedia = 0;
    let disabledFeeds = 0;
    let blockedCreators = 0;
    const removedPhashes = [];
    const removedMediaIds = [];

    db.transaction(() => {
      db.prepare(`INSERT INTO takedowns (kind, value, reason) VALUES (?, ?, ?)
        ON CONFLICT(kind, value) DO UPDATE SET reason = COALESCE(excluded.reason, takedowns.reason)`)
        .run(norm.kind, norm.value, reason ? String(reason).trim() : null);
      td = db.prepare('SELECT * FROM takedowns WHERE kind = ? AND value = ? COLLATE NOCASE').get(norm.kind, norm.value);

      const blockedCreatorIds = new Set();
      const affectedCreators = new Set();

      if (norm.kind === 'creator' || norm.kind === 'handle') {
        const hasPlat = norm.value.includes(':');
        const plat = hasPlat ? norm.value.split(':', 2)[0] : null;
        const bare = hasPlat ? norm.value.split(':', 2)[1] : norm.value;

        const allCreators = db.prepare('SELECT id, handle, display_name, links, status FROM creators').all();
        for (const c of allCreators) {
          let match = false;
          if (norm.kind === 'creator' && (takedownLib.creatorMatches(c.id, norm.value) || takedownLib.creatorMatches(c.handle, norm.value))) {
            match = true;
          } else if (norm.kind === 'handle' && !plat && takedownLib.handleMatches(c.handle, null, bare)) {
            match = true;
          } else if (c.links) {
            let links = [];
            try { links = typeof c.links === 'string' ? JSON.parse(c.links) : c.links; } catch { links = []; }
            for (const l of Array.isArray(links) ? links : []) {
              if (!l) continue;
              const lPlat = String(l.service || l.platform || '').toLowerCase();
              if (l.handle && (norm.kind === 'creator' ? takedownLib.creatorMatches(l.handle, norm.value) : takedownLib.handleMatches(l.handle, lPlat || null, norm.value))) {
                match = true;
                break;
              }
              if (l.url && takedownLib.checkUrl(l.url, [td])) {
                match = true;
                break;
              }
            }
          }
          if (match) {
            blockedCreatorIds.add(c.id);
          }
        }
        // Check aliases and feeds for creator ownership
        if (!plat) {
          const aliasRows = db.prepare('SELECT creator_id FROM creator_aliases WHERE norm = ? OR alias = ? COLLATE NOCASE').all(bare.replace(/[^a-z0-9]/g, ''), bare);
          for (const r of aliasRows) blockedCreatorIds.add(r.creator_id);
        }

        const feedMatches = plat
          ? db.prepare('SELECT * FROM feeds WHERE platform = ? AND target = ? COLLATE NOCASE').all(plat, bare)
          : db.prepare('SELECT * FROM feeds WHERE target = ? COLLATE NOCASE').all(bare);
        for (const f of feedMatches) {
          if (f.creator_id) blockedCreatorIds.add(f.creator_id);
          if (f.enabled) {
            db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?').run(f.id);
            disabledFeeds++;
          }
          blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, why);
        }

        for (const cid of blockedCreatorIds) {
          const c = creatorQ.get.get(cid);
          if (!c) continue;
          const creatorFeeds = db.prepare('SELECT id, enabled, platform, target FROM feeds WHERE creator_id = ?').all(cid);
          for (const f of creatorFeeds) {
            if (f.enabled) {
              db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?').run(f.id);
              disabledFeeds++;
            }
            blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, why);
          }
          db.prepare("UPDATE creators SET status = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(cid);
          try {
            db.prepare('DELETE FROM media_faces WHERE media_id IN (SELECT id FROM media WHERE creator_id = ?)').run(cid);
            db.prepare('DELETE FROM creator_web_matches WHERE creator_id = ?').run(cid);
          } catch { /* ignore */ }
          blocklist.add('creator', cid, why);
          blockedCreators++;
          affectedCreators.add(cid);
        }

        db.prepare("UPDATE candidates SET status = 'rejected', reason = 'takedown' WHERE target = ? COLLATE NOCASE AND status = 'pending'").run(bare);
        db.prepare("UPDATE onlyfans_leads SET status = 'rejected', reason = 'takedown' WHERE handle = ? COLLATE NOCASE").run(bare);
      } else if (norm.kind === 'url' || norm.kind === 'domain') {
        const allFeeds = db.prepare('SELECT * FROM feeds WHERE enabled = 1').all();
        for (const f of allFeeds) {
          const matched = norm.kind === 'url'
            ? takedownLib.urlMatches(f.target, norm.value)
            : takedownLib.domainMatches(f.target, norm.value);
          if (matched) {
            db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?').run(f.id);
            disabledFeeds++;
          }
        }
      }

      // Retroactively purge matching media items
      const mediaRows = db.prepare(`SELECT id, creator_id, platform, author, title, description,
        source_url, media_url, preview_url, thumbnail_url, hash, source_key, phash
        FROM media WHERE publish_state != 'removed'`).all();
      for (const m of mediaRows) {
        const matchedByCreator = m.creator_id && blockedCreatorIds.has(m.creator_id);
        const matchedByRule = matchedByCreator || takedownLib.checkItem({
          creator_id: m.creator_id,
          platform: m.platform,
          author: m.author,
          title: m.title,
          text: m.description,
          description: m.description,
          source_url: m.source_url,
          permalink: m.source_url,
          media_url: m.media_url,
          mediaUrl: m.media_url,
          preview_url: m.preview_url,
          previewUrl: m.preview_url,
          thumbnail_url: m.thumbnail_url,
          thumbnailUrl: m.thumbnail_url,
        }, null, [td]);
        if (!matchedByRule) continue;

        db.prepare("UPDATE media SET publish_state = 'removed', review_reason = 'takedown', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(m.id);
        try {
          db.prepare('DELETE FROM media_faces WHERE media_id = ?').run(m.id);
          db.prepare('DELETE FROM creator_web_matches WHERE media_id = ?').run(m.id);
        } catch { /* ignore */ }
        if (m.hash) blocklist.add('hash', m.hash, why);
        if (m.source_key) blocklist.add('source_key', m.source_key, why);
        if (m.phash) {
          db.prepare('INSERT OR IGNORE INTO phash_blocklist (phash, reason) VALUES (?, ?)').run(m.phash, why);
          removedPhashes.push(m.phash);
        }
        if (m.creator_id) affectedCreators.add(m.creator_id);
        removedMediaIds.push(m.id);
        purgedMedia++;
      }

      // blocked creators' older removed rows: keep their hashes blocked, then clear the identifiers
      for (const cid of blockedCreatorIds) { rememberRemovedHashes(cid, why); purgeRemovedFor(cid); }
      purgeRemovedContent(removedMediaIds);
      for (const cid of affectedCreators) {
        creatorQ.stats.run({ id: cid });
      }
      logAction('takedown', String(td.id), 'add', why, actor);
    })();

    for (const mid of removedMediaIds) notifyState(mid, 'removed');
    for (const ph of removedPhashes) notifyBlocked(ph);

    return { takedown: td, purged: purgedMedia, purgedMedia, disabledFeeds, blockedCreators };
  },
  remove(id, actor = 'admin') {
    const row = takedowns.get(id);
    if (!row) return false;
    db.prepare('DELETE FROM takedowns WHERE id = ?').run(Number(id));
    logAction('takedown', String(id), 'remove', `${row.kind}:${row.value}`, actor);
    return true;
  },
};
  return { takedowns };
};

/** buildPurge: removed content keeps no identifiers (the purge every takedown and block uses). Built by repo.js with the helpers it uses; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildPurge = function buildPurge({ db, blocklist, hasTable }) {
/**
 * Remove the content identifiers of media that is 'removed': face vectors and visual embeddings, the perceptual
 * and exact hashes, every URL, the other places it was posted (alt sources) and its web matches. The rows, their publish state, review reason and all blocklists stay,
 * so an item stays removed and can never be re-imported. Only 'removed' rows are touched; a published
 * row given here is skipped by the SQL, not by the caller.
 */
function purgeRemovedContent(ids) {
  const all = [...new Set(ids.filter(Boolean))];
  let purged = 0;
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const gone = db.prepare(`SELECT id FROM media WHERE publish_state = 'removed' AND id IN (${ph})`).all(...chunk).map((r) => r.id);
    if (!gone.length) continue;
    const gph = gone.map(() => '?').join(',');
    if (hasTable('media_embeddings')) db.prepare(`DELETE FROM media_embeddings WHERE media_id IN (${gph})`).run(...gone);
    // The same class of residue: face vectors, the other places the picture was posted (source URLs) and web matches.
    for (const t of ['media_faces', 'media_alt_sources', 'creator_web_matches']) {
      if (hasTable(t)) db.prepare(`DELETE FROM ${t} WHERE media_id IN (${gph})`).run(...gone);
    }
    // hash and media_url are NOT NULL, and hash is UNIQUE: they get placeholders that no real hash or URL equals
    db.prepare(`UPDATE media SET phash = NULL, hash = 'purged:' || id, media_url = '', preview_url = NULL,
      thumbnail_url = NULL, thumb_url = NULL, hls_url = NULL, tint = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE publish_state = 'removed' AND id IN (${gph})`).run(...gone);
    purged += gone.length;
  }
  return purged;
}
/** Purge every removed item of one creator (a block or takedown may leave older removed rows behind). */
const purgeRemovedFor = (creatorId) => purgeRemovedContent(db.prepare("SELECT id FROM media WHERE creator_id = ? AND publish_state = 'removed'").all(creatorId).map((r) => r.id));
/** Keep a removed item's hashes blocked before its identifiers are cleared. Idempotent. */
function rememberRemovedHashes(creatorId, reason) {
  for (const m of db.prepare("SELECT hash, phash FROM media WHERE creator_id = ? AND publish_state = 'removed'").all(creatorId)) {
    if (m.hash && !String(m.hash).startsWith('purged:')) blocklist.add('hash', m.hash, reason);
    if (m.phash) db.prepare('INSERT OR IGNORE INTO phash_blocklist (phash, reason) VALUES (?, ?)').run(m.phash, reason || null);
  }
}
  return { purgeRemovedContent, purgeRemovedFor, rememberRemovedHashes };
};
