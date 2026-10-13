'use strict';
/**
 * "For you": personal recommendations from a taste profile the *client* sends (the server keeps
 * nothing per visitor). The profile is weighted — tags, creators and sources with how strongly
 * they were engaged — plus what the viewer asked to see less of.
 *
 * 1. Candidates, each from an index: the liked creators' best recent posts, posts from creators
 *    whose style resembles theirs (tf-idf tag similarity, see lib/similarity.js), and the hottest
 *    posts carrying the liked tags.
 * 2. Score: creator affinity, similar-creator affinity, tag affinity (rare tags count for more,
 *    tag-stuffed posts don't win by volume), source and photo/video preference, popularity,
 *    freshness and a little seeded jitter; "show less" tags push items down.
 * 3. Re-rank for variety: one item per post / identical picture, at most two per creator in any
 *    page, and a penalty for repeating the tags of the last few picks.
 *
 * The ranked list is cached per (taste, seed) for a few minutes so infinite scroll pages through
 * the same order without repeats. Only published media from active creators is ever a candidate,
 * so anything the moderation, safety or body filters hide never comes back through here.
 */
const repo = require('../db/repo');
const sim = require('../lib/similarity');

const { db, cleanTag, library, GENERIC_TAGS } = repo;

const LIKED_PER_CREATOR = 40;
const SIMILAR_PER_CREATOR = 16;
const TAG_POOL = 1500;
const MAX_RANKED = 1200;

/** "beach:3.5,beard" → Map(beach → 3.5, beard → 1). Weights are clamped; junk is dropped. */
function parseWeighted(v, re, max, clean = (x) => x) {
  const out = new Map();
  if (typeof v !== 'string') return out;
  for (const part of v.split(',').slice(0, max * 2)) {
    const [rawKey, rawW] = part.trim().split(':');
    if (!rawKey || !re.test(rawKey)) continue;
    const key = clean(rawKey);
    if (!key) continue;
    const w = rawW === undefined ? 1 : Number(rawW);
    if (!Number.isFinite(w) || w <= 0) continue;
    out.set(key, Math.min(1000, (out.get(key) || 0) + w));
    if (out.size >= max) break;
  }
  return out;
}

/** Weights scaled so the strongest is 1. */
function normalise(map) {
  let max = 0;
  for (const w of map.values()) if (w > max) max = w;
  const out = new Map();
  if (max > 0) for (const [k, w] of map) out.set(k, w / max);
  return out;
}

const hash = (id, seed) => {
  let h = (2166136261 ^ (seed | 0)) >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

const COLS = `m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar`;
const VISIBLE = `m.publish_state = 'published' AND m.scope != 'excluded' AND (m.creator_id IS NULL OR (c.status = 'active' AND c.scope != 'excluded'))`;
const marks = (a) => a.map(() => '?').join(',');

function byCreators(ids, perCreator, type) {
  if (!ids.length) return [];
  const typeSql = type ? 'AND m.media_type = ?' : '';
  return db.prepare(`SELECT * FROM (
      SELECT ${COLS}, ROW_NUMBER() OVER (PARTITION BY m.creator_id ORDER BY m.hot DESC, m.seq DESC) AS rn
      FROM media m JOIN creators c ON c.id = m.creator_id
      WHERE m.creator_id IN (${marks(ids)}) AND ${VISIBLE} ${typeSql})
    WHERE rn <= ?`).all(...ids, ...(type ? [type] : []), perCreator);
}

function byTags(tagNames, type) {
  if (!tagNames.length) return [];
  const tagIds = db.prepare(`SELECT id FROM tags WHERE name IN (${marks(tagNames)})`).all(...tagNames).map((r) => r.id);
  if (!tagIds.length) return [];
  const typeSql = type ? 'AND m.media_type = ?' : '';
  // Walk the hot index and stop early: a broad taste can match most of the library.
  return db.prepare(`SELECT ${COLS} FROM media m INDEXED BY ix_media_pub_hot LEFT JOIN creators c ON c.id = m.creator_id
      WHERE m.id IN (SELECT media_id FROM media_tags WHERE tag_id IN (${marks(tagIds)})) AND ${VISIBLE} ${typeSql}
      ORDER BY m.hot DESC, m.seq DESC LIMIT ${TAG_POOL}`).all(...tagIds, ...(type ? [type] : []));
}

const handles = (ids) => (ids.length ? new Map(db.prepare(`SELECT id, handle FROM creators WHERE id IN (${marks(ids)})`).all(...ids).map((r) => [r.id, r.handle])) : new Map());

/** Tag-set overlap (Jaccard) between two items, for the variety penalty. */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / (a.size + b.size - n);
}

