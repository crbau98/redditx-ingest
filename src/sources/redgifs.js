'use strict';
/**
 * RedGIFs adapter (public v2 API with a temporary guest token).
 *
 * Feed kinds:
 *   user   - everything a creator posted (the best signal: creator-owned)
 *   search - text search, ordered by latest
 *   niche  - a RedGIFs niche (community)
 * Searches are untrusted: items must carry a male signal, see lib/scope.
 */
const config = require('../config');
const http = require('./http').forPlatform('redgifs', 700);
const { toIso, clip } = require('./util');

const base = config.baseUrls.redgifs;
let cached = null;

async function authHeaders() {
  if (!cached || Date.now() > cached.expires) {
    const res = await http.json(`${base}/v2/auth/temporary`, { headers: { origin: 'https://www.redgifs.com' }, retries: 1 });
    if (!res || !res.token) throw new Error('RedGIFs auth returned no token');
    cached = { token: res.token, expires: Date.now() + 40 * 60 * 1000 };
  }
  return { authorization: `Bearer ${cached.token}`, origin: 'https://www.redgifs.com' };
}

async function api(path) {
  try {
    return await http.json(`${base}${path}`, { headers: await authHeaders() });
  } catch (e) {
    if (e.status === 401 || e.status === 403) { cached = null; return http.json(`${base}${path}`, { headers: await authHeaders() }); }
    throw e;
  }
}

function itemFromGif(gif, query) {
  if (!gif || !gif.urls) return null;
  const isImage = gif.type === 2 || gif.type === 'image';
  // Image posts sometimes ship only urls.gif / urls.poster. A video still needs a real file (hd/sd/silent);
  // its poster is a still and must not be ingested as the clip.
  const mediaUrl = gif.urls.hd || gif.urls.sd || gif.urls.silent || (isImage ? (gif.urls.gif || gif.urls.poster) : null);
  if (!mediaUrl) return null;
  const tags = (gif.tags || []).map(String);
  return {
    sourceId: `redgifs-${gif.id}`,
    position: 0,
    title: clip(tags.slice(0, 5).join(' ') || query || gif.id, 200),
    author: gif.userName || null,
    community: (gif.niches && gif.niches[0]) || null,
    score: (gif.likes || 0) + Math.round((gif.views || 0) / 50),
    postedAt: toIso(gif.createDate),
    permalink: `https://www.redgifs.com/watch/${gif.id}`,
    mediaType: isImage ? 'image' : 'video',
    mediaUrl,
    previewUrl: gif.urls.poster || gif.urls.thumbnail || null,
    thumbnailUrl: gif.urls.thumbnail || null,
    hasAudio: !!gif.hasAudio,
    width: gif.width || null,
    height: gif.height || null,
    duration: gif.duration || null,
    tags,
    nsfw: 'explicit',
    query: query || null,
    trusted: true, // API-provided media URL (scope trust is decided per feed by the engine)
  };
}

/** Profile block from a RedGIFs user object, including outbound links (paid pages stay link records, never fetches). */
function profileFromUser(u) {
  if (!u || !u.username) return null;
  const bits = [];
  if (typeof u.profileUrl === 'string') bits.push(u.profileUrl);
  if (typeof u.description === 'string') bits.push(u.description);
  for (const l of Array.isArray(u.links) ? u.links : []) {
    if (typeof l === 'string') bits.push(l);
    else if (l && typeof l.url === 'string') bits.push(l.url);
  }
  const social = u.socialMedia || u.social || {};
  if (social && typeof social === 'object') for (const v of Object.values(social)) if (typeof v === 'string') bits.push(v);
  const { extractLinks } = require('../lib/links');
  return {
    displayName: u.name || u.username,
    bio: u.description || null,
    avatarUrl: u.profileImageUrl || null,
    verified: !!u.verified,
    links: extractLinks(bits.join(' ')),
  };
}

