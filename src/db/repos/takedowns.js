'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildTakedowns: takedowns (opt-outs) and what applying one removes. Built by repo.js with the helpers it uses; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildTakedowns = function buildTakedowns({ db, clampInt, blocklist, purgeRemovedContent, purgeRemovedFor, rememberRemovedHashes, logAction, creatorQ, notifyBlocked, notifyState }) {
const takedownLib = require('../../lib/takedowns');
// ---- sweep jobs: a JSON record per takedown in `settings`, so a restart resumes from the stored cursor
const jobKey = (id) => `takedown_job:${id}`;
const OPEN_KEY = 'takedown_jobs_open';
const setQ = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
const getQ = db.prepare('SELECT value FROM settings WHERE key = ?');
const delQ = db.prepare('DELETE FROM settings WHERE key = ?');
function openIds() { const r = getQ.get(OPEN_KEY); try { return r ? JSON.parse(r.value) : []; } catch { return []; } }
function saveJob(job) {
  setQ.run({ key: jobKey(job.id), value: JSON.stringify(job) });
  const open = new Set(openIds());
  if (job.state === 'done' || job.state === 'failed') open.delete(job.id); else open.add(job.id);
  setQ.run({ key: OPEN_KEY, value: JSON.stringify([...open]) });
}
function closeJob(id) { setQ.run({ key: OPEN_KEY, value: JSON.stringify(openIds().filter((x) => x !== id)) }); }
function loadJob(id) { const r = getQ.get(jobKey(id)); try { return r ? JSON.parse(r.value) : null; } catch { return null; } }
/** What the API shows: counts so far, never the id lists. */
function summary(job) {
  const done = job.state === 'done';
  return {
    takedown: db.prepare('SELECT * FROM takedowns WHERE id = ?').get(job.takedownId) || null,
    jobId: job.id, done, state: job.state,
    purged: job.purged, purgedMedia: job.purged, scanned: job.scanned, cursor: job.cursor,
    disabledFeeds: job.disabledFeeds, blockedCreators: job.blockedCreators,
    startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
  };
}
const MAX_MATCH_PER_SLICE = 25;
const scanQ = db.prepare(`SELECT seq, id, creator_id, platform, author, title, description, source_url, media_url, preview_url, thumbnail_url, hash, source_key, phash
  FROM media NOT INDEXED WHERE seq > ? AND publish_state != 'removed' ORDER BY seq LIMIT ?`);
/**
 * Slice sizing: aim each slice at ~15 ms. `pace.perRow` follows the SLOWEST recent cost per row (it decays slowly, not at once),
 * because a cold stretch of the table is slow for a while: a fast slice is no proof that the next one will be.
 */
