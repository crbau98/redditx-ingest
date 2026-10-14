'use strict';
/**
 * Bluesky adapter (AT Protocol).
 *
 *   user   - public AppView getAuthorFeed (no credentials needed)
 *   feedgen - a custom feed (feed generator), at://<actor>/app.bsky.feed.generator/<rkey>
 *   list    - a curated list of accounts, at://<actor>/app.bsky.graph.list/<rkey>
 *   search - app.bsky.feed.searchPosts. The public AppView now requires an
 *            authenticated session for search, so this kind needs
 *            BSKY_IDENTIFIER + BSKY_APP_PASSWORD (an app password, not your
 *            account password).
 *
 * Videos are only published as HLS playlists; we store the playlist URL and
 * the client plays it through hls.js via the /api/hls proxy.
 */
const config = require('../config');
const net = require('../lib/net');
const http = require('./http').forPlatform('bluesky', 400);
const { toIso, clip, errorDetail, repostsOn } = require('./util');
const { extractLinks } = require('../lib/links');

const base = config.baseUrls.bsky;
const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media']);
const LOGIN_REQUIRED = new Set(['!no-unauthenticated']);

const SEARCH_NEEDS_LOGIN = 'Bluesky search needs BSKY_IDENTIFIER and BSKY_APP_PASSWORD';
let session = null;
let loginInFlight = null;

/** exp (ms) of a JWT, or 0 when it cannot be read. */
function jwtExpiry(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')).exp * 1000 || 0; } catch { return 0; }
}

async function login() {
  const { bskyIdentifier: id, bskyPassword: pw } = config.creds;
  let res;
  try {
    res = await http.json(`${config.baseUrls.bskyPds}/xrpc/com.atproto.server.createSession`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: id, password: pw }), retries: 1,
    });
  } catch (e) {
    if (e.status === 400 || e.status === 401) {
      // A rejected credential is a configuration problem, not an outage: report it clearly and don't trip the circuit breaker.
      throw Object.assign(new Error(`Bluesky login was rejected (${errorDetail(e) || `HTTP ${e.status}`}). Check BSKY_IDENTIFIER (handle or email) and BSKY_APP_PASSWORD (an app password from Settings > Privacy and security, not the account password)`), { skip: true });
    }
    throw e;
  }
  if (!res || !res.accessJwt) throw Object.assign(new Error('Bluesky login failed: no access token returned'), { skip: true });
  // Access tokens last ~2h; renew a few minutes early. Unreadable token: assume an hour.
  const exp = jwtExpiry(res.accessJwt);
  session = { jwt: res.accessJwt, expires: exp ? exp - 5 * 60 * 1000 : Date.now() + 60 * 60 * 1000 };
  return session.jwt;
}

