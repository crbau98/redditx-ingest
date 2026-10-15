'use strict';
/**
 * The per-item pipeline. Every raw item from every adapter goes through the
 * same ordered gates, so rules are enforced in exactly one place:
 *
 *   resolve -> safety -> leaks -> blocklist -> scope -> physique (text) -> media checks -> dedupe
 *           -> image (faces, physique, perceptual hash) -> keep (unstable video to the store) -> creator -> insert -> tags
 */
const crypto = require('crypto');
const repo = require('../db/repo');
const registry = require('../sources');
const { checkItem, checkText } = require('../lib/safety');
const { classify, femaleCheck } = require('../lib/scope');
const { canonicalUrl, hostOf, hostBlocked, hostTrusted, looksLikeDirectMedia, normalizeMediaUrl, isJunkTitle } = require('../lib/mediaurl');
const { probeMedia } = require('./probe');
const imagefilter = require('../lib/imagefilter');
const physique = require('./physique');
const dedupe = require('../services/dedupe');
const events = require('./events');
const leaks = require('../lib/leaks');
const paid = require('../lib/paid');
const takedowns = require('../lib/takedowns');
const { extractLinks } = require('../lib/links');
const vault = require('../lib/vault');

const SKIP_AUTHORS = new Set(['[deleted]', 'deleted', 'automoderator', 'web', 'null', 'undefined', '']);
const REDGIFS_PAGE = /redgifs\.com\/(?:watch|ifr)\//i;
const X_POST = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const cleanHandle = (a) => String(a || '').replace(/^[@/]+/, '').replace(/^u\//i, '').trim().slice(0, 80);

const HOST_WINDOW_MS = 20 * 60 * 1000;
const HOST_STRIKES = 2;
const hostState = new Map(); // host -> { ok, reason, at, strikes: Set(url) }
/**
 * Is this media host serving us? Only host-wide evidence closes a host for a window:
 *   - an explicit challenge (Cloudflare `cf-mitigated: challenge`) closes it at once;
 *   - 401/403 or an HTML page where media should be (a deleted, expired or gated single item looks the same) must be
 *     seen on TWO DIFFERENT urls before the host is considered walled.
 * A single suspicious answer skips only that item. Anything else (404 ...) is about one item and never counts.
 */
async function hostReachable(host, url, type) {
  const now = Date.now();
  const known = hostState.get(host);
  const fresh = known && now - known.at < HOST_WINDOW_MS;
  if (fresh && known.closed) return { ok: false, reason: known.reason };
  if (fresh && known.good) return { ok: true }; // one healthy probe vouches for the host for the window
  const p = await probeMedia(url, type);
  const suspicious = !p.ok && (p.challenge || /^http (401|403)\b|not media \(text\/html\)/.test(p.reason || ''));
  // Only a probe that actually fetched media vouches for the host. Timeouts, 404s and 5xx say nothing about a wall:
  // the item is let through (its own failure is its own business) but neither a strike nor a vouch is recorded.
  if (p.ok) { hostState.set(host, { closed: false, good: true, at: now, strikes: new Set() }); return { ok: true }; }
  if (!suspicious) return { ok: true };
  const st = fresh && !known.good ? known : { closed: false, good: false, at: now, strikes: new Set() };
  st.strikes.add(url);
  if (p.challenge || st.strikes.size >= HOST_STRIKES) {
    hostState.set(host, { closed: true, reason: p.reason, at: now, strikes: st.strikes });
    events.log('WARN', `Media host ${host} refuses this server (${p.reason}); skipping its items for ${HOST_WINDOW_MS / 60000} min`);
  } else hostState.set(host, st);
  return { ok: false, reason: p.reason };
}

const IMAGE_STRIKES_TO_BLOCK = 3;

/** Each excluded picture counts against the account that posted it; repeated offenders are blocked for good. */
function noteImageStrike(item, feed) {
  const handle = cleanHandle(item.author);
  if (!handle || SKIP_AUTHORS.has(handle.toLowerCase())) return;
  const key = `${feed.platform}:${handle.toLowerCase()}`;
  repo.logAction('account', key, 'image-female', 'picture shows a woman', 'system');
  const strikes = repo.db.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'account' AND target_id = ? AND action = 'image-female'").get(key).n;
  if (strikes < IMAGE_STRIKES_TO_BLOCK) return;
  const reason = `image filter: ${strikes} pictures with women`;
  const creator = (ownedByFeed(item, feed) ? repo.creators.get(feed.creator_id) : null) || repo.creators.byAccount(feed.platform, handle);
  if (creator && creator.status === 'active') { repo.creators.block(creator.id, reason, 'system'); events.log('WARN', `Creator ${creator.handle} blocked: ${reason}`); }
  else repo.blocklist.add('creator', key, reason);
}

/** Block the creator behind an item whose own profile text is female / feminine, and remember the account. */
function blockFemaleCreator(item, feed, rule) {
  const handle = cleanHandle(item.author);
  const key = handle && `${feed.platform}:${handle.toLowerCase()}`;
  const reason = `scope: ${rule || 'female'} (profile)`;
  let creator = null;
  if (ownedByFeed(item, feed)) creator = repo.creators.get(feed.creator_id);
  else if (handle) creator = repo.creators.byAccount(feed.platform, handle);
  if (creator && creator.status === 'active') {
    repo.creators.block(creator.id, reason, 'system');
    events.log('WARN', `Creator ${creator.handle} blocked: ${reason}`);
  } else if (key && !SKIP_AUTHORS.has(handle.toLowerCase())) {
    repo.blocklist.add('creator', key, reason);
  }
}

/**
 * A repost (Tumblr reblog, X retweet or quote, Bluesky repost, Reddit crosspost) carries somebody else's post. It belongs
 * to the ORIGINAL poster, not to the account whose feed we read, so the feed's own creator is not used for it.
 */
const ownedByFeed = (item, feed) => !!feed.creator_id && ['user', 'channel', 'feed', 'page'].includes(feed.kind) && !item.repostOf;

/**
 * Find an active known creator explicitly tagged or linked in a post's caption/links
 * (e.g. a collab partner, promo repost account, or feature post mentioning `onlyfans.com/<handle>`,
 * `fansly.com/<handle>`, `justfor.fans/<handle>`, or `@handle`).
 */
function mentionedKnownCreator(item, feed) {
  const authorClean = cleanHandle(item.author).toLowerCase();
  const blob = [item.title, item.text, item.description, item.altText, ...(item.links || [])].filter(Boolean).join('\n');
  if (!blob) return null;

  // 1. Check paid handles (onlyfans.com/<handle>, fansly.com/<handle>, justfor.fans/<handle>)
  for (const { service, handle } of paid.findPaidHandles(blob)) {
    const ownerRef = repo.onlyfans.ownerOf(handle, service);
    if (ownerRef) {
      const c = repo.creators.get(ownerRef.id);
      if (c && c.status === 'active' && c.scope !== 'excluded') return c;
    }
    const lead = repo.onlyfans.get(handle, service);
    if (lead && lead.creator_id) {
      const c = repo.creators.get(lead.creator_id);
      if (c && c.status === 'active' && c.scope !== 'excluded') return c;
    }
  }

  // 2. Check explicit profile links in text/links
  for (const l of extractLinks(blob)) {
    if (l.ingestable && l.kind === 'user' && l.target) {
      if (String(l.target).toLowerCase() === authorClean && l.platform === (feed && feed.platform)) continue;
      const c = repo.creators.byAccount(l.platform, l.target);
      if (c && c.status === 'active' && c.scope !== 'excluded') return c;
    }
  }

  // 3. Check @handle / u/handle mentions against active followed/paid creators on the same platform or aliases
  const handleRe = /(?:^|[\s(>])(?:@([A-Za-z0-9_]{3,30})(?!\.[A-Za-z0-9@])|\/?u\/([A-Za-z0-9_-]{3,30}))\b/g;
  let m;
  while ((m = handleRe.exec(blob))) {
    const h = (m[1] || m[2] || '').toLowerCase();
    if (!h || h === authorClean || SKIP_AUTHORS.has(h)) continue;
    const plat = m[2] ? 'reddit' : (feed && feed.platform) || 'x';
    const byAcc = repo.creators.byAccount(plat, h) || repo.creators.byAccount('x', h) || repo.creators.byAccount('reddit', h) || repo.creators.byAccount('redgifs', h);
    if (byAcc && byAcc.status === 'active' && byAcc.scope !== 'excluded') {
      const hasPaidOrBio = !!(byAcc.bio || (byAcc.links && byAcc.links.length) || byAcc.origin !== 'ingest');
      if (hasPaidOrBio) return byAcc;
    }
  }

  return null;
}

/** The creator this item belongs to, if one is already known (never creates one). */
function knownCreator(item, feed) {
  if (ownedByFeed(item, feed)) return repo.creators.get(feed.creator_id);
  if (['rss', 'web', 'linkinbio'].includes(feed.platform)) return mentionedKnownCreator(item, feed);
  const handle = cleanHandle(item.author);
  if (handle && !SKIP_AUTHORS.has(handle.toLowerCase())) {
    const direct = repo.creators.byAccount(feed.platform, handle);
    if (direct) return direct;
  }
  return mentionedKnownCreator(item, feed);
}

/** Which creator does this item belong to? May create one. */
function resolveCreator(item, feed, adapter) {
  // Feeds that belong to a specific creator (their profile, their RSS, their page).
  if (ownedByFeed(item, feed)) {
    const c = repo.creators.get(feed.creator_id);
    if (c) return c.status === 'active' ? c : { blocked: true };
  }
  const platform = feed.platform;
  if (['rss', 'web', 'linkinbio'].includes(platform) && !item.repostOf) {
    const mentioned = mentionedKnownCreator(item, feed);
    if (mentioned) return mentioned;
    // A site/feed with no creator yet becomes its own creator, owned by the feed.
    const name = cleanHandle(feed.label || item.author || new URL(feed.target).hostname);
    const c = repo.creators.create({ handle: name, displayName: item.author || name, origin: 'ingest' });
    repo.feeds.update(feed.id, { creatorId: c.id });
    feed.creator_id = c.id;
    return c;
  }
  const handle = cleanHandle(item.author);
  if (!SKIP_AUTHORS.has(handle.toLowerCase())) {
    if (repo.blocklist.has('creator', `${platform}:${handle}`)) return { blocked: true };
    const existing = repo.creators.byAccount(platform, handle);
    if (existing) {
      if ((feed.kind === 'channel' || (platform === 'telegram' && feed.kind === 'user')) && !feed.creator_id && !item.repostOf && existing.status === 'active') {
        repo.feeds.update(feed.id, { creatorId: existing.id });
        feed.creator_id = existing.id;
      }
      return existing.status === 'active' ? existing : { blocked: true };
    }
  }

  // If this public post tags or links an already-known creator (collab, promo repost, feature post),
  // attribute the item to that known creator and enqueue the posting profile for discovery.
  const mentioned = mentionedKnownCreator(item, feed);
  if (mentioned) {
    if (handle && !SKIP_AUTHORS.has(handle.toLowerCase()) && ['x', 'reddit', 'bluesky', 'redgifs', 'telegram', 'mastodon'].includes(platform)) {
      try {
        require('./discovery').consider(
          { platform, kind: 'user', target: handle, ingestable: true },
          'mention',
          mentioned.id,
          {
            displayName: item.authorName || null,
            bio: item.authorBio || item.title || item.text || null,
            avatarUrl: item.authorAvatar || null,
          },
        );
      } catch { /* best effort */ }
    }
    return mentioned;
  }

  if (SKIP_AUTHORS.has(handle.toLowerCase())) return null;
  // Creator-level safety: handle / display name.
  if (checkText(handle, item.authorName).level === 'block') return { blocked: true };

  const c = repo.creators.create({ handle, displayName: item.authorName || handle, avatarUrl: item.authorAvatar, origin: 'ingest' });
  if ((feed.kind === 'channel' || (platform === 'telegram' && feed.kind === 'user')) && !feed.creator_id && !item.repostOf) {
    repo.feeds.update(feed.id, { creatorId: c.id });
    feed.creator_id = c.id;
    if (feed.kind === 'channel') return c;
  }
  const a = adapter || registry.get(platform);
  if (a && a.kinds.includes('user')) {
    repo.feeds.upsert({
      platform, kind: 'user', target: handle, creatorId: c.id, enabled: 0, trusted: 1, origin: 'ingest',
      intervalMin: (a.intervalMin && a.intervalMin.user) || 240, runNow: false,
    });
  }
  return c;
}

/**
 * @returns {Promise<{outcome: 'added'|'dupe'|'blocked'|'review'|'hidden'|'skipped'|'excluded', reason?: string, mediaId?: string, creatorId?: string}>}
 */
async function processItemInner(rawItem, feed, adapter, settings) {
  const item = { ...rawItem, tags: [...(rawItem.tags || [])] };
  const platform = feed.platform;

  // ---- 0. shape ------------------------------------------------------------
  if (!item.mediaUrl || typeof item.mediaUrl !== 'string') return { outcome: 'skipped', reason: 'no media url' };
  item.mediaUrl = normalizeMediaUrl(item.mediaUrl);
  if (!item.mediaUrl || !/^https?:\/\//i.test(item.mediaUrl)) return { outcome: 'skipped', reason: 'unusable url' };
  if (item.mediaType !== 'image' && item.mediaType !== 'video') return { outcome: 'skipped', reason: 'unknown type' };

  // ---- 1. resolve indirect links (RedGIFs pages etc.) ------------------------
  if (item.resolve === 'redgifs' || REDGIFS_PAGE.test(item.mediaUrl)) {
    let resolved = null;
    try { resolved = await registry.get('redgifs').resolve(item.mediaUrl); } catch { /* handled below */ }
    if (!resolved) return { outcome: 'skipped', reason: 'unresolved redgifs link' };
    Object.assign(item, {
      mediaUrl: resolved.mediaUrl, previewUrl: resolved.previewUrl || item.previewUrl, mediaType: resolved.mediaType,
      hasAudio: resolved.hasAudio, width: resolved.width || item.width, height: resolved.height || item.height,
      duration: resolved.duration || item.duration, trusted: true,
    });
    item.tags.push(...(resolved.tags || []));
  }

  // A link to one X post (a Reddit link post, a Telegram message...): read its media keylessly (fxtwitter / X embed API).
  if (item.resolve === 'x' || X_POST.test(item.mediaUrl)) {
    let resolved = null;
    try { resolved = await registry.get('x').resolve(item.mediaUrl.replace(/\/\/(?:www\.|mobile\.)?(?:fxtwitter|vxtwitter|fixupx|twitter)\.com\//i, '//x.com/')); } catch { /* handled below */ }
    if (!resolved) return { outcome: 'skipped', reason: 'unresolved X link' };
    Object.assign(item, {
      mediaUrl: resolved.mediaUrl, previewUrl: resolved.previewUrl || item.previewUrl, mediaType: resolved.mediaType,
      hasAudio: resolved.hasAudio, width: resolved.width || item.width, height: resolved.height || item.height, trusted: true,
    });
    item.tags.push(...(resolved.tags || []));
  }

  // ---- 2. safety (never bypassable) ---------------------------------------------
  const safety = checkItem(item);
  if (safety.level === 'block') return { outcome: 'blocked', reason: `safety:${safety.rule}` };

  // ---- 2b. leaked paid content (never bypassable) -----------------------------------
  // Reposts of public posts are fine from anywhere; leak sites, file lockers and posts that sell themselves as leaks are not.
  const leak = leaks.checkItem(item);
  if (leak) return { outcome: 'blocked', reason: leak.rule };

  // ---- 2c. creator takedowns & opt-outs (never bypassable) --------------------------
  const tdHit = takedowns.checkItem(item, feed);
  if (tdHit) return { outcome: 'blocked', reason: 'takedown' };

  // ---- 3. blocklist -----------------------------------------------------------
  const sourceKey = `${platform}:${item.sourceId}:${item.position || 0}`;
  const hash = md5(canonicalUrl(item.mediaUrl));
  if (repo.blocklist.has('hash', hash) || repo.blocklist.has('source_key', sourceKey)) return { outcome: 'blocked', reason: 'blocklisted' };

  // A creator that is already hidden or blocked would be refused at step 7 anyway: refuse now, and let known male
  // creators / active paid-page leads carry their profile context into step 4 so short promo captions are not dropped.
  const known = knownCreator(item, feed);
  if (known && known.status !== 'active') return { outcome: 'blocked', reason: 'creator blocked' };
  if (known && takedowns.checkItem(item, feed, null, known)) return { outcome: 'blocked', reason: 'takedown' };
  const paidHandles = paid.findPaidHandles([item.title, item.text, item.altText, item.authorBio, ...(item.links || [])].filter(Boolean).join('\n'));
  let paidTrusted = false;
  const extraScopeTexts = [];
  if (known) {
    if (known.display_name) extraScopeTexts.push(known.display_name);
    if (known.bio) extraScopeTexts.push(known.bio);
    if (known.scope === 'in' && (paidHandles.length > 0 || known.origin !== 'ingest' || (known.links && known.links.length > 0))) {
      paidTrusted = true;
    }
  }
  for (const { service, handle } of paidHandles) {
    const ownerRef = repo.onlyfans.ownerOf(handle, service);
    const owner = ownerRef ? repo.creators.get(ownerRef.id) : null;
    if (owner && owner.status !== 'active') return { outcome: 'blocked', reason: 'creator blocked' };
    if (owner && owner.status === 'active' && owner.scope !== 'excluded') {
      if (owner.display_name) extraScopeTexts.push(owner.display_name);
      if (owner.bio) extraScopeTexts.push(owner.bio);
      paidTrusted = true;
    }
    const lead = repo.onlyfans.get(handle, service);
    if (lead && lead.status === 'rejected') continue;
    if (lead && lead.status !== 'rejected') {
      if (lead.display_name) extraScopeTexts.push(lead.display_name);
      if (lead.bio) extraScopeTexts.push(lead.bio);
      paidTrusted = true;
    }
  }
  if (!paidTrusted && paidHandles.length && (feed.kind === 'user' || feed.kind === 'channel' || (known && known.scope !== 'excluded'))) {
    paidTrusted = true;
  }
  const effectiveTrusted = !!feed.trusted || paidTrusted;

  // ---- 4. scope: is this male-focused? ---------------------------------------------
  const sc = classify(
    [item.title, item.text, item.altText, item.community, item.author, item.authorName, item.authorBio, item.tags, item.labels, ...extraScopeTexts],
    { trusted: effectiveTrusted, screen: [item.query] },
  );
  if (sc.scope === 'excluded') {
    // A female / feminine person (handle, display name or bio) is removed as a creator, not just per post:
    // their other posts, their feeds and their other accounts never come back.
    if (femaleCheck(item.author, item.authorName, item.authorBio).level === 'hard') blockFemaleCreator(item, feed, sc.rule);
    return { outcome: 'excluded', reason: sc.rule || 'not male-focused' };
  }

  // (femaleSoft items DO have male evidence of their own: they are kept for a human, see below.)
  // An open search / tag feed that shows no male evidence at all is dropped instead of piling up in the review queue
  // (a "gay" search returns mostly women on some platforms). Set "Unclear items from open feeds" to review to keep them.
  if (sc.scope === 'uncertain' && !sc.femaleSoft && !effectiveTrusted && settings.scopeMode === 'strict' && settings.untrustedUnclear === 'drop') return { outcome: 'excluded', reason: 'scope:no male signal' };

  // ---- 4b. physique (text): "chubby", "superchub", "gainer", "dad bod" ... ----------------------
  // Only fit / athletic bodies are shown. Words in the item's own text exclude it before anything is downloaded; the same
  // words in the poster's handle / name / bio hide the creator as well (soft: reversible from the admin console).
  if (physique.enabled(physique.live(settings))) {
    const pt = physique.textCheck(item.title, item.text, item.altText, item.community, item.author, item.authorName, item.authorBio, item.tags, item.labels);
    if (pt.heavy) {
      if (physique.textCheck(item.author, item.authorName, item.authorBio).heavy) {
        const c = knownCreator(item, feed);
        if (c) physique.hideCreator(c, `body filter: profile says "${pt.rule.slice(physique.REASON.length)}"`);
      }
      return { outcome: 'excluded', reason: pt.rule };
    }
  }

  // ---- 5. media sanity ---------------------------------------------------------
  if (isJunkTitle(item.title)) return { outcome: 'skipped', reason: 'junk title' };
  const mediaHost = hostOf(item.mediaUrl);
  // YouTube is thumbnail-only via official RSS: allow its image hosts (watch pages are never media URLs here).
  if (hostBlocked(mediaHost, platform)) return { outcome: 'skipped', reason: `blocked host ${mediaHost}` };
  const isHls = /\.m3u8(\?|$)/i.test(item.mediaUrl);
  if (!item.trusted && !hostTrusted(mediaHost) && !looksLikeDirectMedia(item.mediaUrl)) return { outcome: 'skipped', reason: `unknown host ${mediaHost}` };
  if (settings.probeUnknownHosts && !isHls && (item.probe || (!item.trusted && !hostTrusted(mediaHost)))) {
    const p = await probeMedia(item.mediaUrl, item.mediaType);
    if (!p.ok) return { outcome: 'skipped', reason: `probe: ${p.reason}` };
  }

  // Federated media hosts (Lemmy/Misskey/PeerTube instances ...) are trusted for *what* they serve but may refuse *this
  // server* (Cloudflare challenge, hotlink block). Publishing items nobody can load is worse than skipping them, so each
  // such host is probed once per window and its items are skipped while it is walled off.
  if (settings.hostReachability === true && item.trusted && !hostTrusted(mediaHost) && !isHls) {
    const reach = await hostReachable(mediaHost, item.mediaUrl, item.mediaType);
    if (!reach.ok) return { outcome: 'skipped', reason: `unreachable host ${mediaHost}: ${reach.reason}` };
  }

  // ---- 6. dedupe ----------------------------------------------------------------
  if (repo.media.hashExists(hash) || repo.media.keyExists(sourceKey)) return { outcome: 'dupe' };

  // ---- 6a. fetch the media into our own storage -----------------------------------------
  // Sources whose files cannot be hotlinked (Telegram) hand over a `materialize()` instead of a finished URL. It runs only now,
  // after the cheap text gates and the duplicate check, so rejected posts never cost a download or any storage.
  // A source that can stage() first hands over just the picture the checks below need, and the upload waits until they pass.
  const failed = (e) => ({ outcome: 'skipped', reason: `download: ${String(e.message || e).slice(0, 160)}` });
  let materializeLater = false;
  if (typeof item.materialize === 'function') {
    try {
      materializeLater = typeof item.stage === 'function' && await item.stage(item);
      if (!materializeLater) await item.materialize(item);
    } catch (e) { return failed(e); }
  }

  // ---- 6b. image filter: is there a woman in the picture? ---------------------------
  // Text can say nothing at all about a photo, so the picture itself is checked (on-device face + gender model).
  // No face / no image / model unavailable = no verdict: the text gates above already decided.
  // The picture is downloaded ONCE and read twice: faces (policy: women are excluded) and a perceptual hash
  // (policy: the same picture posted again collapses into one item).
  // With the body filter on, the same model pass also measures the build (pose + silhouette): see engine/physique.
  const wantFaces = settings.imageFilter === true;
  const wantHash = settings.dedupe === true;
  const wantBody = physique.enabled(physique.live(settings));
  let phash = null;
  let physiqueScore = null;
  if (wantFaces || wantHash || wantBody) {
    const ir = await imagefilter.checkItem(item, { threshold: (settings.imageFilterThreshold || 50) / 100, faces: wantFaces, hash: wantHash, body: wantBody });
    if (ir.female) {
      repo.blocklist.add('hash', hash, 'image filter: female face');
      dedupe.blockHash(ir.phash, 'image filter: female face'); // the same picture under another URL is refused without another look
      noteImageStrike(item, feed);
      return { outcome: 'excluded', reason: 'image:female-face' };
    }
    phash = wantHash ? ir.phash : null;
    physiqueScore = ir.physique;
  }

  // ---- 6c. perceptual duplicates -----------------------------------------------------
  if (phash) {
    const d = dedupe.check({ phash, mediaType: item.mediaType, width: item.width, height: item.height }, { distance: settings.dedupeDistance == null ? 6 : settings.dedupeDistance });
    if (d.blocked) return { outcome: 'blocked', reason: 'blocklisted (a picture that was removed)' };
    if (d.dup) {
      // Same picture, somewhere else: keep ONE item and remember where else it appeared.
      repo.media.addAltSource(d.dup.id, { platform, source_url: item.permalink || item.mediaUrl, author: item.author ? cleanHandle(item.author) : null, community: item.community || null, posted_at: item.postedAt || null });
      return { outcome: 'dupe', reason: `similar picture (${d.dup.id.slice(0, 8)}, distance ${d.dup.p}/${d.dup.d})`, mediaId: d.dup.id };
    }
  }

  if (materializeLater) {
    try { await item.materialize(item); } catch (e) { return failed(e); }
  }

  // ---- 7. creator -----------------------------------------------------------------
  const creator = resolveCreator(item, feed, adapter);
  if (creator && creator.blocked) return { outcome: 'blocked', reason: 'creator blocked' };
  if (creator && takedowns.checkItem(item, feed, null, creator)) return { outcome: 'blocked', reason: 'takedown' };

  // ---- 7b. keep: a video whose link will expire (and that no source can refresh) is copied to the object store now, so it
  // still plays inside PRISM next week. Best effort: when the copy fails or the file is too big, the original link is kept.
  let keptKey = null;
  if (vault.wanted(item, platform, settings)) {
    const kept = await vault.keep(item, { sourceKey, maxMb: settings.keepVideoMaxMb });
    if (kept) { item.mediaUrl = kept.url; item.hlsUrl = null; keptKey = kept.key; }
  }

  // ---- 8. publish state --------------------------------------------------------------
  let state = 'published';
  let reviewReason = null;
  if (safety.level === 'review') { state = 'review'; reviewReason = `safety:${safety.rule}`; }
  else if (sc.femaleSoft) { state = 'review'; reviewReason = `scope:${sc.rule}`; } // feminine-adjacent wording: a human decides, whatever the feed trust or scope mode
  else if (sc.scope === 'uncertain' && settings.scopeMode === 'strict') { state = 'review'; reviewReason = 'scope:unclear'; }
  const body = physique.live(settings); // the model pass can be slow: judge with the body-filter settings as they are now
  const bodyVerdict = state === 'published' ? physique.stateFor(physiqueScore, body) : null;
  if (bodyVerdict) { state = bodyVerdict.state; reviewReason = bodyVerdict.reason; imagefilter.noteHeavy(); } // kept, hidden: the threshold can move

  const description = item.text && item.text !== item.title ? item.text.slice(0, 500) : null;
  const tags = [...item.tags, item.community, platform, item.query];
  const mediaId = repo.media.insert({
    creator_id: creator ? creator.id : null,
    feed_id: feed.id,
    platform,
    source_id: String(item.sourceId).slice(0, 200),
    source_key: sourceKey,
    post_key: `${platform}:${item.sourceId}`,
    position: item.position || 0,
    source_url: item.permalink || item.mediaUrl,
    community: item.community || null,
    author: item.author ? cleanHandle(item.author) : null,
    title: item.title ? String(item.title).slice(0, 300) : null,
    description,
    media_type: item.mediaType,
    media_url: item.mediaUrl,
    preview_url: item.previewUrl || null,
    thumbnail_url: item.thumbnailUrl || null,
    hls_url: item.hlsUrl || (isHls ? item.mediaUrl : null),
    has_audio: item.hasAudio ? 1 : 0,
    width: Number.isFinite(item.width) ? Math.round(item.width) : null,
    height: Number.isFinite(item.height) ? Math.round(item.height) : null,
    duration: Number.isFinite(item.duration) ? item.duration : null,
    score: Math.max(0, Math.round(item.score || 0)),
    hash,
    nsfw_level: item.nsfw === 'suggestive' ? 'suggestive' : 'explicit',
    scope: sc.scope,
    publish_state: state,
    review_reason: reviewReason,
    posted_at: item.postedAt || new Date().toISOString(),
    phash,
    physique: physiqueScore,
  }, tags);
  if (!mediaId) {
    if (keptKey) require('../lib/objectstore').remove(keptKey).catch(() => {}); // the copy belongs to nobody
    return { outcome: 'dupe' };
  }
  if (phash && (state === 'published' || state === 'review' || bodyVerdict)) dedupe.remember(mediaId, phash, { mediaType: item.mediaType, width: item.width, height: item.height });

  if (physiqueScore != null && creator) physique.reviewCreator(creator.id, body); // consistently heavy creators drop out too

  if (state === 'published') events.newItems(1);
  if (state === 'hidden') return { outcome: 'hidden', mediaId, creatorId: creator ? creator.id : null, reason: reviewReason };
  return { outcome: state === 'review' ? 'review' : 'added', mediaId, creatorId: creator ? creator.id : null, reason: reviewReason };
}

/**
 * Run one item through every gate. Anything a source stored for the item (`discard()`) is removed again unless the item was kept:
 * a rejected, duplicate or failed post must not leave files behind.
 */
async function processItem(rawItem, feed, adapter, settings) {
  let result;
  try { result = await processItemInner(rawItem, feed, adapter, settings); } catch (e) { result = { outcome: 'error', error: e }; }
  if (typeof rawItem.discard === 'function' && result.outcome !== 'added' && result.outcome !== 'review' && result.outcome !== 'hidden') {
    try { await rawItem.discard(); } catch { /* best effort */ }
  }
  if (result.outcome === 'error') throw result.error;
  return result;
}

module.exports = { processItem, resolveCreator, knownCreator, mentionedKnownCreator, cleanHandle, _hostState: hostState };
