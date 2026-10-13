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
const { femaleCheck } = require('../lib/scope');
const { hostBlocked, hostOf, isJunkTitle } = require('../lib/mediaurl');
const { probeMedia } = require('./probe');
const imagefilter = require('../lib/imagefilter');
const dedupe = require('../services/dedupe');
const physique = require('./physique');
const settingsStore = require('../settings');

// Bump whenever the safety or male-only scope rules get stricter: existing libraries are re-swept once.
// v3: male-only scope (female / feminine / trans-feminine content is removed and blocklisted).
const SAFETY_SWEEP_VERSION = '3';

async function sweep({ probe = false, limit = 1_000_000 } = {}) {
  const res = { checked: 0, blocked: 0, review: 0, hidden: 0, dead: 0, female: 0, femaleReview: 0, femaleCreators: 0, femaleFeeds: 0 };
  let after = 0;
  const stmt = repo.db.prepare(`SELECT seq, id, title, description, tags_text, community, author, media_url, media_type, publish_state
    FROM media WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT 500`);
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
      if (isJunkTitle(row.title) || (host && hostBlocked(host))) { repo.media.setState(row.id, 'hidden', 'junk'); res.hidden++; continue; }
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
  const res = { checked: 0, removed: 0, undecided: 0, errors: 0, done: false };
  if (repo.settings.get('image_sweep_version') !== IMAGE_SWEEP_VERSION) {
    repo.settings.set('image_sweep_version', IMAGE_SWEEP_VERSION); repo.settings.set('image_sweep_seq', '0');
  }
  let after = parseInt(repo.settings.get('image_sweep_seq') || '0', 10) || 0;
  const rows = repo.db.prepare(`SELECT seq, id, media_type, media_url, preview_url, thumbnail_url FROM media
    WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  for (const row of rows) {
    after = row.seq;
    const v = await imagefilter.checkItem({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url },
      { threshold: (s.imageFilterThreshold || 50) / 100 });
    res.checked++;
    if (v.female) { repo.media.block(row.id, 'image sweep: picture shows a woman', 'system'); res.removed++; }
    else if (v.status === 'error' || v.status === 'unavailable') res.errors++;
    else if (!v.decided) res.undecided++;
  }
  repo.settings.set('image_sweep_seq', String(after));
  if (res.removed) events.log('OK', `Image sweep: removed ${res.removed} of ${res.checked} checked (women in the picture)`);
  return res;
}

/* ------------------------------------------------------------- physique sweep */
const PHYSIQUE_SWEEP_VERSION = '1'; // bump to re-measure the whole library (e.g. after better anchors or a better model)

/**
 * Measure the build in stored pictures that have no physique score yet (oldest first, cursor `physique_sweep_seq`), hide the
 * heavy ones and re-judge their creators. Same model pass as the face check, so a woman found on the way is removed too.
 * Each picture is looked at once per sweep version: "no torso in view" stays NULL and is not retried.
 */
async function physiqueSweep({ limit = 12, settings } = {}) {
  const s = settings || settingsStore.get();
  const res = { checked: 0, measured: 0, hidden: 0, removed: 0, errors: 0, done: false };
  if (repo.settings.get('physique_sweep_version') !== PHYSIQUE_SWEEP_VERSION) {
    repo.settings.set('physique_sweep_version', PHYSIQUE_SWEEP_VERSION); repo.settings.set('physique_sweep_seq', '0');
  }
  let after = parseInt(repo.settings.get('physique_sweep_seq') || '0', 10) || 0;
  const rows = repo.db.prepare(`SELECT seq, id, creator_id, media_type, media_url, preview_url, thumbnail_url, publish_state FROM media
    WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  const creators = new Set();
  for (const row of rows) {
    const v = await imagefilter.checkItem({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url },
      { threshold: (s.imageFilterThreshold || 50) / 100, faces: s.imageFilter === true, body: true });
    // switched off while the model was busy (that request already re-showed everything): stop, and resume from this row later
    if (!settingsStore.get().physiqueFilter) { res.stopped = true; break; }
    after = row.seq; res.checked++;
    if (v.female) { repo.media.block(row.id, 'physique sweep: picture shows a woman', 'system'); res.removed++; continue; }
    if (v.status === 'error' || v.status === 'unavailable') { res.errors++; continue; }
    if (v.physique == null) continue;
    res.measured++;
    repo.media.setPhysique(row.id, v.physique);
    const verdict = row.publish_state === 'published' ? physique.stateFor(v.physique, s) : null;
    if (verdict) { repo.media.setState(row.id, verdict.state, verdict.reason, { exact: true }); imagefilter.noteHeavy(); res.hidden++; }
    if (row.creator_id) creators.add(row.creator_id);
  }
  for (const id of creators) physique.reviewCreator(id, s);
  repo.settings.set('physique_sweep_seq', String(after));
  if (res.hidden || res.removed) events.log('OK', `Body sweep: ${res.measured} of ${res.checked} measured · ${res.hidden} hidden (heavy)${res.removed ? ` · ${res.removed} removed (women)` : ''}`);
  return res;
}

function physiqueSweepProgress() {
  const cursor = parseInt(repo.settings.get('physique_sweep_seq') || '0', 10) || 0;
  const remaining = repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review') AND seq > ?").get(cursor).n;
  return { cursor, remaining, version: PHYSIQUE_SWEEP_VERSION };
}

/* ------------------------------------------------------------- hash sweep */
/**
 * Give every stored picture a perceptual hash (oldest first, cursor `hash_sweep_seq`) and collapse look-alikes: when a
 * picture matches an OLDER item, it is hidden and listed under the original as "also posted on ...". Hashing only needs
 * the image bytes (no model), so it is cheap and runs even when the face filter is unavailable.
 */
async function hashSweep({ limit = 12, settings } = {}) {
  const s = settings || settingsStore.get();
  const res = { checked: 0, hashed: 0, collapsed: 0, errors: 0, done: false };
  let after = parseInt(repo.settings.get('hash_sweep_seq') || '0', 10) || 0;
  const rows = repo.db.prepare(`SELECT seq, id, platform, source_url, author, community, posted_at, media_type, media_url, preview_url, thumbnail_url, width, height, phash FROM media
    WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  for (const row of rows) {
    after = row.seq; res.checked++;
    let hash = row.phash;
    if (!hash) {
      const v = await imagefilter.checkItem({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url }, { faces: false, hash: true });
      if (!v.phash) { if (v.status === 'error') res.errors++; continue; }
      hash = v.phash; repo.media.setPhash(row.id, hash); res.hashed++;
    }
    if (!s.dedupe) { dedupe.remember(row.id, hash, { mediaType: row.media_type, width: row.width, height: row.height }); continue; }
    const hit = dedupe.check({ phash: hash, mediaType: row.media_type, width: row.width, height: row.height }, { distance: s.dedupeDistance, ignoreId: row.id }).dup;
    const orig = hit && repo.db.prepare("SELECT seq FROM media WHERE id = ? AND publish_state IN ('published','review')").get(hit.id);
    if (orig && orig.seq < row.seq) {
      repo.media.addAltSource(hit.id, { platform: row.platform, source_url: row.source_url, author: row.author, community: row.community, posted_at: row.posted_at });
      repo.media.setState(row.id, 'hidden', `duplicate of ${hit.id}`);
      res.collapsed++;
    } else dedupe.remember(row.id, hash, { mediaType: row.media_type, width: row.width, height: row.height });
  }
  repo.settings.set('hash_sweep_seq', String(after));
  if (res.collapsed || res.hashed) events.log('OK', `Hash sweep: ${res.hashed} hashed, ${res.collapsed} duplicate(s) collapsed (of ${res.checked} checked)`);
  return res;
}

function hashSweepProgress() {
  const cursor = parseInt(repo.settings.get('hash_sweep_seq') || '0', 10) || 0;
  const remaining = repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review') AND seq > ?").get(cursor).n;
  return { cursor, remaining, ...dedupe.stats() };
}

function imageSweepProgress() {
  const cursor = parseInt(repo.settings.get('image_sweep_seq') || '0', 10) || 0;
  const q = (cmp) => repo.db.prepare(`SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review') AND seq ${cmp} ?`).get(cursor).n;
  return { cursor, checkedUpTo: q('<='), remaining: q('>'), version: IMAGE_SWEEP_VERSION };
}

let sweepTimer = null; let sweepBusy = false; let sweepGaveUp = false;
/** Slow background loop: a few items a minute, only while there is work and the model is usable. */
function startImageSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    if (sweepBusy) return;
    const s = settingsStore.get();
    if (!s.imageSweep || !s.imageSweepPerTick) return;
    sweepBusy = true;
    try {
      if (s.dedupe) await hashSweep({ limit: s.imageSweepPerTick * 2, settings: s });
      if ((!s.imageFilter && !s.physiqueFilter) || sweepGaveUp) return;
      if (!(await imagefilter.available())) { sweepGaveUp = true; return; } // logged once by the filter itself
      // The body sweep reads faces in the same pass, so while it has work the face-only sweep would download and analyse the
      // same pictures a second time: let the body sweep go first and move the face sweep's cursor along with it.
      if (s.physiqueFilter) {
        const cursor = (k) => parseInt(repo.settings.get(k) || '0', 10) || 0;
        const before = cursor('physique_sweep_seq');
        const r = await physiqueSweep({ limit: s.imageSweepPerTick, settings: s });
        if (!r.done) {
          // only when the face sweep had reached the same point: the rows in between were just checked for faces too
          if (s.imageFilter && repo.settings.get('image_sweep_version') === IMAGE_SWEEP_VERSION && cursor('image_sweep_seq') >= before) {
            repo.settings.set('image_sweep_seq', String(Math.max(cursor('image_sweep_seq'), cursor('physique_sweep_seq'))));
          }
          return;
        }
      }
      if (s.imageFilter) await imageSweep({ limit: s.imageSweepPerTick, settings: s });
    } catch (e) { events.log('WARN', `Image sweep: ${e.message}`); } finally { sweepBusy = false; }
  }, 60 * 1000);
  sweepTimer.unref();
}
function stopImageSweep() { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = null; }

/** Run the safety sweep once per rule-set version, in the background after boot. */
function startupSweepIfNeeded() {
  setTimeout(() => { physique.textSweep(settingsStore.get()).catch((e) => events.log('WARN', `Body filter: ${e.message}`)); }, 3000).unref();
  if (repo.settings.get('safety_sweep_version') === SAFETY_SWEEP_VERSION) return;
  setTimeout(async () => {
    try { await sweep(); repo.settings.set('safety_sweep_version', SAFETY_SWEEP_VERSION); }
    catch (e) { events.log('ERR', `startup sweep failed: ${e.message}`); }
  }, 1500).unref();
}

module.exports = { sweep, startupSweepIfNeeded, imageSweep, imageSweepProgress, physiqueSweep, physiqueSweepProgress, hashSweep, hashSweepProgress, startImageSweep, stopImageSweep };