function idFromUrl(url) {
  const m = String(url).match(/redgifs\.com\/(?:watch\/|ifr\/|embed\/)?([A-Za-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Creators behind the top results for a keyword (discovery). The gif search response carries a
 * `users` block with profile details; we tally how many top results each creator owns.
 */
async function searchCreators(q, { order = 'trending', count = 80 } = {}) {
  return tallyCreators(await api(`/v2/gifs/search?search_text=${encodeURIComponent(q)}&order=${order}&count=${count}&page=1`));
}

/**
 * Creators who post the most in one niche (the niche's top gifs, tallied by poster), verified ones first.
 * Discovery follows these from the niches PRISM already reads: related creators of the same kind.
 */
async function nicheCreators(niche, { order = 'top', count = 80 } = {}) {
  const list = tallyCreators(await api(`/v2/niches/${encodeURIComponent(niche)}/gifs?order=${order}&count=${count}&page=1`));
  return list.sort((a, b) => (b.verified === true) - (a.verified === true) || b.gifs - a.gifs);
}

/** A gif list response -> its posters: { username, gifs, tags, name, description, followers, verified, avatar }, most gifs first. */
function tallyCreators(json) {
  const byName = new Map();
  for (const g of json.gifs || []) {
    if (!g || !g.userName) continue;
    const k = String(g.userName).toLowerCase();
    const e = byName.get(k) || { username: g.userName, gifs: 0, tags: new Set() };
    e.gifs++; for (const t of g.tags || []) e.tags.add(String(t));
    byName.set(k, e);
  }
  for (const u of json.users || []) {
    const e = byName.get(String(u.username || '').toLowerCase());
    if (e) Object.assign(e, { name: u.name || null, description: u.description || null, followers: u.followers || 0, verified: !!u.verified, avatar: u.profileImageUrl || null });
  }
  return [...byName.values()].map((e) => ({ ...e, tags: [...e.tags].slice(0, 12) })).sort((a, b) => b.gifs - a.gifs);
}

/**
 * One RedGIFs profile by username (discovery: "does this OnlyFans creator post free clips here?").
 * Returns null when there is no such user. `links` is every URL the profile shows (bio + profile link).
 */
async function lookupUser(username) {
  let json;
  try { json = await api(`/v2/users/${encodeURIComponent(String(username).toLowerCase())}`); } catch (e) {
    if (e.status === 404 || e.status === 410) return null;
    throw e;
  }
  const u = (json && (json.user || json)) || null;
  if (!u || !u.username) return null;
  const links = [u.profileUrl, ...(Array.isArray(u.links) ? u.links.map((l) => (l && (l.url || l.href)) || l) : []), ...Object.values(u.socialMedia || u.social || {})]
    .filter((x) => typeof x === 'string' && x);
  return {
    username: u.username, name: u.name || null, description: u.description || null, followers: u.followers || 0, gifs: u.gifs || u.publishedGifs || 0,
    verified: !!u.verified, avatar: u.profileImageUrl || null, links,
  };
}

module.exports = {
  searchCreators,
  nicheCreators,
  tallyCreators,
  lookupUser,
  platform: 'redgifs',
  label: 'RedGIFs',
  color: '#e11d48',
  kinds: ['user', 'search', 'niche'],
  intervalMin: { user: 240, search: 180, niche: 180 },
  itemFromGif,
  profileFromUser,
  isConfigured: () => ({ ok: true }),

  async resolve(url) {
    const id = idFromUrl(url);
    if (!id) return null;
    const json = await api(`/v2/gifs/${encodeURIComponent(id)}`);
    return itemFromGif(json.gif || json, null);
  },

  async fetch(feed, ctx) {
    const count = Math.min(ctx.limit || 40, 80);
    const cursor = ctx.cursor || {};
    let path;
    if (feed.kind === 'user') path = `/v2/users/${encodeURIComponent(feed.target)}/search?order=recent&count=${count}`;
    else if (feed.kind === 'niche') path = `/v2/niches/${encodeURIComponent(feed.target)}/gifs?order=latest&count=${count}`;
    else path = `/v2/gifs/search?search_text=${encodeURIComponent(feed.target)}&order=latest&count=${count}`;

    const items = [];
    let newest = cursor.newestAt || null;
    const maxPages = cursor.newestAt ? 1 : 2;
    let profile;
    for (let page = 1; page <= maxPages; page++) {
      if (ctx.aborted()) break;
      const json = await api(`${path}&page=${page}`);
      for (const gif of json.gifs || []) {
        const it = itemFromGif(gif, feed.kind === 'search' ? feed.target : null);
        if (!it) continue;
        if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
        if (cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) continue;
        items.push(it);
      }
      if (feed.kind === 'user' && !profile && json.users && json.users[0]) {
        const u = json.users[0];
        profile = profileFromUser(u);
      }
      if (page >= (json.pages || 1)) break;
    }
    return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via: 'api' };
  },
};
