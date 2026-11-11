'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildCreators: creator rows: cards, lists, stats, block and merge. Built by repo.js with the helpers it uses; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildCreators = function buildCreators({ uuid, db, normAlias, PLATFORM_TAGS_SQL, cleanTag, hosts, blocklist, purgeRemovedFor, rememberRemovedHashes, logAction, countCache }) {
const POPULAR_ACTIVE_DAYS = 90;
const SELECT_CREATOR_CARD = `
  SELECT c.*,
    (SELECT json_group_array(json(t)) FROM (
        SELECT json_object(
          'u', COALESCE(m.thumb_url, m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END),
          'f', CASE
            WHEN m.thumb_url IS NOT NULL
             AND COALESCE(m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END) IS NOT NULL
             AND COALESCE(m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END) != m.thumb_url
            THEN COALESCE(m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END)
          END
        ) AS t
        FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published' AND m.scope != 'excluded'
        ORDER BY m.score DESC, m.seq DESC LIMIT 6) WHERE json_extract(t, '$.u') IS NOT NULL LIMIT 3) AS previews,
    (SELECT group_concat(p) FROM (SELECT DISTINCT m.platform AS p FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published')) AS platforms
  FROM creators c`;

function serializeCreator(row) {
  if (!row) return null;
  const out = { ...row };
  try { out.links = JSON.parse(row.links || '[]'); } catch { out.links = []; }
  if (row.previews !== undefined) {
    try {
      const parsed = JSON.parse(row.previews || '[]');
      const slots = parsed.map((p) => {
        if (p && typeof p === 'object') return p;
        if (typeof p === 'string' && p.startsWith('{')) {
          try { const o = JSON.parse(p); if (o && typeof o === 'object' && 'u' in o) return o; } catch { /* a plain URL */ }
        }
        return p;
      });
      if (slots.some((p) => p && typeof p === 'object' && 'u' in p)) {
        out.previews = slots.map((p) => (p && typeof p === 'object' ? p.u : p));
        out.previewFalls = slots.map((p) => (p && typeof p === 'object' && p.f) || null);
      } else out.previews = parsed;
    } catch { out.previews = []; }
  }
  if (row.platforms !== undefined) out.platforms = row.platforms ? row.platforms.split(',') : [];
  out.verified = !!row.verified;
  return out;
}

/** The ONE definition of a creator's counters: what is visible (published) now. Every writer uses it; do not write a second one. */
const STATS_SET = `media_count = (SELECT COUNT(*) FROM media WHERE creator_id = @id AND publish_state = 'published'),
      video_count = (SELECT COUNT(*) FROM media WHERE creator_id = @id AND publish_state = 'published' AND media_type = 'video'),
      total_score = (SELECT COALESCE(SUM(score), 0) FROM media WHERE creator_id = @id AND publish_state = 'published'),
      last_media_at = (SELECT MAX(posted_at) FROM media WHERE creator_id = @id AND publish_state = 'published')`;

const creatorQ = {
  get: db.prepare('SELECT * FROM creators WHERE id = ?'),
  insert: db.prepare(`INSERT INTO creators (id, handle, display_name, bio, avatar_url, banner_url, scope, origin)
                      VALUES (@id, @handle, @display_name, @bio, @avatar_url, @banner_url, @scope, @origin)`),
  byAccount: db.prepare(`SELECT c.* FROM feeds f JOIN creators c ON c.id = f.creator_id
                         WHERE f.platform = ? AND f.kind IN ('user', 'channel') AND f.target = ? COLLATE NOCASE LIMIT 1`),
  stats: db.prepare(`UPDATE creators SET ${STATS_SET},
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id`),
  // One new published row. A full recount stays on hide, restore, and re-attribute, where the
  // published set changes by more than "add this row". Counting every post on each insert was
  // the stall on creators who already have thousands.
  bump: db.prepare(`UPDATE creators SET
      media_count = media_count + 1,
      video_count = video_count + @video,
      total_score = total_score + @score,
      last_media_at = CASE
        WHEN @posted IS NULL THEN last_media_at
        WHEN last_media_at IS NULL OR @posted > last_media_at THEN @posted
        ELSE last_media_at
      END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id`),
  // the same counts without touching updated_at (boot-time reconciliation of many creators)
  recount: db.prepare(`UPDATE creators SET ${STATS_SET} WHERE id = @id`),
  feedsOf: db.prepare('SELECT * FROM feeds WHERE creator_id = ? ORDER BY platform, target'),
  topTags: db.prepare(`SELECT t.name, COUNT(*) AS n FROM media m
      JOIN media_tags mt ON mt.media_id = m.id JOIN tags t ON t.id = mt.tag_id
      WHERE m.creator_id = ? AND m.publish_state = 'published' AND t.name NOT IN (${PLATFORM_TAGS_SQL}) GROUP BY t.id ORDER BY n DESC LIMIT 12`),
};

