'use strict';
/**
 * X (Twitter) adapter.
 *
 *   user    official v2 API when X_BEARER_TOKEN is set (reliable, incremental via
 *           since_id); otherwise the public syndication timeline embed, which is
 *           best-effort and X may rate-limit or change it at any time.
 *   search  recent search — requires X_BEARER_TOKEN.
 *
 * Individual tweet links found by other sources are resolved through
 * fxtwitter's public JSON (no credentials).
 */
const config = require('../config');
const http = require('./http').forPlatform('x', 1200);
const { toIso, clip } = require('./util');
const { extractLinks } = require('../lib/links');

const base = config.baseUrls.x;
const bearer = () => ({ authorization: `Bearer ${config.creds.xBearer}` });
const MEDIA_FIELDS = 'media.fields=url,preview_image_url,type,variants,width,height,duration_ms,alt_text';
const TWEET_FIELDS = 'tweet.fields=created_at,public_metrics,possibly_sensitive,entities';

function bestMp4(variants) {
  return (variants || []).filter((v) => v.content_type === 'video/mp4' || /\.mp4/.test(v.url || '')).sort((a, b) => (b.bit_rate || b.bitrate || 0) - (a.bit_rate || a.bitrate || 0))[0];
}

/** v2 API response -> items */
function parseApi(json, query) {
  const users = {}; const media = {};
  ((json.includes && json.includes.users) || []).forEach((u) => { users[u.id] = u; });
  ((json.includes && json.includes.media) || []).forEach((m) => { media[m.media_key] = m; });
  const items = [];
  for (const t of json.data || []) {
    const user = users[t.author_id] || {};
    const keys = (t.attachments && t.attachments.media_keys) || [];
    keys.forEach((key, i) => {
      const m = media[key];
      if (!m) return;
      const isVideo = m.type === 'video' || m.type === 'animated_gif';
      const mp4 = isVideo ? bestMp4(m.variants) : null;
      const mediaUrl = isVideo ? (mp4 && mp4.url) : (m.url ? `${m.url}?name=orig` : null);
      if (!mediaUrl) return;
      items.push({
        sourceId: t.id, position: i,
        title: clip(t.text || '', 300), text: clip(t.text || '', 400),
        author: user.username, authorName: user.name, authorAvatar: user.profile_image_url,
        score: ((t.public_metrics && t.public_metrics.like_count) || 0) + ((t.public_metrics && t.public_metrics.retweet_count) || 0) * 2,
        postedAt: toIso(t.created_at),
        permalink: `https://x.com/${user.username || 'i'}/status/${t.id}`,
        mediaType: isVideo ? 'video' : 'image',
        mediaUrl,
        previewUrl: isVideo ? m.preview_image_url : `${m.url}?name=medium`,
        width: m.width || null, height: m.height || null, duration: m.duration_ms ? m.duration_ms / 1000 : null,
        altText: m.alt_text || null, hasAudio: m.type === 'video',
        tags: ((t.entities && t.entities.hashtags) || []).map((h) => h.tag),
        nsfw: t.possibly_sensitive ? 'explicit' : 'suggestive',
        query: query || null, trusted: true,
      });
    });
  }
  return items;
}

/** legacy "tweet" object (syndication) -> items */
function parseLegacyTweet(t) {
  if (!t || t.retweeted_status) return [];
  const mediaList = (t.extended_entities && t.extended_entities.media) || (t.entities && t.entities.media) || [];
  const user = t.user || {};
  return mediaList.map((m, i) => {
    const isVideo = m.type === 'video' || m.type === 'animated_gif';
    const mp4 = isVideo ? bestMp4(m.video_info && m.video_info.variants) : null;
    const mediaUrl = isVideo ? (mp4 && mp4.url) : (m.media_url_https ? `${m.media_url_https}?name=orig` : null);
    if (!mediaUrl) return null;
    const o = m.original_info || {};
    return {
      sourceId: t.id_str || String(t.id), position: i,
      title: clip(t.full_text || t.text || '', 300), text: clip(t.full_text || t.text || '', 400),
      author: user.screen_name, authorName: user.name, authorAvatar: user.profile_image_url_https,
      score: (t.favorite_count || 0) + (t.retweet_count || 0) * 2,
      postedAt: toIso(t.created_at),
      permalink: `https://x.com/${user.screen_name || 'i'}/status/${t.id_str || t.id}`,
      mediaType: isVideo ? 'video' : 'image', mediaUrl,
      previewUrl: m.media_url_https ? `${m.media_url_https}?name=medium` : null,
      width: o.width || null, height: o.height || null,
      hasAudio: m.type === 'video',
      tags: ((t.entities && t.entities.hashtags) || []).map((h) => h.text),
      nsfw: t.possibly_sensitive ? 'explicit' : 'suggestive', trusted: true,
    };
  }).filter(Boolean);
}

