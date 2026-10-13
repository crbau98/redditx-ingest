'use strict';
/**
 * Creator similarity from the library snapshot (repo.library()): each creator is a tf-idf vector
 * over the style tags on their published media, compared by cosine similarity through an inverted
 * index (tag → creators), so finding one creator's neighbours touches only creators sharing a tag
 * with them. Built lazily once per snapshot and kept with it; no per-request aggregation.
 */

const perLib = new WeakMap(); // library snapshot → index

/** Tags that say where or what platform, not what a creator looks like or posts. */
function isStyleTag(tag, generic) { return !generic.has(tag); }

function build(lib, generic) {
  const creators = lib.creatorTags;
  const C = creators.size || 1;
  const df = new Map();
  for (const tags of creators.values()) for (const t of tags.keys()) if (isStyleTag(t, generic)) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map();
  // A tag nearly everyone carries says little; one only this creator carries says nothing to compare with.
  for (const [t, n] of df) if (n >= 2) idf.set(t, Math.log(1 + C / n));
  const vecs = new Map(); const norms = new Map(); const postings = new Map();
  for (const [cid, tags] of creators) {
    const v = new Map(); let ss = 0;
    for (const [t, n] of tags) {
      const w = idf.get(t);
      if (!w) continue;
      const x = (1 + Math.log(n)) * w;
      v.set(t, x); ss += x * x;
    }
    if (!v.size) continue;
    vecs.set(cid, v); norms.set(cid, Math.sqrt(ss));
    // Every creator has a profile to compare from, but only those that may be shown can be found as
    // a neighbour, so hidden or excluded creators never take one of the top-k slots.
    if (lib.visibleCreators && !lib.visibleCreators.has(cid)) continue;
    for (const [t, x] of v) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([cid, x]); }
  }
  return { vecs, norms, postings, idf, neighbours: new Map() };
}

function indexFor(lib, generic) {
  let ix = perLib.get(lib);
  if (!ix) { ix = build(lib, generic); perLib.set(lib, ix); }
  return ix;
}

/** Cosine similarity of a sparse tag vector against every creator sharing a tag with it. */
function scoreVector(ix, vec, { skip } = {}) {
  let ss = 0;
  for (const x of vec.values()) ss += x * x;
  const norm = Math.sqrt(ss);
  if (!norm) return new Map();
  const dot = new Map();
  for (const [t, x] of vec) {
    const list = ix.postings.get(t);
    if (!list) continue;
    for (const [cid, y] of list) if (cid !== skip) dot.set(cid, (dot.get(cid) || 0) + x * y);
  }
  for (const [cid, d] of dot) dot.set(cid, d / (norm * ix.norms.get(cid)));
  return dot;
}

/**
 * The `k` creators most like `cid`, as [[id, similarity 0..1], …] strongest first.
 * Cached per snapshot (the snapshot is rebuilt after writes, at most once a minute).
 */
function neighbours(lib, generic, cid, k = 20, minSim = 0.05) {
  const ix = indexFor(lib, generic);
  const key = `${cid}|${k}`;
  if (ix.neighbours.has(key)) return ix.neighbours.get(key);
  const v = ix.vecs.get(cid);
  const out = v ? [...scoreVector(ix, v, { skip: cid })].filter(([, s]) => s >= minSim).sort((a, b) => b[1] - a[1]).slice(0, k) : [];
  if (ix.neighbours.size > 5000) ix.neighbours.clear();
  ix.neighbours.set(key, out);
  return out;
}

/** Creators matching a weighted tag taste ({tag: weight}), as [[id, similarity], …]. */
function creatorsForTags(lib, generic, tagWeights, k = 20) {
  const ix = indexFor(lib, generic);
  const v = new Map();
  for (const [t, w] of tagWeights) { const idf = ix.idf.get(t); if (idf && w > 0) v.set(t, w * idf); }
  return [...scoreVector(ix, v)].sort((a, b) => b[1] - a[1]).slice(0, k);
}

/** Inverse document frequency of a tag across creators (0 when unknown or too rare to compare). */
function idfOf(lib, generic, tag) { return indexFor(lib, generic).idf.get(tag) || 0; }

/** Cosine similarity between two creators' tag profiles (0 when either has none). */
function between(lib, generic, a, b) {
  const ix = indexFor(lib, generic);
  const va = ix.vecs.get(a); const vb = ix.vecs.get(b);
  if (!va || !vb) return 0;
  const [small, big] = va.size < vb.size ? [va, vb] : [vb, va];
  let dot = 0;
  for (const [t, x] of small) { const y = big.get(t); if (y) dot += x * y; }
  return dot / (ix.norms.get(a) * ix.norms.get(b));
}

module.exports = { neighbours, creatorsForTags, idfOf, between, indexFor };
