'use strict';
/**
 * Data access. All SQL lives here; routes and the engine never build queries.
 */
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { db } = require('./index');
const { normAlias } = require('../lib/alias');

const nowIso = () => new Date().toISOString();
const clampInt = (v, min, max, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};
const PUBLISH_STATES = ['published', 'review', 'hidden', 'removed'];
// Every item is tagged with its platform at ingest; that is already covered by the source filter, so keep it out of tag lists.
const PLATFORM_TAGS = ['reddit', 'redgifs', 'bluesky', 'mastodon', 'misskey', 'tumblr', 'peertube', 'lemmy', 'x', 'telegram', 'rss', 'web', 'linkinbio'];
const PLATFORM_TAGS_SQL = PLATFORM_TAGS.map((t) => `'${t}'`).join(',');

/* ------------------------------------------------------------------ settings */
const q = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                          ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
  allSettings: db.prepare('SELECT key, value FROM settings'),
};
const settings = {
  get(key) { const r = q.getSetting.get(key); return r ? r.value : null; },
  set(key, value) { q.setSetting.run({ key, value: String(value) }); },
  all() { const o = {}; for (const r of q.allSettings.all()) o[r.key] = r.value; return o; },
};

/* ---------------------------------------------------------------------- tags */
const tagQ = {
  insert: db.prepare('INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)'),
  byName: db.prepare('SELECT id FROM tags WHERE name = ?'),
  link: db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id, source) VALUES (?, ?, ?)'),
  bump: db.prepare('UPDATE tags SET usage_count = usage_count + 1 WHERE id = ?'),
  forMedia: db.prepare('SELECT t.name, t.category FROM tags t JOIN media_tags mt ON mt.tag_id = t.id WHERE mt.media_id = ? ORDER BY t.name'),
  setText: db.prepare('UPDATE media SET tags_text = ? WHERE id = ?'),
};

