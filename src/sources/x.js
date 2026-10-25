'use strict';
/**
 * X (Twitter) adapter.
 *
 *   user    official v2 API when X_BEARER_TOKEN is set (reliable, incremental via
 *           since_id); otherwise the public syndication timeline embed, which is
 *           best-effort and X may rate-limit or change it at any time.
 *   search  recent search with X_BEARER_TOKEN; without it, keyless: a web search (SearXNG / Brave / Keenable)
 *           restricted to x.com finds matching posts and each one is read through fxtwitter.
 *
 * Without a token, a profile whose embed timeline comes back empty or blocked falls back to the same web-search
 * route for that handle. Individual post links (here and in Reddit posts) are read through fxtwitter's public
 * JSON, with X's own embed API (cdn.syndication.twimg.com) as the fallback. No credentials either way.
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
/* A token X refuses (401 bad token, 402 no paid plan / credits left, 403 endpoint not in the plan) would fail every
 * call: park the API for a few hours and use the keyless routes, instead of erroring on every feed. */
const API_PARK_MS = 6 * 3600 * 1000;
const apiState = { parkedUntil: 0, reason: null };
const apiParked = () => Date.now() < apiState.parkedUntil;
const apiAvailable = () => !!config.creds.xBearer && usage().posts < budget() && !apiParked();
async function apiGet(url) {
  if (usage().posts >= budget()) throw Object.assign(new Error(`X API monthly read budget reached (${budget()} posts) — using the keyless route until next month`), { budget: true });
  let json;
  try { json = await http.json(url, { headers: bearer() }); } catch (e) {
    if (e.status === 401 || e.status === 402 || e.status === 403) {
      apiState.parkedUntil = Date.now() + API_PARK_MS;
      apiState.reason = e.status === 402 ? 'X says the token has no paid plan or credits (402)' : e.status === 401 ? 'X rejected the token (401)' : 'this endpoint is not in the token\'s X plan (403)';
      e.apiOff = true;
    }
    throw e;
  }
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
/**
 * Where a post's links really point. The text only shows t.co redirects; the destinations are in entities.urls
 * (API v2 and legacy tweets) or in fxtwitter's raw_text facets. The leak gate (lib/leaks) checks every one.
 */
function expandedLinks(t) {
  const urls = [
    ...((t.entities && t.entities.urls) || []).map((u) => u && (u.unwound_url || u.expanded_url || u.url)),
    ...(((t.raw_text && t.raw_text.facets) || []).map((f) => f && f.type === 'url' && (f.replacement || f.original))),
  ];
  return [...new Set(urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))];
}

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
        title: clip(t.text || '', 300), text: clip(t.text || '', 400), links: expandedLinks(t),
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
      title: clip(t.full_text || t.text || '', 300), text: clip(t.full_text || t.text || '', 400), links: expandedLinks(t),
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

async function fetchTweetFx(id) {
  const json = await http.json(`${config.baseUrls.fxtwitter}/status/${id}`);
  const t = json.tweet;
  if (!t) return [];
  const media = (t.media && t.media.all) || [];
  return media.map((m, i) => {
    const isVideo = m.type === 'video' || m.type === 'gif';
    return {
      sourceId: String(t.id), position: i, title: clip(t.text || '', 300), text: clip(t.text || '', 400), links: expandedLinks(t),
      author: t.author && t.author.screen_name, authorName: t.author && t.author.name, authorAvatar: t.author && t.author.avatar_url,
      score: (t.likes || 0) + (t.retweets || 0) * 2, postedAt: toIso(t.created_timestamp || t.created_at),
      permalink: t.url, mediaType: isVideo ? 'video' : 'image', mediaUrl: m.url, previewUrl: m.thumbnail_url || (isVideo ? null : m.url),
      width: m.width || null, height: m.height || null, hasAudio: m.type === 'video', nsfw: 'explicit', trusted: true,
    };
  }).filter((it) => it.mediaUrl);
}

/** The token X's embed widget sends with tweet-result (derived from the id, not a secret). */
const embedToken = (id) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');