const newPace = () => ({ perRow: 0.02, n: 500 });
function nextSize(pace, ms, rows) {
  if (rows > 0) pace.perRow = Math.max(ms / rows, pace.perRow * 0.97);
  pace.n = Math.max(100, Math.min(1500, Math.round(15 / Math.max(pace.perRow, 0.001))));
  return pace.n;
}
const running = new Set();
function runInBackground(id) {
  if (running.has(id)) return;
  running.add(id);
  const pace = newPace();
  const turn = () => {
    let r;
    try { r = takedowns.step(id, pace.n); } catch (e) {
      const j = loadJob(id); if (j) { j.state = 'failed'; j.error = String(e.message || e).slice(0, 300); saveJob(j); }
      running.delete(id); return;
    }
    nextSize(pace, r.ms, r.rows);
    if (r.done) { running.delete(id); return; }
    setTimeout(turn, 0).unref?.();
  };
  setTimeout(turn, 0).unref?.();
}
const takedowns = {
  all() {
    return db.prepare('SELECT * FROM takedowns ORDER BY id DESC').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM takedowns WHERE id = ?').get(Number(id)) || null;
  },
  find(kind, value) {
    const norm = takedownLib.normalize(kind, value);
    return db.prepare('SELECT * FROM takedowns WHERE kind = ? AND value = ? COLLATE NOCASE').get(norm.kind, norm.value) || null;
  },
  list({ kind, page = 0, limit = 100 } = {}) {
    const lim = clampInt(limit, 1, 500, 100);
    const pg = clampInt(page, 0, 100000, 0);
    const where = kind && takedownLib.KINDS.includes(String(kind).toLowerCase()) ? 'WHERE kind = ?' : '';
    const params = where ? [String(kind).toLowerCase()] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM takedowns ${where}`).get(...params).n;
    const items = db.prepare(`SELECT * FROM takedowns ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, lim, pg * lim);
    return { items, total, page: pg, limit: lim };
  },
  check(item, feed = null) {
    return takedownLib.checkItem(item, feed, takedowns.all());
  },
  /**
   * Phase 1 of a takedown, one short transaction: the takedown row (from this moment the ingest pipeline refuses everything it
   * covers), the feeds it switches off, the creators it blocks, and a job record that remembers where the retroactive sweep is.
   * The sweep over the stored media is NOT here: it runs in chunks (see `step`), so a takedown never holds the loop for the length of
   * the library (about 5 s at 1.15M rows when it was one transaction).
   */
  begin({ kind, value, reason = null, actor = 'admin' } = {}) {
    const norm = takedownLib.normalize(kind, value);
    const why = reason ? String(reason).trim() : 'takedown';
    let job = null;
    db.transaction(() => {
      db.prepare(`INSERT INTO takedowns (kind, value, reason) VALUES (?, ?, ?)
        ON CONFLICT(kind, value) DO UPDATE SET reason = COALESCE(excluded.reason, takedowns.reason)`)
        .run(norm.kind, norm.value, reason ? String(reason).trim() : null);
      const td = db.prepare('SELECT * FROM takedowns WHERE kind = ? AND value = ? COLLATE NOCASE').get(norm.kind, norm.value);
      const blockedCreatorIds = new Set();
      let disabledFeeds = 0;
      let blockedCreators = 0;
      const affected = new Set();

      if (norm.kind === 'creator' || norm.kind === 'handle') {
        const hasPlat = norm.value.includes(':');
        const plat = hasPlat ? norm.value.split(':', 2)[0] : null;
        const bare = hasPlat ? norm.value.split(':', 2)[1] : norm.value;

        const allCreators = db.prepare('SELECT id, handle, display_name, links, status FROM creators').all();
        for (const c of allCreators) {
          let match = false;
          if (norm.kind === 'creator' && (takedownLib.creatorMatches(c.id, norm.value) || takedownLib.creatorMatches(c.handle, norm.value))) {
            match = true;
          } else if (norm.kind === 'handle' && !plat && takedownLib.handleMatches(c.handle, null, bare)) {
            match = true;
          } else if (c.links) {
            let links = [];
            try { links = typeof c.links === 'string' ? JSON.parse(c.links) : c.links; } catch { links = []; }
            for (const l of Array.isArray(links) ? links : []) {
              if (!l) continue;
              const lPlat = String(l.service || l.platform || '').toLowerCase();
              if (l.handle && (norm.kind === 'creator' ? takedownLib.creatorMatches(l.handle, norm.value) : takedownLib.handleMatches(l.handle, lPlat || null, norm.value))) {
                match = true;
                break;
              }
              if (l.url && takedownLib.checkUrl(l.url, [td])) {
                match = true;
                break;
              }
            }
          }
          if (match) blockedCreatorIds.add(c.id);
        }
        // Check aliases and feeds for creator ownership
        if (!plat) {
          const aliasRows = db.prepare('SELECT creator_id FROM creator_aliases WHERE norm = ? OR alias = ? COLLATE NOCASE').all(bare.replace(/[^a-z0-9]/g, ''), bare);
          for (const r of aliasRows) blockedCreatorIds.add(r.creator_id);
        }

        const feedMatches = plat
          ? db.prepare('SELECT * FROM feeds WHERE platform = ? AND target = ? COLLATE NOCASE').all(plat, bare)
          : db.prepare('SELECT * FROM feeds WHERE target = ? COLLATE NOCASE').all(bare);
        for (const f of feedMatches) {
          if (f.creator_id) blockedCreatorIds.add(f.creator_id);
          if (f.enabled) {
            db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?').run(f.id);
            disabledFeeds++;
          }
          blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, why);
        }

        for (const cid of blockedCreatorIds) {
          const c = creatorQ.get.get(cid);
          if (!c) continue;
          const creatorFeeds = db.prepare('SELECT id, enabled, platform, target FROM feeds WHERE creator_id = ?').all(cid);
          for (const f of creatorFeeds) {
            if (f.enabled) {
              db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?').run(f.id);
              disabledFeeds++;
            }
            blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, why);
          }
          db.prepare("UPDATE creators SET status = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(cid);
          // (their pictures' face vectors go with each row in the sweep and in purgeRemovedFor; this is the creator-level table)
          try { db.prepare('DELETE FROM creator_web_matches WHERE creator_id = ?').run(cid); } catch { /* ignore */ }
          blocklist.add('creator', cid, why);
          blockedCreators++;
          affected.add(cid);
        }

        db.prepare("UPDATE candidates SET status = 'rejected', reason = 'takedown' WHERE target = ? COLLATE NOCASE AND status = 'pending'").run(bare);
        db.prepare("UPDATE onlyfans_leads SET status = 'rejected', reason = 'takedown' WHERE handle = ? COLLATE NOCASE").run(bare);
      } else if (norm.kind === 'url' || norm.kind === 'domain') {
        const allFeeds = db.prepare('SELECT * FROM feeds WHERE enabled = 1').all();
        for (const f of allFeeds) {
          const matched = norm.kind === 'url'
            ? takedownLib.urlMatches(f.target, norm.value)
            : takedownLib.domainMatches(f.target, norm.value);
          if (matched) {
            db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?').run(f.id);
            disabledFeeds++;
          }
        }
      }

      job = {
        id: `${td.id}-${Date.now().toString(36)}`, takedownId: td.id, kind: td.kind, value: td.value, why, actor,
        state: 'scanning', cursor: 0, scanned: 0, purged: 0, disabledFeeds, blockedCreators,
        blockedCreatorIds: [...blockedCreatorIds], affected: [...affected], finalizeAt: 0,
        startedAt: new Date().toISOString(), finishedAt: null, error: null,
      };
      saveJob(job);
      logAction('takedown', String(td.id), 'add', why, actor);
    })();
    return job;
  },

  /**
   * One slice of the retroactive sweep, in its own transaction: the next `n` stored items after the job's cursor (a walk in `seq`
   * order, so every item is seen once and one inserted meanwhile is seen too) are matched against the takedown. Each match is
   * marked removed, its hashes and source key are blocklisted BEFORE its identifiers are cleared (purgeRemovedContent), and the
   * cursor moves in the same transaction: a restart resumes exactly here. When the scan runs out, the creator-level clean-up runs
   * (older removed rows keep their hashes blocked, then lose their identifiers; counters are recounted once per creator).
   * @returns {{done: boolean, ms: number}}
   */
  step(jobId, n = 1000) {
    const job = loadJob(jobId);
    if (!job || job.state === 'done' || job.state === 'failed') return { done: true, ms: 0 };
    const t0 = Date.now();
    const td = takedowns.get(job.takedownId) || { id: job.takedownId, kind: job.kind, value: job.value };
    const blockedIds = new Set(job.blockedCreatorIds);
    const removedMediaIds = []; const removedPhashes = [];
    const why = job.why;
    let scannedNow = 0;
    db.transaction(() => {
      if (job.state === 'scanning') {
        const rows = scanQ.all(job.cursor, n);
        const matched = [];
        let seen = 0;
        for (const m of rows) {
          seen++;
          const byCreator = m.creator_id && blockedIds.has(m.creator_id);
          const hit = byCreator || takedownLib.checkItem({
            creator_id: m.creator_id, platform: m.platform, author: m.author, title: m.title, text: m.description, description: m.description,
            source_url: m.source_url, permalink: m.source_url, media_url: m.media_url, mediaUrl: m.media_url,
            preview_url: m.preview_url, previewUrl: m.preview_url, thumbnail_url: m.thumbnail_url, thumbnailUrl: m.thumbnail_url,
          }, null, [td]);
          if (hit) matched.push(m);
          if (matched.length >= MAX_MATCH_PER_SLICE) break; // each match is a dozen writes: a slice stops after this many, whatever n is
        }
        const affected = new Set(job.affected);
        for (const m of matched) {
          db.prepare("UPDATE media SET publish_state = 'removed', review_reason = 'takedown', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(m.id);
          try {
            db.prepare('DELETE FROM media_faces WHERE media_id = ?').run(m.id);
            db.prepare('DELETE FROM creator_web_matches WHERE media_id = ?').run(m.id);
          } catch { /* ignore */ }
          if (m.hash) blocklist.add('hash', m.hash, why);
          if (m.source_key) blocklist.add('source_key', m.source_key, why);
          if (m.phash) {
            db.prepare('INSERT OR IGNORE INTO phash_blocklist (phash, reason) VALUES (?, ?)').run(m.phash, why);
            removedPhashes.push(m.phash);
          }
          if (m.creator_id) affected.add(m.creator_id);
          removedMediaIds.push(m.id);
        }
        purgeRemovedContent(removedMediaIds); // the hashes above are already blocklisted: now the identifiers go
        job.purged += matched.length;
        scannedNow = seen;
        job.scanned += seen;
        if (seen) job.cursor = rows[seen - 1].seq;
        job.affected = [...affected];
        if (seen === rows.length && rows.length < n) job.state = 'finalizing'; // only when the page ran out: a slice cut short by MAX_MATCH_PER_SLICE has rows left
      } else {
        // finalizing: one blocked creator, then one affected creator, per call
        const cids = job.blockedCreatorIds;
        if (job.finalizeAt < cids.length) {
          const cid = cids[job.finalizeAt];
          const left = db.prepare("SELECT seq, id, hash, phash FROM media WHERE creator_id = ? AND publish_state = 'removed' AND seq > ? AND hash NOT LIKE 'purged:%' ORDER BY seq LIMIT 100").all(cid, job.finalizeSeq || 0);
          for (const m of left) {
            if (m.hash) blocklist.add('hash', m.hash, why);
            if (m.phash) db.prepare('INSERT OR IGNORE INTO phash_blocklist (phash, reason) VALUES (?, ?)').run(m.phash, why);
          }
          if (left.length) purgeRemovedContent(left.map((r) => r.id)); // the same creator again next call until none are left
          if (left.length < 100) { job.finalizeAt++; job.finalizeSeq = 0; } else job.finalizeSeq = left[left.length - 1].seq;
        } else {
          const rest = job.affected.splice(0, 1); // a creator's recount reads all of its rows: one per slice
          for (const cid of rest) creatorQ.stats.run({ id: cid });
          if (!job.affected.length) { job.state = 'done'; job.finishedAt = new Date().toISOString(); }
        }
      }
      saveJob(job);
    })();
    for (const mid of removedMediaIds) notifyState(mid, 'removed');
    for (const ph of removedPhashes) notifyBlocked(ph);
    return { done: job.state === 'done', ms: Date.now() - t0, rows: scannedNow };
  },

  /** Drive a job to the end, synchronously. Small libraries and tests; the server uses start(). */
  finishNow(jobId) {
    for (let guard = 0; guard < 1e7; guard++) { if (takedowns.step(jobId, 5000).done) break; }
    return loadJob(jobId);
  },

  /**
   * What the admin route calls. Phase 1 runs now; then slices run for up to `budgetMs` (a small library is finished inside the
   * request, with complete counts), and anything left continues in the background, a slice per timer turn, resuming after a restart.
   */
  start(args, { budgetMs = 25 } = {}) {
    const job0 = takedowns.begin(args);
    const t0 = Date.now();
    let r = { done: false };
    const pace = newPace();
    while (!r.done && Date.now() - t0 < budgetMs) { r = takedowns.step(job0.id, pace.n); nextSize(pace, r.ms, r.rows); }
    const job = loadJob(job0.id);
    if (job.state !== 'done') runInBackground(job.id);
    return summary(job);
  },

  /** Take up jobs a restart interrupted. Call once after boot. */
  resume() {
    const open = openIds();
    for (const id of open) { const j = loadJob(id); if (j && j.state !== 'done' && j.state !== 'failed') runInBackground(id); else closeJob(id); }
    return open.length;
  },
  job(id) { const j = loadJob(String(id)); return j ? summary(j) : null; },
  jobs() { return openIds().map((id) => loadJob(id)).filter(Boolean).map(summary); },

  /** Synchronous end-to-end takedown (the same phases, no yield): small libraries and tests. */
  add(args = {}) {
    const job = takedowns.finishNow(takedowns.begin(args).id);
    return summary(job);
  },
  remove(id, actor = 'admin') {
    const row = takedowns.get(id);
    if (!row) return false;
    db.prepare('DELETE FROM takedowns WHERE id = ?').run(Number(id));
    logAction('takedown', String(id), 'remove', `${row.kind}:${row.value}`, actor);
    return true;
  },
};
  return { takedowns };
};

