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

/* ----------------------------------------------- library snapshot, creator graph */
const { GENERIC_TAGS, quietly, writeVersion, library, libraryWithIndex, LibraryWarmingError } = require('./repos/library').buildLibraryModule({ db, PLATFORM_TAGS });
require('./repos/graph').attachCreatorGraph({ db, creators, library, GENERIC_TAGS, SELECT_CREATOR_CARD, serializeCreator, cleanTag });

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

/* ------------------------------------------------- feeds, runs, reports, discovery */
const { feeds } = require('./repos/feeds').buildFeeds({ db, uuid, nowIso, clampInt });
const { runs } = require('./repos/runs').buildRuns({ db, uuid, nowIso });
const { reports } = require('./repos/reports').buildReports({ db, uuid });
const { candidates, discoveryState, mentionSource, communityHangouts, discoveryTargets, upsertDiscoveryLead, getDiscoveryLead } = require('./repos/candidates').buildCandidates({ db, uuid, hosts });
const { onlyfans } = require('./repos/onlyfans').buildOnlyfans({ db });

/* --------------------------------------------------------------------- media */
const { ftsQuery, serializeMedia, cachedCount, relatedCache, notifyBlocked, notifyState, media } = require('./repos/media').buildMedia({ uuid, db, nowIso, clampInt, PUBLISH_STATES, PLATFORM_TAGS_SQL, tagQ, cleanTag, addTags, hosts, blocklist, purgeRemovedContent, logAction, countCache, creatorQ, paidClause, creators, GENERIC_TAGS, quietly, writeVersion, library });
/* ------------------------------------------------- tag intelligence, stats / home */
const { tagIntel } = require('./repos/tags').buildTagIntel({ db, cleanTag, PLATFORM_TAGS_SQL, library, relatedCache, media });
const { publicStats, adminOverview, discover, INGEST_DAILY_SQL, ingestDailySince } = require('./repos/analytics').buildAnalytics({ db, cachedCount, media, creators, feeds, runs, reports, candidates, blockQ });

/* ----------------------------------------------------------------- takedowns */
const { takedowns } = require('./repos/takedowns').buildTakedowns({ db, clampInt, blocklist, purgeRemovedContent, purgeRemovedFor, rememberRemovedHashes, logAction, creatorQ, notifyBlocked, notifyState });

// test seams (the query plan test reads the exact statement)
const _ingestDaily = { sql: INGEST_DAILY_SQL, since: ingestDailySince };
module.exports = {
  _ingestDaily,
  purgeRemovedContent, // engine/residue-purge: the one purge, for the pre-690c331 backlog
  db, nowIso, clampInt, upsertDiscoveryLead, getDiscoveryLead, cleanTag, ftsQuery, settings, hosts, blocklist, logAction, suggest, audit,
  creators, feeds, runs, media, reports, addTags, publicStats, adminOverview, discover,
  candidates, discoveryState, onlyfans, takedowns, mentionSource, discoveryTargets, communityHangouts, PLATFORM_TAGS, GENERIC_TAGS, tagIntel, library, libraryWithIndex, LibraryWarmingError,
  serializeMedia, serializeCreator, SELECT_CREATOR_CARD,
};
