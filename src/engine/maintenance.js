'use strict';
/**
 * Library-wide maintenance. The important one is `sweep`: it re-applies the
 * current safety / junk rules to content that is already stored, so rule
 * improvements (and anything ingested by an older version with no gate at all)
 * are enforced retroactively.
 */
const repo = require('../db/repo');
const events = require('./events');
const { checkText } = require('../lib/safety');
const { femaleCheck, classify: classifyScope } = require('../lib/scope');
const { hostBlocked, hostOf, isJunkTitle } = require('../lib/mediaurl');
const { probeMedia } = require('./probe');
const imagefilter = require('../lib/imagefilter');
const dedupe = require('../services/dedupe');
const faceMatch = require('../lib/face-match');
const physique = require('./physique');
const buildbias = require('../lib/buildbias');
const deepsearch = require('./deepsearch');
const settingsStore = require('../settings');

// Bump whenever the safety or male-only scope rules get stricter: existing libraries are re-swept once.
// v3: male-only scope (female / feminine / trans-feminine content is removed and blocklisted).
const SAFETY_SWEEP_VERSION = '3';

async function sweep({ probe = false, limit = 1_000_000 } = {}) {
  const res = { checked: 0, blocked: 0, review: 0, hidden: 0, dead: 0, female: 0, femaleReview: 0, femaleCreators: 0, femaleFeeds: 0 };
  let after = 0;
  const stmt = repo.db.prepare(`SELECT seq, id, platform, title, description, tags_text, community, author, media_url, media_type, publish_state
    FROM media NOT INDEXED WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT 500`);
  events.log('INFO', 'Sweeping library against current safety and quality rules…');
  for (;;) {
    const rows = stmt.all(after);
    if (!rows.length || res.checked >= limit) break;
    for (const row of rows) {
      after = row.seq; res.checked++;
      const s = checkText(row.title, row.description, row.tags_text, row.community, row.author);
      if (s.level === 'block') { repo.media.block(row.id, `safety sweep: ${s.rule}`, 'system'); res.blocked++; continue; }
      if (s.level === 'review' && row.publish_state === 'published') { repo.media.setState(row.id, 'review', `safety:${s.rule}`); res.review++; continue; }
      // Male-only scope: hard female / feminine wording removes the item for good (hash + source key are
      // blocklisted so it can never be re-imported); softer wording sends published items back to a human.
      const g = femaleCheck(row.title, row.description, row.tags_text, row.community, row.author);
      if (g.level === 'hard') { repo.media.block(row.id, `scope sweep: ${g.rule}`, 'system'); res.female++; continue; }
      if (g.level === 'soft' && row.publish_state === 'published') { repo.media.setState(row.id, 'review', `scope:${g.rule}`); res.femaleReview++; continue; }
      const host = hostOf(row.media_url); // relative/local URLs have no host: nothing to judge
      if (isJunkTitle(row.title) || (host && hostBlocked(host, row.platform))) { repo.media.setState(row.id, 'hidden', 'junk'); res.hidden++; continue; }
      if (probe && row.publish_state === 'published' && !/\.m3u8/.test(row.media_url) && /imgur\.com/.test(row.media_url)) {
        const p = await probeMedia(row.media_url, row.media_type);
        if (!p.ok && /http (404|410)|too small/.test(p.reason)) { repo.media.setState(row.id, 'hidden', `dead: ${p.reason}`); res.dead++; }
      }
    }
    await new Promise((r) => setImmediate(r)); // let requests breathe
  }
  const creators = repo.db.prepare("SELECT id, handle, display_name, bio FROM creators WHERE status = 'active'").all();
  for (const c of creators) {
    const s = checkText(c.handle, c.display_name, c.bio);
    if (s.level === 'block') { repo.creators.block(c.id, `safety sweep (creator): ${s.rule}`, 'system'); res.blocked++; continue; }
    const g = femaleCheck(c.handle, c.display_name, c.bio);
    if (g.level === 'hard') { repo.creators.block(c.id, `scope sweep (creator): ${g.rule}`, 'system'); res.femaleCreators++; }
  }
  // Feeds named after women / feminine themes (communities, searches, tags) are switched off and remembered.
  for (const f of repo.db.prepare('SELECT id, platform, kind, target, label FROM feeds WHERE enabled = 1').all()) {
    const g = femaleCheck(f.target, f.label);
    if (g.level !== 'hard') continue;
    repo.feeds.update(f.id, { enabled: false });
    repo.blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, `scope sweep (feed): ${g.rule}`);
    res.femaleFeeds++;
  }
  // Feeds that can never work are switched off to keep the scheduler clean: the target is gone (404/410, suspended, private,
  // 3+ failures) or the feed never answers with anything readable (5+). The LAST ERROR is classified (engine/errorclass), not
  // pattern-matched: "Service Unavailable" is a 503 outage and "...1404.xml" a file name, and a rate limit, a challenge, a timeout
  // or a dropped connection can pass, so those feeds keep backing off instead of being switched off for good.
  const { classify } = require('./errorclass');
  for (const f of repo.db.prepare("SELECT id, platform, kind, target, label, consecutive_failures, last_error FROM feeds WHERE enabled = 1 AND consecutive_failures >= 3").all()) {
    const c = classify(f.last_error || '');
    const isBroken = (c.permanent && f.consecutive_failures >= 3) || (f.consecutive_failures >= 5 && !c.transient);
    if (isBroken) {
      repo.feeds.update(f.id, { enabled: false });
      repo.logAction('feed', f.id, 'sweep-disable', `${c.kind}, ${f.consecutive_failures} failures`, 'system'); // what the health report lists as switched off by the engine
      events.log("INFO", `Sweep: disabled failing feed ${f.platform}:${f.kind}:${f.target} (${f.consecutive_failures} failures, ${c.kind})`);
    }
  }

  events.log('OK', `Sweep done: checked ${res.checked} · blocked ${res.blocked} · to review ${res.review} · hidden ${res.hidden}${probe ? ` · dead ${res.dead}` : ''} · male-only scope: ${res.female} removed, ${res.femaleReview} to review, ${res.femaleCreators} creators, ${res.femaleFeeds} feeds`);
  return res;
}