function cleanTag(raw) {
  return String(raw || '')
    .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/^#+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Attach tags and refresh the denormalised `tags_text` used by search. */
function addTags(mediaId, names, source = 'ingest') {
  const clean = [...new Set((names || []).map(cleanTag).filter((t) => t.length >= 2))].slice(0, 20);
  if (!clean.length) return [];
  for (const name of clean) {
    tagQ.insert.run(name, 'general');
    const tag = tagQ.byName.get(name);
    if (tag && tagQ.link.run(mediaId, tag.id, source).changes) tagQ.bump.run(tag.id);
  }
  const all = tagQ.forMedia.all(mediaId).map((t) => t.name);
  tagQ.setText.run(all.join(' '), mediaId);
  return all;
}

/* --------------------------------------------------------------- media hosts */
const hostQ = { add: db.prepare('INSERT OR IGNORE INTO media_hosts (host) VALUES (?)'), all: db.prepare('SELECT host FROM media_hosts') };
let hostCache = null;
const hosts = {
  _load() { if (!hostCache) hostCache = new Set(hostQ.all.all().map((r) => r.host)); return hostCache; },
  add(...urls) {
    const set = hosts._load();
    for (const u of urls) {
      let h; try { h = u && new URL(u).hostname.toLowerCase(); } catch { h = null; }
      if (h && !set.has(h)) { set.add(h); hostQ.add.run(h); }
    }
  },
  has(host) { return hosts._load().has(String(host).toLowerCase()); },
};

/* ------------------------------------------------------------------- blocklist */
const blockQ = {
  add: db.prepare('INSERT OR IGNORE INTO blocklist (type, value, reason) VALUES (?, ?, ?)'),
  has: db.prepare('SELECT 1 AS ok FROM blocklist WHERE type = ? AND value = ?'),
  list: db.prepare('SELECT * FROM blocklist ORDER BY id DESC LIMIT ? OFFSET ?'),
  count: db.prepare('SELECT COUNT(*) AS c FROM blocklist'),
  remove: db.prepare('DELETE FROM blocklist WHERE id = ?'),
};
const blocklist = {
  add(type, value, reason) { return blockQ.add.run(type, String(value).toLowerCase(), reason || null).changes > 0; },
  has(type, value) { return !!blockQ.has.get(type, String(value).toLowerCase()); },
  list(page = 0, limit = 100) { return { items: blockQ.list.all(limit, page * limit), total: blockQ.count.get().c, page, limit }; },
  remove(id) { return blockQ.remove.run(id).changes > 0; },
};

/* ------------------------------------------------------------ moderation log */
const logQ = db.prepare('INSERT INTO moderation_actions (target_type, target_id, action, reason, actor) VALUES (?, ?, ?, ?, ?)');
function logAction(targetType, targetId, action, reason, actor = 'system') {
  logQ.run(targetType, String(targetId), action, reason || null, actor);
}

/* ------------------------------------------------------------------- creators */
const SELECT_CREATOR_CARD = `
  SELECT c.*,
    (SELECT json_group_array(t) FROM (
        SELECT COALESCE(m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END) AS t
        FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published' AND m.scope != 'excluded'
        ORDER BY m.score DESC, m.seq DESC LIMIT 6) WHERE t IS NOT NULL LIMIT 3) AS previews,
    (SELECT group_concat(p) FROM (SELECT DISTINCT m.platform AS p FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published')) AS platforms
  FROM creators c`;

function serializeCreator(row) {
  if (!row) return null;
  const out = { ...row };
  try { out.links = JSON.parse(row.links || '[]'); } catch { out.links = []; }
  if (row.previews !== undefined) { try { out.previews = JSON.parse(row.previews || '[]'); } catch { out.previews = []; } }
  if (row.platforms !== undefined) out.platforms = row.platforms ? row.platforms.split(',') : [];
  out.verified = !!row.verified;
  return out;
}

const creatorQ = {
  get: db.prepare('SELECT * FROM creators WHERE id = ?'),
  insert: db.prepare(`INSERT INTO creators (id, handle, display_name, bio, avatar_url, banner_url, scope, origin)
                      VALUES (@id, @handle, @display_name, @bio, @avatar_url, @banner_url, @scope, @origin)`),
  byAccount: db.prepare(`SELECT c.* FROM feeds f JOIN creators c ON c.id = f.creator_id
                         WHERE f.platform = ? AND f.kind = 'user' AND f.target = ? COLLATE NOCASE LIMIT 1`),
  stats: db.prepare(`UPDATE creators SET
      media_count = (SELECT COUNT(*) FROM media WHERE creator_id = @id AND publish_state = 'published'),
      video_count = (SELECT COUNT(*) FROM media WHERE creator_id = @id AND publish_state = 'published' AND media_type = 'video'),
      total_score = (SELECT COALESCE(SUM(score), 0) FROM media WHERE creator_id = @id AND publish_state = 'published'),
      last_media_at = (SELECT MAX(posted_at) FROM media WHERE creator_id = @id AND publish_state = 'published'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id`),
  feedsOf: db.prepare('SELECT * FROM feeds WHERE creator_id = ? ORDER BY platform, target'),
  topTags: db.prepare(`SELECT t.name, COUNT(*) AS n FROM media m
      JOIN media_tags mt ON mt.media_id = m.id JOIN tags t ON t.id = mt.tag_id
      WHERE m.creator_id = ? AND m.publish_state = 'published' AND t.name NOT IN (${PLATFORM_TAGS_SQL}) GROUP BY t.id ORDER BY n DESC LIMIT 12`),
};

const creators = {
  get(id) { return serializeCreator(creatorQ.get.get(id)); },
  byAccount(platform, handle) { return serializeCreator(creatorQ.byAccount.get(platform, handle)); },

  create({ handle, displayName, bio, avatarUrl, bannerUrl, scope = 'in', origin = 'ingest' }) {
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
    return creators.get(id);
  },

  /** Fill blanks only — never overwrite what an admin curated. */
  enrich(id, { displayName, bio, avatarUrl, bannerUrl, links }) {
    const c = creatorQ.get.get(id);
    if (!c) return;
    const patch = {};
    if (displayName && (!c.display_name || c.display_name === c.handle)) patch.displayName = displayName;
    if (bio && !c.bio) patch.bio = bio;
    if (avatarUrl && !c.avatar_url) patch.avatarUrl = avatarUrl;
    if (bannerUrl && !c.banner_url) patch.bannerUrl = bannerUrl;
    if (links && links.length) {
      let existing = []; try { existing = JSON.parse(c.links || '[]'); } catch { /* ignore */ }
      const seen = new Set(existing.map((l) => l.url));
      // A page that says it is free now (or no longer) updates the stored link's flag.
      let changed = false;
      for (const l of links) {
        const old = l.handle && existing.find((e) => e.url === l.url);
        if (old && !!old.free !== !!l.free) { old.free = !!l.free; old.handle = l.handle; changed = true; }
      }
      const merged = existing.concat(links.filter((l) => l.url && !seen.has(l.url)));
      if (merged.length !== existing.length || changed) patch.links = merged.slice(0, 24);
    }
    if (Object.keys(patch).length) creators.update(id, patch);
  },

  refreshStats(id) { if (id) creatorQ.stats.run({ id }); },

  list({ page = 0, limit = 48, q: query, sort = 'media', platform, admin = false, minMedia, onlyfans: ofOnly = false } = {}) {
    const where = []; const params = [];
    if (ofOnly) where.push("c.links GLOB '*onlyfans.com/[A-Za-z0-9]*'");
    if (!admin) { where.push("c.status = 'active'", "c.scope != 'excluded'"); }
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
    const order = {
      media: 'c.media_count DESC, c.total_score DESC',
      score: 'c.total_score DESC',
      recent: 'c.last_media_at DESC',
      new: 'c.created_at DESC',
      name: 'c.handle COLLATE NOCASE ASC',
    }[sort] || 'c.media_count DESC';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM creators c ${whereSql}`).get(...params).n;
    const items = db.prepare(`${SELECT_CREATOR_CARD} ${whereSql} ORDER BY ${order}, c.id LIMIT ? OFFSET ?`)
      .all(...params, limit, page * limit).map(serializeCreator);
    return { items, total, page, limit };
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
      db.prepare(`INSERT OR IGNORE INTO creator_aliases (creator_id, norm, alias, kind, platform, source, created_at)
        SELECT ?, norm, alias, kind, platform, source, created_at FROM creator_aliases WHERE creator_id = ?`).run(keepId, mergeId);
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
      db.prepare('UPDATE feeds SET enabled = 0 WHERE creator_id = ?').run(id);
      blocklist.add('creator', id, reason);
      for (const f of creatorQ.feedsOf.all(id)) blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, reason);
      creatorQ.stats.run({ id });
      logAction('creator', id, 'block', reason, actor);
    })();
    return creators.get(id);
  },
};

/* ---------------------------------------------- creator discovery helpers */
// Tags that say nothing about a creator's style (platform names, generic words).
const GENERIC_TAGS = new Set([...PLATFORM_TAGS, 'gay', 'nsfw', 'video', 'photo', 'image']);

/*
 * Library snapshot: tag counts and each creator's tag profile over public media, built in one
 * aggregate pass and shared by autocomplete, related tags and similar creators (which otherwise
 * each re-aggregate the whole library per request — hundreds of ms on a large one).
 * Rebuilt after writes, at most once a minute, in the background (stale-while-revalidate); the
 * first build is synchronous. In tests it is rebuilt synchronously on any write so results are exact.
 */
const changesV = db.prepare('SELECT total_changes() AS v');
const snap = { data: null, at: 0, v: -1, pending: false };
const SNAP_MAX_AGE = process.env.NODE_ENV === 'test' ? 0 : 60000;
function buildLibrary() {
  const names = new Map(db.prepare('SELECT id, name FROM tags').all().map((t) => [t.id, t.name]));
  const tagCount = new Map(); const creatorTags = new Map(); const tagCreators = new Map();
  for (const r of db.prepare(`SELECT m.creator_id AS cid, mt.tag_id AS tid, COUNT(*) AS n FROM media m JOIN media_tags mt ON mt.media_id = m.id
      WHERE m.publish_state = 'published' AND m.scope != 'excluded' GROUP BY m.creator_id, mt.tag_id`).iterate()) {
    const name = names.get(r.tid);
    if (!name) continue;
    tagCount.set(name, (tagCount.get(name) || 0) + r.n);
    if (r.cid) {
      if (!creatorTags.has(r.cid)) creatorTags.set(r.cid, new Map());
      creatorTags.get(r.cid).set(name, r.n);
      tagCreators.set(name, (tagCreators.get(name) || 0) + 1);
    }
  }
  const tagList = [...tagCount.entries()].filter(([n]) => !PLATFORM_TAGS.includes(n)).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const total = db.prepare("SELECT COUNT(*) AS n FROM media WHERE publish_state = 'published' AND scope != 'excluded'").get().n;
  // Creators that may be shown (similarity indexes only these, so hidden ones never take a slot).
  const visibleCreators = new Set(db.prepare("SELECT id FROM creators WHERE status = 'active' AND scope != 'excluded'").all().map((r) => r.id));
  return { tagCount, creatorTags, tagCreators, tagList, total, visibleCreators };
}
function library() {
  const v = changesV.get().v;
  if (!snap.data || (SNAP_MAX_AGE === 0 && v !== snap.v)) { snap.data = buildLibrary(); snap.at = Date.now(); snap.v = changesV.get().v; return snap.data; }
  if (v !== snap.v && Date.now() - snap.at > SNAP_MAX_AGE && !snap.pending) {
    snap.pending = true;
    setImmediate(() => { try { snap.data = buildLibrary(); snap.at = Date.now(); snap.v = changesV.get().v; } finally { snap.pending = false; } });
  }
  return snap.data;
}

/**
 * Creators who post in a similar style: cosine similarity of tf-idf tag profiles (rare tags count
 * for more than common ones), served from an index built once per library snapshot.
 * "OnlyFans creators like him" draws from a wider pool, since only some creators have a page.
 */
creators.similar = function similar(id, limit = 12, { onlyfans: ofOnly = false } = {}) {
  const top = require('../lib/similarity').neighbours(library(), GENERIC_TAGS, id, limit * (ofOnly ? 10 : 2)).map(([cid]) => cid);
  if (!top.length) return [];
  const found = db.prepare(`${SELECT_CREATOR_CARD} WHERE c.id IN (${top.map(() => '?').join(',')}) AND c.status = 'active' AND c.scope != 'excluded' AND c.media_count > 0${ofOnly ? " AND c.links GLOB '*onlyfans.com/[A-Za-z0-9]*'" : ''}`)
    .all(...top).map(serializeCreator);
  found.sort((a, b) => top.indexOf(a.id) - top.indexOf(b.id));
  return found.slice(0, limit);
};

/**
 * Probable duplicate creators (the same person added twice, usually from different platforms).
 * Evidence, strongest first: the same link-in-bio / profile link, the same profile picture, handles
 * that collapse to the same string once punctuation and filler suffixes (_xo, _fit, official…) go,
 * handles one typo apart, and the same display name with a similar posting style. Each group lists
 * the creator to keep first (most posts); every other member carries `match`: why it was grouped.
 */
creators.duplicates = function duplicates() {
  const core = (h) => String(h || '').toLowerCase().replace(/@.*$/, '').replace(/\.(bsky\.social|social)$/, '').replace(/[^a-z0-9]/g, '').replace(/(official|xo|fit|real|the|xxx|tv|vip)+$/g, '').replace(/^(the|real|its|im)/, '');
  const nameKey = (n) => String(n || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  const linkKey = (u) => {
    try {
      const x = new URL(u);
      const path = x.pathname.replace(/\/+$/, '').toLowerCase();
      if (path.length < 3) return null; // a bare site says nothing about who
      return `${x.hostname.replace(/^www\./, '').toLowerCase()}${path}`;
    } catch { return null; }
  };
  const rows = db.prepare("SELECT id, handle, display_name, avatar_url, links, media_count, status FROM creators WHERE status != 'blocked'").all();
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const why = new Map(); // id -> Set(reason)
  const join = (a, b, reason) => {
    if (a === b) return;
    for (const id of [a, b]) { if (!why.has(id)) why.set(id, new Set()); why.get(id).add(reason); }
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const bucket = (keyFn, reason, minLen = 1) => {
    const first = new Map();
    for (const r of rows) {
      for (const k of [].concat(keyFn(r) || [])) {
        if (!k || k.length < minLen) continue;
        if (first.has(k)) join(first.get(k), r.id, typeof reason === 'function' ? reason(k) : reason); else first.set(k, r.id);
      }
    }
  };
  bucket((r) => { try { return JSON.parse(r.links || '[]').map((l) => linkKey(l && l.url)).filter(Boolean); } catch { return []; } }, (k) => `same link (${k})`, 6);
  // A picture alone is weak evidence (instances hand out shared default avatars): only a URL no more
  // than two creators use, that doesn't look like a placeholder, and only with a matching name or style.
  const avatarUses = new Map();
  for (const r of rows) if (r.avatar_url) avatarUses.set(r.avatar_url, (avatarUses.get(r.avatar_url) || 0) + 1);
  const firstPic = new Map(); const lib0 = library(); const sim0 = require('../lib/similarity');
  for (const r of rows) {
    const u = r.avatar_url;
    if (!u || u.length < 10 || avatarUses.get(u) > 2 || /(default|missing|placeholder|anonymous|no[-_]?avatar|blank)/i.test(u)) continue;
    const o = firstPic.get(u);
    if (!o) { firstPic.set(u, r); continue; }
    const sameName = nameKey(o.display_name).length >= 4 && nameKey(o.display_name) === nameKey(r.display_name);
    if (sameName || sim0.between(lib0, GENERIC_TAGS, o.id, r.id) >= 0.2) join(o.id, r.id, 'same profile picture');
  }
  bucket((r) => core(r.handle), 'same handle', 4);
  // One typo apart: every handle's single-character deletions meet in a shared key.
  const del = new Map();
  for (const r of rows) {
    const c = core(r.handle);
    if (c.length < 6) continue;
    const keys = new Set([c]);
    for (let i = 0; i < c.length; i++) keys.add(c.slice(0, i) + c.slice(i + 1));
    for (const k of keys) { if (!del.has(k)) del.set(k, []); del.get(k).push(r.id); }
  }
  const coreOf = new Map(rows.map((r) => [r.id, core(r.handle)]));
  const digits = (id) => coreOf.get(id).replace(/\D/g, '');
  for (const ids of del.values()) {
    if (ids.length < 2 || ids.length > 4) continue;
    // Numbered handles (jake1, jake2) are as often different people as backups: a typo must be in the letters.
    for (const other of ids.slice(1)) if (find(other) !== find(ids[0]) && digits(other) === digits(ids[0])) join(ids[0], other, 'nearly the same handle');
  }
  // Same display name: only with a similar style too, since first names repeat.
  const lib = library(); const similarity = require('../lib/similarity');
  const byName = new Map();
  for (const r of rows) { const k = nameKey(r.display_name); if (k.length >= 5) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r.id); } }
  for (const ids of byName.values()) {
    if (ids.length < 2 || ids.length > 6) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      if (similarity.between(lib, GENERIC_TAGS, ids[i], ids[j]) >= 0.3) join(ids[i], ids[j], 'same name, similar posts');
    }
  }
  const groups = new Map();
  for (const r of rows) {
    const root = find(r.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => b.media_count - a.media_count).map(({ links, ...c }, i) => (i === 0 ? c : { ...c, match: [...(why.get(c.id) || [])] })))
    .sort((a, b) => b.reduce((n, c) => n + c.media_count, 0) - a.reduce((n, c) => n + c.media_count, 0));
};

/**
 * Posting rhythm for a profile: posts per day for the last year (for a heatmap), which sources they
 * come from, and the hours of the day they usually post (UTC).
 */
creators.activity = function activity(id, days = 371) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const pub = "creator_id = ? AND publish_state = 'published' AND scope != 'excluded'";
  return {
    days: db.prepare(`SELECT substr(posted_at, 1, 10) AS day, COUNT(*) AS n FROM media WHERE ${pub} AND posted_at >= ? GROUP BY day ORDER BY day`).all(id, since),
    platforms: db.prepare(`SELECT platform, COUNT(*) AS n FROM media WHERE ${pub} GROUP BY platform ORDER BY n DESC`).all(id),
    hours: db.prepare(`SELECT CAST(substr(posted_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n FROM media WHERE ${pub} GROUP BY hour ORDER BY hour`).all(id),
    range: db.prepare(`SELECT MIN(posted_at) AS first, MAX(posted_at) AS last FROM media WHERE ${pub}`).get(id),
  };
};

/**
 * Creators gaining momentum: lots of well-received posts this week compared with their usual pace
 * over the previous three weeks. New arrivals (no history) count as rising too.
 */
/**
 * The creator constellation: the most active public creators as nodes, linked to the creators
 * whose posts they most resemble (tf-idf weighted tag vectors, cosine similarity, each node
 * keeping its strongest few links). Each node carries its dominant tag as a "group" for colour.
 */
creators.graph = function graph({ limit = 150, perNode = 4, minSim = 0.12 } = {}) {
  const nodes = db.prepare(`SELECT c.id, c.handle, c.display_name, c.avatar_url, c.media_count, c.last_media_at,
      (SELECT COALESCE(m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END) FROM media m
        WHERE m.creator_id = c.id AND m.publish_state = 'published' AND m.scope != 'excluded' ORDER BY m.score DESC LIMIT 1) AS preview
    FROM creators c WHERE c.status = 'active' AND c.scope != 'excluded' AND c.media_count >= 2
      AND (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published' AND m.scope != 'excluded') >= 2
    ORDER BY c.media_count DESC, c.total_score DESC LIMIT ?`).all(limit);
  if (nodes.length < 2) return { nodes, links: [] };
  const ids = nodes.map((n) => n.id);
  const rows = db.prepare(`SELECT m.creator_id AS cid, t.name AS tag, COUNT(*) AS n FROM media m
      JOIN media_tags mt ON mt.media_id = m.id JOIN tags t ON t.id = mt.tag_id
      WHERE m.creator_id IN (${ids.map(() => '?').join(',')}) AND m.publish_state = 'published' AND m.scope != 'excluded'
      GROUP BY m.creator_id, t.id`).all(...ids).filter((r) => !GENERIC_TAGS.has(r.tag));
  const df = new Map();
  for (const r of rows) df.set(r.tag, (df.get(r.tag) || 0) + 1);
  const vec = new Map(ids.map((id) => [id, new Map()]));
  for (const r of rows) vec.get(r.cid).set(r.tag, (1 + Math.log(r.n)) * Math.log(1 + nodes.length / df.get(r.tag)));
  const norm = new Map(ids.map((id) => [id, Math.sqrt([...vec.get(id).values()].reduce((a, w) => a + w * w, 0)) || 1]));
  // Community names are tagged too ("mastodon-social"); they say where, not what — prefer real style tags for the group.
  const communities = new Set(db.prepare(`SELECT DISTINCT community FROM media WHERE community IS NOT NULL AND creator_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => cleanTag(r.community)));
  for (const n of nodes) {
    let best = null; let bw = 0; let anyBest = null; let aw = 0;
    for (const [tag, w] of vec.get(n.id)) {
      if (w > aw) { aw = w; anyBest = tag; }
      if (!communities.has(tag) && w > bw) { bw = w; best = tag; }
    }
    n.group = best || anyBest;
  }
  // cosine similarity for every pair (n ≤ a few hundred, so O(n²) is fine), keep each node's strongest links
  const cand = new Map(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i++) {
    const a = vec.get(ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      const b = vec.get(ids[j]);
      const [small, big] = a.size < b.size ? [a, b] : [b, a];
      let dot = 0;
      for (const [tag, w] of small) { const o = big.get(tag); if (o) dot += w * o; }
      if (!dot) continue;
      const sim = dot / (norm.get(ids[i]) * norm.get(ids[j]));
      if (sim < minSim) continue;
      cand.get(ids[i]).push([ids[j], sim]); cand.get(ids[j]).push([ids[i], sim]);
    }
  }
  const seen = new Set(); const links = [];
  for (const [id, list] of cand) {
    list.sort((x, y) => y[1] - x[1]);
    for (const [other, sim] of list.slice(0, perNode)) {
      const key = id < other ? `${id}|${other}` : `${other}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: id, target: other, weight: Math.round(sim * 1000) / 1000 });
    }
  }
  return { nodes, links };
};

creators.rising = function rising(limit = 12) {
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d28 = new Date(now - 28 * 86400000).toISOString();
  const rows = db.prepare(`SELECT m.creator_id AS id,
      SUM(CASE WHEN m.posted_at >= @d7 THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN m.posted_at < @d7 THEN 1 ELSE 0 END) AS before,
      SUM(CASE WHEN m.posted_at >= @d7 THEN m.score + m.likes * 5 ELSE 0 END) AS heat
    FROM media m JOIN creators c ON c.id = m.creator_id
    WHERE m.posted_at >= @d28 AND m.publish_state = 'published' AND m.scope != 'excluded' AND c.status = 'active' AND c.scope != 'excluded'
    GROUP BY m.creator_id HAVING week >= 2`).all({ d7, d28 });
  const scored = rows.map((r) => ({ id: r.id, week: r.week, score: (r.week / (r.before / 3 + 1)) * Math.log2(r.heat + 4) }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
  if (!scored.length) return [];
  const byId = new Map(db.prepare(`${SELECT_CREATOR_CARD} WHERE c.id IN (${scored.map(() => '?').join(',')})`).all(...scored.map((r) => r.id)).map((c) => [c.id, serializeCreator(c)]));
  return scored.map((r) => byId.get(r.id) && { ...byId.get(r.id), week_count: r.week }).filter(Boolean);
};

function likeEscape(q) { return `${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; }

/** Autocomplete across creators, tags and communities. */
function suggest(query, limit = 6) {
  const q = String(query || '').trim().slice(0, 40);
  if (q.length < 1) return { creators: [], tags: [], communities: [] };
  const pre = likeEscape(q); const any = `%${pre}`;
  return {
    creators: db.prepare(`SELECT id, handle, display_name, avatar_url, media_count FROM creators
      WHERE status = 'active' AND scope != 'excluded' AND media_count > 0 AND (handle LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR handle LIKE ? ESCAPE '\\')
      ORDER BY (handle LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') DESC, media_count DESC LIMIT ?`).all(pre, pre, any, pre, pre, limit),
    tags: (() => { const p = q.toLowerCase().replace(/^#/, ''); const out = []; for (const t of library().tagList) { if (t.name.startsWith(p)) { out.push(t); if (out.length >= limit) break; } } return out; })(),
    communities: db.prepare(`SELECT community AS name, platform, COUNT(*) AS count FROM media
      WHERE publish_state = 'published' AND scope != 'excluded' AND community LIKE ? ESCAPE '\\' GROUP BY community, platform ORDER BY count DESC LIMIT ?`).all(pre, limit),
  };
}

/** Moderation audit trail (who did what, when). */
const audit = {
  list({ page = 0, limit = 50, targetType } = {}) {
    const where = targetType ? 'WHERE target_type = ?' : '';
    const params = targetType ? [targetType] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM moderation_actions ${where}`).get(...params).n;
    const items = db.prepare(`SELECT a.*, CASE a.target_type
        WHEN 'media' THEN (SELECT title FROM media WHERE id = a.target_id)
        WHEN 'creator' THEN (SELECT COALESCE(display_name, handle) FROM creators WHERE id = a.target_id)
        ELSE NULL END AS target_label
      FROM moderation_actions a ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params, limit, page * limit);
    return { items, total, page, limit };
  },
};

/* --------------------------------------------------------------------- feeds */
const feedQ = {
  get: db.prepare('SELECT * FROM feeds WHERE id = ?'),
  find: db.prepare('SELECT * FROM feeds WHERE platform = ? AND kind = ? AND target = ? COLLATE NOCASE'),
  insert: db.prepare(`INSERT INTO feeds (id, platform, kind, target, label, creator_id, enabled, trusted, origin, interval_min, priority, next_run_at)
                      VALUES (@id, @platform, @kind, @target, @label, @creator_id, @enabled, @trusted, @origin, @interval_min, @priority, @next_run_at)`),
  del: db.prepare('DELETE FROM feeds WHERE id = ?'),
};

const feeds = {
  get(id) { return feedQ.get.get(id) || null; },
  find(platform, kind, target) { return feedQ.find.get(platform, kind, target) || null; },

  /** Idempotent create. Returns {feed, created}. */
  upsert({ platform, kind, target, label, creatorId = null, enabled = 1, trusted = 1, origin = 'admin', intervalMin = 180, priority = 0, runNow = true }) {
    const existing = feedQ.find.get(platform, kind, target);
    if (existing) {
      if (creatorId && !existing.creator_id) db.prepare('UPDATE feeds SET creator_id = ? WHERE id = ?').run(creatorId, existing.id);
      return { feed: feedQ.get.get(existing.id), created: false };
    }
    const id = uuid();
    feedQ.insert.run({
      id, platform, kind, target, label: label || target, creator_id: creatorId, enabled: enabled ? 1 : 0,
      trusted: trusted ? 1 : 0, origin, interval_min: intervalMin, priority, next_run_at: runNow ? null : new Date(Date.now() + intervalMin * 60000).toISOString(),
    });
    return { feed: feedQ.get.get(id), created: true };
  },

  update(id, patch) {
    const cols = { label: 'label', enabled: 'enabled', trusted: 'trusted', interval_min: 'intervalMin', priority: 'priority', creator_id: 'creatorId' };
    const sets = []; const params = { id };
    for (const [col, key] of Object.entries(cols)) {
      let v = patch[key] !== undefined ? patch[key] : patch[col];
      if (v === undefined) continue;
      if (col === 'enabled' || col === 'trusted') v = v ? 1 : 0;
      if (col === 'interval_min') v = clampInt(v, 5, 60 * 24 * 14, 180);
      if (col === 'priority') v = clampInt(v, -10, 10, 0);
      sets.push(`${col} = @${col}`); params[col] = v;
    }
    if (patch.resetErrors) { sets.push('consecutive_failures = 0', 'last_error = NULL', 'next_run_at = NULL'); }
    if (patch.runNow) sets.push('next_run_at = NULL');
    if (patch.nextRunAt) { sets.push('next_run_at = @next_run_at'); params.next_run_at = patch.nextRunAt; }
    if (!sets.length) return feedQ.get.get(id);
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    db.prepare(`UPDATE feeds SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return feedQ.get.get(id);
  },

  remove(id) { return feedQ.del.run(id).changes > 0; },
  /** Enabled feeds whose time has come, skipping platforms whose breaker is open. */
  due(limit = 20, excludePlatforms = []) {
    const ex = excludePlatforms.length ? `AND platform NOT IN (${excludePlatforms.map(() => '?').join(',')})` : '';
    return db.prepare(`SELECT * FROM feeds WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ${ex}
                       ORDER BY priority DESC, COALESCE(next_run_at, '') ASC LIMIT ?`).all(nowIso(), ...excludePlatforms, limit);
  },

  finishRun(id, { status, error = null, cursor, nextRunAt, addedItems = 0, failures }) {
    db.prepare(`UPDATE feeds SET last_run_at = @now,
        last_success_at = CASE WHEN @ok = 1 THEN @now ELSE last_success_at END,
        last_status = @status, last_error = @error,
        consecutive_failures = @failures, next_run_at = @next,
        cursor = COALESCE(@cursor, cursor), items_total = items_total + @added,
        updated_at = @now WHERE id = @id`).run({
      id, now: nowIso(), ok: status === 'ok' || status === 'empty' ? 1 : 0, status, error: error ? String(error).slice(0, 400) : null,
      failures, next: nextRunAt, cursor: cursor ? JSON.stringify(cursor) : null, added: addedItems,
    });
  },

  list({ platform, kind, status, q: query, creatorId, enabled, page = 0, limit = 100 } = {}) {
    const where = []; const params = [];
    if (platform) { where.push('f.platform = ?'); params.push(platform); }
    if (kind) { where.push('f.kind = ?'); params.push(kind); }
    if (creatorId) { where.push('f.creator_id = ?'); params.push(creatorId); }
    if (enabled !== undefined && enabled !== '') { where.push('f.enabled = ?'); params.push(enabled === true || enabled === '1' || enabled === 1 || enabled === 'true' ? 1 : 0); }
    if (status === 'error') where.push("f.last_status = 'error'");
    else if (status === 'ok') where.push("f.last_status IN ('ok','empty')");
    else if (status === 'never') where.push('f.last_run_at IS NULL');
    if (query) { where.push('(f.target LIKE ? OR f.label LIKE ?)'); params.push(`%${query}%`, `%${query}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM feeds f ${whereSql}`).get(...params).n;
    const items = db.prepare(`SELECT f.*, c.handle AS creator_handle, c.display_name AS creator_name FROM feeds f
      LEFT JOIN creators c ON c.id = f.creator_id ${whereSql}
      ORDER BY f.enabled DESC, f.platform, f.kind, f.target COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, limit, page * limit);
    return { items, total, page, limit };
  },

  counts() {
    return db.prepare(`SELECT platform, COUNT(*) AS total, SUM(enabled) AS enabled,
      SUM(CASE WHEN last_status = 'error' THEN 1 ELSE 0 END) AS failing FROM feeds GROUP BY platform`).all();
  },
  countEnabled() { return db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE enabled = 1').get().n; },
};

/* ---------------------------------------------------------------------- runs */
const runs = {
  start(feedId, trigger) {
    const id = uuid();
    db.prepare('INSERT INTO feed_runs (id, feed_id, trigger, started_at) VALUES (?, ?, ?, ?)').run(id, feedId, trigger, nowIso());
    return id;
  },
  finish(id, { status, fetched = 0, added = 0, dupes = 0, skipped = 0, blocked = 0, review = 0, via = null, error = null, durationMs = 0 }) {
    db.prepare(`UPDATE feed_runs SET finished_at = ?, status = ?, fetched = ?, added = ?, dupes = ?, skipped = ?, blocked = ?, review = ?, via = ?, error = ?, duration_ms = ? WHERE id = ?`)
      .run(nowIso(), status, fetched, added, dupes, skipped, blocked, review, via, error ? String(error).slice(0, 400) : null, durationMs, id);
  },
  recent({ feedId, limit = 50 } = {}) {
    const where = feedId ? 'WHERE r.feed_id = ?' : '';
    const params = feedId ? [feedId, limit] : [limit];
    return db.prepare(`SELECT r.*, f.platform, f.kind, f.target, f.label FROM feed_runs r JOIN feeds f ON f.id = r.feed_id
      ${where} ORDER BY r.started_at DESC LIMIT ?`).all(...params);
  },
  /** Hourly buckets for the dashboard activity chart. */
  activity(hours = 48) {
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    return db.prepare(`SELECT substr(started_at, 1, 13) AS hour, SUM(added) AS added, COUNT(*) AS runs,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
      FROM feed_runs WHERE started_at >= ? GROUP BY hour ORDER BY hour`).all(since);
  },
  /**
   * Per-platform scorecard over the last N days: how many runs, how often they failed, what they actually
   * brought in, how much of it was filtered, and how many creators the platform contributes.
   */
  scoreboard(days = 7) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare(`SELECT f.platform AS platform, COUNT(*) AS runs,
        SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN r.status = 'empty' THEN 1 ELSE 0 END) AS empty,
        SUM(r.fetched) AS fetched, SUM(r.added) AS added, SUM(r.dupes) AS dupes, SUM(r.skipped) AS skipped, SUM(r.blocked) AS blocked,
        AVG(r.duration_ms) AS avg_ms, MAX(CASE WHEN r.status IN ('ok','empty') THEN r.finished_at END) AS last_ok
      FROM feed_runs r JOIN feeds f ON f.id = r.feed_id WHERE r.started_at >= ? AND r.status != 'running' GROUP BY f.platform`).all(since);
    const creators = Object.fromEntries(db.prepare(`SELECT platform, COUNT(DISTINCT creator_id) AS n FROM media WHERE ingested_at >= ? AND creator_id IS NOT NULL AND publish_state = 'published' GROUP BY platform`).all(since).map((r) => [r.platform, r.n]));
    return rows.map((r) => ({
      platform: r.platform, runs: r.runs, errorRate: r.runs ? Math.round((r.errors / r.runs) * 100) : 0, emptyRate: r.runs ? Math.round((r.empty / r.runs) * 100) : 0,
      fetched: r.fetched || 0, added: r.added || 0, dupes: r.dupes || 0, filtered: (r.skipped || 0) + (r.blocked || 0), avgMs: Math.round(r.avg_ms || 0),
      yieldPerRun: r.runs ? Math.round(((r.added || 0) / r.runs) * 10) / 10 : 0, creators: creators[r.platform] || 0, lastOk: r.last_ok || null,
    }));
  },
  /** Items added by a feed's last few finished runs, newest first (for adaptive scheduling). */
  recentAdded(feedId, n = 4) {
    return db.prepare("SELECT added FROM feed_runs WHERE feed_id = ? AND status IN ('ok','empty') ORDER BY started_at DESC LIMIT ?").all(feedId, n).map((r) => r.added || 0);
  },
  prune(keepDays = 30) {
    db.prepare('DELETE FROM feed_runs WHERE started_at < ?').run(new Date(Date.now() - keepDays * 86400000).toISOString());
  },
  abandonRunning() {
    db.prepare("UPDATE feed_runs SET status = 'error', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'").run(nowIso());
  },
};

/* --------------------------------------------------------------------- media */
function ftsQuery(text) {
  const tokens = String(text || '').normalize('NFKC').split(/[^\p{L}\p{N}_#@.]+/u)
    .map((t) => t.replace(/^[#@.]+|[.]+$/g, '').replace(/"/g, '')).filter((t) => t.length > 0).slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

const SORTS = {
  recent: 'm.posted_at DESC, m.seq DESC',
  oldest: 'm.posted_at ASC, m.seq ASC',
  top: 'm.score DESC, m.seq DESC',
  trending: 'm.hot DESC, m.seq DESC',
  ingested: 'm.ingested_at DESC, m.seq DESC',
};
const SINCE_DAYS = { day: 1, week: 7, month: 30, year: 365 };
// BM25 column weights for media_fts(title, author, community, tags_text, description).
const FTS_WEIGHTS = '5.0, 4.0, 2.0, 4.0, 1.0';

const MEDIA_SELECT = `SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar
  FROM media m LEFT JOIN creators c ON c.id = m.creator_id`;

function serializeMedia(row) {
  if (!row) return null;
  const out = { ...row, has_audio: !!row.has_audio };
  delete out.seq;
  return out;
}

const mediaQ = {
  get: db.prepare(`${MEDIA_SELECT} WHERE m.id = ?`),
  byHash: db.prepare('SELECT id FROM media WHERE hash = ?'),
  byKey: db.prepare('SELECT id FROM media WHERE source_key = ?'),
  byPost: db.prepare('SELECT 1 AS ok FROM media WHERE post_key = ? LIMIT 1'),
  insert: db.prepare(`INSERT INTO media (id, creator_id, feed_id, platform, source_id, source_key, post_key, position, source_url, community, author, title, description,
      media_type, media_url, preview_url, thumbnail_url, hls_url, has_audio, width, height, duration, mime_type, score, hash, nsfw_level, scope, publish_state, review_reason, posted_at, phash, physique)
    VALUES (@id, @creator_id, @feed_id, @platform, @source_id, @source_key, @post_key, @position, @source_url, @community, @author, @title, @description,
      @media_type, @media_url, @preview_url, @thumbnail_url, @hls_url, @has_audio, @width, @height, @duration, @mime_type, @score, @hash, @nsfw_level, @scope, @publish_state, @review_reason, @posted_at, @phash, @physique)`),
  state: db.prepare("UPDATE media SET publish_state = ?, review_reason = COALESCE(?, review_reason), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
  stateExact: db.prepare("UPDATE media SET publish_state = ?, review_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
  like: db.prepare('UPDATE media SET likes = likes + 1 WHERE id = ?'),
  unlike: db.prepare('UPDATE media SET likes = MAX(0, likes - 1) WHERE id = ?'),
  view: db.prepare('UPDATE media SET views = views + 1 WHERE id = ?'),
};

function buildMediaWhere(f) {
  const where = []; const params = [];
  const state = f.state === undefined ? 'published' : f.state;
  if (state === 'all') where.push("m.publish_state != 'removed'");
  else if (state === 'any') where.push('1=1');
  else if (PUBLISH_STATES.includes(state)) where.push(`m.publish_state = '${state}'`);
  else where.push("m.publish_state = 'published'");
  if (!f.admin) where.push("m.scope != 'excluded'", "(m.creator_id IS NULL OR m.creator_id NOT IN (SELECT id FROM creators WHERE status != 'active'))");
  if (f.type === 'image' || f.type === 'video') { where.push('m.media_type = ?'); params.push(f.type); }
  if (f.platform) { where.push('m.platform = ?'); params.push(f.platform); }
  if (f.community) { where.push('m.community = ? COLLATE NOCASE'); params.push(f.community); }
  if (f.creator) { where.push('m.creator_id = ?'); params.push(f.creator); }
  if (Array.isArray(f.creators)) {
    if (!f.creators.length) where.push('0=1');
    else { where.push(`m.creator_id IN (${f.creators.map(() => '?').join(',')})`); params.push(...f.creators); }
  }
  // what the viewer asked to see less of ("Not interested")
  if (Array.isArray(f.notCreators) && f.notCreators.length) {
    where.push(`(m.creator_id IS NULL OR m.creator_id NOT IN (${f.notCreators.map(() => '?').join(',')}))`); params.push(...f.notCreators);
  }
  if (Array.isArray(f.notTags) && f.notTags.length) {
    const list = f.notTags.slice(0, 30).map(cleanTag);
    where.push(`m.id NOT IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name IN (${list.map(() => '?').join(',')}))`); params.push(...list);
  }
  if (Array.isArray(f.ids)) {
    if (!f.ids.length) where.push('0=1');
    else { where.push(`m.id IN (${f.ids.map(() => '?').join(',')})`); params.push(...f.ids); }
  }
  if (f.scope) { where.push('m.scope = ?'); params.push(f.scope); }
  if (f.level === 'explicit' || f.level === 'suggestive') { where.push('m.nsfw_level = ?'); params.push(f.level); }
  if (f.minScore) { where.push('m.score >= ?'); params.push(f.minScore); }
  if (f.after) { where.push('m.ingested_at > ?'); params.push(f.after); }
  if (f.since && SINCE_DAYS[f.since]) { where.push('m.posted_at >= ?'); params.push(new Date(Date.now() - SINCE_DAYS[f.since] * 86400000).toISOString()); }
  if (f.tag) {
    where.push('m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?)');
    params.push(cleanTag(f.tag));
  }
  // every one of these tags (narrowing search: "beard beach")
  for (const t of (Array.isArray(f.tagsAll) ? f.tagsAll : []).slice(0, 6)) {
    where.push('m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?)');
    params.push(cleanTag(t));
  }
  // any of these tags (a topic)
  if (Array.isArray(f.tagsAny) && f.tagsAny.length) {
    const list = f.tagsAny.slice(0, 12).map(cleanTag);
    where.push(`m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name IN (${list.map(() => '?').join(',')}))`);
    params.push(...list);
  }
  return { where, params };
}

/*
 * Listing speed on large libraries. Without help SQLite filters on publish_state and then sorts
 * every published row; walking the matching sort index instead stops after one page. That wins
 * whenever the filters are broad, so it is forced for broad filters and left to the planner for
 * narrow ones (one creator, a community, explicit ids, rare tags) where an index lookup is cheaper.
 */
const SORT_INDEX = { recent: 'ix_media_pub_posted', oldest: 'ix_media_pub_posted', top: 'ix_media_pub_score', trending: 'ix_media_pub_hot', ingested: 'ix_media_ingested' };
const BROAD_TAG_MIN = 1500; // rows carrying a tag before scanning in sort order beats a lookup
const tagCountCache = new Map(); // tag -> { n, at }
function tagRows(name) {
  const hit = tagCountCache.get(name);
  if (hit && Date.now() - hit.at < 60000) return hit.n;
  const n = db.prepare('SELECT COUNT(*) AS n FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?').get(name).n;
  if (tagCountCache.size > 2000) tagCountCache.clear();
  tagCountCache.set(name, { n, at: Date.now() });
  return n;
}
function sortIndexFor(f, sort, where) {
  const idx = SORT_INDEX[sort || 'recent'];
  if (!idx || !where.includes("m.publish_state = 'published'")) return null; // partial indexes cover published rows only
  if (f.creator || (Array.isArray(f.ids) && f.ids.length) || f.community || f.minScore) return null;
  const all = [...(f.tag ? [f.tag] : []), ...(Array.isArray(f.tagsAll) ? f.tagsAll : [])].map(cleanTag);
  if (all.length && Math.min(...all.map(tagRows)) < BROAD_TAG_MIN) return null;
  if (Array.isArray(f.tagsAny) && f.tagsAny.length && f.tagsAny.map(cleanTag).reduce((a, t) => a + tagRows(t), 0) < BROAD_TAG_MIN) return null;
  return idx;
}
// Totals ("1,234 results") are recounted only after a write: the cache is keyed by SQLite's
// total_changes(), which moves on every insert/update/delete made through this connection.
const countCache = new Map(); // sql+params -> { n, at, v }
const changesQ = db.prepare('SELECT total_changes() AS v');
function cachedCount(sql, args) {
  const key = `${sql}|${JSON.stringify(args)}`;
  const v = changesQ.get().v;
  const hit = countCache.get(key);
  if (hit && hit.v === v && Date.now() - hit.at < 60000) return hit.n;
  const n = db.prepare(sql).get(...args).n;
  if (countCache.size > 500) countCache.clear();
  countCache.set(key, { n, at: Date.now(), v });
  return n;
}
/** Same write-invalidated caching for small aggregate row sets (platform counts, stats). */
cachedCount.rows = function cachedRows(sql, args = []) {
  const key = `rows|${sql}|${JSON.stringify(args)}`;
  const v = changesQ.get().v;
  const hit = countCache.get(key);
  if (hit && hit.v === v && Date.now() - hit.at < 60000) return hit.n;
  const n = db.prepare(sql).all(...args);
  if (countCache.size > 500) countCache.clear();
  countCache.set(key, { n, at: Date.now(), v });
  return n;
};
const relatedCache = new Map(); // tags|mode|limit -> { lib, value } (valid while the library snapshot is the same object)

/** Listeners told when a picture's publish state changes (the perceptual-duplicate index keeps itself current this way). */
const stateHooks = [];
const blockedHooks = [];
const notifyBlocked = (hex) => { for (const fn of blockedHooks) { try { fn(hex); } catch { /* ignore */ } } };
const notifyState = (id, state) => { for (const fn of stateHooks) { try { fn(id, state); } catch { /* an index must never break moderation */ } } };

const media = {
  /** Subscribe to publish-state changes: fn(id, state). */
  onState(fn) { stateHooks.push(fn); },
  onPhashBlocked(fn) { blockedHooks.push(fn); },
  setPhash(id, hex) { db.prepare('UPDATE media SET phash = ? WHERE id = ?').run(hex || null, id); },
  setPhysique(id, score) { db.prepare('UPDATE media SET physique = ? WHERE id = ?').run(Number.isFinite(score) ? Math.round(score) : null, id); },
  /** Pictures that already have a perceptual hash and are visible or awaiting review (feeds the in-memory index). */
  // body-filter hides are reversible (a threshold change shows them again), so they stay indexed: a copy is never stored twice
  hashedRows() { return db.prepare("SELECT id, phash, media_type, width, height FROM media WHERE phash IS NOT NULL AND (publish_state IN ('published','review') OR (publish_state = 'hidden' AND review_reason LIKE 'physique:%'))").all(); },
  hashInfo(id) { return db.prepare('SELECT phash, media_type, width, height, publish_state, review_reason FROM media WHERE id = ?').get(id); },
  /** Another place the SAME picture was posted. */
  addAltSource(mediaId, { platform, source_url, author = null, community = null, posted_at = null }) {
    if (!mediaId || !source_url) return false;
    return db.prepare('INSERT OR IGNORE INTO media_alt_sources (media_id, platform, source_url, author, community, posted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(mediaId, platform || 'web', String(source_url).slice(0, 600), author, community, posted_at).changes > 0;
  },
  altSources(id, limit = 8) { return db.prepare('SELECT platform, source_url, author, community, posted_at FROM media_alt_sources WHERE media_id = ? ORDER BY posted_at ASC, id ASC LIMIT ?').all(id, limit); },
  phashBlocked() { return db.prepare('SELECT phash FROM phash_blocklist').all().map((r) => r.phash); },
  blockPhash(hex, reason) { return !!hex && db.prepare('INSERT OR IGNORE INTO phash_blocklist (phash, reason) VALUES (?, ?)').run(hex, reason || null).changes > 0; },
  serialize: serializeMedia,
  get(id) { return serializeMedia(mediaQ.get.get(id)); },
  getFull(id) {
    const m = serializeMedia(mediaQ.get.get(id));
    if (!m) return null;
    m.tags = tagQ.forMedia.all(id).map((t) => t.name);
    return m;
  },
  hashExists(hash) { return !!mediaQ.byHash.get(hash); },
  keyExists(key) { return !!mediaQ.byKey.get(key); },
  postKnown(postKey) { return !!mediaQ.byPost.get(postKey); },

  /** @returns {string|null} new media id, or null on duplicate */
  insert(row, tags = []) {
    const id = uuid();
    const run = db.transaction(() => {
      try {
        mediaQ.insert.run({
          id, creator_id: null, feed_id: null, source_id: null, source_key: null, post_key: null, position: 0, source_url: null,
          community: null, author: null, title: null, description: null, preview_url: null, thumbnail_url: null, hls_url: null,
          has_audio: 0, width: null, height: null, duration: null, mime_type: null, score: 0, nsfw_level: 'explicit', scope: 'in',
          publish_state: 'published', review_reason: null, posted_at: nowIso(), phash: null, physique: null, ...row,
        });
      } catch (e) {
        // Duplicate hash / source_key: expected and harmless. Anything else is a real bug.
        if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
        throw e;
      }
      if (tags.length) addTags(id, tags, 'ingest');
      hosts.add(row.media_url, row.preview_url, row.thumbnail_url, row.hls_url);
      return id;
    });
    return run();
  },

  /** `exact`: write `reason` as given (null clears it) instead of keeping the previous reason when none is passed. */
  setState(id, state, reason, { exact = false } = {}) {
    if (!PUBLISH_STATES.includes(state)) throw new Error('bad state');
    const m = db.prepare('SELECT creator_id FROM media WHERE id = ?').get(id);
    (exact ? mediaQ.stateExact : mediaQ.state).run(state, reason || null, id);
    if (m && m.creator_id) creators.refreshStats(m.creator_id);
    notifyState(id, state);
  },

  update(id, patch) {
    const allowed = ['title', 'description', 'nsfw_level', 'scope'];
    const sets = []; const params = { id };
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      if (k === 'scope' && !['in', 'uncertain', 'excluded'].includes(patch[k])) continue;
      if (k === 'nsfw_level' && !['suggestive', 'explicit', 'extreme'].includes(patch[k])) continue;
      sets.push(`${k} = @${k}`); params[k] = patch[k];
    }
    if (patch.publish_state && PUBLISH_STATES.includes(patch.publish_state)) { sets.push('publish_state = @publish_state'); params.publish_state = patch.publish_state; }
    if (!sets.length) return media.get(id);
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    db.prepare(`UPDATE media SET ${sets.join(', ')} WHERE id = @id`).run(params);
    const m = db.prepare('SELECT creator_id FROM media WHERE id = ?').get(id);
    if (m && m.creator_id) creators.refreshStats(m.creator_id);
    if (params.publish_state) notifyState(id, params.publish_state);
    return media.get(id);
  },

  /** Remove and remember (so ingestion never brings it back). */
  block(id, reason, actor = 'admin') {
    const m = db.prepare('SELECT id, hash, source_key, post_key, creator_id, phash FROM media WHERE id = ?').get(id);
    if (!m) return null;
    db.transaction(() => {
      mediaQ.state.run('removed', reason || null, id);
      if (m.hash) blocklist.add('hash', m.hash, reason);
      if (m.source_key) blocklist.add('source_key', m.source_key, reason);
      // the same picture re-uploaded anywhere else stays blocked too
      if (m.phash) db.prepare('INSERT OR IGNORE INTO phash_blocklist (phash, reason) VALUES (?, ?)').run(m.phash, reason || null);
      logAction('media', id, 'block', reason, actor);
      if (m.creator_id) creators.refreshStats(m.creator_id);
    })();
    notifyState(id, 'removed');
    if (m.phash) notifyBlocked(m.phash);
    return true;
  },

  bumpLike(id, delta = 1) { return (delta >= 0 ? mediaQ.like : mediaQ.unlike).run(id).changes > 0; },
  bumpView(id) { return mediaQ.view.run(id).changes > 0; },

  list(f = {}) {
    const limit = clampInt(f.limit, 1, 200, 48);
    const page = clampInt(f.page, 0, 100000, 0);
    const { where, params } = buildMediaWhere(f);
    const match = ftsQuery(f.q);
    let join = false;
    let order;
    const joinParams = [];
    if (f.q && !match) where.push('0=1'); // query had no searchable tokens
    if (match) {
      if (!f.sort || f.sort === 'relevance') {
        join = true;
        joinParams.push(match);
        // Best match: BM25 with a hit in the title, creator or tags counting for more than one in a
        // long description, nudged by popularity so a well-liked exact match beats an obscure one.
        order = 'fts.rank * (1 + 0.12 * ln(1 + MAX(m.hot, 0))), m.posted_at DESC, m.seq DESC';
      } else {
        where.push('m.seq IN (SELECT rowid FROM media_fts WHERE media_fts MATCH ?)');
        params.push(match);
      }
    }
    if (!order) {
      if (f.sort === 'random') { order = 'hash_seed(m.id, ?) ASC, m.seq'; }
      else order = SORTS[f.sort] || SORTS.recent;
    }
    const orderParams = f.sort === 'random' && !match ? [clampInt(f.seed, 0, 2147483647, 1)] : [];
    const whereSql = where.join(' AND ');
    const forced = !join && f.sort !== 'random' ? sortIndexFor(f, SORTS[f.sort] ? f.sort : 'recent', where) : null;
    // With a text match, CROSS JOIN pins the loop order: run the MATCH once, then look rows up by key.
    const base = join
      ? `FROM (SELECT rowid AS rid, bm25(media_fts, ${FTS_WEIGHTS}) AS rank FROM media_fts WHERE media_fts MATCH ?) fts CROSS JOIN media m ON m.seq = fts.rid LEFT JOIN creators c ON c.id = m.creator_id WHERE ${whereSql}`
      : `FROM media m${forced ? ` INDEXED BY ${forced}` : ''} LEFT JOIN creators c ON c.id = m.creator_id WHERE ${whereSql}`;
    // Count with an IN-subquery, never the FTS join: with the join SQLite may drive the loop from
    // media and re-run the MATCH once per row (minutes on a large library instead of milliseconds).
    const total = f.noCount ? null : (join
      ? cachedCount(`SELECT COUNT(*) AS n FROM media m WHERE m.seq IN (SELECT rowid FROM media_fts WHERE media_fts MATCH ?) AND ${whereSql}`, [...joinParams, ...params])
      : cachedCount(`SELECT COUNT(*) AS n FROM media m WHERE ${whereSql}`, params));
    const rows = db.prepare(`SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar ${base}
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(...joinParams, ...params, ...orderParams, limit, page * limit);
    return { items: rows.map(serializeMedia), total, page, limit };
  },

  /**
   * "More like this": the rest of the same post, a few from the same creator, then posts sharing
   * the most *distinctive* tags (a shared rare tag counts for more than a shared common one), then
   * the best posts of creators with a similar style, then more from the creator and the community.
   */
  related(id, limit = 12) {
    const m = db.prepare('SELECT id, creator_id, post_key, community FROM media WHERE id = ?').get(id);
    if (!m) return [];
    const seen = new Set([id]);
    const out = [];
    const take = (rows, cap = limit) => { let n = 0; for (const r of rows) { if (!seen.has(r.id) && out.length < limit && n < cap) { seen.add(r.id); out.push(serializeMedia(r)); n++; } } };
    const pub = "m.publish_state = 'published' AND m.scope != 'excluded' AND (m.creator_id IS NULL OR m.creator_id NOT IN (SELECT id FROM creators WHERE status != 'active' OR scope = 'excluded'))";
    if (m.post_key) take(db.prepare(`${MEDIA_SELECT} WHERE m.post_key = ? AND m.id != ? AND ${pub} ORDER BY m.position LIMIT ?`).all(m.post_key, id, limit));
    const own = m.creator_id ? db.prepare(`${MEDIA_SELECT} WHERE m.creator_id = ? AND m.id != ? AND ${pub} ORDER BY m.score DESC LIMIT ?`).all(m.creator_id, id, limit) : [];
    take(own, Math.max(3, Math.ceil(limit / 3)));
    if (out.length < limit) {
      // Very common tags would join against most of the library and say little; skip them.
      const ranked = db.prepare(`SELECT mt2.media_id AS id, SUM(1.0 / ln(2 + t.usage_count)) AS w
          FROM media_tags mt1 JOIN tags t ON t.id = mt1.tag_id JOIN media_tags mt2 ON mt2.tag_id = mt1.tag_id
          WHERE mt1.media_id = ? AND mt2.media_id != ? AND t.usage_count <= 5000 AND t.name NOT IN (${PLATFORM_TAGS_SQL}, 'gay', 'nsfw', 'video', 'photo', 'image')
          GROUP BY mt2.media_id ORDER BY w DESC LIMIT 80`).all(id, id);
      if (ranked.length) {
        const byId = new Map(db.prepare(`${MEDIA_SELECT} WHERE m.id IN (${ranked.map(() => '?').join(',')}) AND ${pub}`).all(...ranked.map((r) => r.id)).map((r) => [r.id, r]));
        // Variety: no more than two from any one other creator.
        const per = new Map();
        take(ranked.map((r) => byId.get(r.id)).filter((r) => {
          if (!r) return false;
          const k = r.creator_id || r.id; const n = per.get(k) || 0;
          if (r.creator_id === m.creator_id || n >= 2) return false;
          per.set(k, n + 1); return true;
        }));
      }
    }
    if (out.length < limit && m.creator_id) {
      const near = require('../lib/similarity').neighbours(library(), GENERIC_TAGS, m.creator_id, 6).map(([cid]) => cid);
      if (near.length) {
        take(db.prepare(`SELECT * FROM (SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar,
            ROW_NUMBER() OVER (PARTITION BY m.creator_id ORDER BY m.score DESC) AS rn
          FROM media m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.creator_id IN (${near.map(() => '?').join(',')}) AND ${pub}) WHERE rn <= 2 ORDER BY rn, score DESC`).all(...near).map((r) => { delete r.rn; return r; }));
      }
    }
    if (out.length < limit) take(own);
    if (out.length < limit && m.community) take(db.prepare(`${MEDIA_SELECT} WHERE m.community = ? AND m.id != ? AND ${pub} ORDER BY m.score DESC LIMIT ?`).all(m.community, id, limit));
    return out;
  },

  /**
   * Refresh the "Trending" score. Only rows whose stored score drifted more than `tolerance` (2%) are rewritten: rewriting every
   * published row each time put the whole table through the WAL, and so through Litestream to the backup, every ten minutes.
   * A fresh post still moves on every pass; a month-old one is rewritten about once a day.
   */
  recomputeHot(tolerance = 0.02) {
    const now = Date.now();
    return db.prepare(`UPDATE media SET hot = hot_score(score, likes, views, epoch_ms(posted_at), @now)
      WHERE publish_state = 'published' AND abs(hot - hot_score(score, likes, views, epoch_ms(posted_at), @now)) > @tol * hot_score(score, likes, views, epoch_ms(posted_at), @now)`)
      .run({ now, tol: tolerance }).changes;
  },

  communities(limit = 60) {
    return db.prepare(`SELECT community AS name, platform, COUNT(*) AS count FROM media
      WHERE publish_state = 'published' AND scope != 'excluded' AND community IS NOT NULL AND community != ''
      GROUP BY community, platform ORDER BY count DESC LIMIT ?`).all(limit);
  },

  tags(limit = 60, minCount = 1) {
    return db.prepare(`SELECT t.name, COUNT(*) AS count FROM media_tags mt
      JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
      WHERE m.publish_state = 'published' AND m.scope != 'excluded' AND t.name NOT IN (${PLATFORM_TAGS_SQL})
      GROUP BY t.id HAVING count >= ? ORDER BY count DESC, t.name LIMIT ?`).all(minCount, limit);
  },

  platforms() {
    return cachedCount.rows(`SELECT platform, COUNT(*) AS count FROM media WHERE publish_state = 'published' AND scope != 'excluded'
      GROUP BY platform ORDER BY count DESC`);
  },

  /** Cheap listing used by the admin junk sweeper. */
  page(offset, limit) {
    return db.prepare(`SELECT id, title, media_url, preview_url, platform FROM media WHERE publish_state = 'published'
      ORDER BY seq LIMIT ? OFFSET ?`).all(limit, offset);
  },

  countByState() {
    const o = { published: 0, review: 0, hidden: 0, removed: 0 };
    for (const r of db.prepare('SELECT publish_state AS s, COUNT(*) AS n FROM media GROUP BY publish_state').all()) o[r.s] = r.n;
    return o;
  },
};

/* ----------------------------------------------------------- tag intelligence */
const tagIntel = {
  /**
   * Tags that travel with the given ones: co-occurrence on published media, ranked by
   * how much more often they appear together than their overall frequency predicts.
   * `all` (default) measures against media carrying every given tag — the set a "narrow
   * with" refinement actually narrows; `all: false` uses media carrying any of them (topics).
   */
  related(names, limit = 12, { all = true } = {}) {
    const list = [...new Set((names || []).map(cleanTag).filter(Boolean))].slice(0, 4);
    if (!list.length) return [];
    const lib = library();
    // Co-occurrence over a big base set costs a few hundred ms; it only changes when the snapshot does.
    const key = `${list.join(',')}|${all ? 1 : 0}|${limit}`;
    const hit = relatedCache.get(key);
    if (hit && hit.lib === lib) return hit.value;
    const value = tagIntel.relatedUncached(list, limit, all, lib);
    if (relatedCache.size > 400) relatedCache.clear();
    relatedCache.set(key, { lib, value });
    return value;
  },
  relatedUncached(list, limit, all, lib) {
    const total = lib.total || 1;
    const marks = list.map(() => '?').join(',');
    const baseSet = `SELECT mt2.media_id FROM media_tags mt2 JOIN tags t2 ON t2.id = mt2.tag_id JOIN media m ON m.id = mt2.media_id
      WHERE t2.name IN (${marks}) AND m.publish_state = 'published' AND m.scope != 'excluded'
      GROUP BY mt2.media_id${all ? ' HAVING COUNT(DISTINCT mt2.tag_id) = ?' : ''}`;
    const baseArgs = all ? [...list, list.length] : list;
    const base = db.prepare(`SELECT COUNT(*) AS n FROM (${baseSet})`).get(...baseArgs).n;
    if (!base) return [];
    const rows = db.prepare(`SELECT t.name, COUNT(DISTINCT mt.media_id) AS co
      FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
      WHERE mt.media_id IN (${baseSet})
        AND t.name NOT IN (${marks}) AND t.name NOT IN (${PLATFORM_TAGS_SQL})
      GROUP BY t.id HAVING co >= 2`).all(...baseArgs, ...list);
    const communities = new Set(db.prepare("SELECT DISTINCT community FROM media WHERE community IS NOT NULL").all().map((r) => cleanTag(r.community)));
    return rows.filter((r) => !communities.has(r.name)).map((r) => {
      const lift = (r.co / base) / ((lib.tagCount.get(r.name) || r.co) / total);
      return { name: r.name, count: r.co, lift: Math.round(lift * 100) / 100, score: Math.log(1 + r.co) * Math.log(1 + lift) };
    }).filter((r) => r.lift > 1).sort((a, b) => b.score - a.score).slice(0, limit);
  },

  /**
   * Topics: the library's frequent tags grouped by how often they co-occur (cosine of
   * co-occurrence counts, greedy grouping around the most common tags). Each topic gets a
   * readable name from its two leading tags, a size and a few preview images.
   */
  topics({ maxTopics = 10, pool = 60, minCount = 3 } = {}) {
    const top = db.prepare(`SELECT t.id, t.name, COUNT(*) AS n FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
      WHERE m.publish_state = 'published' AND m.scope != 'excluded' AND t.name NOT IN (${PLATFORM_TAGS_SQL}) AND t.name NOT IN ('gay','nsfw','video','photo','image')
      GROUP BY t.id HAVING n >= ? ORDER BY n DESC LIMIT ?`).all(minCount, pool);
    if (top.length < 3) return [];
    // community names are tagged too — they say where, not what
    const communities = new Set(db.prepare("SELECT DISTINCT community FROM media WHERE community IS NOT NULL").all().map((r) => cleanTag(r.community)));
    const tags = top.filter((t) => !communities.has(t.name));
    const ids = tags.map((t) => t.id);
    const co = new Map();
    for (const r of db.prepare(`SELECT a.tag_id AS a, b.tag_id AS b, COUNT(*) AS n FROM media_tags a JOIN media_tags b ON a.media_id = b.media_id AND a.tag_id < b.tag_id
        JOIN media m ON m.id = a.media_id WHERE m.publish_state = 'published' AND m.scope != 'excluded' AND a.tag_id IN (${ids.map(() => '?').join(',')}) AND b.tag_id IN (${ids.map(() => '?').join(',')})
        GROUP BY a.tag_id, b.tag_id`).all(...ids, ...ids)) co.set(`${r.a}|${r.b}`, r.n);
    const count = new Map(tags.map((t) => [t.id, t.n]));
    const assoc = (x, y) => { const n = co.get(x < y ? `${x}|${y}` : `${y}|${x}`) || 0; return n / Math.sqrt(count.get(x) * count.get(y)); };
    const used = new Set(); const topics = [];
    for (const seed of tags) {
      if (used.has(seed.id) || topics.length >= maxTopics) continue;
      const members = tags.filter((t) => t.id !== seed.id && !used.has(t.id)).map((t) => ({ t, a: assoc(seed.id, t.id) }))
        .filter((x) => x.a >= 0.22).sort((p, q) => q.a - p.a).slice(0, 5).map((x) => x.t);
      if (!members.length) continue;
      used.add(seed.id); members.forEach((m) => used.add(m.id));
      const names = [seed.name, ...members.map((m) => m.name)];
      const title = `${seed.name[0].toUpperCase()}${seed.name.slice(1).replace(/-/g, ' ')} & ${members[0].name.replace(/-/g, ' ')}`;
      const list = media.list({ tagsAny: names, sort: 'top', limit: 4, noCount: true }).items;
      const total = media.list({ tagsAny: names, limit: 1 }).total;
      topics.push({ id: names.slice(0, 3).join('+'), title, tags: names, count: total, previews: list.map((m) => m.preview_url || m.thumbnail_url || (m.media_type === 'image' ? m.media_url : null)).filter(Boolean) });
    }
    return topics.sort((a, b) => b.count - a.count);
  },

  /** Vocabulary for query understanding. */
  vocabulary() {
    return {
      tags: db.prepare(`SELECT t.name, COUNT(*) AS count FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
        WHERE m.publish_state = 'published' AND m.scope != 'excluded' AND t.name NOT IN (${PLATFORM_TAGS_SQL}) GROUP BY t.id ORDER BY count DESC LIMIT 3000`).all(),
      creators: db.prepare("SELECT id, handle, display_name, media_count FROM creators WHERE status = 'active' AND scope != 'excluded' AND media_count > 0 ORDER BY media_count DESC LIMIT 5000").all(),
      communities: db.prepare("SELECT community AS name, COUNT(*) AS count FROM media WHERE publish_state = 'published' AND scope != 'excluded' AND community IS NOT NULL AND community != '' GROUP BY community ORDER BY count DESC LIMIT 2000").all(),
    };
  },
};

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
    const items = db.prepare(`SELECT r.*, m.title AS media_title, COALESCE(m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END) AS media_thumb,
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

/* -------------------------------------------------------------- stats / home */
function publicStats() {
  const [s] = cachedCount.rows(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videos
    FROM media WHERE publish_state = 'published' AND scope != 'excluded'`);
  const c = cachedCount("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND media_count > 0", []);
  return { total: s.total || 0, images: s.images || 0, videos: s.videos || 0, creators: c };
}

function adminOverview() {
  const states = media.countByState();
  const pubByPlatform = media.platforms();
  return {
    media: { ...states, total: states.published + states.review + states.hidden },
    creators: {
      total: db.prepare('SELECT COUNT(*) AS n FROM creators').get().n,
      active: db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND media_count > 0").get().n,
      blocked: db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'blocked'").get().n,
    },
    feeds: {
      total: db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n,
      enabled: feeds.countEnabled(),
      failing: db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE enabled = 1 AND last_status = 'error'").get().n,
      byPlatform: feeds.counts(),
    },
    queues: { review: states.review, reports: reports.openCount() },
    pubByPlatform,
    activity: runs.activity(48),
    last24h: db.prepare(`SELECT COALESCE(SUM(added),0) AS added, COALESCE(SUM(dupes),0) AS dupes, COALESCE(SUM(skipped),0) AS skipped,
        COALESCE(SUM(blocked),0) AS blocked, COUNT(*) AS runs FROM feed_runs WHERE started_at >= ?`).get(new Date(Date.now() - 86400000).toISOString()),
    blocklist: blockQ.count.get().c,
    discovery: candidates.counts(),
    ingestDaily: db.prepare(`SELECT substr(ingested_at, 1, 10) AS day, platform, COUNT(*) AS n FROM media
      WHERE ingested_at >= ? GROUP BY day, platform ORDER BY day`).all(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)),
  };
}

function discover() {
  const pageOf = (f) => media.list({ ...f, noCount: true }).items;
  return {
    stats: publicStats(),
    trending: pageOf({ sort: 'trending', limit: 20 }),
    freshVideos: pageOf({ type: 'video', sort: 'recent', limit: 14 }),
    topCreators: creators.list({ sort: 'score', limit: 14, minMedia: 2 }).items,
    newCreators: creators.list({ sort: 'new', limit: 12, minMedia: 2 }).items,
    rising: creators.rising(12),
    tags: media.tags(36, 2),
    communities: media.communities(24),
    platforms: media.platforms(),
  };
}

/* ------------------------------------------------------------- discovery */
const parseSignals = (row) => { if (!row) return null; let sig = {}; try { sig = JSON.parse(row.signals || '{}'); } catch { sig = {}; } return { ...row, signals: sig }; };
const candidates = {
  get(id) { return parseSignals(db.prepare('SELECT * FROM candidates WHERE id = ?').get(id)); },
  find(platform, kind, target) { return parseSignals(db.prepare('SELECT * FROM candidates WHERE platform = ? AND kind = ? AND target = ? COLLATE NOCASE').get(platform, kind, String(target))); },
  insert(row) {
    const id = uuid();
    db.prepare(`INSERT INTO candidates (id, platform, kind, target, label, url, display_name, avatar_url, bio, score, signals, scope, status, reason, creator_id)
      VALUES (@id, @platform, @kind, @target, @label, @url, @display_name, @avatar_url, @bio, @score, @signals, @scope, @status, @reason, @creator_id)`).run({
      id, label: null, url: null, display_name: null, avatar_url: null, bio: null, score: 0, scope: 'uncertain', status: 'pending', reason: null, creator_id: null,
      ...row, signals: JSON.stringify(row.signals || {}),
    });
    hosts.add(row.avatar_url);
    return candidates.get(id);
  },
  update(id, patch) {
    const cols = ['label', 'url', 'display_name', 'avatar_url', 'bio', 'score', 'scope', 'status', 'reason', 'creator_id', 'decided_at'];
    const sets = []; const params = { id };
    for (const c of cols) if (patch[c] !== undefined) { sets.push(`${c} = @${c}`); params[c] = patch[c]; }
    if (patch.signals !== undefined) { sets.push('signals = @signals'); params.signals = JSON.stringify(patch.signals); }
    sets.push(`last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (patch.avatar_url) hosts.add(patch.avatar_url);
    return candidates.get(id);
  },
  list({ status = 'pending', page = 0, limit = 50, q: query, platform, sort = 'score' } = {}) {
    const where = []; const params = [];
    if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
    if (platform) { where.push('platform = ?'); params.push(platform); }
    if (query) { where.push("(target LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')"); const l = `%${String(query).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; params.push(l, l); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = sort === 'recent' ? 'last_seen DESC' : sort === 'new' ? 'first_seen DESC' : 'score DESC, last_seen DESC';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM candidates ${w}`).get(...params).n;
    const items = db.prepare(`SELECT * FROM candidates ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, page * limit).map(parseSignals);
    return { items, total, page, limit };
  },
  /** Highest-scoring undecided candidates (for auto-follow). */
  promotable(minScore, limit, offset = 0) {
    return db.prepare("SELECT * FROM candidates WHERE status = 'pending' AND score >= ? AND scope != 'excluded' AND (reason IS NULL OR reason NOT LIKE 'needs review%') ORDER BY score DESC, id LIMIT ? OFFSET ?").all(minScore, limit, offset).map(parseSignals);
  },
  /** Pending accounts (kind 'user' unless given) that still need details (bio/name) looked up. */
  needingDetails(platform, limit, kind = 'user') {
    return db.prepare("SELECT * FROM candidates WHERE status = 'pending' AND platform = ? AND kind = ? AND bio IS NULL AND (reason IS NULL OR reason != 'checked') ORDER BY score DESC LIMIT ?").all(platform, kind, limit).map(parseSignals);
  },
  counts() {
    const o = { pending: 0, followed: 0, linked: 0, rejected: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM candidates GROUP BY status').all()) o[r.status] = r.n;
    o.followedToday = db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status IN ('followed','linked') AND decided_at >= ?").get(new Date(Date.now() - 86400000).toISOString()).n;
    return o;
  },
  /** Drop old, low-value pending rows so the queue stays useful. */
  prune(days = 45, maxScore = 3) {
    return db.prepare("DELETE FROM candidates WHERE status = 'pending' AND score < ? AND last_seen < ?").run(maxScore, new Date(Date.now() - days * 86400000).toISOString()).changes;
  },
};

const discoveryState = {
  get(key, fallback = null) { const r = db.prepare('SELECT value FROM discovery_state WHERE key = ?').get(key); return r ? r.value : fallback; },
  set(key, value) {
    db.prepare(`INSERT INTO discovery_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value === null || value === undefined ? null : String(value));
  },
  /** ISO time a key was last written (null if never). */
  touchedAt(key) { const r = db.prepare('SELECT updated_at FROM discovery_state WHERE key = ?').get(key); return r ? r.updated_at : null; },
};

/* ------------------------------------------------------- OnlyFans leads (v7) */
const parseLead = (r) => {
  if (!r) return null;
  const out = { ...r, free: !!r.free };
  try { out.sources = JSON.parse(r.sources || '[]'); } catch { out.sources = []; }
  try { out.accounts = JSON.parse(r.accounts || '[]'); } catch { out.accounts = []; }
  return out;
};
const onlyfans = {
  get(handle) { return parseLead(db.prepare('SELECT * FROM onlyfans_leads WHERE handle = ?').get(String(handle))); },
  /**
   * Someone named this OnlyFans page. `sourceId` is the creator whose post/bio named it (null for web search).
   * Counts one mention per distinct source, so a promo channel reposting the same creator does not inflate it.
   */
  note(handle, { sourceId = null, origin = 'post', displayName = null, bio = null, free = false } = {}) {
    const h = String(handle).toLowerCase();
    const cur = onlyfans.get(h);
    if (!cur) {
      db.prepare(`INSERT INTO onlyfans_leads (handle, mentions, sources, origin, display_name, bio, free) VALUES (?, 1, ?, ?, ?, ?, ?)`)
        .run(h, JSON.stringify(sourceId ? [sourceId] : []), origin, displayName, bio, free ? 1 : 0);
      return onlyfans.get(h);
    }
    const sources = new Set(cur.sources);
    const fresh = sourceId ? !sources.has(sourceId) : origin !== cur.origin;
    if (sourceId) sources.add(sourceId);
    db.prepare(`UPDATE onlyfans_leads SET mentions = mentions + ?, sources = ?, display_name = COALESCE(display_name, ?), bio = COALESCE(bio, ?),
        free = MAX(free, ?), last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE handle = ?`)
      .run(fresh ? 1 : 0, JSON.stringify([...sources].slice(-25)), displayName, bio, free ? 1 : 0, h);
    return onlyfans.get(h);
  },
  /** A followed creator links to this page: it is theirs. */
  claim(handle, creatorId) {
    const h = String(handle).toLowerCase();
    db.prepare(`INSERT INTO onlyfans_leads (handle, creator_id, status, origin, checked_at) VALUES (?, ?, 'claimed', 'profile', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(handle) DO UPDATE SET creator_id = excluded.creator_id, status = 'claimed', last_seen = excluded.last_seen`).run(h, creatorId);
  },
  update(handle, patch) {
    const cols = ['status', 'reason', 'display_name', 'bio', 'creator_id', 'checked_at', 'attempts'];
    const sets = []; const params = { handle: String(handle).toLowerCase() };
    for (const c of cols) if (patch[c] !== undefined) { sets.push(`${c} = @${c}`); params[c] = patch[c]; }
    if (patch.accounts !== undefined) { sets.push('accounts = @accounts'); params.accounts = JSON.stringify(patch.accounts.slice(0, 12)); }
    if (patch.free !== undefined) { sets.push('free = @free'); params.free = patch.free ? 1 : 0; }
    if (!sets.length) return onlyfans.get(handle);
    db.prepare(`UPDATE onlyfans_leads SET ${sets.join(', ')} WHERE handle = @handle`).run(params);
    return onlyfans.get(handle);
  },
  /** Leads to look for next: never-checked first, then the most-mentioned whose last look is older than `staleDays`. */
  workable(limit = 10, staleDays = 14) {
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT * FROM onlyfans_leads WHERE (status = 'pending') OR (status = 'searching' AND attempts < 4 AND (checked_at IS NULL OR checked_at < ?))
      ORDER BY status = 'pending' DESC, mentions DESC, last_seen DESC LIMIT ?`).all(since, limit).map(parseLead);
  },
  list({ status, page = 0, limit = 50, q: query } = {}) {
    const where = []; const params = [];
    if (status && status !== 'all') { where.push('l.status = ?'); params.push(status); }
    if (query) { where.push("l.handle LIKE ? ESCAPE '\\'"); params.push(`%${String(query).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM onlyfans_leads l ${w}`).get(...params).n;
    const items = db.prepare(`SELECT l.*, c.handle AS creator_handle, c.display_name AS creator_name, c.media_count AS creator_media
      FROM onlyfans_leads l LEFT JOIN creators c ON c.id = l.creator_id ${w} ORDER BY l.mentions DESC, l.last_seen DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, page * limit).map(parseLead);
    return { items, total, page, limit };
  },
  /** The active creator whose stored links point at this OnlyFans page, if any. */
  ownerOf(handle) {
    const h = String(handle).toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
    return db.prepare(`SELECT id, handle FROM creators WHERE status = 'active' AND links LIKE ? ESCAPE '\\' LIMIT 1`).get(`%onlyfans.com/${h}"%`) || null;
  },
  /** Creators with an OnlyFans page but few known accounts elsewhere, least recently searched first. */
  reachTargets(limit = 4, staleDays = 30, maxAccounts = 4) {
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT c.id, c.handle, c.display_name, c.links,
        (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) AS accounts
      FROM creators c LEFT JOIN discovery_state ds ON ds.key = 'of.reach.' || c.id
      WHERE c.status = 'active' AND c.scope != 'excluded' AND c.links GLOB '*onlyfans.com/[A-Za-z0-9]*' AND (ds.updated_at IS NULL OR ds.updated_at < ?)
        AND (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) <= ?
      ORDER BY ds.updated_at IS NOT NULL, ds.updated_at ASC, c.media_count DESC LIMIT ?`).all(since, maxAccounts, limit);
  },
  counts() {
    const out = { pending: 0, searching: 0, found: 0, claimed: 0, rejected: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM onlyfans_leads GROUP BY status').all()) out[r.status] = r.n;
    out.creators = db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND links GLOB '*onlyfans.com/[A-Za-z0-9]*'").get().n;
    return out;
  },
};

/** Recently ingested text from active creators — raw material for mention mining. */
function mentionSource(afterIso, limit = 2000) {
  return db.prepare(`SELECT m.platform, m.title, m.description, m.creator_id, m.ingested_at FROM media m JOIN creators c ON c.id = m.creator_id
    WHERE m.ingested_at > ? AND m.publish_state = 'published' AND c.status = 'active' AND (m.title IS NOT NULL OR m.description IS NOT NULL)
    ORDER BY m.ingested_at ASC LIMIT ?`).all(afterIso || '', limit);
}

/** Creators worth investigating, least recently checked first (by a discovery_state key prefix). */
/**
 * Communities where several followed creators post but that are not followed themselves
 * ("where your creators hang out"). Pure SQL over what is already ingested.
 */
function communityHangouts({ minCreators = 2, limit = 60 } = {}) {
  return db.prepare(`SELECT m.platform, m.community, COUNT(DISTINCT m.creator_id) AS creators, group_concat(DISTINCT m.creator_id) AS ids
    FROM media m JOIN creators c ON c.id = m.creator_id
    WHERE m.community IS NOT NULL AND m.community != '' AND m.platform IN ('reddit', 'lemmy')
      AND m.publish_state = 'published' AND m.scope != 'excluded' AND c.status = 'active' AND c.scope != 'excluded'
      AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.platform = m.platform AND f.kind = 'community' AND f.target = m.community COLLATE NOCASE)
    GROUP BY m.platform, m.community COLLATE NOCASE HAVING creators >= ? ORDER BY creators DESC LIMIT ?`).all(minCreators, limit)
    .map((r) => ({ ...r, ids: String(r.ids || '').split(',').filter(Boolean) }));
}

function discoveryTargets({ platform, prefix, staleDays, limit, minMedia = 1, maxAccounts = 99 }) {
  const since = new Date(Date.now() - staleDays * 86400000).toISOString();
  const platformJoin = platform ? 'JOIN feeds f ON f.creator_id = c.id AND f.platform = @platform AND f.kind = \'user\' AND f.enabled = 1' : '';
  return db.prepare(`SELECT c.id, c.handle, c.display_name, c.media_count, ${platform ? 'f.target AS target' : 'NULL AS target'},
      (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) AS accounts,
      ds.updated_at AS checked
    FROM creators c ${platformJoin}
    LEFT JOIN discovery_state ds ON ds.key = @prefix || c.id
    WHERE c.status = 'active' AND c.scope != 'excluded' AND c.media_count >= @minMedia AND (ds.updated_at IS NULL OR ds.updated_at < @since)
    GROUP BY c.id HAVING accounts <= @maxAccounts
    ORDER BY ds.updated_at IS NOT NULL, ds.updated_at ASC, c.media_count DESC LIMIT @limit`).all({ platform: platform || null, prefix, since, limit, minMedia, maxAccounts });
}

module.exports = {
  db, nowIso, clampInt, cleanTag, ftsQuery, settings, hosts, blocklist, logAction, suggest, audit,
  creators, feeds, runs, media, reports, addTags, publicStats, adminOverview, discover,
  candidates, discoveryState, onlyfans, mentionSource, discoveryTargets, communityHangouts, PLATFORM_TAGS, GENERIC_TAGS, tagIntel, library,
  serializeMedia, serializeCreator, SELECT_CREATOR_CARD,
};