/** X's own embed API -> items (same shape as fxtwitter's). Age-restricted or deleted posts come back as tombstones. */
function parseEmbedTweet(t) {
  if (!t || t.__typename === 'TweetTombstone' || !t.id_str) return [];
  const user = t.user || {};
  return (t.mediaDetails || []).map((m, i) => {
    const isVideo = m.type === 'video' || m.type === 'animated_gif';
    const mp4 = isVideo ? bestMp4(m.video_info && m.video_info.variants) : null;
    const mediaUrl = isVideo ? (mp4 && mp4.url) : (m.media_url_https ? `${m.media_url_https}?name=orig` : null);
    if (!mediaUrl) return null;
    const o = m.original_info || {};
    return {
      sourceId: t.id_str, position: i, title: clip(t.text || '', 300), text: clip(t.text || '', 400), links: expandedLinks(t),
      author: user.screen_name, authorName: user.name, authorAvatar: user.profile_image_url_https,
      score: (t.favorite_count || 0) + (t.retweet_count || 0) * 2, postedAt: toIso(t.created_at),
      permalink: `https://x.com/${user.screen_name || 'i'}/status/${t.id_str}`,
      mediaType: isVideo ? 'video' : 'image', mediaUrl,
      previewUrl: m.media_url_https ? `${m.media_url_https}?name=medium` : null,
      width: o.width || null, height: o.height || null, hasAudio: m.type === 'video',
      tags: ((t.entities && t.entities.hashtags) || []).map((h) => h.text),
      nsfw: t.possibly_sensitive ? 'explicit' : 'suggestive', trusted: true,
    };
  }).filter(Boolean);
}

async function fetchTweetEmbed(id) {
  return parseEmbedTweet(await http.json(`${config.baseUrls.xEmbed}/tweet-result?id=${id}&token=${embedToken(id)}&lang=en`));
}

/** One post's media, keyless: fxtwitter first, X's embed API when fxtwitter fails or finds no media. */
async function fetchTweet(id) {
  let fxErr = null;
  try { const items = await fetchTweetFx(id); if (items.length) return items; } catch (e) { fxErr = e; }
  try { return await fetchTweetEmbed(id); } catch (e) { throw fxErr || e; }
}

/* ------------------------------------------------- keyless discovery of posts through web search */
const NOT_HANDLES = new Set(['i', 'home', 'search', 'explore', 'hashtag', 'intent', 'share', 'settings', 'notifications', 'messages', 'compose', 'login', 'signup', 'tos', 'privacy', 'about', 'download', 'jobs']);
const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})/i;
const PROFILE_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#]|$)/i;

/** Web results -> unique {handle, id} posts (in result order) and the profile handles that appeared. */
function postsInResults(results) {
  const posts = []; const seen = new Set(); const profiles = new Set();
  for (const r of results || []) {
    const url = String((r && r.url) || '');
    const m = url.match(STATUS_URL);
    if (m) {
      if (!seen.has(m[2]) && !NOT_HANDLES.has(m[1].toLowerCase())) { seen.add(m[2]); posts.push({ handle: m[1], id: m[2] }); }
      continue;
    }
    const p = url.match(PROFILE_URL);
    if (p && !NOT_HANDLES.has(p[1].toLowerCase())) profiles.add(p[1]);
  }
  return { posts, profiles: [...profiles] };
}

/* Every keyless X run is one web search. Count them per day so a few hundred X feeds cannot get the search engines
 * behind SearXNG to block this server. */