function parseSyndication(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('X syndication page had no timeline data (rate limited or changed)');
  const data = JSON.parse(m[1]);
  const entries = (data.props && data.props.pageProps && data.props.pageProps.timeline && data.props.pageProps.timeline.entries) || [];
  return entries.filter((e) => e.type === 'tweet' && e.content && e.content.tweet).map((e) => e.content.tweet);
}

async function viaApi(feed, ctx, cursor) {
  const items = [];
  let profile;
  const since = cursor.newestId && !ctx.force ? `&since_id=${cursor.newestId}` : '';
  if (feed.kind === 'search') {
    const q = `${feed.target} has:media -is:retweet -is:reply`;
    const json = await http.json(`${base}/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=100&expansions=attachments.media_keys,author_id&${MEDIA_FIELDS}&${TWEET_FIELDS}&user.fields=username,name,profile_image_url${since}`, { headers: bearer() });
    return { items: parseApi(json, feed.target), newestId: json.meta && json.meta.newest_id, profile };
  }
  const u = await http.json(`${base}/2/users/by/username/${encodeURIComponent(feed.target)}?user.fields=description,profile_image_url,name,entities`, { headers: bearer() });
  if (!u.data) throw Object.assign(new Error('X user not found or suspended'), { status: 404 });
  profile = { displayName: u.data.name, bio: u.data.description, avatarUrl: (u.data.profile_image_url || '').replace('_normal', '_400x400'), links: extractLinks(u.data.description || '') };
  const json = await http.json(`${base}/2/users/${u.data.id}/tweets?max_results=100&exclude=retweets,replies&expansions=attachments.media_keys,author_id&${MEDIA_FIELDS}&${TWEET_FIELDS}&user.fields=username,name,profile_image_url${since}`, { headers: bearer() });
  items.push(...parseApi(json, null));
  return { items, newestId: json.meta && json.meta.newest_id, profile };
}

async function viaSyndication(feed) {
  const html = await http.text(`${config.baseUrls.xSyndication}/srv/timeline-profile/screen-name/${encodeURIComponent(feed.target)}?showReplies=false`, {
    headers: { accept: 'text/html', referer: 'https://publish.twitter.com/' },
  });
  return parseSyndication(html).flatMap(parseLegacyTweet);
}

async function fetchTweet(id) {
  const json = await http.json(`${config.baseUrls.fxtwitter}/status/${id}`);
  const t = json.tweet;
  if (!t) return [];
  const media = (t.media && t.media.all) || [];
  return media.map((m, i) => {
    const isVideo = m.type === 'video' || m.type === 'gif';
    return {
      sourceId: t.id, position: i, title: clip(t.text || '', 300), text: clip(t.text || '', 400),
      author: t.author && t.author.screen_name, authorName: t.author && t.author.name, authorAvatar: t.author && t.author.avatar_url,
      score: (t.likes || 0) + (t.retweets || 0) * 2, postedAt: toIso(t.created_timestamp || t.created_at),
      permalink: t.url, mediaType: isVideo ? 'video' : 'image', mediaUrl: m.url, previewUrl: m.thumbnail_url || (isVideo ? null : m.url),
      width: m.width || null, height: m.height || null, nsfw: 'explicit', trusted: true,
    };
  }).filter((it) => it.mediaUrl);
}

module.exports = {
  platform: 'x',
  label: 'X',
  color: '#a1a1aa',
  kinds: ['user', 'search'],
  intervalMin: { user: 240, search: 180 },
  parseApi, parseLegacyTweet, parseSyndication, fetchTweet,
  isConfigured(kind) {
    if (config.creds.xBearer) return { ok: true, note: 'Official API' };
    return kind === 'search'
      ? { ok: false, note: 'Search needs X_BEARER_TOKEN' }
      : { ok: true, note: 'Keyless best-effort (syndication) — add X_BEARER_TOKEN for reliability' };
  },

  tweetIdFromUrl(url) { const m = String(url).match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i); return m ? m[1] : null; },

  async resolve(url) { const id = module.exports.tweetIdFromUrl(url); return id ? (await fetchTweet(id))[0] || null : null; },

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    if (config.creds.xBearer) {
      const r = await viaApi(feed, ctx, cursor);
      const newestAt = r.items.reduce((a, it) => (it.postedAt && (!a || it.postedAt > a) ? it.postedAt : a), cursor.newestAt || null);
      return { items: r.items, cursor: { newestId: r.newestId || cursor.newestId, newestAt }, profile: r.profile, via: 'api' };
    }
    if (feed.kind === 'search') throw Object.assign(new Error('X search requires X_BEARER_TOKEN'), { skip: true });
    const items = await viaSyndication(feed);
    let newest = cursor.newestAt || null;
    const fresh = [];
    for (const it of items) {
      if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
      if (cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) continue;
      fresh.push(it);
    }
    return { items: fresh, cursor: newest ? { newestAt: newest } : undefined, via: 'syndication' };
  },
};
