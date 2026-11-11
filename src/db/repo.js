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
    // tags.usage_count is kept by the media_tags triggers (schema v23), so the link itself is enough
    if (tag) tagQ.link.run(mediaId, tag.id, source);
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

/* ------------------------------------------------- removed content: identifiers */
const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const { purgeRemovedContent, purgeRemovedFor, rememberRemovedHashes } = require('./repos/takedowns').buildPurge({ db, blocklist, hasTable });

/* ------------------------------------------------------------ moderation log */
const logQ = db.prepare('INSERT INTO moderation_actions (target_type, target_id, action, reason, actor) VALUES (?, ?, ?, ?, ?)');
function logAction(targetType, targetId, action, reason, actor = 'system') {
  logQ.run(targetType, String(targetId), action, reason || null, actor);
}

// Shared by the creators and media groups: cached list totals (sql+params -> { n, at, v }); a visibility change clears it.
const countCache = new Map(); // sql+params -> { n, at, v }

/* ------------------------------------------------------------------- creators */
const { SELECT_CREATOR_CARD, serializeCreator, creatorQ, paidClause, creators } = require('./repos/creators').buildCreators({ uuid, db, normAlias, PLATFORM_TAGS_SQL, cleanTag, hosts, blocklist, purgeRemovedFor, rememberRemovedHashes, logAction, countCache });

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
/**
 * "Has the data behind a cached total changed?" Keyed on SQLite's total_changes(), which moves on every row this connection
 * writes. Viewers' likes and views and the trending-score refresh move it all the time without changing any count, tag
 * profile or visibility, so they are subtracted (`quiet`): without that, every view of a post threw away every cached total.
 */
let quiet = 0;
const quietly = (changes) => { quiet += changes; return changes; };
const writeVersion = () => changesV.get().v - quiet;
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
/** The similarity index for a library, built alongside it (src/lib/similarity.js), so no request builds it. */
function libraryWithIndex() {
  const lib = buildLibrary();
  return { lib, index: require('../lib/similarity').indexFor(lib, GENERIC_TAGS) };
}
// Before the first worker build the library does not exist yet. A read that needs it gets 503 "warming" (with
// Retry-After, see src/app.js), not an empty 200: an empty answer reads as "there are no similar creators".
class LibraryWarmingError extends Error {
  constructor() { super('The library is still being built, try again shortly'); this.status = 503; this.code = 'warming'; this.retryAfter = 5; }
}
const LIB_MAX_AGE = 60000;
let libV = -1; // the write counter when the last worker refresh was asked for
/**
 * Production (worker mode): never builds on the main thread. The snapshot is built by the aggregate
 * worker (src/lib/aggregate-jobs.js: 'library'), served stale while a refresh runs, refreshed at most
 * once a minute and only after a write on this process. Before the first build it is empty.
 * Tests and ':memory:' databases (no worker): synchronous, exact, as before.
 */