const today = () => new Date().toISOString().slice(0, 10);
function webUsage() {
  let u = {}; try { u = JSON.parse(require('../db/repo').settings.get('x.websearch') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0 } : { day: today(), count: 0 };
}
function webSpend() { const u = webUsage(); require('../db/repo').settings.set('x.websearch', JSON.stringify({ day: u.day, count: u.count + 1 })); }
function webBudget() { try { return require('../settings').get().xKeylessSearchesPerDay; } catch { return 150; } }

const RESOLVE_PER_RUN = 20;
const SEEN_KEEP = 400;

/**
 * Keyless route for both kinds: search the web for x.com posts, then read the ones not seen before.
 * `search` feeds take any author; `user` feeds keep only that handle's own posts.
 */
async function viaWebSearch(feed, ctx, cursor) {
  const websearch = require('../lib/websearch');
  if (!websearch.configured()) throw Object.assign(new Error('Keyless X needs web search: set SEARXNG_URL (bundled in deploy/) or BRAVE_API_KEY'), { skip: true });
  if (webUsage().count >= webBudget()) throw Object.assign(new Error(`Keyless X: today's ${webBudget()} web searches are used (Settings: X web searches per day)`), { skip: true, budget: true });
  let budget = 40; try { budget = require('../settings').get().braveDailyBudget; } catch { /* default */ }
  webSpend();
  const handle = feed.kind === 'user' ? String(feed.target).replace(/^@/, '') : null;
  let results;
  try {
    results = handle
      ? await websearch.search(`"${handle}"`, { site: `x.com/${handle}`, count: 30, budget })
      : await websearch.search(feed.target, { site: 'x.com', count: 30, budget });
  } catch (e) {
    // A search outage is not X failing: skip this run instead of tripping the X circuit breaker.
    throw Object.assign(new Error(`Keyless X: web search failed: ${e.message}`), { skip: true });
  }
  const found = postsInResults(results);
  const posts = handle ? found.posts.filter((p) => p.handle.toLowerCase() === handle.toLowerCase()) : found.posts;
  const seen = new Set((cursor.seen || []).map(String));
  const todo = posts.filter((p) => ctx.force || !seen.has(p.id)).slice(0, RESOLVE_PER_RUN);
  const items = []; const notes = []; let failed = 0;
  for (const p of todo) {
    if (ctx.aborted && ctx.aborted()) break;
    try { items.push(...(await fetchTweet(p.id)).map((it) => (feed.kind === 'search' ? { ...it, query: feed.target } : it))); seen.add(p.id); } catch (e) {
      failed++;
      if (failed === 1) notes.push(`could not read post ${p.id}: ${e.message}`);
      if (e.status === 404) seen.add(p.id); // deleted: do not ask again
    }
  }
  if (!results.length) notes.push('the web search returned nothing');
  else if (!posts.length) notes.push(`the web search returned ${results.length} results but no x.com posts${handle ? ` by @${handle}` : ''}`);
  // Accounts the search turned up are leads for discovery (scored and followed there, never here).
  if (feed.kind === 'search' && found.profiles.length) {
    try { const d = require('../engine/discovery'); for (const h of found.profiles.slice(0, 10)) d.consider({ platform: 'x', kind: 'user', target: h, label: h, ingestable: true }, 'search', feed.target); } catch { /* best effort */ }
  }
  if (todo.length && failed === todo.length) throw Object.assign(new Error(`X posts found by web search could not be read (${notes[0]})`), { status: 502 });
  const newestAt = items.reduce((a, it) => (it.postedAt && (!a || it.postedAt > a) ? it.postedAt : a), cursor.newestAt || null);
  return { items, cursor: { ...cursor, newestAt, seen: [...seen].slice(-SEEN_KEEP) }, notes, via: `websearch${results.provider ? `:${results.provider}` : ''}` };
}

/** Keyless profile (name, bio, avatar, links) through fxtwitter. */
async function fetchProfileFx(handle) {
  const json = await http.json(`${config.baseUrls.fxtwitter}/${encodeURIComponent(handle)}`);
  const u = json && json.user;
  if (!u) return null;
  const bio = u.description || '';
  const site = u.website && (u.website.url || u.website.display_url);
  return { displayName: u.name, bio, avatarUrl: (u.avatar_url || '').replace('_normal', '_400x400') || null, links: extractLinks(`${bio} ${site || ''}`) };
}

/** Profiles for up to 100 usernames (discovery enrichment). Needs X_BEARER_TOKEN and budget. */
async function lookupUsers(usernames) {
  const list = [...new Set(usernames.map((u) => String(u).replace(/^@/, '')).filter((u) => /^[A-Za-z0-9_]{1,15}$/.test(u)))].slice(0, 100);
  if (!list.length || !apiAvailable()) return [];
  const json = await apiGet(`${base}/2/users/by?usernames=${list.join(',')}&user.fields=description,public_metrics,profile_image_url,name`);
  return (json.data || []).map((u) => ({ username: u.username, name: u.name, description: u.description || '', followers: (u.public_metrics && u.public_metrics.followers_count) || 0, avatar: (u.profile_image_url || '').replace('_normal', '_400x400') || null }));
}

module.exports = {
  expandedLinks,
  lookupUsers,
  apiAvailable,
  platform: 'x',
  label: 'X',
  color: '#a1a1aa',
  kinds: ['user', 'search'],
  intervalMin: { user: 240, search: 180 },
  apiState, parseApi, parseLegacyTweet, parseSyndication, parseEmbedTweet, postsInResults, embedToken, fetchTweet, usage, webUsage,
  isConfigured(kind) {
    if (config.creds.xBearer && apiParked()) {
      const web = require('../lib/websearch').configured();
      if (kind === 'search' && !web) return { ok: false, note: `${apiState.reason} — search needs a working token or web search` };
      return { ok: true, note: `${apiState.reason} — using the keyless route` };
    }
    if (config.creds.xBearer) {
      const u = usage();
      if (u.posts >= budget()) {
        const web = require('../lib/websearch').configured();
        return kind === 'search' && !web ? { ok: false, note: `Monthly X read budget used (${u.posts}/${budget()})` } : { ok: true, note: `Budget used (${u.posts}/${budget()}) — keyless fallback` };
      }
      return { ok: true, note: `Official API · ${u.posts.toLocaleString('en')} / ${budget().toLocaleString('en')} posts read this month` };
    }
    const web = require('../lib/websearch').configured();
    if (kind === 'search') return web ? { ok: true, note: 'Keyless: finds x.com posts through web search — add X_BEARER_TOKEN for full search' } : { ok: false, note: 'Search needs X_BEARER_TOKEN or web search (SEARXNG_URL)' };
    return { ok: true, note: `Keyless best-effort (embed timeline${web ? ', then web search' : ''}) — add X_BEARER_TOKEN for reliability` };
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
        // Out of budget, or the plan does not include this endpoint (403): fall through to the keyless routes.
        if (!(e.budget || e.apiOff || e.status === 429)) throw e;
      }
    }
    if (feed.kind === 'search') return viaWebSearch(feed, ctx, cursor);
    // Profiles: the embed timeline first. X often serves it empty, stale or not at all to logged-out readers, so an
    // empty or failed answer falls back to finding the account's posts through web search.
    let items = []; let embedErr = null;
    try { items = await viaSyndication(feed); } catch (e) { embedErr = e; }
    if (!items.length) {
      let r;
      try { r = await viaWebSearch(feed, ctx, cursor); } catch (e) {
        if (e.skip && !embedErr) return { items: [], via: 'syndication', notes: [e.message] }; // embed answered, just empty
        if (e.skip) { embedErr.message = `${embedErr.message}; ${e.message}`; throw embedErr; }
        e.message = `${e.message} (embed timeline: ${embedErr.message})`;
        throw e;
      }
      if (embedErr) r.notes.unshift(`embed timeline failed: ${embedErr.message}`);
      if (ctx.needProfile) { try { r.profile = await fetchProfileFx(feed.target); } catch { /* optional */ } }
      return r;
    }
    let newest = cursor.newestAt || null;
    const fresh = [];
    for (const it of items) {
      const at = it.cursorAt || it.postedAt;
      if (at && (!newest || at > newest)) newest = at;
      if (cursor.newestAt && at && at <= cursor.newestAt && !ctx.force) continue;
      fresh.push(it);
    }
    let profile;
    if (ctx.needProfile) { try { profile = await fetchProfileFx(feed.target); } catch { /* optional */ } }
    return { items: fresh, cursor: newest ? { ...cursor, newestAt: newest } : (cursor.seen ? cursor : undefined), profile, via: 'syndication' };
  },
};
import { fetchPage } from '../lib/net.js';
import { MediaAsset } from '../lib/models.js';

export default async function xAdapter(query) {
    const results = [];
    // Bypassing login walls by using a nitter or alternative frontend if needed
    const url = `https://nitter.net/search?q=${encodeURIComponent(query)}`;
    const html = await fetchPage(url);
    
    const images = html.match(/https?:\/\/[^" ]+\.(?:jpg|jpeg|png|webp|gif)/gi) || [];
    for (const src of images) {
        results.push(new MediaAsset({ 
            url: src, 
            source: 'x', 
            type: 'image' 
        }));
    }
    return results;
}