/** Cached access JWT for the configured app password (null when not configured). One login at a time. */
async function sessionToken(force = false) {
  const { bskyIdentifier: id, bskyPassword: pw } = config.creds;
  if (!id || !pw) return null;
  if (!force && session && Date.now() < session.expires) return session.jwt;
  if (!loginInFlight) loginInFlight = login().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

/** Authenticated GET against the user's PDS (which proxies app.bsky.* to the AppView). Re-logs in once on an expired token. */
async function authedJson(url) {
  const call = async (jwt) => http.json(url, { headers: { authorization: `Bearer ${jwt}` } });
  const jwt = await sessionToken();
  if (!jwt) throw Object.assign(new Error(SEARCH_NEEDS_LOGIN), { skip: true });
  try { return await call(jwt); } catch (e) {
    if (e.status === 401 || (e.status === 400 && /ExpiredToken|InvalidToken/i.test(e.body || ''))) {
      session = null;
      return call(await sessionToken(true));
    }
    if (e.status === 403) {
      throw Object.assign(new Error(`Bluesky refused the authenticated request (HTTP 403${errorDetail(e) ? `: ${errorDetail(e)}` : ''})`), { status: 403 });
    }
    throw e;
  }
}

function mediaOf(embed) {
  if (!embed) return [];
  const type = embed.$type || '';
  if (type.startsWith('app.bsky.embed.recordWithMedia')) return mediaOf(embed.media);
  if (type.startsWith('app.bsky.embed.images')) {
    return (embed.images || []).map((im) => ({
      kind: 'image', url: im.fullsize, preview: im.thumb, alt: im.alt || null,
      width: im.aspectRatio && im.aspectRatio.width, height: im.aspectRatio && im.aspectRatio.height,
    }));
  }
  if (type.startsWith('app.bsky.embed.video')) {
    return [{
      kind: 'video', url: embed.playlist, hls: embed.playlist, preview: embed.thumbnail, alt: embed.alt || null,
      width: embed.aspectRatio && embed.aspectRatio.width, height: embed.aspectRatio && embed.aspectRatio.height,
    }];
  }
  return [];
}

/** feed[] view entry -> items. A repost is kept (setting "reposts") and credited to the original poster. */
function parsePostView(entry) {
  const post = entry.post || entry;
  if (!post || !post.uri) return [];
  const reposted = entry.reason && /reasonRepost/.test(entry.reason.$type || '');
  const via = reposted && entry.reason.by ? entry.reason.by.handle || null : null;
  // Kept only when we know who reposted it and it is somebody else's post (a self-repost adds nothing).
  if (reposted && (!repostsOn() || !via || via === (post.author && post.author.handle))) return [];
  const selfLabels = post.record && post.record.labels && Array.isArray(post.record.labels.values) ? post.record.labels.values : [];
  const labels = [...(post.labels || []), ...selfLabels, ...((post.author && post.author.labels) || [])].map((l) => l && l.val).filter(Boolean);
  if (labels.some((l) => LOGIN_REQUIRED.has(l))) return [];
  const rkey = post.uri.split('/').pop();
  const handle = post.author && post.author.handle;
  // 'handle.invalid' = the account's handle no longer verifies; the DID still resolves on bsky.app.
  const profileRef = handle && handle !== 'handle.invalid' ? handle : post.author && post.author.did;
  const nsfw = labels.some((l) => ADULT_LABELS.has(l)) ? 'explicit' : 'suggestive';
  const tags = ((post.record && post.record.tags) || []).concat(((post.record && post.record.text) || '').match(/#[\p{L}\p{N}_]+/gu) || []);
  return mediaOf(post.embed).filter((m) => m.url).map((m, i) => ({
    sourceId: `${post.author && post.author.did}:${rkey}`,
    position: i,
    title: clip((post.record && post.record.text) || '', 300),
    text: clip((post.record && post.record.text) || '', 400),
    author: handle,
    authorName: post.author && post.author.displayName,
    authorAvatar: post.author && post.author.avatar,
    score: (post.likeCount || 0) + (post.repostCount || 0) * 2,
    postedAt: toIso((post.record && post.record.createdAt) || post.indexedAt),
    permalink: `https://bsky.app/profile/${profileRef}/post/${rkey}`,
    mediaType: m.kind,
    mediaUrl: m.url,
    previewUrl: m.preview,
    hlsUrl: m.hls || null,
    hasAudio: m.kind === 'video',
    width: m.width || null,
    height: m.height || null,
    altText: m.alt,
    tags,
    labels,
    nsfw,
    trusted: true,
    ...(reposted && handle ? { repostOf: { platform: 'bluesky', handle, via } } : {}),
  }));
}

const didCache = new Map();
/** at://handle/... -> at://did:plc:.../... (the AppView wants DIDs in feed/list URIs). */
async function resolveUri(uri) {
  const m = String(uri).match(/^at:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error('Expected an at:// URI');
  if (m[1].startsWith('did:')) return uri;
  if (!didCache.has(m[1])) {
    const r = await http.json(`${base}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(m[1])}`);
    if (!r.did) throw new Error(`Could not resolve ${m[1]}`);
    didCache.set(m[1], r.did);
  }
  return `at://${didCache.get(m[1])}/${m[2]}`;
}

async function fetchProfile(actor) {
  try {
    const p = await http.json(`${base}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
    return {
      displayName: p.displayName || p.handle, bio: p.description || null, avatarUrl: p.avatar || null, bannerUrl: p.banner || null,
      links: extractLinks(p.description || ''), handle: p.handle, verified: !!(p.verification && p.verification.verifiedStatus === 'valid'),
    };
  } catch { return null; }
}

/** Popular custom feeds matching a keyword (discovery). Public AppView endpoint. */
async function searchFeeds(q, limit = 25) {
  const json = await http.json(`${base}/xrpc/app.bsky.unspecced.getPopularFeedGenerators?query=${encodeURIComponent(q)}&limit=${limit}`);
  return (json.feeds || []).map((f) => ({ uri: f.uri, displayName: f.displayName || null, description: f.description || null, likeCount: f.likeCount || 0, creator: f.creator && f.creator.handle, avatar: f.avatar || null }))
    .filter((f) => /^at:\/\//.test(f.uri || ''));
}

const actorOut = (p) => ({
  handle: p.handle, displayName: p.displayName || null, description: p.description || null, avatar: p.avatar || null,
  labels: (p.labels || []).map((l) => l.val), followers: p.followersCount || 0,
});

/** People search by keyword (discovery). Public AppView endpoint; returns bios for the gate. */
async function searchActors(q, limit = 25) {
  const json = await http.json(`${base}/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(q)}&limit=${limit}`);
  return (json.actors || []).map(actorOut).filter((a) => a.handle);
}

/** Bluesky's own "similar accounts" for an actor (discovery lookalikes). Public AppView endpoint. */
async function suggestedFor(actor) {
  const json = await http.json(`${base}/xrpc/app.bsky.graph.getSuggestedFollowsByActor?actor=${encodeURIComponent(actor)}`);
  return (json.suggestions || []).map(actorOut).filter((a) => a.handle);
}

module.exports = {
  searchFeeds,
  searchActors,
  suggestedFor,
  platform: 'bluesky',
  label: 'Bluesky',
  color: '#0085ff',
  kinds: ['user', 'search', 'feedgen', 'list'],
  intervalMin: { user: 180, search: 120, feedgen: 90, list: 120 },
  parsePostView, mediaOf, resolveUri, sessionToken, _resetSession() { session = null; loginInFlight = null; },
  isConfigured(kind) {
    if (kind === 'search') {
      return config.creds.bskyIdentifier && config.creds.bskyPassword ? { ok: true } : { ok: false, note: SEARCH_NEEDS_LOGIN };
    }
    return { ok: true };
  },

  async fetch(feed, ctx) {
    try { return await fetchFeed(feed, ctx); } catch (e) {
      // The AppView answers a deleted/renamed account, a dead custom feed or an unknown handle with HTTP 400
      // (not 404), so the engine would retry them forever. Report them as "gone" so repeated misses disable the feed.
      if (e && e.status === 400 && /not found|could not find|unknownfeed|unknownlist|deactivated|takendown|suspended|unable to resolve|invalid handle/i.test(`${e.body || ''} ${e.message || ''}`)) {
        throw Object.assign(new Error(`Bluesky ${feed.kind === 'user' ? 'account' : feed.kind === 'list' ? 'list' : 'feed'} not found: ${feed.target}${errorDetail(e) ? ` (${errorDetail(e)})` : ''}`), { status: 404 });
      }
      throw e;
    }
  },
};

async function fetchFeed(feed, ctx) {
  const cursor = ctx.cursor || {};
  const items = [];
  let newest = cursor.newestAt || null;
  let next = null;
  const maxPages = cursor.newestAt ? 2 : 4;
  // Custom feeds are ranked, not chronological: never stop early on an "old" post, rely on dedupe instead.
  const ranked = feed.kind === 'feedgen';
  const uri = feed.kind === 'feedgen' || feed.kind === 'list' ? await resolveUri(feed.target) : null;
  const cur = () => (next ? `&cursor=${encodeURIComponent(next)}` : '');

  for (let page = 0; page < maxPages; page++) {
    if (ctx.aborted()) break;
    let json;
    if (feed.kind === 'search') {
      // The public AppView answers searchPosts with 403 since 2025: go through the PDS with a session.
      json = await authedJson(`${config.baseUrls.bskyPds}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(feed.target)}&sort=latest&limit=50${cur()}`);
      json.feed = (json.posts || []).map((post) => ({ post }));
    } else if (feed.kind === 'feedgen') {
      json = await http.json(`${base}/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(uri)}&limit=50${cur()}`);
    } else if (feed.kind === 'list') {
      json = await http.json(`${base}/xrpc/app.bsky.feed.getListFeed?list=${encodeURIComponent(uri)}&limit=50${cur()}`);
    } else {
      json = await http.json(`${base}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(String(feed.target).replace(/^@/, ''))}&filter=posts_with_media&limit=50&includePins=false${cur()}`);
    }
    let reachedKnown = false;
    for (const entry of json.feed || []) {
      for (const it of parsePostView(entry)) {
        if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
        if (!ranked && cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
        items.push({ ...it, query: feed.kind === 'search' ? feed.target : null });
      }
    }
    next = json.cursor;
    if (!next || reachedKnown) break;
  }

  let profile;
  if (feed.kind === 'user' && (ctx.needProfile || !cursor.newestAt)) profile = await fetchProfile(feed.target);
  return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via: feed.kind === 'search' ? 'search' : feed.kind === 'user' ? 'appview' : `appview-${feed.kind}` };
}
