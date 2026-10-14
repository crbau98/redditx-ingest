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
const { toIso, clip, repostsOn } = require('./util');
const { extractLinks } = require('../lib/links');

const base = config.baseUrls.x;

/* X API plans cap how many posts you may read per month. Count what we read and stop
 * using the API (falling back to the keyless route for profiles) before the cap. */
const month = () => new Date().toISOString().slice(0, 7);
function usage() {
  const repo = require('../db/repo');
  let u = {}; try { u = JSON.parse(repo.settings.get('x.usage') || '{}'); } catch { u = {}; }
  return u.month === month() ? { month: u.month, posts: u.posts || 0, calls: u.calls || 0 } : { month: month(), posts: 0, calls: 0 };
}
function spend(posts) {
  const repo = require('../db/repo');
  const u = usage();
  repo.settings.set('x.usage', JSON.stringify({ month: u.month, posts: u.posts + (posts || 0), calls: u.calls + 1 }));
}
function budget() { try { return require('../settings').get().xMonthlyReadBudget; } catch { return 10000; } }
const apiAvailable = () => !!config.creds.xBearer && usage().posts < budget();
async function apiGet(url) {
  if (usage().posts >= budget()) throw Object.assign(new Error(`X API monthly read budget reached (${budget()} posts) — using the keyless route until next month`), { budget: true });
  const json = await http.json(url, { headers: bearer() });
  spend((json.meta && json.meta.result_count) || (Array.isArray(json.data) ? json.data.length : json.data ? 1 : 0));
  return json;
}
const bearer = () => ({ authorization: `Bearer ${config.creds.xBearer}` });
const MEDIA_FIELDS = 'media.fields=url,preview_image_url,type,variants,width,height,duration_ms,alt_text';
const TWEET_FIELDS = 'tweet.fields=created_at,public_metrics,possibly_sensitive,entities,referenced_tweets,attachments,author_id';
// Reposts and quotes: the original post, its author and its media come back in `includes`.
const REF_EXPANSIONS = 'referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys';

function bestMp4(variants) {
  return (variants || []).filter((v) => v.content_type === 'video/mp4' || /\.mp4/.test(v.url || '')).sort((a, b) => (b.bit_rate || b.bitrate || 0) - (a.bit_rate || a.bitrate || 0))[0];
}

/**
 * v2 API response -> items. A repost carries no media of its own: the original post's media is used and credited to
 * the original author (`repostOf`). A quote keeps its own media and adds the quoted post's.
 */
function parseApi(json, query) {
  const users = {}; const media = {}; const refs = {};
  ((json.includes && json.includes.users) || []).forEach((u) => { users[u.id] = u; });
  ((json.includes && json.includes.media) || []).forEach((m) => { media[m.media_key] = m; });
  ((json.includes && json.includes.tweets) || []).forEach((t) => { refs[t.id] = t; });
  const items = [];
  const reposts = repostsOn();
  const emit = (t, via) => {
    const user = users[t.author_id] || {};
    const keys = (t.attachments && t.attachments.media_keys) || [];
    const repostOf = via && user.username && via !== user.username ? { platform: 'x', handle: user.username, via } : null;
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
        ...(repostOf ? { repostOf } : {}),
      });
    });
  };
  for (const t of json.data || []) {
    const by = (users[t.author_id] || {}).username;
    const refList = t.referenced_tweets || [];
    const rt = refList.find((r) => r.type === 'retweeted');
    if (rt) { if (reposts && refs[rt.id]) emit(refs[rt.id], by); continue; }
    emit(t, null);
    const qt = refList.find((r) => r.type === 'quoted');
    if (qt && reposts && refs[qt.id]) emit(refs[qt.id], by);
  }
  return items;
}

/** legacy "tweet" object (syndication) -> items. Reposts and quotes are credited to the original author. */
function parseLegacyTweet(t, via = null) {
  if (!t) return [];
  if (typeof via !== 'string') via = null; // used directly as a flatMap callback: the 2nd argument is an index
  if (t.retweeted_status) {
    if (!repostsOn() || via) return [];
    // a retweet is new when it was retweeted: the feed cursor follows the retweet's time, not the original's
    const at = toIso(t.created_at);
    return parseLegacyTweet(t.retweeted_status, (t.user && t.user.screen_name) || null).map((it) => (at ? { ...it, cursorAt: at } : it));
  }
  const quoted = t.quoted_status && repostsOn() && !via ? parseLegacyTweet(t.quoted_status, (t.user && t.user.screen_name) || null) : [];
  const mediaList = (t.extended_entities && t.extended_entities.media) || (t.entities && t.entities.media) || [];
  const user = t.user || {};
  const repostOf = via && user.screen_name && via !== user.screen_name ? { platform: 'x', handle: user.screen_name, via } : null;
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
      ...(repostOf ? { repostOf } : {}),
    };
  }).filter(Boolean).concat(quoted);
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
    let newestId = null; let next = null;
    for (let page = 0; page < (cursor.newestId && !ctx.force ? 1 : 2); page++) {
      const json = await apiGet(`${base}/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=100&expansions=attachments.media_keys,author_id,${REF_EXPANSIONS}&${MEDIA_FIELDS}&${TWEET_FIELDS}&user.fields=username,name,profile_image_url${since}${next ? `&next_token=${encodeURIComponent(next)}` : ''}`);
      if (!newestId && json.meta) newestId = json.meta.newest_id;
      items.push(...parseApi(json, feed.target));
      next = json.meta && json.meta.next_token;
      if (!next) break;
    }
    return { items, newestId, profile };
  }
  const u = await apiGet(`${base}/2/users/by/username/${encodeURIComponent(feed.target)}?user.fields=description,profile_image_url,name,entities`);
  if (!u.data) throw Object.assign(new Error('X user not found or suspended'), { status: 404 });
  profile = { displayName: u.data.name, bio: u.data.description, avatarUrl: (u.data.profile_image_url || '').replace('_normal', '_400x400'), links: extractLinks(u.data.description || '') };
  // First sync walks back a few pages so a newly followed creator arrives with a real back catalogue;
  // later syncs are incremental via since_id.
  let newestId = null; let next = null;
  // Creators found by discovery start with one page: the monthly read budget goes further.
  const pages = (cursor.newestId && !ctx.force) || feed.origin === 'discovered' ? 1 : 2;
  for (let page = 0; page < pages; page++) {
    if (ctx.aborted && ctx.aborted()) break;
    const exclude = repostsOn() ? 'replies' : 'retweets,replies';
    const json = await apiGet(`${base}/2/users/${u.data.id}/tweets?max_results=100&exclude=${exclude}&expansions=attachments.media_keys,author_id,${REF_EXPANSIONS}&${MEDIA_FIELDS}&${TWEET_FIELDS}&user.fields=username,name,profile_image_url${since}${next ? `&pagination_token=${encodeURIComponent(next)}` : ''}`);
    if (!newestId && json.meta) newestId = json.meta.newest_id;
    items.push(...parseApi(json, null));
    next = json.meta && json.meta.next_token;
    if (!next) break;
  }
  return { items, newestId, profile };
}