/** buildPurge: removed content keeps no identifiers (the purge every takedown and block uses). Built by repo.js with the helpers it uses; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildPurge = function buildPurge({ db, blocklist, hasTable }) {
/**
 * Remove the content identifiers of media that is 'removed': face vectors and visual embeddings, the perceptual
 * and exact hashes, every URL, the other places it was posted (alt sources) and its web matches. The rows, their publish state, review reason and all blocklists stay,
 * so an item stays removed and can never be re-imported. Only 'removed' rows are touched; a published
 * row given here is skipped by the SQL, not by the caller.
 */
const storedUrls = new Set();
let dropScheduled = false;
/** Delete the bytes behind purged URLs: object-store copies and cached proxy images. Runs once the caller's sync work is done. */
function scheduleDrop() {
  if (dropScheduled || !storedUrls.size) return;
  dropScheduled = true;
  setImmediate(async () => {
    dropScheduled = false;
    const urls = [...storedUrls]; storedUrls.clear();
    let store = null; let cache = null;
    try { store = require('../../lib/objectstore'); } catch { /* not configured */ }
    try { cache = require('../../lib/media-cache'); } catch { /* not configured */ }
    for (const u of urls) {
      try { if (cache && cache.drop) cache.drop(u); } catch { /* best effort */ }
      const key = store && store.keyOf(u);
      if (key) { try { await store.remove(key); } catch { /* best effort: the row no longer points at it */ } }
    }
  }).unref?.();
}
function purgeRemovedContent(ids) {
  try { return purgeRemovedContentNow(ids); } finally { scheduleDrop(); }
}
function purgeRemovedContentNow(ids) {
  const all = [...new Set(ids.filter(Boolean))];
  let purged = 0;
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const gone = db.prepare(`SELECT id FROM media WHERE publish_state = 'removed' AND id IN (${ph})`).all(...chunk).map((r) => r.id);
    if (!gone.length) continue;
    const gph = gone.map(() => '?').join(',');
    if (hasTable('media_embeddings')) db.prepare(`DELETE FROM media_embeddings WHERE media_id IN (${gph})`).run(...gone);
    // The same class of residue: face vectors, the other places the picture was posted (source URLs) and web matches.
    for (const t of ['media_faces', 'media_alt_sources', 'creator_web_matches']) {
      if (hasTable(t)) db.prepare(`DELETE FROM ${t} WHERE media_id IN (${gph})`).run(...gone);
    }
    if (hasTable('media_tags')) db.prepare(`DELETE FROM media_tags WHERE media_id IN (${gph})`).run(...gone);
    // The stored bytes go too (after this transaction commits): our object-store copies and the proxy's disk cache.
    for (const r of db.prepare(`SELECT media_url, preview_url, thumbnail_url, thumb_url, hls_url FROM media WHERE id IN (${gph})`).all(...gone)) {
      for (const u of Object.values(r)) if (u) storedUrls.add(u);
    }
    // hash and media_url are NOT NULL, and hash is UNIQUE: they get placeholders that no real hash or URL equals.
    // The text that identifies the post goes as well; the update trigger takes it out of media_fts, so search no longer
    // finds it. source_key and post_key stay: they are opaque ids that keep the post from being imported again.
    db.prepare(`UPDATE media SET phash = NULL, hash = 'purged:' || id, media_url = '', preview_url = NULL,
      thumbnail_url = NULL, thumb_url = NULL, hls_url = NULL, tint = NULL,
      source_url = NULL, title = NULL, description = NULL, ocr_text = NULL, author = NULL, community = NULL, tags_text = '',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE publish_state = 'removed' AND id IN (${gph})`).run(...gone);
    purged += gone.length;
  }
  return purged;
}
/** Purge every removed item of one creator (a block or takedown may leave older removed rows behind). */
const purgeRemovedFor = (creatorId) => purgeRemovedContent(db.prepare("SELECT id FROM media WHERE creator_id = ? AND publish_state = 'removed'").all(creatorId).map((r) => r.id));
/** Keep a removed item's hashes blocked before its identifiers are cleared. Idempotent. */
function rememberRemovedHashes(creatorId, reason) {
  for (const m of db.prepare("SELECT hash, phash FROM media WHERE creator_id = ? AND publish_state = 'removed'").all(creatorId)) {
    if (m.hash && !String(m.hash).startsWith('purged:')) blocklist.add('hash', m.hash, reason);
    if (m.phash) db.prepare('INSERT OR IGNORE INTO phash_blocklist (phash, reason) VALUES (?, ?)').run(m.phash, reason || null);
  }
}
  return { purgeRemovedContent, purgeRemovedFor, rememberRemovedHashes };
};
