'use strict';
/**
 * "More like this" by look: visually similar posts from PRISM's own library, across every source.
 *
 *   store     one vector per item in `media_embeddings` (lib/embeddings: DIM int8 + a scale, model-tagged so a new model
 *             re-embeds). A picture that cannot be fetched gets a 'fail' row and is retried after FAIL_RETRY_DAYS.
 *   backfill  a slow background loop embeds published items without a vector, newest first, PER_TICK a minute on the
 *             image workers (niced threads), so new posts are searchable within minutes and the old library fills in.
 *   index     all vectors in one Int8Array in memory (DIM + a few floats per item: ~26 MB per 100k items), built lazily and
 *             appended to as the backfill runs. Similarity is cosine after centring on the library mean, which removes the
 *             "every photo is a photo" direction that would otherwise make everything look alike; the centring is folded
 *             into per-item constants, so a query stays one int8 dot product per item.
 *   query     `similar(id)`: the nearest items, at most two per creator, never the same post, only what is visible now;
 *             `similarCreators(id)`: creators whose pictures, on average, look like his.
 *
 * Search by look only: no face or identity model takes part.
 */
const repo = require('../db/repo');
const events = require('./events');
const emb = require('../lib/embeddings');
const imagefilter = require('../lib/imagefilter');

const { db } = repo;
const { DIM, MODEL_ID } = emb;
const PER_TICK = Math.max(0, parseInt(process.env.VISUAL_EMBED_PER_MIN ?? '40', 10) || 0);
const FAIL_RETRY_DAYS = 14;
const MIN_INDEX = 20; // below this, similarity says little: callers fall back to tag-based related posts

