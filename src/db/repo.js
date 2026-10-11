'use strict';
/**
 * Data access. All SQL lives here; routes and the engine never build queries.
 */
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { db } = require('./index');

const nowIso = () => new Date().toISOString();
const clampInt = (v, min, max, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};
const PUBLISH_STATES = ['published', 'review', 'hidden', 'removed'];

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
        FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published'
        ORDER BY m.score DESC, m.seq DESC LIMIT 6) WHERE t IS NOT NULL LIMIT 3) AS previews,
    (SELECT group_concat(DISTINCT m.platform) FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published') AS platforms
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
      WHERE m.creator_id = ? AND m.publish_state = 'published' GROUP BY t.id ORDER BY n DESC LIMIT 12`),
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
      const merged = existing.concat(links.filter((l) => l.url && !seen.has(l.url)));
      if (merged.length !== existing.length) patch.links = merged.slice(0, 24);
    }
    if (Object.keys(patch).length) creators.update(id, patch);
  },

  refreshStats(id) { if (id) creatorQ.stats.run({ id }); },

  list({ page = 0, limit = 48, q: query, sort = 'media', platform, admin = false, minMedia } = {}) {
    const where = []; const params = [];
    if (!admin) { where.push("c.status = 'active'", "c.scope != 'excluded'"); }
    const min = minMedia !== undefined ? minMedia : (admin ? 0 : 1);
    if (min > 0) { where.push('c.media_count >= ?'); params.push(min); }
    if (query) {
      where.push('(c.handle LIKE ? ESCAPE \'\\\' OR c.display_name LIKE ? ESCAPE \'\\\')');
      const like = `%${String(query).replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like);
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
    return out;
  },

  merge(keepId, mergeId) {
    if (keepId === mergeId) return null;
    const keep = creatorQ.get.get(keepId); const gone = creatorQ.get.get(mergeId);
    if (!keep || !gone) return null;
    db.transaction(() => {
      db.prepare('UPDATE media SET creator_id = ? WHERE creator_id = ?').run(keepId, mergeId);
      db.prepare('UPDATE feeds SET creator_id = ? WHERE creator_id = ?').run(keepId, mergeId);
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
      media_type, media_url, preview_url, thumbnail_url, hls_url, has_audio, width, height, duration, mime_type, score, hash, nsfw_level, scope, publish_state, review_reason, posted_at)
    VALUES (@id, @creator_id, @feed_id, @platform, @source_id, @source_key, @post_key, @position, @source_url, @community, @author, @title, @description,
      @media_type, @media_url, @preview_url, @thumbnail_url, @hls_url, @has_audio, @width, @height, @duration, @mime_type, @score, @hash, @nsfw_level, @scope, @publish_state, @review_reason, @posted_at)`),
  state: db.prepare("UPDATE media SET publish_state = ?, review_reason = COALESCE(?, review_reason), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
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
  if (Array.isArray(f.ids)) {
    if (!f.ids.length) where.push('0=1');
    else { where.push(`m.id IN (${f.ids.map(() => '?').join(',')})`); params.push(...f.ids); }
  }
  if (f.scope) { where.push('m.scope = ?'); params.push(f.scope); }
  if (f.level === 'explicit' || f.level === 'suggestive') { where.push('m.nsfw_level = ?'); params.push(f.level); }
  if (f.minScore) { where.push('m.score >= ?'); params.push(f.minScore); }
  if (f.since && SINCE_DAYS[f.since]) { where.push('m.posted_at >= ?'); params.push(new Date(Date.now() - SINCE_DAYS[f.since] * 86400000).toISOString()); }
  if (f.tag) {
    where.push('m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?)');
    params.push(cleanTag(f.tag));
  }
  return { where, params };
}

const media = {
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
          publish_state: 'published', review_reason: null, posted_at: nowIso(), ...row,
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

  setState(id, state, reason) {
    if (!PUBLISH_STATES.includes(state)) throw new Error('bad state');
    const m = db.prepare('SELECT creator_id FROM media WHERE id = ?').get(id);
    mediaQ.state.run(state, reason || null, id);
    if (m && m.creator_id) creators.refreshStats(m.creator_id);
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
    return media.get(id);
  },

  /** Remove and remember (so ingestion never brings it back). */
  block(id, reason, actor = 'admin') {
    const m = db.prepare('SELECT id, hash, source_key, post_key, creator_id FROM media WHERE id = ?').get(id);
    if (!m) return null;
    db.transaction(() => {
      mediaQ.state.run('removed', reason || null, id);
      if (m.hash) blocklist.add('hash', m.hash, reason);
      if (m.source_key) blocklist.add('source_key', m.source_key, reason);
      logAction('media', id, 'block', reason, actor);
      if (m.creator_id) creators.refreshStats(m.creator_id);
    })();
    return true;
  },

  bumpLike(id, delta = 1) { return (delta >= 0 ? mediaQ.like : mediaQ.unlike).run(id).changes > 0; },
  bumpView(id) { return mediaQ.view.run(id).changes > 0; },

  list(f = {}) {
    const limit = clampInt(f.limit, 1, 200, 48);
    const page = clampInt(f.page, 0, 100000, 0);
    const { where, params } = buildMediaWhere(f);
    const match = ftsQuery(f.q);
    let join = '';
    let order;
    const joinParams = [];
    if (f.q && !match) where.push('0=1'); // query had no searchable tokens
    if (match) {
      if (!f.sort || f.sort === 'relevance') {
        join = 'JOIN (SELECT rowid AS rid, rank FROM media_fts WHERE media_fts MATCH ?) fts ON fts.rid = m.seq';
        joinParams.push(match);
        order = 'fts.rank, m.posted_at DESC, m.seq DESC';
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
    const base = `FROM media m LEFT JOIN creators c ON c.id = m.creator_id ${join} WHERE ${whereSql}`;
    const total = f.noCount ? null : db.prepare(`SELECT COUNT(*) AS n FROM media m ${join} WHERE ${whereSql}`).get(...joinParams, ...params).n;
    const rows = db.prepare(`SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar ${base}
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(...joinParams, ...params, ...orderParams, limit, page * limit);
    return { items: rows.map(serializeMedia), total, page, limit };
  },

  related(id, limit = 12) {
    const m = db.prepare('SELECT id, creator_id, post_key, community FROM media WHERE id = ?').get(id);
    if (!m) return [];
    const seen = new Set([id]);
    const out = [];
    const take = (rows) => { for (const r of rows) { if (!seen.has(r.id) && out.length < limit) { seen.add(r.id); out.push(serializeMedia(r)); } } };
    const pub = "m.publish_state = 'published' AND m.scope != 'excluded'";
    if (m.post_key) take(db.prepare(`${MEDIA_SELECT} WHERE m.post_key = ? AND m.id != ? AND ${pub} ORDER BY m.position LIMIT ?`).all(m.post_key, id, limit));
    if (m.creator_id && out.length < limit) take(db.prepare(`${MEDIA_SELECT} WHERE m.creator_id = ? AND m.id != ? AND ${pub} ORDER BY m.score DESC LIMIT ?`).all(m.creator_id, id, limit));
    if (out.length < limit) {
      take(db.prepare(`${MEDIA_SELECT} WHERE m.id IN (
          SELECT mt2.media_id FROM media_tags mt1 JOIN media_tags mt2 ON mt1.tag_id = mt2.tag_id
          WHERE mt1.media_id = ? AND mt2.media_id != ? GROUP BY mt2.media_id ORDER BY COUNT(*) DESC LIMIT 60) AND ${pub}
        ORDER BY m.score DESC LIMIT ?`).all(id, id, limit));
    }
    if (out.length < limit && m.community) take(db.prepare(`${MEDIA_SELECT} WHERE m.community = ? AND m.id != ? AND ${pub} ORDER BY m.score DESC LIMIT ?`).all(m.community, id, limit));
    return out;
  },

  recomputeHot() {
    const now = Date.now();
    return db.prepare(`UPDATE media SET hot = hot_score(score, likes, views, epoch_ms(posted_at), ?) WHERE publish_state = 'published'`).run(now).changes;
  },

  communities(limit = 60) {
    return db.prepare(`SELECT community AS name, platform, COUNT(*) AS count FROM media
      WHERE publish_state = 'published' AND scope != 'excluded' AND community IS NOT NULL AND community != ''
      GROUP BY community, platform ORDER BY count DESC LIMIT ?`).all(limit);
  },

  tags(limit = 60, minCount = 1) {
    return db.prepare(`SELECT t.name, COUNT(*) AS count FROM media_tags mt
      JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
      WHERE m.publish_state = 'published' AND m.scope != 'excluded'
      GROUP BY t.id HAVING count >= ? ORDER BY count DESC, t.name LIMIT ?`).all(minCount, limit);
  },

  platforms() {
    return db.prepare(`SELECT platform, COUNT(*) AS count FROM media WHERE publish_state = 'published' AND scope != 'excluded'
      GROUP BY platform ORDER BY count DESC`).all();
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
  const s = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS images,
      SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videos
    FROM media WHERE publish_state = 'published' AND scope != 'excluded'`).get();
  const c = db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND media_count > 0").get().n;
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
    tags: media.tags(36, 2),
    communities: media.communities(24),
    platforms: media.platforms(),
  };
}

module.exports = {
  db, nowIso, clampInt, cleanTag, ftsQuery, settings, hosts, blocklist, logAction,
  creators, feeds, runs, media, reports, addTags, publicStats, adminOverview, discover,
};
