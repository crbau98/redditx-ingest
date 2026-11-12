'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildLibraryModule: the library snapshot (tag counts, creator tag profiles) and the write counter behind cached totals. Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildLibraryModule = function buildLibraryModule({ db, PLATFORM_TAGS }) {
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
  return { lib, index: require('../../lib/similarity').indexFor(lib, GENERIC_TAGS) };
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
  const snapshots = require('../../lib/snapshots');
  if (!snapshots.USE_WORKER) return libraryInline();
  const entry = snapshots.peek('library');
  const v = writeVersion();
  if (!entry || (v !== libV && Date.now() - entry.at > LIB_MAX_AGE)) {
    libV = v;
    snapshots.refresh('library').catch((e) => console.error('[library] refresh failed:', e.message));
  }
  if (!entry) throw new LibraryWarmingError();
  require('../../lib/similarity').adopt(entry.value.lib, entry.value.index);
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
  return { GENERIC_TAGS, quietly, writeVersion, library, libraryWithIndex, LibraryWarmingError };
};
