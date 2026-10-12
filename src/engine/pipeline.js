'use strict';
/**
 * The per-item pipeline. Every raw item from every adapter goes through the
 * same ordered gates, so rules are enforced in exactly one place:
 *
 *   resolve -> safety -> blocklist -> scope -> media checks -> dedupe
 *           -> creator -> insert -> tags
 */
const crypto = require('crypto');
const repo = require('../db/repo');
const registry = require('../sources');
const { checkItem, checkText } = require('../lib/safety');
const { classify, femaleCheck } = require('../lib/scope');
const { canonicalUrl, hostOf, hostBlocked, hostTrusted, looksLikeDirectMedia, normalizeMediaUrl, isJunkTitle } = require('../lib/mediaurl');
const { probeMedia } = require('./probe');
const imagefilter = require('../lib/imagefilter');
const events = require('./events');

const SKIP_AUTHORS = new Set(['[deleted]', 'deleted', 'automoderator', 'web', 'null', 'undefined', '']);
const REDGIFS_PAGE = /redgifs\.com\/(?:watch|ifr)\//i;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const cleanHandle = (a) => String(a || '').replace(/^[@/]+/, '').replace(/^u\//i, '').trim().slice(0, 80);

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
  const creator = (feed.creator_id && ['user', 'feed', 'page'].includes(feed.kind) ? repo.creators.get(feed.creator_id) : null) || repo.creators.byAccount(feed.platform, handle);
  if (creator && creator.status === 'active') { repo.creators.block(creator.id, reason, 'system'); events.log('WARN', `Creator ${creator.handle} blocked: ${reason}`); }
  else repo.blocklist.add('creator', key, reason);
}

/** Block the creator behind an item whose own profile text is female / feminine, and remember the account. */
function blockFemaleCreator(item, feed, rule) {
  const handle = cleanHandle(item.author);
  const key = handle && `${feed.platform}:${handle.toLowerCase()}`;
  const reason = `scope: ${rule || 'female'} (profile)`;
  let creator = null;
  if (feed.creator_id && ['user', 'feed', 'page'].includes(feed.kind)) creator = repo.creators.get(feed.creator_id);
  else if (handle) creator = repo.creators.byAccount(feed.platform, handle);
  if (creator && creator.status === 'active') {
    repo.creators.block(creator.id, reason, 'system');
    events.log('WARN', `Creator ${creator.handle} blocked: ${reason}`);
  } else if (key && !SKIP_AUTHORS.has(handle.toLowerCase())) {
    repo.blocklist.add('creator', key, reason);
  }
}