function paidClause(key, tablePrefix = '') {
  const p = String(key || '').toLowerCase().trim();
  const col = tablePrefix ? `${tablePrefix}.links` : 'links';
  if (p === 'onlyfans' || p === 'onlyfans.com') {
    return { sql: `(${col} GLOB '*onlyfans.com/[A-Za-z0-9]*' OR ${col} LIKE '%"service":"OnlyFans"%' OR ${col} LIKE '%onlyfans.com/%')`, params: [] };
  }
  if (p === 'fansly' || p === 'fansly.com') {
    return { sql: `(${col} GLOB '*fansly.com/[A-Za-z0-9]*' OR ${col} LIKE '%"service":"Fansly"%' OR ${col} LIKE '%fansly.com/%')`, params: [] };
  }
  if (p === 'justforfans' || p === 'justfor.fans' || p === 'jff') {
    return { sql: `(${col} LIKE '%justfor.fans/%' OR ${col} LIKE '%"service":"JustFor.Fans"%')`, params: [] };
  }
  if (p === 'gayforfans' || p === 'gayforfans.com' || p === 'gff') {
    return { sql: `(${col} LIKE '%gayforfans.com/%' OR ${col} LIKE '%"service":"GayForFans"%')`, params: [] };
  }
  return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${p.replace(/[\\%_]/g, (x) => '\\' + x)}%`] };
}

const creators = {
  get(id) { return serializeCreator(creatorQ.get.get(id)); },
  byAccount(platform, handle) {
    const h = String(handle || '');
    const hit = creatorQ.byAccount.get(platform, h);
    if (hit) return serializeCreator(hit);
    if (platform === 'coomer' && !h.includes('/')) {
      for (const svc of ['onlyfans', 'fansly']) {
        const alt = creatorQ.byAccount.get('coomer', `${svc}/${h}`);
        if (alt) return serializeCreator(alt);
      }
    }
    return null;
  },

  create({ handle, displayName, bio, avatarUrl, bannerUrl, scope = 'in', origin = 'ingest' }) {
    // A handle never has a space: a "Dante Colle" / "dantecolle.bsky.social" pair is stored the right way round.
    ({ handle, displayName } = require('../../lib/creator-names').orderNames(handle, displayName));
    const id = uuid();
    hosts.add(avatarUrl, bannerUrl);
    creatorQ.insert.run({
      id, handle: String(handle).slice(0, 80), display_name: displayName || handle,
      bio: bio || null, avatar_url: avatarUrl || null, banner_url: bannerUrl || null, scope, origin,
    });
    return creators.get(id);
  },

  update(id, patch) {
    const allowed = { display_name: 'displayName', bio: 'bio', avatar_url: 'avatarUrl', banner_url: 'bannerUrl', handle: 'handle', scope: 'scope', status: 'status', verified: 'verified' };
    const sets = []; const params = { id };
    for (const [col, key] of Object.entries(allowed)) {
      const v = patch[key] !== undefined ? patch[key] : patch[col];
      if (v === undefined) continue;
      if (col === 'scope' && !['in', 'uncertain', 'excluded'].includes(v)) continue;
      if (col === 'status' && !['active', 'hidden', 'blocked'].includes(v)) continue;
      sets.push(`${col} = @${col}`); params[col] = col === 'verified' ? (v ? 1 : 0) : v;
    }
    if (patch.links !== undefined) { sets.push('links = @links'); params.links = JSON.stringify(patch.links || []); }
    if (!sets.length) return creators.get(id);
    hosts.add(patch.avatarUrl || patch.avatar_url, patch.bannerUrl || patch.banner_url);
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    db.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE id = @id`).run(params);
    // A status/scope change changes which media the public lists count (hidden creator hides their posts).
    if (params.status !== undefined || params.scope !== undefined) countCache.clear();
    return creators.get(id);
  },

  /**
   * Fill blanks only — never overwrite what an admin curated. One exception: a picture (avatar / banner) a platform now serves from
   * the SAME site as the stored one replaces it (a changed or dead avatar link would otherwise stay for ever); a link from another
   * site never does, so a creator's accounts on different platforms cannot take the avatar back and forth.
   */
  enrich(id, { displayName, bio, avatarUrl, bannerUrl, links }) {
    const c = creatorQ.get.get(id);
    if (!c) return;
    const patch = {};
    const validName = displayName && !/^(?:untitled|sin t[íi]tulo|unbenannt|sans titre)$/i.test(String(displayName).trim());
    if (validName && (!c.display_name || c.display_name === c.handle)) patch.displayName = displayName;
    if (bio && !c.bio) patch.bio = bio;
    const { siteOf } = require('../../lib/site'); // the registrable domain, not the last two labels (`co.uk`, `github.io` are not sites)
    const better = (now, stored) => !!now && (!stored || (now !== stored && siteOf(now) && siteOf(now) === siteOf(stored)));
    if (better(avatarUrl, c.avatar_url)) patch.avatarUrl = avatarUrl;
    if (better(bannerUrl, c.banner_url)) patch.bannerUrl = bannerUrl;
    if (links && links.length) {
      let existing = []; try { existing = JSON.parse(c.links || '[]'); } catch { /* ignore */ }
      const normUrl = (u) => String(u || '').toLowerCase().replace(/\/+$/, '');
      const seen = new Set(existing.map((l) => normUrl(l.url)));
      // A page that says it is free now (or no longer) updates the stored link's flag. Paid pages
      // match by (service, handle) so 'Fansly.com/Jake' never duplicates 'fansly.com/jake'.
      let changed = false;
      for (const l of links) {
        let old = l.handle
          ? existing.find((e) => e.handle && String(e.handle).toLowerCase() === String(l.handle).toLowerCase() && (e.service || '') === (l.service || ''))
          : null;
        if (!old && l.url) old = existing.find((e) => normUrl(e.url) === normUrl(l.url));
        if (old) {
          if (!!old.free !== !!l.free) { old.free = !!l.free; changed = true; }
          if (l.handle && !old.handle) { old.handle = l.handle; changed = true; }
          continue;
        }
        if (l.url && !seen.has(normUrl(l.url))) { seen.add(normUrl(l.url)); existing.push(l); changed = true; }
      }
      if (changed) patch.links = existing.slice(0, 24);
    }
    if (Object.keys(patch).length) creators.update(id, patch);
  },

  refreshStats(id) { if (id) creatorQ.stats.run({ id }); },
  /** Recompute the counters of one creator without marking it updated. */
  recount(id) { if (id) creatorQ.recount.run({ id }); },

  list({ page = 0, limit = 48, q: query, sort = 'media', platform, admin = false, minMedia, onlyfans: ofOnly = false, paidHost, freshDays, ids } = {}) {
    const where = []; const params = [];
    if (ofOnly) where.push("c.links GLOB '*onlyfans.com/[A-Za-z0-9]*'");
    if (Array.isArray(ids) && ids.length) { where.push('c.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(ids.slice(0, 200))); }
    // "posted in the last N days": who is actually publishing right now.
    const fresh = freshDays ? Math.min(Math.max(parseInt(freshDays, 10) || 0, 0), 3650) : 0;
    if (fresh) { where.push('c.last_media_at >= ?'); params.push(new Date(Date.now() - fresh * 86400000).toISOString()); }
    if (paidHost) { const pc = paidClause(paidHost, 'c'); where.push(pc.sql); params.push(...pc.params); }
    if (!admin) { where.push("c.status = 'active'", "c.scope != 'excluded'"); }
    // "Popular" never shows a creator who has not posted in 90 days: a dead page is not a first-screen result.
    if (sort === 'popular' && !fresh) { where.push('c.last_media_at >= ?'); params.push(new Date(Date.now() - POPULAR_ACTIVE_DAYS * 86400000).toISOString()); }
    const min = minMedia !== undefined ? minMedia : (admin ? 0 : 1);
    if (min > 0) { where.push('c.media_count >= ?'); params.push(min); }
    if (query) {
      // also any name or handle he goes by elsewhere (creator_aliases, engine/identity)
      const norm = normAlias(query);
      where.push(`(c.handle LIKE ? ESCAPE '\\' OR c.display_name LIKE ? ESCAPE '\\'${norm.length >= 3 ? ' OR EXISTS (SELECT 1 FROM creator_aliases a WHERE a.creator_id = c.id AND a.norm LIKE ?)' : ''})`);
      const like = `%${String(query).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like);
      if (norm.length >= 3) params.push(`${norm}%`);
    }
    if (platform) {
      where.push('EXISTS (SELECT 1 FROM media m WHERE m.creator_id = c.id AND m.platform = ? AND m.publish_state = \'published\')');
      params.push(platform);
    }
    const mediaOrder = "((c.links GLOB '*onlyfans.com/[A-Za-z0-9]*' OR c.links LIKE '%onlyfans.com/%' OR c.links LIKE '%OnlyFans%') AND c.media_count >= 5) DESC, (c.origin = 'admin') DESC, c.media_count DESC, c.total_score DESC";
    const order = {
      media: mediaOrder,
      // Popular = the stored rank (engine/popularity.js), then the freshest and the biggest archive.
      // popularity is NOT NULL. COALESCE here forced a sort of every active creator.
      popular: 'c.popularity DESC, c.last_media_at DESC, c.media_count DESC, c.total_score DESC',
      recent: 'c.last_media_at DESC',
      new: 'c.created_at DESC',
      name: 'c.handle COLLATE NOCASE ASC',
    }[sort] || 'c.media_count DESC';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // The default Popular screen matches ix_creators_popular_active exactly. Without INDEXED BY, a status
    // filter makes the planner walk every active creator and sort. Narrower filters (a search, one platform)
    // stay with the planner.
    const broadPopular = sort === 'popular' && !admin && !query && !platform && !ofOnly && !paidHost && !(Array.isArray(ids) && ids.length);
    const cardSql = broadPopular
      ? SELECT_CREATOR_CARD.replace('FROM creators c', 'FROM creators c INDEXED BY ix_creators_popular_active')
      : SELECT_CREATOR_CARD;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM creators c ${whereSql}`).get(...params).n;
    const items = db.prepare(`${cardSql} ${whereSql} ORDER BY ${order}, c.id LIMIT ? OFFSET ?`)
      .all(...params, limit, page * limit).map(serializeCreator);
    return { items, total, page, limit };
  },

  /** Creators who post ALL of these tags, most posts first. Used by tag-only search before the full library snapshot. */
  byTags(tags, limit = 8) {
    const list = [...new Set((Array.isArray(tags) ? tags : []).map(cleanTag).filter(Boolean))].slice(0, 6);
    if (!list.length) return [];
    const marks = list.map(() => '?').join(',');
    return db.prepare(`SELECT c.id FROM creators c
      JOIN media m ON m.creator_id = c.id AND m.publish_state = 'published' AND m.scope != 'excluded'
      JOIN media_tags mt ON mt.media_id = m.id
      JOIN tags t ON t.id = mt.tag_id
      WHERE t.name IN (${marks}) AND c.status = 'active' AND c.scope != 'excluded'
      GROUP BY c.id HAVING COUNT(DISTINCT t.name) = ?
      ORDER BY COUNT(*) DESC, c.media_count DESC LIMIT ?`)
      .all(...list, list.length, limit).map((r) => r.id);
  },

  detail(id) {
    const c = db.prepare(`${SELECT_CREATOR_CARD} WHERE c.id = ?`).get(id);
    if (!c) return null;
    const out = serializeCreator(c);
    out.accounts = creatorQ.feedsOf.all(id).map((f) => ({
      id: f.id, platform: f.platform, kind: f.kind, target: f.target, label: f.label,
      enabled: !!f.enabled, last_success_at: f.last_success_at, last_status: f.last_status,
    }));
    out.topTags = creatorQ.topTags.all(id);
    out.aliases = db.prepare("SELECT alias, kind, platform FROM creator_aliases WHERE creator_id = ? AND source != 'bio' ORDER BY kind DESC, created_at LIMIT 24").all(id)
      .filter((a) => a.alias.toLowerCase() !== String(c.handle).toLowerCase());
    return out;
  },

  merge(keepId, mergeId) {
    if (keepId === mergeId) return null;
    const keep = creatorQ.get.get(keepId); const gone = creatorQ.get.get(mergeId);
    if (!keep || !gone) return null;
    db.transaction(() => {
      db.prepare('UPDATE media SET creator_id = ? WHERE creator_id = ?').run(keepId, mergeId);
      db.prepare('UPDATE feeds SET creator_id = ? WHERE creator_id = ?').run(keepId, mergeId);
      db.prepare('UPDATE onlyfans_leads SET creator_id = ? WHERE creator_id = ?').run(keepId, mergeId);
      db.prepare(`INSERT INTO creator_aliases (creator_id, norm, alias, kind, platform, source, signal, evidence_url, created_at)
        SELECT ?, norm, alias, kind, platform, source, signal, evidence_url, created_at FROM creator_aliases WHERE creator_id = ? AND true
        ON CONFLICT (creator_id, norm) DO UPDATE SET alias = excluded.alias, kind = excluded.kind, platform = COALESCE(excluded.platform, platform), source = excluded.source,
          signal = COALESCE(excluded.signal, signal), evidence_url = COALESCE(excluded.evidence_url, evidence_url)
        WHERE creator_aliases.source = 'bio' AND excluded.source != 'bio'`).run(keepId, mergeId); // a confirmed name beats one only a bio claimed
      creators.enrich(keepId, { displayName: gone.display_name, bio: gone.bio, avatarUrl: gone.avatar_url, bannerUrl: gone.banner_url, links: JSON.parse(gone.links || '[]') });
      db.prepare('DELETE FROM creators WHERE id = ?').run(mergeId);
      creatorQ.stats.run({ id: keepId });
    })();
    return creators.get(keepId);
  },

  /** Block a creator: hide everything they have, record it so it never returns. */
  block(id, reason, actor = 'admin') {
    const c = creatorQ.get.get(id);
    if (!c) return null;
    db.transaction(() => {
      db.prepare("UPDATE creators SET status = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
      db.prepare("UPDATE media SET publish_state = 'removed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE creator_id = ? AND publish_state != 'removed'").run(id);
      rememberRemovedHashes(id, reason);
      purgeRemovedFor(id);
      db.prepare('UPDATE feeds SET enabled = 0 WHERE creator_id = ?').run(id);
      blocklist.add('creator', id, reason);
      for (const f of creatorQ.feedsOf.all(id)) blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, reason);
      creatorQ.stats.run({ id });
      logAction('creator', id, 'block', reason, actor);
    })();
    return creators.get(id);
  },
};
  return { SELECT_CREATOR_CARD, serializeCreator, creatorQ, paidClause, creators };
};
