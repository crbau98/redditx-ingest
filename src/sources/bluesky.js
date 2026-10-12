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
const { toIso, clip } = require('./util');
const { extractLinks } = require('../lib/links');

const base = config.baseUrls.bsky;
const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media']);
const LOGIN_REQUIRED = new Set(['!no-unauthenticated']);

let session = null;
async function sessionToken() {
  const { bskyIdentifier: id, bskyPassword: pw } = config.creds;
  if (!id || !pw) return null;
  if (session && Date.now() < session.expires) return session.jwt;
  const res = await net.fetchJSON(`${config.baseUrls.bskyPds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: id, password: pw }), retries: 1,
  });
  if (!res.accessJwt) throw new Error('Bluesky login failed');
  session = { jwt: res.accessJwt, expires: Date.now() + 90 * 60 * 1000 };
  return session.jwt;
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

/** feed[] view entry -> items. Reposts are skipped (the original poster owns it). */
function parsePostView(entry) {
  const post = entry.post || entry;
  if (!post || !post.uri) return [];
  if (entry.reason && /reasonRepost/.test(entry.reason.$type || '')) return [];
  const labels = [...(post.labels || []), ...((post.author && post.author.labels) || [])].map((l) => l.val);
  if (labels.some((l) => LOGIN_REQUIRED.has(l))) return [];
  const rkey = post.uri.split('/').pop();
  const handle = post.author && post.author.handle;
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
    permalink: `https://bsky.app/profile/${handle}/post/${rkey}`,
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

module.exports = {
  platform: 'bluesky',
  label: 'Bluesky',
  color: '#0085ff',
  kinds: ['user', 'search', 'feedgen', 'list'],
  intervalMin: { user: 180, search: 120, feedgen: 90, list: 120 },
  parsePostView, mediaOf, resolveUri,
  isConfigured(kind) {
    if (kind === 'search') {
      return config.creds.bskyIdentifier && config.creds.bskyPassword ? { ok: true } : { ok: false, note: 'Search needs BSKY_IDENTIFIER + BSKY_APP_PASSWORD' };
    }
    return { ok: true };
  },

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    const items = [];
    let newest = cursor.newestAt || null;
    let next = null;
    const maxPages = cursor.newestAt ? 2 : 4;
    // Custom feeds are ranked, not chronological: never stop early on an "old" post, rely on dedupe instead.
    const ranked = feed.kind === 'feedgen';
    const uri = feed.kind === 'feedgen' || feed.kind === 'list' ? await resolveUri(feed.target) : null;

    for (let page = 0; page < maxPages; page++) {
      if (ctx.aborted()) break;
      let json;
      if (feed.kind === 'search') {
        const jwt = await sessionToken();
        json = await http.json(`${config.baseUrls.bskyPds}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(feed.target)}&sort=latest&limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, { headers: { authorization: `Bearer ${jwt}` } });
        json.feed = (json.posts || []).map((post) => ({ post }));
      } else if (feed.kind === 'feedgen') {
        json = await http.json(`${base}/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(uri)}&limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      } else if (feed.kind === 'list') {
        json = await http.json(`${base}/xrpc/app.bsky.feed.getListFeed?list=${encodeURIComponent(uri)}&limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      } else {
        json = await http.json(`${base}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(feed.target)}&filter=posts_with_media&limit=50&includePins=false${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
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
  },
};