/**
 * Greedy variety re-rank: walk the scored list; each slot takes the best of the next few candidates
 * after penalising a creator's third appearance in the current page and tag repetition with the
 * last few picks.
 */
function diversify(scored, pageSize, max) {
  const out = []; const rest = scored.slice();
  let pageCreators = new Map();
  const WINDOW = 40;
  while (out.length < max && rest.length) {
    if (out.length % pageSize === 0) pageCreators = new Map();
    const recent = out.slice(-4);
    let best = -1; let bestVal = -Infinity;
    for (let i = 0; i < Math.min(WINDOW, rest.length); i++) {
      const c = rest[i];
      let v = c.score;
      const k = c.row.creator_id || c.row.id;
      if ((pageCreators.get(k) || 0) >= 2) v -= 100; // hard cap unless nothing else is left
      let o = 0;
      for (const r of recent) { const x = overlap(c.tags, r.tags); if (x > o) o = x; if (r.row.creator_id && r.row.creator_id === c.row.creator_id) o = Math.max(o, 0.6); }
      v -= 1.2 * o;
      if (v > bestVal) { bestVal = v; best = i; }
    }
    // One creator can fill the whole look-ahead (a prolific account under a broad tag): find the best
    // uncapped candidate further down before letting it take a third slot.
    const capped = (c) => (pageCreators.get(c.row.creator_id || c.row.id) || 0) >= 2;
    if (best >= 0 && capped(rest[best])) {
      for (let i = WINDOW; i < rest.length; i++) if (!capped(rest[i])) { best = i; break; }
    }
    const [pick] = rest.splice(best, 1);
    const k = pick.row.creator_id || pick.row.id;
    pageCreators.set(k, (pageCreators.get(k) || 0) + 1);
    out.push(pick);
  }
  return out;
}