/** Which creator does this item belong to? May create one. */
function resolveCreator(item, feed, adapter) {
  // Feeds that belong to a specific creator (their profile, their RSS, their page).
  if (feed.creator_id && ['user', 'feed', 'page'].includes(feed.kind)) {
    const c = repo.creators.get(feed.creator_id);
    if (c) return c.status === 'active' ? c : { blocked: true };
  }
  const platform = feed.platform;
  if (['rss', 'web', 'linkinbio'].includes(platform)) {
    // A site/feed with no creator yet becomes its own creator, owned by the feed.
    const name = cleanHandle(feed.label || item.author || new URL(feed.target).hostname);
    const c = repo.creators.create({ handle: name, displayName: item.author || name, origin: 'ingest' });
    repo.feeds.update(feed.id, { creatorId: c.id });
    feed.creator_id = c.id;
    return c;
  }
  const handle = cleanHandle(item.author);
  if (SKIP_AUTHORS.has(handle.toLowerCase())) return null;
  if (repo.blocklist.has('creator', `${platform}:${handle}`)) return { blocked: true };
  const existing = repo.creators.byAccount(platform, handle);
  if (existing) return existing.status === 'active' ? existing : { blocked: true };
  // Creator-level safety: handle / display name.
  if (checkText(handle, item.authorName).level === 'block') return { blocked: true };

  const c = repo.creators.create({ handle, displayName: item.authorName || handle, avatarUrl: item.authorAvatar, origin: 'ingest' });
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
 * @returns {Promise<{outcome: 'added'|'dupe'|'blocked'|'review'|'skipped'|'excluded', reason?: string, mediaId?: string, creatorId?: string}>}
 */
async function processItem(rawItem, feed, adapter, settings) {
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

  // ---- 2. safety (never bypassable) ---------------------------------------------
  const safety = checkItem(item);
  if (safety.level === 'block') return { outcome: 'blocked', reason: `safety:${safety.rule}` };

  // ---- 3. blocklist -----------------------------------------------------------
  const sourceKey = `${platform}:${item.sourceId}:${item.position || 0}`;
  const hash = md5(canonicalUrl(item.mediaUrl));
  if (repo.blocklist.has('hash', hash) || repo.blocklist.has('source_key', sourceKey)) return { outcome: 'blocked', reason: 'blocklisted' };

  // ---- 4. scope: is this male-focused? ---------------------------------------------
  const sc = classify([item.title, item.text, item.altText, item.community, item.author, item.authorName, item.authorBio, item.tags, item.labels, item.query], { trusted: !!feed.trusted });
  if (sc.scope === 'excluded') {
    // A female / feminine person (handle, display name or bio) is removed as a creator, not just per post:
    // their other posts, their feeds and their other accounts never come back.
    if (femaleCheck(item.author, item.authorName, item.authorBio).level === 'hard') blockFemaleCreator(item, feed, sc.rule);
    return { outcome: 'excluded', reason: sc.rule || 'not male-focused' };
  }

  // ---- 5. media sanity ---------------------------------------------------------
  if (isJunkTitle(item.title)) return { outcome: 'skipped', reason: 'junk title' };
  const mediaHost = hostOf(item.mediaUrl);
  if (hostBlocked(mediaHost)) return { outcome: 'skipped', reason: `blocked host ${mediaHost}` };
  const isHls = /\.m3u8(\?|$)/i.test(item.mediaUrl);
  if (!item.trusted && !hostTrusted(mediaHost) && !looksLikeDirectMedia(item.mediaUrl)) return { outcome: 'skipped', reason: `unknown host ${mediaHost}` };
  if (settings.probeUnknownHosts && !isHls && (item.probe || (!item.trusted && !hostTrusted(mediaHost)))) {
    const p = await probeMedia(item.mediaUrl, item.mediaType);
    if (!p.ok) return { outcome: 'skipped', reason: `probe: ${p.reason}` };
  }

  // ---- 6. dedupe ----------------------------------------------------------------
  if (repo.media.hashExists(hash) || repo.media.keyExists(sourceKey)) return { outcome: 'dupe' };

  // ---- 6b. image filter: is there a woman in the picture? ---------------------------
  // Text can say nothing at all about a photo, so the picture itself is checked (on-device face + gender model).
  // No face / no image / model unavailable = no verdict: the text gates above already decided.
  if (settings.imageFilter === true) {
    const ir = await imagefilter.checkItem(item, { threshold: (settings.imageFilterThreshold || 50) / 100 });
    if (ir.female) {
      repo.blocklist.add('hash', hash, 'image filter: female face');
      noteImageStrike(item, feed);
      return { outcome: 'excluded', reason: 'image:female-face' };
    }
  }

  // ---- 7. creator -----------------------------------------------------------------
  const creator = resolveCreator(item, feed, adapter);
  if (creator && creator.blocked) return { outcome: 'blocked', reason: 'creator blocked' };

  // ---- 8. publish state --------------------------------------------------------------
  let state = 'published';
  let reviewReason = null;
  if (safety.level === 'review') { state = 'review'; reviewReason = `safety:${safety.rule}`; }
  else if (sc.femaleSoft) { state = 'review'; reviewReason = `scope:${sc.rule}`; } // feminine-adjacent wording: a human decides, whatever the feed trust or scope mode
  else if (sc.scope === 'uncertain' && settings.scopeMode === 'strict') { state = 'review'; reviewReason = 'scope:unclear'; }

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
  }, tags);
  if (!mediaId) return { outcome: 'dupe' };

  if (state === 'published') events.newItems(1);
  return { outcome: state === 'review' ? 'review' : 'added', mediaId, creatorId: creator ? creator.id : null, reason: reviewReason };
}

module.exports = { processItem, resolveCreator, cleanHandle };