let ready = false;
function ensureTable() {
  if (ready) return;
  // Kept here rather than in a numbered migration: the table belongs to this feature alone and nothing else joins on it.
  db.exec(`CREATE TABLE IF NOT EXISTS media_embeddings (
      media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      vec BLOB,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
  ready = true;
}

/* ------------------------------------------------------------------ index */
let ix = null;
function emptyIndex(cap = 1024) {
  return { n: 0, cap, ids: [], creators: [], posts: [], row: new Map(), q: new Int8Array(cap * DIM), scale: new Float32Array(cap), mean: null, meanN: 0, done: 0, dm: null, nc: null, mm: 0, dirty: true };
}
function grow(x) {
  const cap = x.cap * 2;
  const q = new Int8Array(cap * DIM); q.set(x.q); x.q = q;
  const sc = new Float32Array(cap); sc.set(x.scale); x.scale = sc;
  x.cap = cap;
}
function addTo(x, id, creatorId, postKey, vec) {
  const u = emb.unpack(vec);
  if (!u || x.row.has(id)) return;
  if (x.n >= x.cap) grow(x);
  x.q.set(u.q, x.n * DIM); x.scale[x.n] = u.scale;
  x.ids.push(id); x.creators.push(creatorId || null); x.posts.push(postKey || null); x.row.set(id, x.n);
  x.n++; x.dirty = true;
}
/**
 * Library mean and the per-item constants for centred cosine: dm_i = a_i·m, nc_i = |a_i - m|². The mean is recomputed only
 * once the index has grown by a twentieth since; rows added in between get their constants against the current mean.
 */
function finish(x) {
  if (!x.dirty) return;
  const full = !x.mean || x.n > x.meanN * 1.05 + 10;
  if (full) {
    const mean = new Float64Array(DIM);
    for (let i = 0; i < x.n; i++) { const s = x.scale[i]; const o = i * DIM; for (let j = 0; j < DIM; j++) mean[j] += s * x.q[o + j]; }
    for (let j = 0; j < DIM; j++) mean[j] /= Math.max(1, x.n);
    let mm = 0; for (let j = 0; j < DIM; j++) mm += mean[j] * mean[j];
    Object.assign(x, { mean, mm, meanN: x.n, done: 0 });
  }
  if (!x.dm || x.dm.length < x.cap) {
    const dm = new Float32Array(x.cap); const nc = new Float32Array(x.cap);
    if (x.dm && !full) { dm.set(x.dm); nc.set(x.nc); }
    x.dm = dm; x.nc = nc;
  }
  for (let i = full ? 0 : x.done; i < x.n; i++) {
    const s = x.scale[i]; const o = i * DIM; let d = 0; let aa = 0;
    for (let j = 0; j < DIM; j++) { const a = s * x.q[o + j]; d += a * x.mean[j]; aa += a * a; }
    x.dm[i] = d; x.nc[i] = Math.max(1e-9, aa - 2 * d + x.mm);
  }
  x.done = x.n; x.dirty = false;
}
function index() {
  ensureTable();
  if (!ix) {
    const x = emptyIndex();
    for (const r of db.prepare(`SELECT e.media_id, e.vec, m.creator_id, m.post_key FROM media_embeddings e JOIN media m ON m.id = e.media_id
        WHERE e.model = ? AND m.publish_state = 'published' ORDER BY m.seq`).iterate(MODEL_ID)) addTo(x, r.media_id, r.creator_id, r.post_key, r.vec);
    ix = x;
  }
  finish(ix);
  return ix;
}

/* ------------------------------------------------------------------ query */
const COLS = 'm.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar';
const VISIBLE = "m.publish_state = 'published' AND m.scope != 'excluded' AND (m.creator_id IS NULL OR (c.status = 'active' AND c.scope != 'excluded'))";

/** Nearest neighbours of row `r` in index `x`, best first: [[row, similarity], …]. */
function nearest(x, r, k) {
  const { q } = x; const v = q.slice(r * DIM, r * DIM + DIM); const qs = x.scale[r]; const qdm = x.dm[r]; const qn = x.nc[r];
  const top = []; let floor = -Infinity;
  for (let i = 0; i < x.n; i++) {
    if (i === r) continue;
    const o = i * DIM; let d0 = 0; let d1 = 0; let d2 = 0; let d3 = 0;
    for (let j = 0; j < DIM; j += 4) { d0 += q[o + j] * v[j]; d1 += q[o + j + 1] * v[j + 1]; d2 += q[o + j + 2] * v[j + 2]; d3 += q[o + j + 3] * v[j + 3]; }
    const d = d0 + d1 + d2 + d3;
    const sim = (qs * x.scale[i] * d - qdm - x.dm[i] + x.mm) / Math.sqrt(qn * x.nc[i]);
    if (top.length < k) { top.push([i, sim]); if (top.length === k) { top.sort((a, b) => a[1] - b[1]); floor = top[0][1]; } }
    else if (sim > floor) {
      // replace the weakest, keep ascending order
      let p = 0; while (p + 1 < k && top[p + 1][1] < sim) { top[p] = top[p + 1]; p++; }
      top[p] = [i, sim]; floor = top[0][1];
    }
  }
  return top.sort((a, b) => b[1] - a[1]);
}

// Caches only the index's answer (neighbour ids), never the rows: visibility is checked against the database on every
// request, so a post hidden or a creator blocked after the first lookup drops out at once.
const cache = new Map();
/**
 * Visually similar posts to media `id`. Returns null when this item has no vector yet (or the index is too small), so
 * the caller can fall back to tag-based "related"; otherwise serialized media rows with `similarity` (0..1).
 */
function similar(id, limit = 12) {
  const x = index();
  const r = x.row.get(id);
  if (r === undefined || x.n < MIN_INDEX) return null;
  const key = `${id}|${limit}|${x.n}`;
  let picked = cache.get(key);
  if (!picked) {
    const cands = nearest(x, r, Math.min(x.n - 1, limit * 6 + 20));
    const post = x.posts[r];
    const per = new Map(); const posts = new Set(post ? [post] : []);
    picked = [];
    for (const [i, s] of cands) {
      const c = x.creators[i]; const pk = x.posts[i];
      if (pk && posts.has(pk)) continue;
      if (c && (per.get(c) || 0) >= 2) continue;
      picked.push([x.ids[i], s]);
      if (pk) posts.add(pk);
      if (c) per.set(c, (per.get(c) || 0) + 1);
      if (picked.length >= limit * 2) break;
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, picked);
  }
  const ids = picked.map(([mid]) => mid);
  const rows = ids.length ? db.prepare(`SELECT ${COLS} FROM media m LEFT JOIN creators c ON c.id = m.creator_id WHERE m.id IN (SELECT value FROM json_each(?)) AND ${VISIBLE}`).all(JSON.stringify(ids)) : [];
  const byId = new Map(rows.map((m) => [m.id, m]));
  return picked.filter(([mid]) => byId.has(mid)).slice(0, limit).map(([mid, s]) => ({ ...repo.serializeMedia(byId.get(mid)), similarity: Math.round(Math.max(0, s) * 1000) / 1000 }));
}

/**
 * Each creator's look: the centred mean of his pictures' vectors, unit length. Rebuilt from the index at most every
 * PROFILE_MS (a few hundred ms per 100k items); creators with fewer than MIN_PICS pictures have no profile.
 */
const PROFILE_MS = 10 * 60000; const MIN_PICS = 3;
let profiles = null;
function creatorProfiles(x) {
  if (profiles && profiles.ix === x && Date.now() - profiles.at < PROFILE_MS) return profiles;
  const sums = new Map(); const counts = new Map();
  for (let i = 0; i < x.n; i++) {
    const c = x.creators[i];
    if (!c) continue;
    let s = sums.get(c);
    if (!s) { s = new Float32Array(DIM); sums.set(c, s); counts.set(c, 0); }
    const sc = x.scale[i]; const o = i * DIM;
    for (let j = 0; j < DIM; j++) s[j] += sc * x.q[o + j] - x.mean[j];
    counts.set(c, counts.get(c) + 1);
  }
  const vecs = new Map();
  for (const [c, s] of sums) {
    if (counts.get(c) < MIN_PICS) continue;
    let ss = 0; for (let j = 0; j < DIM; j++) ss += s[j] * s[j];
    const n = Math.sqrt(ss); if (!n) continue;
    for (let j = 0; j < DIM; j++) s[j] /= n;
    vecs.set(c, s);
  }
  profiles = { ix: x, at: Date.now(), vecs };
  return profiles;
}

/**
 * Creators whose pictures look like this creator's (setting, framing, build, style), as [[creatorId, similarity], …]
 * strongest first; null when he has no look profile yet. The caller fetches and filters the creator cards.
 */
function similarCreators(id, k = 24) {
  const x = index();
  if (x.n < MIN_INDEX) return null;
  const { vecs } = creatorProfiles(x);
  const me = vecs.get(id);
  if (!me) return null;
  const out = [];
  for (const [c, v] of vecs) {
    if (c === id) continue;
    let d = 0; for (let j = 0; j < DIM; j++) d += me[j] * v[j];
    out.push([c, d]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, k);
}

/* ---------------------------------------------------------------- backfill */
function pending(limit) {
  ensureTable();
  const retry = new Date(Date.now() - FAIL_RETRY_DAYS * 86400000).toISOString();
  return db.prepare(`SELECT m.id, m.media_type, m.media_url, m.preview_url, m.thumbnail_url, m.source_url, m.creator_id, m.post_key FROM media m
      WHERE m.publish_state = 'published' AND m.scope != 'excluded'
        AND NOT EXISTS (SELECT 1 FROM media_embeddings e WHERE e.media_id = m.id AND (e.model = ? OR (e.model = 'fail' AND e.created_at > ?)))
      ORDER BY m.seq DESC LIMIT ?`).all(MODEL_ID, retry, limit);
}

const save = () => db.prepare(`INSERT INTO media_embeddings (media_id, model, vec) VALUES (?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET model = excluded.model, vec = excluded.vec, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
const counters = { embedded: 0, failed: 0 };

/** Embed up to `limit` items that have no vector. @returns {Promise<{embedded, failed, unavailable?}>} */
async function backfill(limit = PER_TICK) {
  const rows = pending(limit);
  const stmt = save();
  const res = { embedded: 0, failed: 0 };
  for (const m of rows) {
    const url = imagefilter.imageUrlOf({ mediaType: m.media_type, mediaUrl: m.media_url, previewUrl: m.preview_url, thumbnailUrl: m.thumbnail_url });
    if (!url) { stmt.run(m.id, 'fail', null); res.failed++; continue; }
    let referer;
    try { referer = `${new URL(m.source_url || url).origin}/`; } catch { /* none */ }
    const r = await imagefilter.embedUrl(url, { referer });
    if (r.status === 'unavailable') { res.unavailable = r.reason; break; }
    if (r.status !== 'ok' || !emb.unpack(r.vec)) { stmt.run(m.id, 'fail', null); res.failed++; continue; }
    stmt.run(m.id, MODEL_ID, r.vec);
    if (ix) addTo(ix, m.id, m.creator_id, m.post_key, r.vec);
    res.embedded++;
  }
  counters.embedded += res.embedded; counters.failed += res.failed;
  return res;
}

let timer = null; let busy = false; let gaveUp = false;
function start() {
  if (timer || !PER_TICK) return;
  timer = setInterval(async () => {
    if (busy || gaveUp) return;
    busy = true;
    try {
      const r = await backfill(PER_TICK);
      if (r.unavailable) { gaveUp = true; events.log('WARN', `Visual search: image model unavailable (${r.unavailable}); "More like this" uses tags only`); }
    } catch (e) { events.log('WARN', `Visual search backfill: ${e.message}`); } finally { busy = false; }
  }, 60 * 1000);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

function status() {
  ensureTable();
  const done = db.prepare('SELECT COUNT(*) AS n FROM media_embeddings WHERE model = ?').get(MODEL_ID).n;
  return { model: MODEL_ID, embedded: done, indexed: ix ? ix.n : null, ...counters, perMinute: PER_TICK };
}

/** Tests: forget the in-memory index and cached answers. */
function _reset() { ix = null; profiles = null; cache.clear(); }

module.exports = { similar, similarCreators, backfill, start, stop, status, ensureTable, _reset, _nearest: nearest, _index: index };