/* ------------------------------------------------------------- image sweep */
const IMAGE_SWEEP_VERSION = '1'; // bump to re-check the whole library (e.g. after a better model)

/**
 * Re-check stored items with the image filter, oldest first, resuming from a cursor so a restart never starts over.
 * A picture showing a woman removes the item and remembers its hash. Pictures that cannot be fetched (expired
 * hotlinks, 403) are skipped, not removed: no verdict is not a verdict.
 */
async function imageSweep({ limit = 12, settings } = {}) {
  const s = settings || settingsStore.get();
  const res = { checked: 0, removed: 0, undecided: 0, errors: 0, faces: 0, done: false };
  if (repo.settings.get('image_sweep_version') !== IMAGE_SWEEP_VERSION) {
    repo.settings.set('image_sweep_version', IMAGE_SWEEP_VERSION); repo.settings.set('image_sweep_seq', '0');
  }
  let after = parseInt(repo.settings.get('image_sweep_seq') || '0', 10) || 0;
  const rows = repo.db.prepare(`SELECT seq, id, media_type, media_url, preview_url, thumbnail_url FROM media NOT INDEXED
    WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  for (const row of rows) {
    after = row.seq;
    await new Promise((res2) => setImmediate(res2)); // never a whole pass in one blocking stretch (see faceSweep)
    const v = await imagefilter.checkItem({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url },
      { threshold: (s.imageFilterThreshold || 50) / 100 });
    res.checked++;
    if (v.female) { repo.media.block(row.id, 'image sweep: picture shows a woman', 'system'); res.removed++; }
    else if (v.status === 'error' || v.status === 'unavailable') res.errors++;
    else if (!v.decided) res.undecided++;
    // Face matching on the existing library: the same model pass that checks for women also returns male
    // descriptors, so this is the cheap place to enrol old media without a second download.
    if (s.faceMatch && v.faceList && v.faceList.length) {
      try { res.faces += faceMatch.saveMediaFaces(row.id, v.faceList); } catch { /* best effort */ }
    }
    if (s.faceMatch) { try { repo.db.prepare('UPDATE media SET face_at = ? WHERE id = ?').run(new Date().toISOString(), row.id); } catch { /* best effort */ } }
  }
  repo.settings.set('image_sweep_seq', String(after));
  if (res.removed) events.log('OK', `Image sweep: removed ${res.removed} of ${res.checked} checked (women in the picture)`);
  return res;
}

/* ------------------------------------------------------------- physique sweep */
const PHYSIQUE_SWEEP_VERSION = '2'; // 2: stricter anchors (v5). bump to re-measure the whole library (e.g. after better anchors or a better model)

/**
 * Measure the build in stored pictures that have no physique score yet (oldest first, cursor `physique_sweep_seq`), hide the
 * heavy ones and re-judge their creators. Same model pass as the face check, so a woman found on the way is removed too.
 * Each picture is looked at once per sweep version: "no torso in view" stays NULL and is not retried. Hidden pictures are
 * measured too (only published ones change state), so one restored later (a report dismissed, a threshold raised) has a score.
 */
async function physiqueSweep({ limit = 12, settings } = {}) {
  const s = settings || settingsStore.get();
  const res = { checked: 0, measured: 0, hidden: 0, removed: 0, errors: 0, done: false };
  if (repo.settings.get('physique_sweep_version') !== PHYSIQUE_SWEEP_VERSION) {
    repo.settings.set('physique_sweep_version', PHYSIQUE_SWEEP_VERSION); repo.settings.set('physique_sweep_seq', '0');
  }
  let after = parseInt(repo.settings.get('physique_sweep_seq') || '0', 10) || 0;
  const startedAt = after;
  const rows = repo.db.prepare(`SELECT seq, id, creator_id, media_type, media_url, preview_url, thumbnail_url, publish_state, physique, review_reason, title, description, tags_text, community, author FROM media NOT INDEXED
    WHERE publish_state IN ('published','review','hidden') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  const creators = new Set();
  for (const row of rows) {
    await new Promise((res2) => setImmediate(res2)); // one picture at a time: never a whole pass in one block
    const v = await imagefilter.checkItem({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url },
      { threshold: (s.imageFilterThreshold || 50) / 100, faces: s.imageFilter === true, body: true });
    // the settings may have changed while the model was busy (that request already re-applied the library): judge this row
    // with the current ones, and if the filter was switched off, stop and resume from this row later
    const now = settingsStore.get();
    if (!now.physiqueFilter) { res.stopped = true; break; }
    after = row.seq; res.checked++;
    // The row as it is NOW: the model call above can take long enough for an admin to approve, reject, remove or block it, and
    // the snapshot read before it must not undo that.
    const cur = repo.db.prepare('SELECT publish_state, physique, review_reason, title, description, tags_text, community, author FROM media WHERE id = ?').get(row.id);
    if (!cur) continue;
    if (v.female) { repo.media.block(row.id, 'physique sweep: picture shows a woman', 'system'); res.removed++; continue; }
    if (v.status === 'error' || v.status === 'unavailable') { res.errors++; continue; }
    if (now.faceMatch && v.faceList && v.faceList.length) {
      try { res.faces = (res.faces || 0) + faceMatch.saveMediaFaces(row.id, v.faceList); } catch { /* best effort */ }
    }
    if (now.faceMatch) { try { repo.db.prepare('UPDATE media SET face_at = ? WHERE id = ?').run(new Date().toISOString(), row.id); } catch { /* best effort */ } }
    // A row hidden for its WORDS that the current word list no longer matches (the text sweep leaves it hidden and rewinds this
    // sweep to it): it is shown again only now, after a real measurement, with the stored verdict: hidden with a body reason if
    // heavy, published otherwise. No torso in view leaves it unmeasured, as the pipeline publishes any other such picture.
    if (cur.publish_state === 'hidden' && cur.physique !== physique.APPROVED && /^physique:(text:|101$)/.test(cur.review_reason || '')
        && !physique.textCheck(cur.title, cur.description, cur.tags_text, cur.community, cur.author).heavy) {
      repo.media.setPhysique(row.id, v.physique == null ? null : v.physique);
      physique.publish(row.id, now);
      res.restored = (res.restored || 0) + 1;
      if (row.creator_id) creators.add(row.creator_id);
      continue;
    }
    if (v.physique == null || cur.physique === physique.APPROVED) continue; // an admin approved it over the body filter
    res.measured++;
    repo.media.setPhysique(row.id, v.physique);
    const verdict = cur.publish_state === 'published' ? physique.stateFor(v.physique, now) : null;
    if (verdict) { repo.media.setState(row.id, verdict.state, verdict.reason, { exact: true }); imagefilter.noteHeavy(); res.hidden++; }
    if (row.creator_id) creators.add(row.creator_id);
  }
  if (creators.size) { const now = settingsStore.get(); for (const id of creators) physique.reviewCreator(id, now); }
  // a text sweep may have moved the cursor BACK while this batch awaited the model (a rewind to rows it left for measuring):
  // keep that lower value, the rows between are measured again on the next tick
  const stored = parseInt(repo.settings.get('physique_sweep_seq') || '0', 10) || 0;
  repo.settings.set('physique_sweep_seq', String(stored < startedAt ? stored : after));
  if (res.hidden || res.removed) events.log('OK', `Body sweep: ${res.measured} of ${res.checked} measured · ${res.hidden} hidden (heavy)${res.removed ? ` · ${res.removed} removed (women)` : ''}`);
  return res;
}

/* ------------------------------------------------------------- progress counts */
// The admin pages ask for these counts on every load, and each one counts a large slice of the media table. Each count is
// kept for 60 s (in memory, per statement and arguments); the sweeps themselves always read live rows.
const PROGRESS_TTL_MS = 60 * 1000;
const progressCache = new Map();
let progressClock = () => Date.now();
function countCached(sql, ...args) {
  const key = `${sql}|${JSON.stringify(args)}`;
  const now = progressClock();
  const hit = progressCache.get(key);
  if (hit && now - hit.at < PROGRESS_TTL_MS) return hit.value;
  const value = repo.db.prepare(sql).get(...args);
  progressCache.set(key, { at: now, value });
  if (progressCache.size > 100) progressCache.delete(progressCache.keys().next().value);
  return value;
}

function physiqueSweepProgress() {
  const cursor = parseInt(repo.settings.get('physique_sweep_seq') || '0', 10) || 0;
  const remaining = countCached("SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review','hidden') AND seq > ?", cursor).n;
  return { cursor, remaining, version: PHYSIQUE_SWEEP_VERSION };
}

/* ------------------------------------------------------------ lean-preference bias sweep */
/**
 * Give every stored row its lean-preference ranking multiplier (lib/buildbias): oldest first,
 * cursor `lean_bias_seq`, words on the row's own text plus any measured build score. Rows that
 * stay neutral keep NULL and are never rewritten; a biased row's trending score folds the
 * multiplier in on the next drift refresh. Bounded per tick, one small pass a minute.
 */
async function leanBiasSweep({ limit = 4000, settings } = {}) {
  const s = settings || settingsStore.get();
  const res = { judged: 0, biased: 0, done: false };
  if (!s.leanPreference) { res.done = true; return res; }
  let after = parseInt(repo.settings.get('lean_bias_seq') || '0', 10) || 0;
  const rows = repo.db.prepare(`SELECT seq, id, title, description, tags_text, community, author, physique FROM media
    WHERE lean_bias IS NULL AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  const upd = repo.db.prepare('UPDATE media SET lean_bias = ? WHERE id = ?');
  for (const row of rows) {
    const bias = buildbias.biasFor(row.physique, [row.title, row.description, row.tags_text, row.community, row.author]);
    if (bias != null) { upd.run(bias, row.id); res.biased++; }
    after = row.seq;
    res.judged++;
  }
  repo.settings.set('lean_bias_seq', String(after));
  return res;
}

function leanBiasProgress() {
  const cursor = parseInt(repo.settings.get('lean_bias_seq') || '0', 10) || 0;
  const remaining = countCached('SELECT COUNT(*) AS n FROM media WHERE lean_bias IS NULL AND seq > ?', cursor).n;
  return { cursor, remaining };
}

/**
 * The preference was switched off: forget every stored bias (chunked, yielded) so ranking
 * returns to the plain trending score. New rows stay neutral too — the sweep stops on its own.
 */
async function clearLeanBias() {
  const upd = repo.db.prepare('UPDATE media SET lean_bias = NULL WHERE seq > @from AND seq <= @to AND lean_bias IS NOT NULL');
  const max = repo.db.prepare('SELECT MAX(seq) AS m FROM media').get();
  const top = (max && max.m) || 0;
  let from = 0;
  let cleared = 0;
  while (from < top) {
    const to = Math.min(from + 20000, top);
    cleared += upd.run({ from, to }).changes;
    from = to;
    await new Promise((r) => setImmediate(r));
  }
  repo.settings.set('lean_bias_seq', '0'); // a later re-enable re-judges the whole library
  events.log('OK', `Lean preference off: ${cleared} stored biases cleared`);
  return cleared;
}

/* ------------------------------------------------------------- hash sweep */
/**
 * Give every stored picture a perceptual hash (oldest first, cursor `hash_sweep_seq`) and collapse look-alikes: when a
 * picture matches an OLDER item, it is hidden and listed under the original as "also posted on ...". Hashing only needs
 * the image bytes (no model), so it is cheap and runs even when the face filter is unavailable.
 */
const siblingPoster = repo.db.prepare('SELECT 1 FROM media WHERE post_key = ? AND id != ? AND preview_url = ? LIMIT 1');
/**
 * Is this video's poster borrowed, i.e. not a picture of THIS video? A creator banner / icon, or the same picture its sibling items of
 * the post use (Coomer videos have no poster of their own). A borrowed poster says nothing about which video it is, so its hash must
 * not decide that two videos are the same (see pipeline: posterShared).
 */
function borrowedPoster(row) {
  if (row.media_type !== 'video' || !row.preview_url) return false;
  // These adapters never have a poster of the video itself, and the pipeline marks every such video posterShared at ingest, but that
  // marker is not stored, so the sweep must know the platforms: an RSS video's poster is the entry's media:thumbnail (often channel
  // artwork reused by every entry, with no sibling row to show it); a Coomer video borrows its post's first picture or the creator's
  // banner, and the siblings of one post do NOT share a post_key (each attachment's source id ends in its own index), so a post with
  // a picture and several videos cannot be recognised through post_key either.
  if (row.platform === 'rss' || row.platform === 'coomer') return true;
  if (/\/(?:banners|icons)\//.test(row.preview_url)) return true;
  return !!(row.post_key && siblingPoster.get(row.post_key, row.id, row.preview_url));
}

async function hashSweep({ limit = 12, settings } = {}) {
  await dedupe.loadChunked().catch(() => {}); // a sweep that starts during the boot build would read a partial index
  const s = settings || settingsStore.get();
  const res = { checked: 0, hashed: 0, collapsed: 0, errors: 0, done: false };
  let after = parseInt(repo.settings.get('hash_sweep_seq') || '0', 10) || 0;
  const rows = repo.db.prepare(`SELECT seq, id, creator_id, platform, post_key, source_url, author, community, posted_at, media_type, media_url, preview_url, thumbnail_url, width, height, phash FROM media NOT INDEXED
    WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  const byId = repo.db.prepare("SELECT seq FROM media WHERE id = ? AND publish_state IN ('published','review')");
  const touched = new Set(); // creators whose published set changed; recounted once at the end
  for (const row of rows) {
    after = row.seq; res.checked++;
    // setTimeout(0), not setImmediate: under a busy ingest the next Immediate can run before the
    // event loop answers HTTP, and a 48-row hash pass was showing up as a multi-second hashSweep block.
    await new Promise((res2) => setTimeout(res2, 0));
    if (borrowedPoster(row)) {
      // a hash the OLD sweep took from the borrowed poster is wrong: drop it, from the database and from the dedupe index, so it cannot
      // make an unrelated video with a similar poster look like a duplicate
      if (row.phash) { repo.media.setPhash(row.id, null); dedupe.forget(row.id); }
      continue;
    }
    let hash = row.phash;
    if (!hash) {
      const v = await imagefilter.checkItem({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url }, { faces: false, hash: true });
      if (!v.phash) { if (v.status === 'error') res.errors++; continue; }
      hash = v.phash; repo.media.setPhash(row.id, hash); res.hashed++;
    }
    if (!s.dedupe) { dedupe.remember(row.id, hash, { mediaType: row.media_type, width: row.width, height: row.height }); continue; }
    const hit = dedupe.check({ phash: hash, mediaType: row.media_type, width: row.width, height: row.height }, { distance: s.dedupeDistance, ignoreId: row.id }).dup;
    const orig = hit && byId.get(hit.id);
    if (orig && orig.seq < row.seq) {
      repo.media.addAltSource(hit.id, { platform: row.platform, source_url: row.source_url, author: row.author, community: row.community, posted_at: row.posted_at });
      // deferStats: collapsing dozens of dupes used to recount each creator on every hide and
      // stall the loop for seconds. One recount per touched creator runs after the pass.
      repo.media.setState(row.id, 'hidden', `duplicate of ${hit.id}`, { deferStats: true });
      if (row.creator_id) touched.add(row.creator_id);
      res.collapsed++;
    } else dedupe.remember(row.id, hash, { mediaType: row.media_type, width: row.width, height: row.height });
  }
  for (const id of touched) {
    await new Promise((res2) => setTimeout(res2, 0));
    repo.creators.refreshStats(id);
  }
  repo.settings.set('hash_sweep_seq', String(after));
  if (res.collapsed || res.hashed) events.log('OK', `Hash sweep: ${res.hashed} hashed, ${res.collapsed} duplicate(s) collapsed (of ${res.checked} checked)`);
  return res;
}

/**
 * Where does a video the old sweep hid come back to? The sweep hid items that were published OR waiting in the review queue, and
 * overwrote the reason of the latter with "duplicate of ...", so what it was is not recorded. Rather than publish what may have been
 * waiting for a person, the text gates are run again on what is stored: a safety "block" or a female / feminine scope verdict keeps
 * it hidden; a safety "review" rule, feminine-adjacent wording, or a stored scope other than "in" sends it to the review queue
 * (with the reason); only a row that passes every one is published.
 * @returns {{state: 'published'|'review'|'hidden', reason: string|null}}
 */
function restoreVerdict(r) {
  const saf = checkText(r.title, r.description, r.community, r.author, r.tags_text);
  if (saf.level === 'block') return { state: 'hidden', reason: null };
  const sc = classifyScope([r.title, r.description, r.community, r.author, r.tags_text], { trusted: true });
  if (sc.scope === 'excluded') return { state: 'hidden', reason: null };
  if (saf.level === 'review') return { state: 'review', reason: `safety:${saf.rule}` };
  if (sc.femaleSoft) return { state: 'review', reason: `scope:${sc.rule}` };
  if (r.scope && r.scope !== 'in') return { state: 'review', reason: `scope:${r.scope}` };
  return { state: 'published', reason: null };
}

/**
 * One-off repair for videos the hash sweep collapsed before it knew about borrowed posters: a Coomer or RSS video hidden as "duplicate
 * of X" where X is a video with the very same poster URL is a different video (the poster is shared: a creator banner, a post's
 * picture, channel artwork), so it comes back (see restoreVerdict for where to), and the stale hash of both is cleared. Nothing else
 * is touched. Idempotent.
 * @returns {{restored: number, toReview: number, kept: number}}
 */
function repairSharedPosterCollapse() {
  const rows = repo.db.prepare(`SELECT m.id, m.preview_url, m.review_reason, m.source_url, m.title, m.description, m.community, m.author, m.tags_text, m.scope FROM media m
    WHERE m.platform IN ('coomer', 'rss') AND m.media_type = 'video' AND m.publish_state = 'hidden' AND m.review_reason LIKE 'duplicate of %'`).all();
  const orig = repo.db.prepare('SELECT id, media_type, preview_url FROM media WHERE id = ?');
  const dropAlt = repo.db.prepare('DELETE FROM media_alt_sources WHERE media_id = ? AND source_url = ?');
  let restored = 0; let toReview = 0; let kept = 0;
  for (const r of rows) {
    const o = orig.get(String(r.review_reason).slice('duplicate of '.length).trim());
    if (!o || o.media_type !== 'video' || !r.preview_url || o.preview_url !== r.preview_url) continue;
    const verdict = restoreVerdict(r);
    repo.db.transaction(() => {
      repo.media.setPhash(r.id, null); repo.media.setPhash(o.id, null);
      dedupe.forget(r.id); dedupe.forget(o.id); // the index may already be loaded: the stale entries must go from it too
      if (r.source_url) dropAlt.run(o.id, r.source_url);
      if (verdict.state === 'hidden') repo.media.setState(r.id, 'hidden', 'poster-collapse: kept hidden by the safety/scope gates', { exact: true });
      else repo.media.setState(r.id, verdict.state, verdict.reason, { exact: true });
    })();
    if (verdict.state === 'published') restored++; else if (verdict.state === 'review') toReview++; else kept++;
  }
  if (restored || toReview) events.log('OK', `Restored ${restored} video(s) the duplicate sweep had collapsed on a shared poster${toReview ? `, ${toReview} more went to the review queue` : ''}`);
  return { restored, toReview, kept };
}

/**
 * One-off, after the repair above: clear the perceptual hash of EVERY video whose poster is borrowed (the old sweep took them from the
 * poster). The hash sweep clears these as its cursor reaches them, but on an upgraded database its cursor is already past them.
 * Chunked, yielding between chunks. Idempotent.
 * @returns {Promise<{cleared: number}>}
 */
async function clearBorrowedPosterHashes() {
  const rows = repo.db.prepare("SELECT id, platform, post_key, media_type, preview_url FROM media WHERE media_type = 'video' AND phash IS NOT NULL AND preview_url IS NOT NULL").all();
  let cleared = 0;
  for (let i = 0; i < rows.length; i += 500) {
    repo.db.transaction(() => {
      for (const r of rows.slice(i, i + 500)) if (borrowedPoster(r)) { repo.media.setPhash(r.id, null); dedupe.forget(r.id); cleared++; }
    })();
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (cleared) events.log('OK', `Cleared the perceptual hash of ${cleared} video(s) taken from a borrowed poster`);
  return { cleared };
}

function hashSweepProgress() {
  const cursor = parseInt(repo.settings.get('hash_sweep_seq') || '0', 10) || 0;
  const remaining = countCached("SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review') AND seq > ?", cursor).n;
  return { cursor, remaining, ...dedupe.stats() };
}

function imageSweepProgress() {
  const cursor = parseInt(repo.settings.get('image_sweep_seq') || '0', 10) || 0;
  const q = (cmp) => countCached(`SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review') AND seq ${cmp} ?`, cursor).n;
  return { cursor, checkedUpTo: q('<='), remaining: q('>'), version: IMAGE_SWEEP_VERSION };
}

/* ------------------------------------------------------------- face enrolment */
/**
 * Newest-first face enrolment for the existing library. New posts get descriptors at ingest; this
 * sweep gives old posts the same treatment, starting with the freshest so active creators become
 * matchable quickly. `face_at` marks every attempt, successful or not, so a dead picture is not
 * downloaded every minute. Vectors live in `media_faces`; takedown purges them.
 */
/**
 * One pass over the library, oldest first (cursor `face_backfill_seq`): published rows stamped `face_at` with no face
 * vectors stored are given back to the face sweep (face_at cleared), at most `limit` per call. They were stamped while in
 * review (vectors are only saved for published rows), so they were never enrolled. Each row is cleared at most once: the
 * cursor moves past it, so a picture that truly has no face is re-checked once by the sweep and then keeps its stamp.
 * This only clears a column; the face sweep still reads pictures at its own rate.
 */
const FACE_BACKFILL_DONE = 'done';
// One call reads at most this many rowids of media. The old query sorted every published row (temporary B-tree) on
// each call, every minute: up to 25 s of blocked event loop on production.
const FACE_BACKFILL_WINDOW = 20000;
function faceBackfill({ limit = 200, window = FACE_BACKFILL_WINDOW } = {}) {
  const at = repo.settings.get('face_backfill_seq');
  if (at === FACE_BACKFILL_DONE) return { cleared: 0, done: true };
  const after = parseInt(at || '0', 10) || 0;
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  const top = (repo.db.prepare('SELECT MAX(seq) AS m FROM media').get() || {}).m || 0;
  const to = after + Math.max(1, Number(window) || FACE_BACKFILL_WINDOW);
  // rowid range, NOT INDEXED: no sort, and never more than one window of rows per statement
  const rows = after >= top ? [] : repo.db.prepare(`SELECT seq, id FROM media NOT INDEXED
    WHERE seq > ? AND seq <= ? AND publish_state = 'published' AND face_at IS NOT NULL AND scope != 'excluded'
      AND NOT EXISTS (SELECT 1 FROM media_faces f WHERE f.media_id = media.id)
    ORDER BY seq LIMIT ?`).all(after, to, cap);
  if (rows.length) {
    const clear = repo.db.prepare('UPDATE media SET face_at = NULL WHERE id = ?');
    repo.db.transaction(() => { for (const r of rows) clear.run(r.id); })();
  }
  // A full batch resumes after its last row; otherwise the whole window is done and the next call starts after it.
  const next = rows.length >= cap ? rows[rows.length - 1].seq : to;
  const done = rows.length < cap && next >= top;
  repo.settings.set('face_backfill_seq', done ? FACE_BACKFILL_DONE : String(next));
  return { cleared: rows.length, done };
}

async function faceSweep({ limit = 12, settings } = {}) {
  const s = settings || settingsStore.get();
  const res = { checked: 0, enrolled: 0, errors: 0, done: false };
  if (!s.faceMatch) return { ...res, off: true };
  if (!(await imagefilter.available())) return { ...res, unavailable: true };
  try { res.backfill = faceBackfill().cleared; } catch { /* the backfill must never stop the sweep */ }
  // Newest ingested first, in the order of v28's partial index: ORDER BY posted_at sorted every un-enrolled published
  // row into a temp B-tree each minute (34-83 s main-thread stalls on production).
  const rows = repo.db.prepare(`SELECT id, media_type, media_url, preview_url, thumbnail_url
    FROM media INDEXED BY ix_media_face_todo
    WHERE face_at IS NULL AND publish_state = 'published' AND scope != 'excluded'
      AND (media_type = 'image' OR preview_url IS NOT NULL OR thumbnail_url IS NOT NULL)
    ORDER BY seq DESC LIMIT ?`).all(Math.max(1, Math.min(120, Number(limit) || 12)));
  if (!rows.length) return { ...res, done: true };
  for (const row of rows) {
    res.checked++;
    // Hand the event loop a turn between pictures: when the model runs in-process (IMAGE_WORKERS=0, or a
    // worker pool that could not start) inference is synchronous, and a whole pass in one go was a 14 s stall.
    await new Promise((res2) => setImmediate(res2));
    const now = new Date().toISOString();
    let v;
    try {
      v = await imagefilter.checkItem({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url }, { faces: true, hash: false });
    } catch { res.errors++; repo.db.prepare('UPDATE media SET face_at = ? WHERE id = ?').run(now, row.id); continue; }
    if (v.status === 'error' || v.status === 'unavailable') res.errors++;
    if (v.faceList && v.faceList.length) {
      try { res.enrolled += faceMatch.saveMediaFaces(row.id, v.faceList); } catch { /* best effort */ }
    }
    repo.db.prepare('UPDATE media SET face_at = ? WHERE id = ?').run(now, row.id);
  }
  return res;
}

function faceSweepProgress() {
  const row = countCached("SELECT COUNT(*) AS remaining FROM media WHERE face_at IS NULL AND publish_state = 'published' AND scope != 'excluded' AND (media_type = 'image' OR preview_url IS NOT NULL OR thumbnail_url IS NOT NULL)");
  const faces = countCached('SELECT COUNT(DISTINCT media_id) AS media, COUNT(*) AS descriptors FROM media_faces');
  return { remaining: row.remaining, ...faces };
}

let sweepTimer = null; let sweepBusy = false; let sweepGaveUp = false;
const RETIRE_EVERY_MS = 24 * 3600 * 1000;
const RETIRE_RETRY_MS = 3600 * 1000;
/**
 * Once a day (the time of the last run is stored, so a restart does not start a second round): pause the app's own feeds that
 * never worked (see sourcehealth.retireDead). Nothing is recorded while the setting is off, so switching it on runs it at once.
 */
function retireDeadFeeds(now = Date.now()) {
  if (!settingsStore.get().autoRetireFeeds) return null;
  const last = Date.parse(repo.settings.get('auto_retire_last') || '') || 0;
  if (last <= now && now - last < RETIRE_EVERY_MS) return null; // (a stored time in the future, after a clock step, is stale)
  let r;
  try {
    r = require('./sourcehealth').retireDead({ now });
  } catch (e) {
    // a failed pass is retried in an hour (not next minute, which would repeat a persistent error 1,440 times a day, and not
    // tomorrow, which would let one transient database error switch the step off for a day)
    repo.settings.set('auto_retire_last', new Date(now - RETIRE_EVERY_MS + RETIRE_RETRY_MS).toISOString());
    throw e;
  }
  repo.settings.set('auto_retire_last', new Date(now).toISOString()); // recorded only once the pass has worked
  if (r.paused.length) events.log('INFO', `Feeds paused (stopped working): ${r.paused.length}${r.capped ? ' (daily cap reached)' : ''} — ${r.paused.slice(0, 5).map((f) => `${f.platform}:${f.target}`).join(', ')}${r.paused.length > 5 ? ', …' : ''}. Admin → Sources lists them; enabling one keeps it on.`);
  return r;
}
/** Slow background loop: a few items a minute, only while there is work and the model is usable. */
function startImageSweep() {
  if (sweepTimer) return;
  const blockwatch = require('../lib/blockwatch');
  sweepTimer = setInterval(async () => {
    try { retireDeadFeeds(); } catch (e) { events.log('WARN', `Feed retirement: ${e.message}`); }
    if (sweepBusy) return;
    const s = settingsStore.get();
    // Face enrolment gets its own small newest-first pass even when the image sweep is off: it is
    // what makes creator matching useful on the existing library.
    if (s.faceMatch && s.faceSweepPerMinute > 0) {
      sweepBusy = true;
      try { await blockwatch.around('faceSweep', () => faceSweep({ limit: s.faceSweepPerMinute, settings: s })); } catch (e) { events.log('WARN', `Face sweep: ${e.message}`); } finally { sweepBusy = false; }
    }
    // The lean-preference bias pass needs no model and no network: pure word/score reads, a bounded chunk a minute.
    if (s.leanPreference) {
      sweepBusy = true;
      try { await blockwatch.around('leanBias', () => leanBiasSweep({ limit: 4000, settings: s })); } catch (e) { events.log('WARN', `Lean bias sweep: ${e.message}`); } finally { sweepBusy = false; }
    }
    // Universal whole-web sweep: every hour a couple of creators get a deep pull (seeds first),
    // so nobody's coverage depends on somebody searching for him. Kicks are fire-and-forget.
    if (s.deepPullPerHour > 0) {
      const lastRotate = parseInt(repo.settings.get('deepsearch_rotate_at') || '0', 10) || 0;
      if (Date.now() - lastRotate > 60 * 60 * 1000) {
        repo.settings.set('deepsearch_rotate_at', String(Date.now()));
        try { deepsearch.rotate({ limit: s.deepPullPerHour }); } catch (e) { events.log('WARN', `Deep-pull rotation: ${e.message}`); }
      }
    }
    if (!s.imageSweep || !s.imageSweepPerTick) return;
    sweepBusy = true;
    try {
      // Same bite as the image sweep (was 2×): a bigger hash pass hid many rows and recounted each
      // creator mid-tick. With deferred recounts the bite can grow again once p99 stays quiet.
      if (s.dedupe) await blockwatch.around('hashSweep', () => hashSweep({ limit: s.imageSweepPerTick, settings: s }));
      if ((!s.imageFilter && !s.physiqueFilter) || sweepGaveUp) return;
      if (!(await imagefilter.available())) { sweepGaveUp = true; return; } // logged once by the filter itself
      // The body sweep reads faces in the same pass, so while it has work the face-only sweep would download and analyse the
      // same pictures a second time: let the body sweep go first and move the face sweep's cursor along with it.
      if (s.physiqueFilter) {
        const cursor = (k) => parseInt(repo.settings.get(k) || '0', 10) || 0;
        const before = cursor('physique_sweep_seq');
        const r = await blockwatch.around('physiqueSweep', () => physiqueSweep({ limit: s.imageSweepPerTick, settings: s }));
        if (!r.done) {
          // only when the face sweep had reached the same point: the rows in between were just checked for faces too
          if (s.imageFilter && repo.settings.get('image_sweep_version') === IMAGE_SWEEP_VERSION && cursor('image_sweep_seq') >= before) {
            repo.settings.set('image_sweep_seq', String(Math.max(cursor('image_sweep_seq'), cursor('physique_sweep_seq'))));
          }
          return;
        }
      }
      if (s.imageFilter) await blockwatch.around('imageSweep', () => imageSweep({ limit: s.imageSweepPerTick, settings: s }));
    } catch (e) { events.log('WARN', `Image sweep: ${e.message}`); } finally { sweepBusy = false; }
  }, 60 * 1000);
  sweepTimer.unref();
}
function stopImageSweep() { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = null; }

/** Run the safety sweep once per rule-set version, in the background after boot. */
function startupSweepIfNeeded() {
  setTimeout(() => {
    try {
      physique.migrateDefaults();
      // The body filter is OFF in production and unchanged across most deploys. Re-applying it walks every
      // measured picture and every creator with a physique row, on the boot path where the health probe is
      // still settling (a multi-second main-thread pass). Run it only when the on/off state or threshold changed.
      const s = settingsStore.get();
      const sig = `${physique.enabled(s) ? 1 : 0}|${physique.threshold(s)}`;
      if (String(repo.settings.get('physique_boot_reapply_sig') || '') !== sig) {
        physique.reapply(s);
        repo.settings.set('physique_boot_reapply_sig', sig);
      }
    } catch (e) { events.log('WARN', `Body filter: ${e.message}`); }
    physique.textSweep(settingsStore.get()).catch((e) => events.log('WARN', `Body filter: ${e.message}`));
  }, 3000).unref();
  setTimeout(() => {
    try {
      if (repo.settings.get('shared_poster_repair') !== '1') { repairSharedPosterCollapse(); repo.settings.set('shared_poster_repair', '1'); }
      if (repo.settings.get('shared_poster_hash_clear') !== '1') clearBorrowedPosterHashes().then(() => repo.settings.set('shared_poster_hash_clear', '1')).catch((e) => events.log('WARN', `Borrowed-poster hashes: ${e.message}`));
    } catch (e) { events.log('WARN', `Shared-poster repair: ${e.message}`); }
  }, 4000).unref();
  if (repo.settings.get('safety_sweep_version') === SAFETY_SWEEP_VERSION) return;
  setTimeout(async () => {
    try { await sweep(); repo.settings.set('safety_sweep_version', SAFETY_SWEEP_VERSION); }
    catch (e) { events.log('ERR', `startup sweep failed: ${e.message}`); }
  }, 1500).unref();
}

module.exports = { _progressCache: { clear: () => progressCache.clear(), setClock: (fn) => { progressClock = fn || (() => Date.now()); }, ttlMs: PROGRESS_TTL_MS }, clearBorrowedPosterHashes, repairSharedPosterCollapse, retireDeadFeeds, sweep, startupSweepIfNeeded, imageSweep, imageSweepProgress, faceSweep, faceSweepProgress, faceBackfill, physiqueSweep, physiqueSweepProgress, leanBiasSweep, leanBiasProgress, clearLeanBias, hashSweep, hashSweepProgress, startImageSweep, stopImageSweep };
