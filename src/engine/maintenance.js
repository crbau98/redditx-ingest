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
const physique = require('./physique');
const settingsStore = require('../settings');

// Bump whenever the safety or male-only scope rules get stricter: existing libraries are re-swept once.
// v3: male-only scope (female / feminine / trans-feminine content is removed and blocklisted).
const SAFETY_SWEEP_VERSION = '3';

async function sweep({ probe = false, limit = 1_000_000 } = {}) {
  const res = { checked: 0, blocked: 0, review: 0, hidden: 0, dead: 0, female: 0, femaleReview: 0, femaleCreators: 0, femaleFeeds: 0 };
  let after = 0;
  const stmt = repo.db.prepare(`SELECT seq, id, platform, title, description, tags_text, community, author, media_url, media_type, publish_state
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
  const rows = repo.db.prepare(`SELECT seq, id, creator_id, media_type, media_url, preview_url, thumbnail_url, publish_state, physique, review_reason, title, description, tags_text, community, author FROM media
    WHERE publish_state IN ('published','review','hidden') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  const creators = new Set();
  for (const row of rows) {
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

function physiqueSweepProgress() {
  const cursor = parseInt(repo.settings.get('physique_sweep_seq') || '0', 10) || 0;
  const remaining = repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review','hidden') AND seq > ?").get(cursor).n;
  return { cursor, remaining, version: PHYSIQUE_SWEEP_VERSION };
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
  const s = settings || settingsStore.get();
  const res = { checked: 0, hashed: 0, collapsed: 0, errors: 0, done: false };
  let after = parseInt(repo.settings.get('hash_sweep_seq') || '0', 10) || 0;
  const rows = repo.db.prepare(`SELECT seq, id, platform, post_key, source_url, author, community, posted_at, media_type, media_url, preview_url, thumbnail_url, width, height, phash FROM media
    WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT ?`).all(after, limit);
  if (!rows.length) { res.done = true; return res; }
  for (const row of rows) {
    after = row.seq; res.checked++;
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
  const remaining = repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review') AND seq > ?").get(cursor).n;
  return { cursor, remaining, ...dedupe.stats() };
}

function imageSweepProgress() {
  const cursor = parseInt(repo.settings.get('image_sweep_seq') || '0', 10) || 0;
  const q = (cmp) => repo.db.prepare(`SELECT COUNT(*) AS n FROM media WHERE publish_state IN ('published','review') AND seq ${cmp} ?`).get(cursor).n;
  return { cursor, checkedUpTo: q('<='), remaining: q('>'), version: IMAGE_SWEEP_VERSION };
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
  sweepTimer = setInterval(async () => {
    try { retireDeadFeeds(); } catch (e) { events.log('WARN', `Feed retirement: ${e.message}`); }
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
  setTimeout(() => {
    try { physique.migrateDefaults(); physique.reapply(settingsStore.get()); } catch (e) { events.log('WARN', `Body filter: ${e.message}`); }
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

module.exports = { clearBorrowedPosterHashes, repairSharedPosterCollapse, retireDeadFeeds, sweep, startupSweepIfNeeded, imageSweep, imageSweepProgress, physiqueSweep, physiqueSweepProgress, hashSweep, hashSweepProgress, startImageSweep, stopImageSweep };