function library() {
  const snapshots = require('../lib/snapshots');
  if (!snapshots.USE_WORKER) return libraryInline();
  const entry = snapshots.peek('library');
  const v = writeVersion();
  if (!entry || (v !== libV && Date.now() - entry.at > LIB_MAX_AGE)) {
    libV = v;
    snapshots.refresh('library').catch((e) => console.error('[library] refresh failed:', e.message));
  }
  if (!entry) throw new LibraryWarmingError();
  require('../lib/similarity').adopt(entry.value.lib, entry.value.index);
  return entry.value.lib;
}
function libraryInline() {
  const v = writeVersion();
  if (!snap.data || (SNAP_MAX_AGE === 0 && v !== snap.v)) { snap.data = buildLibrary(); snap.at = Date.now(); snap.v = writeVersion(); return snap.data; }
  if (v !== snap.v && Date.now() - snap.at > SNAP_MAX_AGE && !snap.pending) {
    snap.pending = true;
    setImmediate(() => { try { snap.data = buildLibrary(); snap.at = Date.now(); snap.v = writeVersion(); } finally { snap.pending = false; } });
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
 * Creators who co-star or frequently collaborate with this creator.
 * Sourced from mutual post mentions (@handle, OnlyFans/Fansly links), candidate co-mentions,
 * and incoming scene tags. Bidirectional mentions receive higher ranking weights.
 */
creators.collabs = function collabs(id, limit = 12) {
  const c = creators.get(id);
  if (!c || c.status !== 'active') return [];

  const selfHandles = new Set([c.handle.toLowerCase()]);
  if (c.display_name) selfHandles.add(c.display_name.toLowerCase());
  try {
    const aliases = db.prepare('SELECT alias FROM creator_aliases WHERE creator_id = ?').all(c.id);
    for (const a of aliases) if (a.alias) selfHandles.add(a.alias.toLowerCase());
  } catch { /* best effort */ }
  try {
    const feedsRows = db.prepare('SELECT target FROM feeds WHERE creator_id = ?').all(c.id);
    for (const f of feedsRows) if (f.target) selfHandles.add(f.target.toLowerCase());
  } catch { /* best effort */ }
  if (Array.isArray(c.links)) {
    for (const l of c.links) if (l && l.handle) selfHandles.add(l.handle.toLowerCase());
  }

  // 1. Outgoing mentions in media by this creator
  const myMedia = db.prepare("SELECT title, description FROM media WHERE creator_id = ? AND publish_state = 'published' AND (title LIKE '%@%' OR description LIKE '%@%' OR title LIKE '%onlyfans.com/%' OR description LIKE '%onlyfans.com/%' OR title LIKE '%/u/%' OR description LIKE '%/u/%')").all(c.id);
  const mentionCounts = new Map();
  for (const m of myMedia) {
    const text = `${m.title || ''} ${m.description || ''}`;
    const handles = new Set();
    for (const match of text.matchAll(/@([a-zA-Z0-9_]{3,30})/g)) handles.add(match[1].toLowerCase());
    for (const match of text.matchAll(/(?:^|[^\w/])\/?u\/([a-zA-Z0-9_-]{3,30})/g)) handles.add(match[1].toLowerCase());
    for (const match of text.matchAll(/(?:onlyfans|fansly)\.com\/([a-zA-Z0-9_.-]{3,30})/gi)) handles.add(match[1].toLowerCase());
    for (const h of handles) {
      if (!selfHandles.has(h)) mentionCounts.set(h, (mentionCounts.get(h) || 0) + 1);
    }
  }

  const creatorScores = new Map();
  const targetHandles = [...mentionCounts.keys()];
  if (targetHandles.length) {
    const placeholders = targetHandles.map(() => '?').join(',');
    const matched = db.prepare(`SELECT id, lower(handle) as h FROM creators WHERE status = 'active' AND scope != 'excluded' AND lower(handle) IN (${placeholders}) AND id != ?`).all(...targetHandles, c.id);
    for (const row of matched) {
      creatorScores.set(row.id, (creatorScores.get(row.id) || 0) + (mentionCounts.get(row.h) || 1));
    }
    const matchedAliases = db.prepare(`SELECT ca.creator_id as id, lower(ca.alias) as a FROM creator_aliases ca JOIN creators c ON c.id = ca.creator_id WHERE c.status = 'active' AND c.scope != 'excluded' AND lower(ca.alias) IN (${placeholders}) AND c.id != ?`).all(...targetHandles, c.id);
    for (const row of matchedAliases) {
      creatorScores.set(row.id, (creatorScores.get(row.id) || 0) + (mentionCounts.get(row.a) || 1));
    }
  }

  // 2. Incoming mentions via FTS (other creators posting about this creator)
  try {
    const ftsTerm = c.handle.replace(/[^a-zA-Z0-9_]/g, '');
    if (ftsTerm.length >= 3) {
      const incoming = db.prepare("SELECT m.creator_id, COUNT(*) as count FROM media_fts f JOIN media m ON m.seq = f.rowid WHERE media_fts MATCH ? AND m.creator_id != ? AND m.creator_id IS NOT NULL AND m.publish_state = 'published' GROUP BY m.creator_id").all(ftsTerm, c.id);
      for (const inc of incoming) {
        const existing = creatorScores.get(inc.creator_id) || 0;
        creatorScores.set(inc.creator_id, existing + inc.count * (existing > 0 ? 3 : 1));
      }
    }
  } catch { /* best effort */ }

  // 3. Candidates discovery co-mentions
  try {
    const candidateRows = db.prepare("SELECT creator_id FROM candidates WHERE status IN ('followed', 'linked') AND creator_id IS NOT NULL AND creator_id != ? AND signals LIKE ?").all(c.id, '%"' + c.id + '"%');
    for (const row of candidateRows) {
      creatorScores.set(row.creator_id, (creatorScores.get(row.creator_id) || 0) + 2);
    }
  } catch { /* best effort */ }

  const sortedIds = [...creatorScores.entries()].sort((a, b) => b[1] - a[1]).map(([cid]) => cid).slice(0, limit);
  if (!sortedIds.length) return [];

  const found = db.prepare(`${SELECT_CREATOR_CARD} WHERE c.id IN (${sortedIds.map(() => '?').join(',')}) AND c.status = 'active' AND c.scope != 'excluded'`).all(...sortedIds).map(serializeCreator);
  found.sort((a, b) => creatorScores.get(b.id) - creatorScores.get(a.id));
  return found.map((card) => ({ ...card, collab_count: creatorScores.get(card.id) || 1 }));
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

// INDEXED BY: only the last 28 days of posts are read; the planner would scan every published row (~0.8 s on 260k rows, a few ms this way)
creators.rising = function rising(limit = 12) {
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d28 = new Date(now - 28 * 86400000).toISOString();
  const rows = db.prepare(`SELECT m.creator_id AS id,
      SUM(CASE WHEN m.posted_at >= @d7 THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN m.posted_at < @d7 THEN 1 ELSE 0 END) AS before,
      SUM(CASE WHEN m.posted_at >= @d7 THEN m.score + m.likes * 5 ELSE 0 END) AS heat
    FROM media m INDEXED BY ix_media_pub_posted JOIN creators c ON c.id = m.creator_id
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
  const norm = normAlias(q);
  const aliasCond = norm.length >= 2 ? ' OR EXISTS (SELECT 1 FROM creator_aliases a WHERE a.creator_id = creators.id AND a.norm LIKE ?)' : '';
  const cArgs = norm.length >= 2
    ? [pre, pre, any, any, `${norm}%`, pre, pre, limit]
    : [pre, pre, any, any, pre, pre, limit];
  return {
    creators: db.prepare(`SELECT id, handle, display_name, avatar_url, media_count FROM creators
      WHERE status = 'active' AND scope != 'excluded' AND (media_count > 0 OR origin != 'ingest')
        AND (handle LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR handle LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'${aliasCond})
      ORDER BY (handle LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') DESC, media_count DESC LIMIT ?`).all(...cArgs),
    tags: (() => { const p = q.toLowerCase().replace(/^#/, ''); const out = []; for (const t of library().tagList) { if (t.name.startsWith(p)) { out.push(t); if (out.length >= limit) break; } } return out; })(),
    // a case-insensitive prefix, as a range on the NOCASE index (LIKE cannot use it here: ~1 s per keystroke on 260k rows, ~30 ms as a range)
    communities: db.prepare(`SELECT community AS name, platform, COUNT(*) AS count FROM media INDEXED BY ix_media_pub_comm
      WHERE publish_state = 'published' AND scope != 'excluded' AND community >= ? COLLATE NOCASE AND community < ? COLLATE NOCASE
      GROUP BY community, platform ORDER BY count DESC LIMIT ?`).all(q, `${q}\u{10FFFF}`, limit),
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
    // A feed on a host that is gone or is the wrong platform is created disabled, so no seed can switch it on.
    const dead = require('../lib/deadhosts').deadReason(platform, target);
    if (dead) enabled = 0;
    feedQ.insert.run({
      id, platform, kind, target, label: label || target, creator_id: creatorId, enabled: enabled ? 1 : 0,
      trusted: trusted ? 1 : 0, origin, interval_min: intervalMin, priority, next_run_at: runNow ? null : new Date(Date.now() + intervalMin * 60000).toISOString(),
    });
    return { feed: feedQ.get.get(id), created: true };
  },

  update(id, patch) {
    // Every path that turns a feed on or points it at a new target comes through here (admin PATCH, follow, re-enable,
    // physique, stagger, import). A feed on a dead or wrong-platform host stays off, whatever the caller asked for.
    const current = feedQ.get.get(id);
    if (current && patch && (patch.enabled !== undefined || patch.target !== undefined)) {
      const wantOn = patch.enabled !== undefined ? !!patch.enabled : !!current.enabled;
      const target = patch.target !== undefined ? patch.target : current.target;
      if (wantOn && require('../lib/deadhosts').deadReason(current.platform, target)) patch = { ...patch, enabled: false };
    }
    const cols = { target: 'target', label: 'label', enabled: 'enabled', trusted: 'trusted', interval_min: 'intervalMin', priority: 'priority', creator_id: 'creatorId' };
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
  /**
   * Enabled feeds whose time has come, skipping platforms whose breaker is open. When more are due than can run (one
   * feed per platform at a time), the most overdue goes first, where an hour late counts double for a followed creator's
   * own account and half for a feed that has been failing. New and "run now" feeds (no next_run_at) go before all of them.
   * Weighting lateness, not sorting by kind, means nothing waits forever: an open feed late long enough still wins.
   */
  due(limit = 20, excludePlatforms = [], onlyPlatforms = [], { backfill } = {}) {
    const ex = (excludePlatforms.length ? `AND platform NOT IN (${excludePlatforms.map(() => '?').join(',')})` : '')
      + (onlyPlatforms.length ? ` AND platform IN (${onlyPlatforms.map(() => '?').join(',')})` : '')
      + (backfill === true ? ` AND ${require('../engine/backfill').PENDING_SQL}` : backfill === false ? ` AND NOT ${require('../engine/backfill').PENDING_SQL}` : '');
    const now = nowIso();
    return db.prepare(`SELECT * FROM feeds WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ${ex}
                       ORDER BY priority DESC,
                         CASE WHEN next_run_at IS NULL THEN 1e9 ELSE (julianday(?) - julianday(next_run_at))
                           * (CASE WHEN creator_id IS NOT NULL AND kind IN ('user', 'channel', 'page', 'feed') THEN 2.0 ELSE 1.0 END)
                           * (CASE WHEN consecutive_failures > 0 THEN 0.5 ELSE 1.0 END) END DESC,
                         COALESCE(next_run_at, '') ASC LIMIT ?`).all(now, ...excludePlatforms, ...onlyPlatforms, now, limit);
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
  /** Runs still 'running' after maxAgeMs are marked errors (engine watchdog, every tick). Uses ix_runs_running. */
  timeoutStale(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return db.prepare("UPDATE feed_runs SET status = 'error', error = ?, finished_at = ? WHERE status = 'running' AND started_at < ?")
      .run(`timed out: still running after ${Math.round(maxAgeMs / 60000)} min (watchdog)`, nowIso(), cutoff).changes;
  },
  abandonRunning() {
    db.prepare("UPDATE feed_runs SET status = 'error', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'").run(nowIso());
  },
};

/* --------------------------------------------------------------------- media */
const { ftsQuery, serializeMedia, cachedCount, relatedCache, notifyBlocked, notifyState, media } = require('./repos/media').buildMedia({ uuid, db, nowIso, clampInt, PUBLISH_STATES, PLATFORM_TAGS_SQL, tagQ, cleanTag, addTags, hosts, blocklist, purgeRemovedContent, logAction, countCache, creatorQ, paidClause, creators, GENERIC_TAGS, quietly, writeVersion, library });

/* ----------------------------------------------------------- tag intelligence */
function topicStills(m) {
  const chain = [];
  for (const u of [m.thumb_url, m.preview_url, m.thumbnail_url, m.media_type === 'image' ? m.media_url : null]) {
    if (u && !chain.includes(u)) chain.push(u);
  }
  return chain;
}

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
    // The base set (media that carry the listed tags, all of them or any) is found from the tag side: one tag's
    // posting list, probed by (media_id, tag_id) for the rest. No GROUP BY over every tag row of the base set.
    const tagIds = db.prepare(`SELECT id FROM tags WHERE name IN (${marks})`).all(...list).map((r) => r.id);
    if (!tagIds.length || (all && tagIds.length !== list.length)) return [];
    const idMarks = tagIds.map(() => '?').join(',');
    const baseIds = all
      ? db.prepare(`SELECT mt1.media_id AS media_id FROM media_tags mt1 JOIN media m ON m.id = mt1.media_id
          WHERE mt1.tag_id = ? AND m.publish_state = 'published' AND m.scope != 'excluded'
            AND (SELECT COUNT(*) FROM media_tags mt2 WHERE mt2.media_id = mt1.media_id AND mt2.tag_id IN (${idMarks})) = ?`)
        .all(tagIds[0], ...tagIds, tagIds.length).map((r) => r.media_id)
      : db.prepare(`SELECT DISTINCT mt.media_id AS media_id FROM media_tags mt JOIN media m ON m.id = mt.media_id
          WHERE mt.tag_id IN (${idMarks}) AND m.publish_state = 'published' AND m.scope != 'excluded'`)
        .all(...tagIds).map((r) => r.media_id);
    const base = baseIds.length;
    if (!base) return [];
    const rows = db.prepare(`SELECT t.name, COUNT(*) AS co
      FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
      WHERE mt.media_id IN (SELECT value FROM json_each(?))
        AND t.name NOT IN (${marks}) AND t.name NOT IN (${PLATFORM_TAGS_SQL})
      GROUP BY t.id HAVING co >= 2`).all(JSON.stringify(baseIds), ...list);
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
      const stills = list.map(topicStills).filter((c) => c.length);
      topics.push({ id: names.slice(0, 3).join('+'), title, tags: names, count: total, previews: stills.map((c) => c[0]), previewFalls: stills.map((c) => c[1] || null) });
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

/* -------------------------------------------------------------- stats / home */
function publicStats() {
  const [s] = cachedCount.rows(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videos
    FROM media INDEXED BY ix_media_pub_count WHERE publish_state = 'published' AND scope != 'excluded'`);
  const c = cachedCount("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND media_count > 0", []);
  return { total: s.total || 0, images: s.images || 0, videos: s.videos || 0, creators: c };
}

/** The daily ingest chart: a range on ix_media_ingested_plat (v34), never a full scan. */
const INGEST_DAILY_SQL = `SELECT substr(ingested_at, 1, 10) AS day, platform, COUNT(*) AS n FROM media
      WHERE ingested_at >= ? GROUP BY day, platform ORDER BY day`;
/** Start of the UTC day 14 days ago, as a full ISO timestamp (the same instant the bare date meant). */
const ingestDailySince = (now = Date.now()) => `${new Date(now - 14 * 86400000).toISOString().slice(0, 10)}T00:00:00.000Z`;

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
    ingestDaily: db.prepare(INGEST_DAILY_SQL).all(ingestDailySince()),
  };
}

function discover() {
  const pageOf = (f) => media.list({ ...f, noCount: true }).items;
  // Suggested creators, in the order a visitor should meet them: the stored popularity rank first
  // (engagement + breadth + volume + freshness, engine/popularity.js), with the 90-day activity
  // floor the Creators page uses. When the ranked pool is empty (a brand-new library), the old
  // media-count order answers instead.
  const featured = creators.list({ sort: 'popular', limit: 16, minMedia: 2 }).items;
  const ofTrending = pageOf({ paidHost: 'onlyfans', sort: 'trending', limit: 20 });
  const ofVideos = pageOf({ type: 'video', paidHost: 'onlyfans', sort: 'recent', limit: 14 });
  return {
    stats: publicStats(),
    trending: ofTrending.length >= 8 ? ofTrending : pageOf({ sort: 'trending', limit: 20 }),
    freshVideos: ofVideos.length >= 6 ? ofVideos : pageOf({ type: 'video', sort: 'recent', limit: 14 }),
    topCreators: featured.length ? featured : creators.list({ sort: 'media', limit: 16, minMedia: 2 }).items,
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
const OF = 'OnlyFans';
/** Canonical paid-page host per traced service, for owner matching and lead search queries. */
const PAID_HOSTS = { 'OnlyFans': 'onlyfans.com', 'Fansly': 'fansly.com', 'JustFor.Fans': 'justfor.fans',
  'ManyVids': 'manyvids.com', 'LoyalFans': 'loyalfans.com', 'Fanvue': 'fanvue.com',
  'FanCentro': 'fancentro.com', 'Clips4Sale': 'clips4sale.com', 'Patreon': 'patreon.com' };
const onlyfans = {
  get(handle, service = OF) { return parseLead(db.prepare('SELECT * FROM onlyfans_leads WHERE service = ? AND handle = ?').get(service, String(handle))); },
  /**
   * Someone named this paid page. `sourceId` is the creator whose post/bio named it (null for web search).
   * Counts one mention per distinct source, so a promo channel reposting the same creator does not inflate it.
   */
  note(handle, { service = OF, sourceId = null, origin = 'post', displayName = null, bio = null, free = false } = {}) {
    const h = String(handle).toLowerCase();
    const cur = onlyfans.get(h, service);
    if (!cur) {
      db.prepare(`INSERT INTO onlyfans_leads (service, handle, mentions, sources, origin, display_name, bio, free) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(service, h, JSON.stringify(sourceId ? [sourceId] : []), origin, displayName, bio, free ? 1 : 0);
      return onlyfans.get(h, service);
    }
    const sources = new Set(cur.sources);
    const fresh = sourceId ? !sources.has(sourceId) : origin !== cur.origin;
    if (sourceId) sources.add(sourceId);
    db.prepare(`UPDATE onlyfans_leads SET mentions = mentions + ?, sources = ?, display_name = COALESCE(display_name, ?), bio = COALESCE(bio, ?),
        free = MAX(free, ?), last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE service = ? AND handle = ?`)
      .run(fresh ? 1 : 0, JSON.stringify([...sources].slice(-25)), displayName, bio, free ? 1 : 0, service, h);
    return onlyfans.get(h, service);
  },
  /** A followed creator links to this page: it is theirs. */
  claim(handle, creatorId, service = OF) {
    const h = String(handle).toLowerCase();
    db.prepare(`INSERT INTO onlyfans_leads (service, handle, creator_id, status, origin, checked_at) VALUES (?, ?, ?, 'claimed', 'profile', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(service, handle) DO UPDATE SET creator_id = excluded.creator_id, status = 'claimed', last_seen = excluded.last_seen`).run(service, h, creatorId);
  },
  update(handle, patch, service = OF) {
    if (typeof service === 'object' && service !== null) { patch = { ...service, ...patch }; service = OF; } // update(handle, {service, ...}) also works
    if (patch.service !== undefined) service = patch.service;
    const cols = ['status', 'reason', 'display_name', 'bio', 'creator_id', 'checked_at', 'attempts'];
    const sets = []; const params = { service, handle: String(handle).toLowerCase() };
    for (const c of cols) if (patch[c] !== undefined) { sets.push(`${c} = @${c}`); params[c] = patch[c]; }
    if (patch.accounts !== undefined) { sets.push('accounts = @accounts'); params.accounts = JSON.stringify(patch.accounts.slice(0, 12)); }
    if (patch.free !== undefined) { sets.push('free = @free'); params.free = patch.free ? 1 : 0; }
    if (!sets.length) return onlyfans.get(handle, service);
    db.prepare(`UPDATE onlyfans_leads SET ${sets.join(', ')} WHERE service = @service AND handle = @handle`).run(params);
    return onlyfans.get(handle, service);
  },
  /** Leads to look for next: never-checked first, then the most-mentioned whose last look is older than `staleDays`. */
  workable(limit = 10, staleDays = 14) {
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT * FROM onlyfans_leads WHERE (status = 'pending') OR (status = 'searching' AND attempts < 4 AND (checked_at IS NULL OR checked_at < ?))
      ORDER BY status = 'pending' DESC, mentions DESC, last_seen DESC LIMIT ?`).all(since, limit).map(parseLead);
  },
  list({ status, service, page = 0, limit = 50, q: query } = {}) {
    const where = []; const params = [];
    if (status && status !== 'all') { where.push('l.status = ?'); params.push(status); }
    if (service && service !== 'all') { where.push('l.service = ?'); params.push(service); }
    if (query) { where.push("l.handle LIKE ? ESCAPE '\\'"); params.push(`%${String(query).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM onlyfans_leads l ${w}`).get(...params).n;
    const items = db.prepare(`SELECT l.*, c.handle AS creator_handle, c.display_name AS creator_name, c.media_count AS creator_media
      FROM onlyfans_leads l LEFT JOIN creators c ON c.id = l.creator_id ${w} ORDER BY l.mentions DESC, l.last_seen DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, page * limit).map(parseLead);
    return { items, total, page, limit };
  },
  /** The active creator whose stored links point at this paid page, if any. */
  ownerOf(handle, service = OF) {
    const host = PAID_HOSTS[service] || PAID_HOSTS[OF];
    const h = String(handle).toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
    // The handle may sit behind a section segment (clips4sale.com/store/<handle>), so any path
    // ending in the handle counts, on that host only.
    return db.prepare(`SELECT id, handle FROM creators WHERE status = 'active' AND links LIKE ? ESCAPE '\\' LIMIT 1`).get(`%${host}/%${h}"%`) || null;
  },
  /** Creators with a paid page but few known accounts elsewhere, least recently searched first. */
  reachTargets(limit = 4, staleDays = 30, maxAccounts = 4, service = OF, keyPrefix = null) {
    const host = PAID_HOSTS[service] || PAID_HOSTS[OF];
    const key = keyPrefix || 'of.reach.';
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT c.id, c.handle, c.display_name, c.links,
        (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) AS accounts
      FROM creators c LEFT JOIN discovery_state ds ON ds.key = ? || c.id
      WHERE c.status = 'active' AND c.scope != 'excluded' AND c.links GLOB ? AND (ds.updated_at IS NULL OR ds.updated_at < ?)
        AND (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) <= ?
      ORDER BY ds.updated_at IS NOT NULL, ds.updated_at ASC, c.media_count DESC LIMIT ?`).all(key, `*${host}/[A-Za-z0-9]*`, since, maxAccounts, limit);
  },
  /**
   * Creators already followed here that have no mirrored page yet, most media first: the input for
   * matching a creator *by his name* against coomer's public creator index. A paid link is not
   * required — a popular creator whose OnlyFans handle differs from the name he uses everywhere
   * else is exactly who the handle-based pass cannot find.
   */
  nameTargets(limit = 60, staleDays = 45, keyPrefix = 'coomer.name.') {
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT c.id, c.handle, c.display_name, c.media_count
      FROM creators c LEFT JOIN discovery_state ds ON ds.key = ? || c.id
      WHERE c.status = 'active' AND c.scope != 'excluded'
        AND c.display_name IS NOT NULL AND length(trim(c.display_name)) >= 4
        AND (ds.updated_at IS NULL OR ds.updated_at < ?)
        AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.creator_id = c.id AND f.platform = 'coomer')
      ORDER BY ds.updated_at IS NOT NULL, ds.updated_at ASC, c.media_count DESC LIMIT ?`).all(keyPrefix, since, limit);
  },
  counts() {
    const out = { pending: 0, searching: 0, found: 0, claimed: 0, rejected: 0, byService: {} };
    for (const r of db.prepare('SELECT service, status, COUNT(*) AS n FROM onlyfans_leads GROUP BY service, status').all()) {
      out[r.status] = (out[r.status] || 0) + r.n;
      (out.byService[r.service] = out.byService[r.service] || {})[r.status] = r.n;
    }
    out.creators = db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND links GLOB '*onlyfans.com/[A-Za-z0-9]*'").get().n;
    return out;
  },
};

/* ----------------------------------------------------------------- takedowns */
const { takedowns } = require('./repos/takedowns').buildTakedowns({ db, clampInt, blocklist, purgeRemovedContent, purgeRemovedFor, rememberRemovedHashes, logAction, creatorQ, notifyBlocked, notifyState });

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
    WHERE m.community IS NOT NULL AND m.community != '' AND m.platform IN ('reddit', 'lemmy', 'redgifs')
      AND m.publish_state = 'published' AND m.scope != 'excluded' AND c.status = 'active' AND c.scope != 'excluded'
      AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.platform = m.platform AND f.kind IN ('community', 'niche') AND f.target = m.community COLLATE NOCASE)
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

/** Insert or refresh a firehose/stream lead. Keeps first_seen_at, bumps last_seen_at. */
function upsertDiscoveryLead({ platform, externalId, handle = null, payload = null }) {
  if (!platform || !externalId) throw new Error('upsertDiscoveryLead: platform and externalId required');
  const now = Date.now();
  db.prepare(`INSERT INTO discovery_leads (platform, external_id, handle, payload, first_seen_at, last_seen_at)
    VALUES (@platform, @externalId, @handle, @payload, @now, @now)
    ON CONFLICT(platform, external_id) DO UPDATE SET
      handle = COALESCE(excluded.handle, discovery_leads.handle),
      payload = COALESCE(excluded.payload, discovery_leads.payload),
      last_seen_at = excluded.last_seen_at`)
    .run({ platform, externalId: String(externalId), handle, payload: payload == null ? null : JSON.stringify(payload), now });
  return { platform, externalId: String(externalId) };
}

function getDiscoveryLead(platform, externalId) {
  return db.prepare('SELECT * FROM discovery_leads WHERE platform = ? AND external_id = ?').get(platform, String(externalId)) || null;
}

// test seams (the query plan test reads the exact statement)
const _ingestDaily = { sql: INGEST_DAILY_SQL, since: ingestDailySince };
module.exports = {
  _ingestDaily,
  db, nowIso, clampInt, upsertDiscoveryLead, getDiscoveryLead, cleanTag, ftsQuery, settings, hosts, blocklist, logAction, suggest, audit,
  creators, feeds, runs, media, reports, addTags, publicStats, adminOverview, discover,
  candidates, discoveryState, onlyfans, takedowns, mentionSource, discoveryTargets, communityHangouts, PLATFORM_TAGS, GENERIC_TAGS, tagIntel, library, libraryWithIndex, LibraryWarmingError,
  serializeMedia, serializeCreator, SELECT_CREATOR_CARD,
};
