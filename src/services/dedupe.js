'use strict';
/**
 * Perceptual duplicate detection (the decision layer over lib/phash + lib/phash-index).
 *
 *   live      hashes of every published / in-review picture, kept current through repo state hooks
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

function load() {
  if (loaded) return;
  loaded = true;
  for (const r of repo.media.hashedRows()) live.add(r.id, r.phash, { type: r.media_type, aspect: aspectOf(r.width, r.height) });
  for (const h of repo.media.phashBlocked()) blocked.add(h, h);
}

repo.media.onState((id, state) => {
  if (!loaded) return;
  if (state === 'published' || state === 'review') {
    const r = repo.media.hashInfo(id);
    if (r && r.phash) live.add(id, r.phash, { type: r.media_type, aspect: aspectOf(r.width, r.height) });
  } else live.remove(id);
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

/** Refuse this picture (and its look-alikes) from now on. */
function blockHash(phash, reason) {
  load();
  if (phash && repo.media.blockPhash(phash, reason)) blocked.add(phash, phash);
}

function stats() { load(); return { indexed: live.size, blocked: blocked.size }; }
function _reset() { loaded = false; live.entries.clear(); live.buckets.clear(); blocked.entries.clear(); blocked.buckets.clear(); }

module.exports = { check, remember, blockHash, stats, load, _reset };
