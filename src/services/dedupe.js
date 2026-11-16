'use strict';
/**
 * Perceptual duplicate detection (the decision layer over lib/phash + lib/phash-index).
 *
 *   live      hashes of every published / in-review picture (and of those the body filter hid: that hide is reversible),
 *             kept current through repo state hooks
 *   blocked   hashes of pictures an admin (or a gate) removed: a re-upload anywhere is refused too
 *
 * The same picture posted again (another platform, another creator, re-encoded, resized) does not become a second item:
 * the original gains an "also posted on ..." entry instead. The index loads lazily from the database on first use.
 */
const repo = require('../db/repo');
const { PhashIndex } = require('../lib/phash-index');

const live = new PhashIndex();
const blocked = new PhashIndex();
let loaded = false;

const aspectOf = (w, h) => (w > 0 && h > 0 ? w / h : null);

function loadSync() {
  for (const r of repo.media.hashedRows()) live.add(r.id, r.phash, { type: r.media_type, aspect: aspectOf(r.width, r.height) });
  for (const h of repo.media.phashBlocked()) blocked.add(h, h);
}

function load() {
  if (loaded) return;
  // A chunked build is already spoken for: do not fall into a multi-second sync scan. Mid-build
  // callers see the partial index (the same as remember() during loadChunked).
  if (building) return;
  loaded = true;
  loadSync();
}

// One straight build of 900k rows holds the loop for ~119 s (its sync index adds). The boot warmer
// takes this road instead: seq-ordered chunks with a yield between them, so health checks keep answering.
// The chunk is sized by TIME, not by row count: a slice (one SQLite read of the next rows + their index adds) aims at
// SLICE_TARGET_MS, so a cold volume or a sparse region of the table (rows without a hash are scanned and skipped) shrinks
// the next read instead of holding the loop for however long 5000 rows took.
const LOAD_CHUNK = 5000;
const LOAD_CHUNK_MIN = 200;
const SLICE_TARGET_MS = 30;
let building = null; // one in-flight chunked build: later callers await it instead of racing a sync load()
function loadChunked(opts) {
  if (building) return building.then(() => ({ chunks: 0, rows: 0, already: true }));
  building = loadChunkedOnce(opts);
  return building;
}
async function loadChunkedOnce({ chunk = LOAD_CHUNK, targetMs = SLICE_TARGET_MS } = {}) {
  if (loaded) return { chunks: 0, rows: 0, already: true };
  loaded = true; // remember()/check() during the build land in the live part; the tail chunk catches them up
  const blockwatch = require('../lib/blockwatch');
  blockwatch.slice('dedupe:blocklist', () => { for (const h of repo.media.phashBlocked()) blocked.add(h, h); }); // the blocklist first: a re-upload of a removed picture is refused from the first second
  let chunks = 0; let rows = 0; let after = 0; let worstMs = 0;
  let n = Math.min(chunk, 1000); // the first read is small: the volume may be cold
  for (;;) {
    let batch;
    const ms = blockwatch.slice('dedupe:load', () => {
      batch = repo.media.hashedChunk(after, n);
      for (const r of batch) live.add(r.id, r.phash, { type: r.media_type, aspect: aspectOf(r.width, r.height) });
    });
    worstMs = Math.max(worstMs, ms);
    rows += batch.length; chunks++;
    if (!batch.length || batch.length < n) break;
    after = batch[batch.length - 1].seq;
    // aim the next slice at targetMs, growing at most 2x per step (a quick slice is not proof the next region is as cheap)
    n = Math.max(LOAD_CHUNK_MIN, Math.min(chunk, Math.round(n * Math.min(2, targetMs / Math.max(ms, 1)))));
    await new Promise((res) => setTimeout(res, 0)); // a timer, not setImmediate: queued requests and health probes run first
  }
  return { chunks, rows, already: false, worstSliceMs: Math.round(worstMs) };
}

const indexed = (r) => r.publish_state === 'published' || r.publish_state === 'review' || (r.publish_state === 'hidden' && String(r.review_reason || '').startsWith('physique:'));

repo.media.onState((id) => {
  if (!loaded) return;
  const r = repo.media.hashInfo(id);
  if (r && r.phash && indexed(r)) live.add(id, r.phash, { type: r.media_type, aspect: aspectOf(r.width, r.height) });
  else live.remove(id);
});
repo.media.onPhashBlocked((hex) => { if (loaded) blocked.add(hex, hex); });

/**
 * @param {{phash: string, mediaType: string, width?: number, height?: number}} q
 * @param {{distance?: number, ignoreId?: string}} opts
 * @returns {{dup: {id:string,p:number,d:number}|null, blocked: {p:number,d:number}|null}}
 */
function check(q, { distance = 6, ignoreId } = {}) {
  load();
  if (!q || !q.phash) return { dup: null, blocked: null };
  const type = q.mediaType === 'video' ? 'video' : 'image';
  const b = blocked.find(q.phash, { max: Math.min(distance, 4) })[0] || null; // a blocked picture is matched more tightly: it must really be the same
  const found = live.find(q.phash, { max: distance, type, aspect: aspectOf(q.width, q.height) }).filter((m) => m.id !== ignoreId);
  return { dup: found[0] || null, blocked: b ? { p: b.p, d: b.d } : null };
}

/** Make a freshly stored picture findable. */
function remember(id, phash, { mediaType, width, height } = {}) {
  load();
  if (phash) live.add(id, phash, { type: mediaType === 'video' ? 'video' : 'image', aspect: aspectOf(width, height) });
}

/** Take a picture out of the index (its hash was wrong, e.g. a borrowed poster). The next load rebuilds from the database anyway. */
function forget(id) { if (loaded) live.remove(id); }

/** Refuse this picture (and its look-alikes) from now on. */
function blockHash(phash, reason) {
  load();
  if (phash && repo.media.blockPhash(phash, reason)) blocked.add(phash, phash);
}

function stats() { load(); return { indexed: live.size, blocked: blocked.size }; }
function _reset() {
  loaded = false;
  building = null;
  live.clear();
  blocked.clear();
}

module.exports = { check, remember, forget, blockHash, stats, load, loadChunked, _reset };