function rank(t) {
  const lib = library();
  const tagW = normalise(t.tags); const creatorW = normalise(t.creators); const platW = normalise(t.platforms);
  const avoidC = t.avoidCreators; const avoidT = t.avoidTags;

  // Similar creators: neighbours of the most-liked creators, weighted by how much each was liked.
  const neighbourW = new Map(); const neighbourVia = new Map();
  const liked = [...creatorW].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [cid, w] of liked.slice(0, 10)) {
    for (const [nid, s] of sim.neighbours(lib, GENERIC_TAGS, cid, 12)) {
      if (creatorW.has(nid) || avoidC.has(nid)) continue;
      const val = s * (0.5 + 0.5 * w);
      if (val > (neighbourW.get(nid) || 0)) { neighbourW.set(nid, val); neighbourVia.set(nid, cid); }
    }
  }
  // A tag-only taste still finds creators: the ones whose profile best matches those tags.
  if (liked.length < 3 && tagW.size) {
    for (const [nid, s] of sim.creatorsForTags(lib, GENERIC_TAGS, tagW, 12)) {
      if (creatorW.has(nid) || avoidC.has(nid) || neighbourW.has(nid)) continue;
      neighbourW.set(nid, s * 0.8);
    }
  }
  const neighbourIds = [...neighbourW].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([id]) => id);

  const topTags = [...tagW].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k]) => k);
  const rows = new Map();
  for (const r of [...byCreators(liked.map(([id]) => id), LIKED_PER_CREATOR, t.type), ...byCreators(neighbourIds, SIMILAR_PER_CREATOR, t.type), ...byTags(topTags, t.type)]) {
    if (!rows.has(r.id)) rows.set(r.id, r);
  }

  const now = Date.now();
  const maxIdf = Math.max(1e-9, ...topTags.map((x) => sim.idfOf(lib, GENERIC_TAGS, x) || Math.log(2)));
  const scored = [];
  for (const r of rows.values()) {
    if (r.creator_id && avoidC.has(r.creator_id)) continue;
    const tags = new Set(String(r.tags_text || '').split(' ').filter((x) => x && !GENERIC_TAGS.has(x)));
    let score = 0; let reason = null; let best = 0;
    const cw = r.creator_id ? creatorW.get(r.creator_id) : undefined;
    if (cw !== undefined) { const v = 2.4 * (0.45 + 0.55 * cw); score += v; if (v > best) { best = v; reason = { kind: 'creator', label: 'A creator you like' }; } }
    const nw = r.creator_id ? neighbourW.get(r.creator_id) : undefined;
    if (nw !== undefined) {
      const v = 1.8 * nw; score += v;
      const via = neighbourVia.get(r.creator_id);
      if (v > best) { best = v; reason = via ? { kind: 'similar', via } : { kind: 'similar', label: 'Matches your taste' }; }
    }
    let tv = 0; let topTag = null; let topTagV = 0;
    for (const x of tags) {
      const w = tagW.get(x);
      if (w) {
        const idf = sim.idfOf(lib, GENERIC_TAGS, x) || Math.log(2);
        const v = w * (0.4 + 0.6 * Math.min(1, idf / maxIdf));
        tv += v;
        if (v > topTagV) { topTagV = v; topTag = x; }
      }
      if (avoidT.has(x)) score -= 1.6;
    }
    if (tv) {
      const v = Math.min(3, 1.5 * tv / Math.sqrt(Math.max(2, tags.size) / 2)); // long tag lists don't win by volume
      score += v;
      if (v > best) { best = v; reason = { kind: 'tag', label: `#${topTag}` }; }
    }
    if (!cw && !nw && !tv) continue; // nothing to do with this taste
    const pw = platW.get(r.platform);
    if (pw) score += 0.3 * pw;
    if (t.video !== null) score += (r.media_type === 'video' ? t.video - 0.5 : 0.5 - t.video) * 1.2;
    score += 0.45 * Math.min(1, Math.log1p(Math.max(0, r.hot || 0)) / Math.log1p(10));
    const ageDays = Math.max(0, (now - (Date.parse(r.posted_at) || now)) / 86400000);
    score += 0.35 * Math.exp(-ageDays / 10);
    score += (hash(r.id, t.seed) % 1000) / 1000 * 0.4;
    scored.push({ row: r, tags, score, reason });
  }
  scored.sort((a, b) => b.score - a.score || (b.row.seq - a.row.seq));

  // One per post (carousel siblings) and per identical picture posted twice.
  const seenPost = new Set(); const seenPic = new Set(); const unique = [];
  for (const s of scored) {
    const pk = s.row.post_key; const ph = s.row.phash;
    if ((pk && seenPost.has(pk)) || (ph && seenPic.has(ph))) continue;
    if (pk) seenPost.add(pk);
    if (ph) seenPic.add(ph);
    unique.push(s);
  }
  const pool = unique.slice(0, MAX_RANKED);
  const via = handles([...new Set(pool.map((x) => x.reason && x.reason.via).filter(Boolean))]);
  // Scored candidates, best first; the variety pass runs per request, after that request's filtering.
  return pool.map((x) => {
    let reason = x.reason ? x.reason.label : null;
    if (x.reason && x.reason.via) reason = via.get(x.reason.via) ? `Like @${via.get(x.reason.via)}` : 'Matches your taste';
    const m = repo.serializeMedia(x.row); delete m.rn; m.reason = reason;
    return { row: m, tags: x.tags, score: x.score };
  });
}

/** The items still visible right now (published, not excluded, creator active): one indexed lookup. */
function visible(items) {
  if (!items.length) return items;
  const ok = new Set();
  for (let i = 0; i < items.length; i += 500) {
    const ids = items.slice(i, i + 500).map((m) => m.id);
    for (const r of db.prepare(`SELECT m.id FROM media m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.id IN (SELECT value FROM json_each(?)) AND ${VISIBLE}`).all(JSON.stringify(ids))) ok.add(r.id);
  }
  return items.filter((m) => ok.has(m.id));
}

/* Ranked lists, per taste + seed, so scrolling pages through one stable order. */
const cache = new Map();
let TTL = process.env.NODE_ENV === 'test' ? 0 : 5 * 60000;
/** Tests only: keep ranked lists cached (to check what is filtered on the way out). */
const setCacheTtl = (ms) => { TTL = ms; cache.clear(); };
function keyOf(t) {
  const flat = (m) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, w]) => `${k}:${Math.round(w * 100)}`).join(',');
  return [flat(t.tags), flat(t.creators), flat(t.platforms), [...t.avoidTags].sort().join(','), [...t.avoidCreators].sort().join(','), t.video, t.type, t.seed, t.limit].join('|');
}

/**
 * @param t {tags, creators, platforms: Map<key, weight>, avoidTags, avoidCreators, exclude: Set,
 *           video: number|null, type, seed, page, limit}
 */