async function viaSyndication(feed) {
  const html = await http.text(`${config.baseUrls.xSyndication}/srv/timeline-profile/screen-name/${encodeURIComponent(feed.target)}?showReplies=false`, {
    headers: { accept: 'text/html', referer: 'https://publish.twitter.com/' },
  });
  return parseSyndication(html).flatMap((t) => parseLegacyTweet(t));
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

/** Profiles for up to 100 usernames (discovery enrichment). Needs X_BEARER_TOKEN and budget. */
async function lookupUsers(usernames) {
  const list = [...new Set(usernames.map((u) => String(u).replace(/^@/, '')).filter((u) => /^[A-Za-z0-9_]{1,15}$/.test(u)))].slice(0, 100);
  if (!list.length || !apiAvailable()) return [];
  const json = await apiGet(`${base}/2/users/by?usernames=${list.join(',')}&user.fields=description,public_metrics,profile_image_url,name`);
  return (json.data || []).map((u) => ({ username: u.username, name: u.name, description: u.description || '', followers: (u.public_metrics && u.public_metrics.followers_count) || 0, avatar: (u.profile_image_url || '').replace('_normal', '_400x400') || null }));
}

module.exports = {
  lookupUsers,
  apiAvailable,
  platform: 'x',
  label: 'X',
  color: '#a1a1aa',
  kinds: ['user', 'search'],
  intervalMin: { user: 240, search: 180 },
  parseApi, parseLegacyTweet, parseSyndication, fetchTweet, usage,
  isConfigured(kind) {
    if (config.creds.xBearer) {
      const u = usage();
      if (u.posts >= budget()) return kind === 'search' ? { ok: false, note: `Monthly X read budget used (${u.posts}/${budget()})` } : { ok: true, note: `Budget used (${u.posts}/${budget()}) — keyless fallback` };
      return { ok: true, note: `Official API · ${u.posts.toLocaleString('en')} / ${budget().toLocaleString('en')} posts read this month` };
    }
    return kind === 'search'
      ? { ok: false, note: 'Search needs X_BEARER_TOKEN' }
      : { ok: true, note: 'Keyless best-effort (syndication) — add X_BEARER_TOKEN for reliability' };
  },

  tweetIdFromUrl(url) { const m = String(url).match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i); return m ? m[1] : null; },

  async resolve(url) { const id = module.exports.tweetIdFromUrl(url); return id ? (await fetchTweet(id))[0] || null : null; },

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    if (apiAvailable()) {
      try {
        const r = await viaApi(feed, ctx, cursor);
        const newestAt = r.items.reduce((a, it) => (it.postedAt && (!a || it.postedAt > a) ? it.postedAt : a), cursor.newestAt || null);
        return { items: r.items, cursor: { newestId: r.newestId || cursor.newestId, newestAt }, profile: r.profile, via: 'api' };
      } catch (e) {
        // Out of budget, or the plan does not include this endpoint (403): profiles still work keyless.
        if (feed.kind === 'search' || !(e.budget || e.status === 403 || e.status === 429)) throw e;
      }
    }
    if (feed.kind === 'search') throw Object.assign(new Error(config.creds.xBearer ? 'X API read budget used up for this month' : 'X search requires X_BEARER_TOKEN'), { skip: true });
    const items = await viaSyndication(feed);
    let newest = cursor.newestAt || null;
    const fresh = [];
    for (const it of items) {
      const at = it.cursorAt || it.postedAt;
      if (at && (!newest || at > newest)) newest = at;
      if (cursor.newestAt && at && at <= cursor.newestAt && !ctx.force) continue;
      fresh.push(it);
    }
    return { items: fresh, cursor: newest ? { newestAt: newest } : undefined, via: 'syndication' };
  },
};
