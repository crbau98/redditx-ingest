'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildMedia: the media library: listing, search, cursors, moderation state, hashes. Built by repo.js with the helpers it uses; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildMedia = function buildMedia({ uuid, db, nowIso, clampInt, PUBLISH_STATES, PLATFORM_TAGS_SQL, tagQ, cleanTag, addTags, hosts, blocklist, purgeRemovedContent, logAction, countCache, creatorQ, paidClause, creators, GENERIC_TAGS, quietly, writeVersion, library }) {
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
// Cursor paging is stable across inserts: the token carries the last row's sort key and seq.
const CURSOR_SORTS = { recent: 'm.posted_at', oldest: 'm.posted_at', top: 'm.score', trending: 'm.hot', ingested: 'm.ingested_at' };
const CURSOR_DIR = { recent: 'DESC', oldest: 'ASC', top: 'DESC', trending: 'DESC', ingested: 'DESC' };

function encodeMediaCursor(sort, row) {
  const col = CURSOR_SORTS[sort];
  if (!col || !row) return null;
  const key = row[col.slice(2)];
  if (key === null || key === undefined) return null;
  return Buffer.from(JSON.stringify({ s: sort, k: key, q: row.seq }), 'utf8').toString('base64url');
}

function decodeMediaCursor(token, sort) {
  if (!token || typeof token !== 'string' || token.length > 240) return null;
  if (!CURSOR_SORTS[sort]) return null;
  try {
    const d = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!d || d.s !== sort || d.q === null || d.q === undefined) return null;
    const q = Number(d.q);
    if (!Number.isFinite(q)) return null;
    if (typeof d.k !== 'string' && typeof d.k !== 'number') return null;
    return { s: sort, k: d.k, q };
  } catch { return null; }
}

// BM25 column weights for media_fts(title, author, community, tags_text, description, ocr_text).
const FTS_WEIGHTS = '5.0, 4.0, 2.0, 4.0, 1.0, 1.0';

const MEDIA_SELECT = `SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar, c.links AS creator_links
  FROM media m LEFT JOIN creators c ON c.id = m.creator_id`;

function serializeMedia(row) {
  if (!row) return null;
  const out = { ...row, has_audio: !!row.has_audio };
  delete out.seq;
  delete out.ocr_text;
  delete out.ocr_at;
  return out;
}