function recommend(t) {
  const page = t.page || 0; const limit = t.limit || 36;
  if (!t.tags.size && !t.creators.size) return { items: [], total: 0, page, limit, personalized: false };
  const key = keyOf(t);
  let hit = cache.get(key);
  // Later pages keep the order they started with; a first page re-ranks if the library changed.
  if (!hit || Date.now() - hit.at > TTL || (page === 0 && hit.v !== library())) {
    hit = { at: Date.now(), list: rank(t), v: library() };
    cache.delete(key);
    cache.set(key, hit);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  // The cached order is shared by every request with this taste; what this request has already
  // seen, and anything moderated since the list was built, is filtered out on the way out.
  // Variety (one creator at most twice per page, no tag runs) is applied after that filtering, so
  // removed items never squeeze two pages' worth of one creator into one.
  // Only the head of the list that this page can reach is re-checked (pages so far, plus room for
  // the variety pass to look ahead), so later pages stay cheap.
  const open = hit.list.filter((x) => !t.exclude.has(x.row.id));
  const head = open.slice(0, (page + 2) * limit + 80);
  const okIds = new Set(visible(head.map((x) => x.row)).map((m) => m.id));
  const ranked = diversify(head.filter((x) => okIds.has(x.row.id)), limit, (page + 1) * limit);
  const items = ranked.slice(page * limit).map((x) => x.row);
  return { items, total: open.length - (head.length - okIds.size), page, limit, personalized: true };
}

/**
 * Creators you might like: those most similar to the creators in your taste (weighted by how
 * much you like each), or matching your tags when you have no favourites yet. Excludes creators
 * you already like, follow or asked to see less of.
 */
function creatorsForYou(t, limit = 12) {
  const lib = library();
  const creatorW = normalise(t.creators); const tagW = normalise(t.tags);
  const score = new Map(); const via = new Map();
  for (const [cid, w] of [...creatorW].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    for (const [nid, s] of sim.neighbours(lib, GENERIC_TAGS, cid, 20)) {
      if (creatorW.has(nid) || t.avoidCreators.has(nid) || t.exclude.has(nid)) continue;
      const v = s * (0.4 + 0.6 * w);
      score.set(nid, (score.get(nid) || 0) + v);
      if (!via.has(nid) || v > via.get(nid)[1]) via.set(nid, [cid, v]);
    }
  }
  if (tagW.size) {
    for (const [nid, s] of sim.creatorsForTags(lib, GENERIC_TAGS, tagW, 40)) {
      if (creatorW.has(nid) || t.avoidCreators.has(nid) || t.exclude.has(nid)) continue;
      score.set(nid, (score.get(nid) || 0) + 0.6 * s);
    }
  }
  const top = [...score].sort((a, b) => b[1] - a[1]).slice(0, limit * 2).map(([id]) => id);
  if (!top.length) return [];
  const found = db.prepare(`${repo.SELECT_CREATOR_CARD} WHERE c.id IN (${marks(top)}) AND c.status = 'active' AND c.scope != 'excluded' AND c.media_count > 0`).all(...top).map(repo.serializeCreator);
  found.sort((a, b) => top.indexOf(a.id) - top.indexOf(b.id));
  const names = handles([...new Set(found.map((c) => via.get(c.id) && via.get(c.id)[0]).filter(Boolean))]);
  return found.slice(0, limit).map((c) => {
    const v = via.get(c.id);
    return { ...c, reason: v && names.get(v[0]) ? `Like @${names.get(v[0])}` : 'Matches your taste' };
  });
}

const TAG_RE = /^[\p{L}\p{N}-]{2,40}$/u;
const UUID = /^[0-9a-f-]{36}$/i;
/** Taste from query parameters (see public/js/store.js tastes.query()). Hostile input is dropped. */
function tasteFromQuery(q, { clampInt }) {
  const set = (v, re, max) => new Set(typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter((x) => re.test(x)).slice(0, max) : []);
  const video = q.video !== undefined && q.video !== '' && Number.isFinite(Number(q.video)) ? Math.min(1, Math.max(0, Number(q.video))) : null;
  return {
    tags: parseWeighted(q.tags, TAG_RE, 24, cleanTag),
    creators: parseWeighted(q.creators, UUID, 40),
    platforms: parseWeighted(q.platforms, /^[a-z]{2,20}$/, 8),
    avoidTags: new Set([...set(q.avoid_tags, TAG_RE, 30)].map(cleanTag)),
    avoidCreators: set(q.avoid_creators, UUID, 100),
    exclude: set(q.exclude, UUID, 200),
    video,
    type: q.type === 'image' || q.type === 'video' ? q.type : undefined,
    seed: clampInt(q.seed, 0, 2147483647, 1),
    page: clampInt(q.page, 0, 1000, 0),
    limit: clampInt(q.limit, 1, 60, 36),
  };
}

module.exports = { recommend, creatorsForYou, tasteFromQuery, parseWeighted, diversify, setCacheTtl };
