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
const INLINE = !!require('../config').isTest || require('../config').dbPath === ':memory:';
const slice = (label, fn) => { let out; const bw = require('../lib/blockwatch'); if (bw && bw.slice) bw.slice(label, () => { out = fn(); }); else out = fn(); return out; };
const turn = () => new Promise((r) => setTimeout(r, 0)); // a timer, not setImmediate: queued requests and health probes run first
const SLICE_MS = 25;
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
function finish(x, { allowFull = true } = {}) {
  if (!x.dirty) return;
  // A full re-mean costs one pass over every vector: at library scale that is seconds of sync work.
  // 25% growth between full passes (was 5%) keeps the incremental path (constants against the
  // current mean) doing nearly all the work; a recommender does not need a fresher mean than that.
  // On the request path (allowFull false) a due re-mean is handed to refreshAsync() and the new rows get constants against the
  // current mean meanwhile: the full pass is never synchronous on a large index.
  const due = !x.mean || x.n > x.meanN * 1.25 + 50;
  const full = due && (allowFull || !x.mean);
  if (due && !full) refreshAsync(x);
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
/**
 * The index for a request. In production it is never built here: before the boot build (warmIndex) has finished this kicks it off
 * and returns null, and the caller answers from tags instead. A synchronous build was a whole pass over every vector on the request
 * path, the first 'More like this' after a deploy paid it, and so did the event loop. Tests and :memory: build inline.
 */
function index() {
  ensureTable();
  if (!ix) {
    if (!INLINE) { warmIndex().catch((e) => events.log('WARN', `Visual index: ${e.message}`)); return null; }
    const x = emptyIndex();
    for (const r of db.prepare(`SELECT e.media_id, e.vec, m.creator_id, m.post_key FROM media_embeddings e JOIN media m ON m.id = e.media_id
        WHERE e.model = ? AND m.publish_state = 'published' ORDER BY m.seq`).iterate(MODEL_ID)) addTo(x, r.media_id, r.creator_id, r.post_key, r.vec);
    ix = x;
  }
  finish(ix, { allowFull: INLINE });
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
  if (!x) return null; // still building: tag-based related posts answer
  const r = x.row.get(id);
  if (r === undefined || x.n < MIN_INDEX) return null;
  const key = `${id}|${limit}|${x.n}`;
  let picked = cache.get(key);
  if (!picked) {
    const cands = slice('visual:nearest', () => nearest(x, r, Math.min(x.n - 1, limit * 6 + 20))); // one pass over every vector
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
let profilesBuilding = null;
/** The profiles for index `x`: the current set, or the stale one (or null) while a fresh set is built in slices in the background. */
function creatorProfiles(x) {
  const fresh = profiles && profiles.ix === x && Date.now() - profiles.at < PROFILE_MS;
  if (fresh) return profiles;
  if (INLINE) { profiles = buildProfilesSync(x); return profiles; }
  if (!profilesBuilding) profilesBuilding = buildProfiles(x).then((p) => { profiles = p; }).catch((e) => events.log('WARN', `Visual profiles: ${e.message}`)).finally(() => { profilesBuilding = null; });
  return profiles && profiles.ix === x ? profiles : null;
}
function addProfileRows(x, sums, counts, from, to) {
  for (let i = from; i < to; i++) {
    const c = x.creators[i];
    if (!c) continue;
    let s = sums.get(c);
    if (!s) { s = new Float32Array(DIM); sums.set(c, s); counts.set(c, 0); }
    const sc = x.scale[i]; const o = i * DIM;
    for (let j = 0; j < DIM; j++) s[j] += sc * x.q[o + j] - x.mean[j];
    counts.set(c, counts.get(c) + 1);
  }
}
function normaliseProfiles(sums, counts) {
  const vecs = new Map();
  for (const [c, s] of sums) {
    if (counts.get(c) < MIN_PICS) continue;
    let ss = 0; for (let j = 0; j < DIM; j++) ss += s[j] * s[j];
    const n = Math.sqrt(ss); if (!n) continue;
    for (let j = 0; j < DIM; j++) s[j] /= n;
    vecs.set(c, s);
  }
  return vecs;
}
function buildProfilesSync(x) {
  const sums = new Map(); const counts = new Map();
  addProfileRows(x, sums, counts, 0, x.n);
  return { ix: x, at: Date.now(), vecs: normaliseProfiles(sums, counts) };
}
/** The same pass in time-sized row slices with a turn of the loop between them. Rows are only ever appended, so 0..n stays valid. */
async function buildProfiles(x) {
  const sums = new Map(); const counts = new Map();
  const n = x.n; const mean = x.mean; let rows = 2000;
  for (let i = 0; i < n;) {
    const to = Math.min(n, i + rows);
    const t = Date.now();
    slice('visual:profiles', () => addProfileRows({ ...x, mean }, sums, counts, i, to));
    rows = sized(rows, Date.now() - t, to - i); i = to;
    await turn();
  }
  return { ix: x, at: Date.now(), vecs: slice('visual:profiles', () => normaliseProfiles(sums, counts)) };
}

/**
 * Creators whose pictures look like this creator's (setting, framing, build, style), as [[creatorId, similarity], …]
 * strongest first; null when he has no look profile yet. The caller fetches and filters the creator cards.
 */
function similarCreators(id, k = 24) {
  const x = index();
  if (!x || x.n < MIN_INDEX) return null;
  const p = creatorProfiles(x);
  if (!p) return null; // the profiles are being built in the background: the posting-style answer stands in
  const { vecs } = p;
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
/**
 * The items that still need a picture, newest first.
 *
 * media.seq is the INTEGER PRIMARY KEY (the rowid), so "newest first" is a backward walk of the table with no sort.
 * One walk from the top every minute still re-read every already-embedded row first: with the top 300k done that was
 * 2.5-3.5 s on the main thread per tick. So the walk keeps a cursor:
 *   - rows above `top` (inserted since the last call) are read first, every call;
 *   - then the walk resumes at `cursor`, downward, at most WINDOWS windows of WINDOW rowids per call;
 *   - at the bottom it rests REST_MS and then starts again from the top. That later pass is what picks up a failure
 *     whose retry is due, or a row published after the walk passed it.
 * A call can return fewer than `limit` rows (or none) while the walk crosses an embedded stretch; the next call goes on.
 */
const WINDOW_SQL = `SELECT m.rowid AS rid, m.id, m.media_type, m.media_url, m.preview_url, m.thumbnail_url, m.source_url, m.creator_id, m.post_key
    FROM media m NOT INDEXED
    WHERE m.publish_state = 'published' AND m.scope != 'excluded'
      AND NOT EXISTS (SELECT 1 FROM media_embeddings e WHERE e.media_id = m.id AND (e.model = ? OR (e.model = 'fail' AND e.created_at > ?)))
      AND m.rowid > ? AND m.rowid <= ?
    ORDER BY m.rowid DESC LIMIT ?`;
const REST_MS = 60 * 60 * 1000;
let scan = null;
const scanStats = { windows: 0 };
function resetScan({ window = 5000, windows = 2 } = {}) { scan = { top: null, cursor: 0, restUntil: 0, window, windows }; }
resetScan();

function pending(limit) {
  ensureTable();
  const retry = new Date(Date.now() - FAIL_RETRY_DAYS * 86400000).toISOString();
  const stmt = db.prepare(WINDOW_SQL);
  const max = db.prepare('SELECT MAX(rowid) AS r FROM media').get().r || 0;
  if (scan.top === null || max < scan.top) { scan.top = max; scan.cursor = max; scan.restUntil = 0; }
  const out = [];
  // New rows first. The top only moves past rows that were all handed out, and stays below the ones handed out, so a
  // pass that stops early (model unavailable) sees them again.
  if (max > scan.top) {
    const fresh = stmt.all(MODEL_ID, retry, scan.top, max, limit);
    scanStats.windows++;
    out.push(...fresh);
    scan.top = fresh.length >= limit ? scan.top : fresh.length ? fresh[fresh.length - 1].rid - 1 : max;
  }
  if (out.length < limit && Date.now() >= scan.restUntil) {
    if (scan.cursor <= 0) scan.cursor = scan.top; // the rest is over: a new pass from the top
    for (let w = 0; w < scan.windows && out.length < limit; w++) {
      const lo = Math.max(0, scan.cursor - scan.window);
      const rows = stmt.all(MODEL_ID, retry, lo, scan.cursor, limit - out.length);
      scanStats.windows++;
      out.push(...rows);
      if (out.length >= limit) { scan.cursor = rows[0].rid; break; } // resume at these rows (inclusive) next time
      scan.cursor = lo;
      if (lo === 0) { scan.restUntil = Date.now() + REST_MS; break; }
    }
  }
  return out;
}

const save = () => db.prepare(`INSERT INTO media_embeddings (media_id, model, vec) VALUES (?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET model = excluded.model, vec = excluded.vec, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
const counters = { embedded: 0, failed: 0 };

function storeOne(m, r, stmt) {
  if (r.status !== 'ok' || !emb.unpack(r.vec)) { stmt.run(m.id, 'fail', null); return false; }
  stmt.run(m.id, MODEL_ID, r.vec);
  if (ix) addTo(ix, m.id, m.creator_id, m.post_key, r.vec);
  return true;
}
/** Embed up to `limit` items that have no vector. @returns {Promise<{embedded, failed, unavailable?}>} */
async function backfill(limit = PER_TICK) {
  const rows = pending(limit);
  const stmt = save();
  const res = { embedded: 0, failed: 0 };
  // Attribution honesty: the 'embed' watchdog tag must only cover THIS job's synchronous work.
  // Each item's network+model await yields the loop, so while we wait, the tag goes idle — any
  // block during the wait belongs to whatever actually ran (a request, another job), not to us.
  const bw = (() => { try { return require('./blockwatch'); } catch { return null; } })();
  for (const m of rows) {
    const url = imagefilter.imageUrlOf({ mediaType: m.media_type, mediaUrl: m.media_url, previewUrl: m.preview_url, thumbnailUrl: m.thumbnail_url });
    if (!url) { stmt.run(m.id, 'fail', null); res.failed++; continue; }
    let referer;
    try { referer = `${new URL(m.source_url || url).origin}/`; } catch { /* none */ }
    if (bw) bw.work('idle');
    const r = await imagefilter.embedUrl(url, { referer });
    if (bw) bw.work('embed');
    if (r.status === 'unavailable') { res.unavailable = r.reason; break; }
    // the synchronous work of one result under its own name (the awaits above are not ours): unpack, store, add to the index
    let stored = false;
    if (bw && bw.slice) bw.slice('embed:store', () => { stored = storeOne(m, r, stmt); }); else stored = storeOne(m, r, stmt);
    if (stored) res.embedded++; else res.failed++;
  }
  counters.embedded += res.embedded; counters.failed += res.failed;
  return res;
}

let timer = null; let busy = false; let gaveUp = false;
function start() {
  if (timer || !PER_TICK) return;
  const blockwatch = require('../lib/blockwatch');
  timer = setInterval(async () => {
    if (busy || gaveUp || !require('../lib/duty').modelSweepOpen()) return;
    blockwatch.work('embed');
    busy = true;
    try {
      const r = await backfill(PER_TICK);
      if (r.unavailable) { gaveUp = true; events.log('WARN', `Visual search: image model unavailable (${r.unavailable}); "More like this" uses tags only`); }
    } catch (e) { events.log('WARN', `Visual search backfill: ${e.message}`); } finally { busy = false; blockwatch.work('idle'); }
  }, 60 * 1000);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

function status() {
  ensureTable();
  const done = db.prepare('SELECT COUNT(*) AS n FROM media_embeddings WHERE model = ?').get(MODEL_ID).n;
  return { model: MODEL_ID, embedded: done, indexed: ix ? ix.n : null, ...counters, perMinute: PER_TICK };
}

/**
 * Build the in-memory index once, at boot (called from the warm-up after the first health answer), so the first
 * "More like this" visitor does not pay the cold build. Chunked and yielding: on a library with hundreds of
 * thousands of vectors the synchronous build was one uninterrupted multi-second-to-minutes block right after
 * boot (the ~119 s deploy stall). Measured on 150k media / 51.6k vectors: cold build 333 ms, first similar
 * request 477 ms, second 42 ms. Revisit moving this to the aggregate worker only if production passes ~150k rows
 * AND the chunked build still shows up in blockwatch.
 */
// One statement reads at most this many rowids of media (the cap; each read is sized by time below it). The old single query sorted every published row (with its
// vector) in a temporary B-tree before returning the first one: one synchronous step of minutes on a large library.
const WARM_WINDOW = 20000;

/** Next slice size (rows) from the last one's time, aiming at SLICE_MS: grows at most 2x, shrinks at once. */
function sized(rows, ms, done) {
  if (!done) return rows;
  return Math.max(200, Math.min(200000, Math.round(Math.min(rows * 2, done * SLICE_MS / Math.max(ms, 1)))));
}

/**
 * The full re-mean of `x` and its per-row constants, in row slices with a turn of the loop between them, installed in one step at
 * the end (requests keep using the old mean and constants until then). Rows appended meanwhile get their constants on the next
 * finish(), against the new mean. One at a time.
 */
let refreshing = null;
function refreshAsync(x) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const n = x.n;
    const mean = new Float64Array(DIM);
    let rows = 2000;
    for (let i = 0; i < n;) {
      const to = Math.min(n, i + rows); const t = Date.now();
      slice('visual:mean', () => { for (let k = i; k < to; k++) { const sc = x.scale[k]; const o = k * DIM; for (let j = 0; j < DIM; j++) mean[j] += sc * x.q[o + j]; } });
      rows = sized(rows, Date.now() - t, to - i); i = to;
      await turn();
    }
    for (let j = 0; j < DIM; j++) mean[j] /= Math.max(1, n);
    let mm = 0; for (let j = 0; j < DIM; j++) mm += mean[j] * mean[j];
    const dm = new Float32Array(Math.max(x.cap, n)); const nc = new Float32Array(Math.max(x.cap, n));
    rows = 2000;
    for (let i = 0; i < n;) {
      const to = Math.min(n, i + rows); const t = Date.now();
      slice('visual:centre', () => {
        for (let k = i; k < to; k++) {
          const sc = x.scale[k]; const o = k * DIM; let d = 0; let aa = 0;
          for (let j = 0; j < DIM; j++) { const a = sc * x.q[o + j]; d += a * mean[j]; aa += a * a; }
          dm[k] = d; nc[k] = Math.max(1e-9, aa - 2 * d + mm);
        }
      });
      rows = sized(rows, Date.now() - t, to - i); i = to;
      await turn();
    }
    // install in one step; rows n..x.n (added while this ran) are done by the next finish(), incrementally
    if (dm.length < x.cap) { const d2 = new Float32Array(x.cap); d2.set(dm); const n2 = new Float32Array(x.cap); n2.set(nc); Object.assign(x, { dm: d2, nc: n2 }); }
    else Object.assign(x, { dm, nc });
    Object.assign(x, { mean, mm, meanN: n, done: n, dirty: x.n > n });
    cache.clear();
    return x;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * Build the in-memory index once, at boot (called from the warm-up after the first health answer), so the first "More like this"
 * visitor does not pay the cold build. Every step is a time-sized slice with a turn of the loop between them, named for blockwatch:
 *   visual:load    a range of media rows (by seq) joined to their vectors, appended to a preallocated index (no doubling copies)
 *   visual:mean    the library mean, a slice of rows at a time
 *   visual:centre  the per-row constants for centred cosine, a slice of rows at a time
 * The finished index is installed in one step; until then index() returns null and callers answer from tags. The old build
 * ran the mean and constants (two passes over every vector) in one synchronous finish() at the end: 2-4.8 s blocks after deploys
 * on prod, with no timed culprit, while warm:visualIndex was pending.
 */
let building = null;
function warmIndex() {
  if (ix && !ix.dirty) return Promise.resolve(ix.n);
  if (building) return building;
  building = (async () => {
    ensureTable();
    if (!ix) {
      const expect = slice('visual:load', () => db.prepare('SELECT COUNT(*) AS n FROM media_embeddings WHERE model = ?').get(MODEL_ID).n);
      const x = emptyIndex(Math.max(1024, Math.ceil(expect * 1.05)));
      const stmt = db.prepare(`SELECT e.media_id, e.vec, m.creator_id, m.post_key FROM media m NOT INDEXED CROSS JOIN media_embeddings e
          WHERE m.seq > ? AND m.seq <= ? AND e.media_id = m.id AND e.model = ? AND m.publish_state = 'published' ORDER BY m.seq`);
      let top = (db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0;
      let span = 1000; let perSeq = 0;
      for (let from = 0; ;) {
        const to = Math.min(from + span, top);
        const t = Date.now();
        slice('visual:load', () => { for (const r of stmt.iterate(from, to, MODEL_ID)) addTo(x, r.media_id, r.creator_id, r.post_key, r.vec); });
        const ms = Date.now() - t;
        perSeq = Math.max(ms / Math.max(to - from, 1), perSeq * 0.97); // follows the slowest recent stretch: a cold region stays small
        from = to;
        if (from >= top) { top = (db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0; if (from >= top) break; }
        span = Math.max(200, Math.min(WARM_WINDOW, Math.round(SLICE_MS / Math.max(perSeq, 0.0005))));
        await turn();
      }
      if (x.n) await refreshAsync(x);
      else finish(x);
      ix = x;
    } else if (ix.dirty) {
      await refreshAsync(ix);
    }
    finish(ix, { allowFull: false }); // rows the backfill added meanwhile: incremental
    return ix.n;
  })().finally(() => { building = null; });
  return building;
}

/** Tests: forget the in-memory index and cached answers. */
function _reset() { ix = null; profiles = null; building = null; refreshing = null; profilesBuilding = null; cache.clear(); resetScan(); }

module.exports = { _refreshAsync: refreshAsync, _finish: finish, _WINDOW_SQL: WINDOW_SQL, _resetScan: resetScan, _scanStats: () => ({ ...scanStats }), similar, similarCreators, backfill, start, stop, status, ensureTable, warmIndex, _reset, _nearest: nearest, _index: index, _pending: pending, _MODEL_ID: MODEL_ID };