const mediaQ = {
  get: db.prepare(`${MEDIA_SELECT} WHERE m.id = ?`),
  byHash: db.prepare('SELECT id FROM media WHERE hash = ?'),
  byKey: db.prepare('SELECT id FROM media WHERE source_key = ?'),
  byPost: db.prepare('SELECT 1 AS ok FROM media WHERE post_key = ? LIMIT 1'),
  insert: db.prepare(`INSERT INTO media (id, creator_id, feed_id, platform, source_id, source_key, post_key, position, source_url, community, author, title, description,
      media_type, media_url, preview_url, thumbnail_url, hls_url, has_audio, width, height, duration, mime_type, score, hash, nsfw_level, scope, publish_state, review_reason, posted_at, phash, physique, attribution_evidence, lean_bias)
    VALUES (@id, @creator_id, @feed_id, @platform, @source_id, @source_key, @post_key, @position, @source_url, @community, @author, @title, @description,
      @media_type, @media_url, @preview_url, @thumbnail_url, @hls_url, @has_audio, @width, @height, @duration, @mime_type, @score, @hash, @nsfw_level, @scope, @publish_state, @review_reason, @posted_at, @phash, @physique, @attribution_evidence, @lean_bias)`),
  leanSet: db.prepare('UPDATE media SET lean_bias = ? WHERE id = ?'),
  state: db.prepare("UPDATE media SET publish_state = ?, review_reason = COALESCE(?, review_reason), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
  stateExact: db.prepare("UPDATE media SET publish_state = ?, review_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
  reviewIdsByReason: db.prepare("SELECT id, creator_id FROM media WHERE publish_state = 'review' AND review_reason = ? ORDER BY seq LIMIT ?"),
  countReviewReason: db.prepare("SELECT COUNT(*) AS n FROM media WHERE publish_state = 'review' AND review_reason = ?"),
  reviewReasonCounts: db.prepare("SELECT review_reason AS reason, COUNT(*) AS n FROM media WHERE publish_state = 'review' AND review_reason IS NOT NULL AND review_reason != '' GROUP BY review_reason ORDER BY n DESC LIMIT ?"),
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
  // creators with a page on a paid platform ("on Fansly"): their free posts, from any source
  if (f.paidHost) { const pc = paidClause(f.paidHost); where.push(`m.creator_id IN (SELECT id FROM creators WHERE ${pc.sql})`); params.push(...pc.params); }
  // pictures the physique model measured as lean or athletic (0..100 heaviness; -1 and 101 are markers)
  if (f.build === 'fit') where.push('m.physique BETWEEN 0 AND 30');
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
  // Review queue: one exact hold reason, or one hold kind (safety / scope / other). Exact reason wins.
  if (typeof f.reviewReason === 'string' && f.reviewReason) {
    where.push('m.review_reason = ?');
    params.push(f.reviewReason);
  } else if (f.reviewKind === 'safety') {
    where.push("m.review_reason LIKE 'safety:%'");
  } else if (f.reviewKind === 'scope') {
    where.push("m.review_reason IN ('scope:unclear', 'scope')");
  } else if (f.reviewKind === 'other') {
    where.push("(m.review_reason IS NULL OR (m.review_reason NOT LIKE 'safety:%' AND m.review_reason NOT IN ('scope:unclear', 'scope')))");
  }
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
const SORT_INDEX = { recent: 'ix_media_pub_posted', oldest: 'ix_media_pub_posted', top: 'ix_media_pub_score', trending: 'ix_media_pub_hot', ingested: 'ix_media_pub_ingested' };
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
/**
 * Share of the published library that belongs to creators with a page on a paid host ("on OnlyFans"), from the creators'
 * own media counts (a 10k-row scan of the links column, cached for a minute). A host most of the library's creators use
 * is as broad a filter as a common tag: walking the sort index meets a match every few rows, where the creator index
 * would gather and sort every one of those creators' posts (~200 ms for the first page, on 20% of the creators).
 */
const paidShareCache = new Map(); // host -> { share, at }
function paidShare(host) {
  const hit = paidShareCache.get(host);
  if (hit && Date.now() - hit.at < 60000) return hit.share;
  const pc = paidClause(host);
  const mine = db.prepare(`SELECT COALESCE(SUM(media_count), 0) AS n FROM creators WHERE status = 'active' AND ${pc.sql}`).get(...pc.params).n;
  const all = db.prepare("SELECT COALESCE(SUM(media_count), 0) AS n FROM creators WHERE status = 'active'").get().n;
  const share = all ? mine / all : 0;
  if (paidShareCache.size > 50) paidShareCache.clear();
  paidShareCache.set(host, { share, at: Date.now() });
  return share;
}
const BROAD_PAID_SHARE = 0.1;
function sortIndexFor(f, sort, where) {
  const idx = SORT_INDEX[sort || 'recent'];
  if (!idx || !where.includes("m.publish_state = 'published'")) return null; // partial indexes cover published rows only
  if (f.creator || (Array.isArray(f.ids) && f.ids.length) || f.community || f.minScore) return null;
  if (f.paidHost && paidShare(f.paidHost) < BROAD_PAID_SHARE) return null;
  const all = [...(f.tag ? [f.tag] : []), ...(Array.isArray(f.tagsAll) ? f.tagsAll : [])].map(cleanTag);
  if (all.length && Math.min(...all.map(tagRows)) < BROAD_TAG_MIN) return null;
  // several tags that must all match: the matches are about total * product of the shares, far fewer than any one tag's rows
  if (all.length > 1) {
    const total = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM media').get().n || 1;
    if (total * all.reduce((p, t) => p * (tagRows(t) / total), 1) < BROAD_TAG_MIN) return null;
  }
  if (Array.isArray(f.tagsAny) && f.tagsAny.length && f.tagsAny.map(cleanTag).reduce((a, t) => a + tagRows(t), 0) < BROAD_TAG_MIN) return null;
  return idx;
}
// Totals ("1,234 results") are recounted only after a write that can change them: the cache is keyed by writeVersion()
// (SQLite's total_changes(), minus the likes / views / trending-score writes, which change no count).
function cachedCount(sql, args) {
  const key = `${sql}|${JSON.stringify(args)}`;
  const v = writeVersion();
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
  const v = writeVersion();
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

/**
 * The list total for the plain public library ("N results": everything published, optionally one type and/or one platform)
 * reads only platform, media_type, creator_id and the two state columns, which ix_media_pub_count holds (schema v22):
 * an index-only scan instead of a table lookup per row (~1 s -> ~80 ms on 260k rows). Named explicitly because the planner
 * prefers ix_media_state. Any other filter (tags, community, creator, text...) is left to the planner.
 */
const COUNT_ONLY_FILTERS = new Set(['limit', 'page', 'sort', 'seed', 'type', 'platform', 'noCount', 'paidHost']);
function countIndexFor(f) {
  if (f.admin || (f.state !== undefined && f.state !== 'published')) return null;
  for (const k of Object.keys(f)) if (f[k] !== undefined && !COUNT_ONLY_FILTERS.has(k) && k !== 'since' && k !== 'after') return null;
  // "since last week" / "new since": a short window of the date indexes, not the whole library (a year is most of it: left to the planner)
  if (f.since === 'day' || f.since === 'week' || f.since === 'month') return f.after ? null : 'ix_media_pub_posted';
  if (f.since) return null;
  if (f.after) return 'ix_media_ingested';
  return 'ix_media_pub_count';
}

const media = {
  /** Subscribe to publish-state changes: fn(id, state). */
  onState(fn) { stateHooks.push(fn); },
  onPhashBlocked(fn) { blockedHooks.push(fn); },
  setPhash(id, hex) { db.prepare('UPDATE media SET phash = ? WHERE id = ?').run(hex || null, id); },
  setPhysique(id, score) { db.prepare('UPDATE media SET physique = ? WHERE id = ?').run(Number.isFinite(score) ? Math.round(score) : null, id); },
  /** Lean-preference ranking multiplier (see lib/buildbias): null puts the row back to neutral. */
  setLeanBias(id, bias) { mediaQ.leanSet.run(bias == null ? null : bias, id); },
  /** Pictures that already have a perceptual hash and are visible or awaiting review (feeds the in-memory index). */
  // body-filter hides are reversible (a threshold change shows them again), so they stay indexed: a copy is never stored twice
  hashedRows() { return db.prepare("SELECT id, phash, media_type, width, height FROM media WHERE phash IS NOT NULL AND (publish_state IN ('published','review') OR (publish_state = 'hidden' AND review_reason LIKE 'physique:%'))").all(); },
  /** One seq-ordered slice of hashedRows(), for the chunked first build (services/dedupe.loadChunked). */
  hashedChunk(after = 0, n = 5000) { return db.prepare("SELECT seq, id, phash, media_type, width, height FROM media NOT INDEXED WHERE phash IS NOT NULL AND seq > ? AND (publish_state IN ('published','review') OR (publish_state = 'hidden' AND review_reason LIKE 'physique:%')) ORDER BY seq LIMIT ?").all(after, n); },
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
  idByKey(key) { const r = mediaQ.byKey.get(key); return r ? r.id : null; },
  postKnown(postKey) { return !!mediaQ.byPost.get(postKey); },

  /** @returns {string|null} new media id, or null on duplicate */
  insert(row, tags = []) {
    const id = uuid();
    const rec = {
      id, creator_id: null, feed_id: null, source_id: null, source_key: null, post_key: null, position: 0, source_url: null,
      community: null, author: null, title: null, description: null, preview_url: null, thumbnail_url: null, hls_url: null,
      has_audio: 0, width: null, height: null, duration: null, mime_type: null, score: 0, nsfw_level: 'explicit', scope: 'in',
      publish_state: 'published', review_reason: null, posted_at: nowIso(), phash: null, physique: null, attribution_evidence: null, lean_bias: null, ...row,
    };
    const run = db.transaction(() => {
      try {
        mediaQ.insert.run(rec);
      } catch (e) {
        // Duplicate hash / source_key: expected and harmless. Anything else is a real bug.
        if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
        throw e;
      }
      if (tags.length) addTags(id, tags, 'ingest');
      // A published row moves the visible counters by itself. Hide, restore, and re-attribute
      // still recount, because those can take a row out of the published set.
      if (rec.creator_id && rec.publish_state === 'published') {
        creatorQ.bump.run({
          id: rec.creator_id,
          video: rec.media_type === 'video' ? 1 : 0,
          score: Number(rec.score) || 0,
          posted: rec.posted_at || null,
        });
      }
      hosts.add(rec.media_url, rec.preview_url, rec.thumbnail_url, rec.hls_url);
      return id;
    });
    return run();
  },

  /** `exact`: write `reason` as given (null clears it) instead of keeping the previous reason when none is passed. */
  setState(id, state, reason, { exact = false, deferStats = false } = {}) {
    if (!PUBLISH_STATES.includes(state)) throw new Error('bad state');
    const m = db.prepare('SELECT creator_id FROM media WHERE id = ?').get(id);
    (exact ? mediaQ.stateExact : mediaQ.state).run(state, reason || null, id);
    // `deferStats`: a bulk caller refreshes each affected creator once itself (refreshStats recounts all of a creator's media)
    if (m && m.creator_id && !deferStats) creators.refreshStats(m.creator_id);
    countCache.clear(); // a hide/restore must be visible in the next total at once
    notifyState(id, state);
  },

  /** Waiting rows with this exact hold reason, oldest first. Never more than 500. */
  reviewIdsByReason(reason, limit = 500) {
    return mediaQ.reviewIdsByReason.all(reason, Math.min(500, Math.max(1, limit | 0)));
  },
  countReviewReason(reason) { return mediaQ.countReviewReason.get(reason).n; },
  /** How many items are waiting under each hold reason, biggest first. */
  reviewReasonCounts(limit = 24) {
    return mediaQ.reviewReasonCounts.all(Math.min(40, Math.max(1, limit | 0)));
  },

  /**
   * Move every item one feed brought in to another creator, or to none (creatorId null / ''), and the feed with them:
   * the cleanup after a feed was attached to the wrong man. Only rows whose ingest feed is this feed change; the feed's
   * own creator_id is set in the same transaction, so its next posts follow; each creator that lost or gained rows is
   * recounted once; one audit row records it. Nothing is merged.
   * @returns {{moved: number, from: string[], to: string|null}|null} null when the feed or target creator does not exist
   */
  reassignFeed(feedId, creatorId, { actor = 'admin' } = {}) {
    const feed = db.prepare('SELECT id, platform, target FROM feeds WHERE id = ?').get(feedId);
    if (!feed) return null;
    const to = creatorId ? String(creatorId) : null;
    if (to && !db.prepare('SELECT id FROM creators WHERE id = ?').get(to)) return null;
    const out = db.transaction(() => {
      const from = db.prepare('SELECT DISTINCT creator_id AS id FROM media WHERE feed_id = ? AND creator_id IS NOT ?').all(feed.id, to).map((r) => r.id);
      const moved = db.prepare("UPDATE media SET creator_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE feed_id = ? AND creator_id IS NOT ?").run(to, feed.id, to).changes;
      // The feed itself goes with its items: a feed still owned by the old creator would credit its next posts to him
      // again (pipeline ownedByFeed).
      db.prepare("UPDATE feeds SET creator_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(to, feed.id);
      return { moved, from: from.filter(Boolean) };
    })();
    if (out.moved) {
      for (const id of new Set([...out.from, to].filter(Boolean))) creators.refreshStats(id);
      countCache.clear(); // a creator filter's totals changed
      logAction('feed', feed.id, 'reassign-media', `${out.moved} item(s) of ${feed.platform}:${String(feed.target).slice(0, 80)} from ${out.from.join(', ') || 'none'} to ${to || 'no creator'}`, actor);
    }
    return { moved: out.moved, from: out.from, to };
  },

  update(id, patch, { deferStats = false } = {}) {
    const allowed = ['title', 'description', 'nsfw_level', 'scope'];
    const sets = []; const params = { id };
    let movedFrom = null;
    if (patch.creator_id !== undefined) {
      // Re-attribute a row to another creator (an admin fixing a page that was named after its
      // site instead of the man in it). Unknown creator id: refuse by leaving the row untouched.
      if (patch.creator_id && !db.prepare('SELECT id FROM creators WHERE id = ?').get(patch.creator_id)) return media.get(id);
      const cur = db.prepare('SELECT creator_id FROM media WHERE id = ?').get(id);
      movedFrom = cur ? cur.creator_id : null;
      if ((movedFrom || null) !== (patch.creator_id || null)) { sets.push('creator_id = @creator_id'); params.creator_id = patch.creator_id || null; }
    }
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
    // A bulk caller refreshes each affected creator once. A per-row recount scans that creator's whole library.
    if (!deferStats) {
      if (m && m.creator_id) creators.refreshStats(m.creator_id);
      if (movedFrom && movedFrom !== (m && m.creator_id)) creators.refreshStats(movedFrom);
    }
    if (params.publish_state || params.scope) countCache.clear(); // visibility changed: the next total must see it
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
      purgeRemovedContent([id]);
      logAction('media', id, 'block', reason, actor);
      if (m.creator_id) creators.refreshStats(m.creator_id);
    })();
    countCache.clear();
    notifyState(id, 'removed');
    if (m.phash) notifyBlocked(m.phash);
    return true;
  },

  bumpLike(id, delta = 1) { return quietly((delta >= 0 ? mediaQ.like : mediaQ.unlike).run(id).changes) > 0; },
  bumpView(id) { return quietly(mediaQ.view.run(id).changes) > 0; },

  list(f = {}) {
    const limit = clampInt(f.limit, 1, 200, 48);
    const requestedSort = SORTS[f.sort] ? f.sort : 'recent';
    const cursorSort = !f.ids && (!f.q || f.sort) && f.sort !== 'random' && f.sort !== 'relevance' ? requestedSort : null;
    const cursor = cursorSort ? decodeMediaCursor(f.cursor, cursorSort) : null;
    const useCursor = !!cursor;
    const page = useCursor ? 0 : clampInt(f.page, 0, 100000, 0);
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
    if (useCursor) {
      const col = CURSOR_SORTS[cursor.s];
      const cmp = CURSOR_DIR[cursor.s] === 'ASC' ? '>' : '<';
      where.push(`(${col} ${cmp} ? OR (${col} = ? AND m.seq ${cmp} ?))`);
      params.push(cursor.k, cursor.k, cursor.q);
    }
    const orderParams = order.startsWith('hash_seed') ? [clampInt(f.seed, 0, 2147483647, 1)] : [];
    const whereSql = where.join(' AND ');
    const forced = !join && f.sort !== 'random' ? sortIndexFor(f, SORTS[f.sort] ? f.sort : 'recent', where) : null;
    // With a text match, CROSS JOIN pins the loop order: run the MATCH once, then look rows up by key.
    const base = join
      ? `FROM (SELECT rowid AS rid, bm25(media_fts, ${FTS_WEIGHTS}) AS rank FROM media_fts WHERE media_fts MATCH ?) fts CROSS JOIN media m ON m.seq = fts.rid LEFT JOIN creators c ON c.id = m.creator_id WHERE ${whereSql}`
      : `FROM media m${forced ? ` INDEXED BY ${forced}` : ''} LEFT JOIN creators c ON c.id = m.creator_id WHERE ${whereSql}`;
    // Count with an IN-subquery, never the FTS join: with the join SQLite may drive the loop from
    // media and re-run the MATCH once per row (minutes on a large library instead of milliseconds).
    const total = (f.noCount || useCursor) ? null : (join
      ? cachedCount(`SELECT COUNT(*) AS n FROM media m WHERE m.seq IN (SELECT rowid FROM media_fts WHERE media_fts MATCH ?) AND ${whereSql}`, [...joinParams, ...params])
      : cachedCount(`SELECT COUNT(*) AS n FROM media m${countIndexFor(f) ? ` INDEXED BY ${countIndexFor(f)}` : ''} WHERE ${whereSql}`, params));
    const rows = db.prepare(`SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar, c.links AS creator_links ${base}
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(...joinParams, ...params, ...orderParams, limit, page * limit);
    const nextCursor = cursorSort && rows.length === limit ? encodeMediaCursor(cursorSort, rows[rows.length - 1]) : null;
    return { items: rows.map(serializeMedia), total, page, limit, nextCursor };
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
      const near = require('../../lib/similarity').neighbours(library(), GENERIC_TAGS, m.creator_id, 6).map(([cid]) => cid);
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
    // lean_bias folds the owner's type preference into the ranking (NULL = neutral, lib/buildbias).
    return quietly(db.prepare(require('../functions').HOT_UPDATE_SQL)
      .run({ now, tol: tolerance }).changes);
  },

  /**
   * The same refresh as recomputeHot(), but in rowid ranges with a yield between them.
   *
   * The single statement rewrites every published row whose score drifted, and it evaluates the
   * hot_score() SQL function three times per row. On a large library that is minutes of blocked
   * event loop: requests time out and the platform's health check cannot answer, so a deploy is
   * killed even though the container is fine. Chunked, the same work is done in pieces small
   * enough that the server keeps answering between them.
   */
  async recomputeHotChunked(tolerance = 0.02, chunk = 2000) { // 2k rows per statement: a 20k chunk was a 1-3 s main-thread block on a cold file
    const now = Date.now();
    const stmt = db.prepare(require('../functions').HOT_UPDATE_RANGE_SQL);
    const max = db.prepare('SELECT MAX(seq) AS m FROM media WHERE publish_state = ?').get('published');
    const top = max && max.m ? max.m : 0;
    let from = 0;
    let updated = 0;
    while (from < top) {
      const to = Math.min(from + chunk, top);
      updated += quietly(stmt.run({ now, tol: tolerance, from, to }).changes);
      from = to;
      await new Promise((r) => setImmediate(r)); // let requests (and the health check) through
    }
    return updated;
  },

  communities(limit = 60) {
    return db.prepare(`SELECT community AS name, platform, COUNT(*) AS count FROM media INDEXED BY ix_media_pub_comm
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
    return cachedCount.rows(`SELECT platform, COUNT(*) AS count FROM media INDEXED BY ix_media_pub_count WHERE publish_state = 'published' AND scope != 'excluded'
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
  return { ftsQuery, serializeMedia, cachedCount, relatedCache, notifyBlocked, notifyState, media };
};
