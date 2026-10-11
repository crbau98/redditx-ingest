'use strict';
/**
 * Reddit adapter.
 *
 * Reddit is the richest source but also the one that most often blocks
 * unauthenticated server traffic (403/429 from datacenter IPs). To keep
 * ingestion working without babysitting, every request walks a transport
 * ladder and uses the first one that answers:
 *
 *   1. OAuth app-only token (REDDIT_CLIENT_ID/SECRET)   - the supported way
 *   2. www  /<path>.json                                 - public JSON
 *   3. old  /<path>.json                                 - different edge
 *   4. /<path>.rss                                       - Atom, rarely blocked
 *   5. Arctic Shift archive                              - works when Reddit is down
 */
const config = require('../config');
const http = require('./http').forPlatform('reddit', 1100);
const net = require('../lib/net');
const rss = require('./rss');
const { toIso, decodeHtml, pickWidth, clip } = require('./util');
const { hostOf, hostBlocked, hostMatches, normalizeMediaUrl, looksLikeDirectMedia } = require('../lib/mediaurl');

const base = config.baseUrls.reddit;
const oldBase = base.includes('www.reddit.com') ? base.replace('www.reddit.com', 'old.reddit.com') : base;
const REDGIFS_LINK = /redgifs\.com\/(?:watch|ifr)\/[a-z0-9]+/i;

/* ----------------------------------------------------------------- OAuth */
let token = null;
async function oauthToken() {
  const { redditClientId: id, redditClientSecret: secret } = config.creds;
  if (!id || !secret) return null;
  if (token && Date.now() < token.expires - 60000) return token.value;
  const res = await net.fetchJSON(`${base}/api/v1/access_token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': config.redditUserAgent,
    },
    body: 'grant_type=client_credentials',
    retries: 1,
  });
  if (!res.access_token) throw new Error('Reddit OAuth returned no token');
  token = { value: res.access_token, expires: Date.now() + (res.expires_in || 3600) * 1000 };
  return token.value;
}

/* --------------------------------------------------------------- parsing */
function previewOf(d) {
  const img = d.preview && d.preview.images && d.preview.images[0];
  if (!img || !img.source) return {};
  const cands = [{ url: decodeHtml(img.source.url), width: img.source.width }]
    .concat((img.resolutions || []).map((r) => ({ url: decodeHtml(r.url), width: r.width })));
  return {
    previewUrl: pickWidth(cands, 640),
    width: img.source.width || null,
    height: img.source.height || null,
    mp4: img.variants && img.variants.mp4 && img.variants.mp4.source && decodeHtml(img.variants.mp4.source.url),
  };
}

/** One Reddit submission -> 0..n ingest items (galleries yield several). */
function parsePost(post) {
  const d = (post && post.data) || post;
  if (!d || !d.id) return [];
  if (d.removed_by_category || d.author === '[deleted]') return [];
  const cp = d.crosspost_parent_list && d.crosspost_parent_list[0];
  const ownMedia = d.is_gallery || d.is_video || (d.media && d.media.reddit_video);
  const src = cp && !ownMedia ? cp : d; // crossposts carry their media on the parent
  const url = decodeHtml(src.url_overridden_by_dest || src.url || '');
  const host = hostOf(url);

  const base = {
    sourceId: d.id,
    title: clip(d.title || '', 300),
    text: clip(d.selftext || '', 400),
    author: d.author,
    community: d.subreddit,
    score: d.score || 0,
    postedAt: toIso(d.created_utc),
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    nsfw: d.over_18 ? 'explicit' : 'suggestive',
    tags: d.link_flair_text ? [d.link_flair_text] : [],
    trusted: true,
  };
  const prev = previewOf(src);
  const items = [];

  if (src.is_gallery && src.gallery_data && src.media_metadata) {
    (src.gallery_data.items || []).slice(0, 20).forEach((gi, i) => {
      const meta = src.media_metadata[gi.media_id];
      if (!meta || meta.status !== 'valid' || !meta.s) return;
      const s = meta.s;
      const isAnim = meta.e === 'AnimatedImage';
      const video = isAnim && s.mp4 ? decodeHtml(s.mp4) : null;
      const mediaUrl = video || decodeHtml(s.u || s.gif || '');
      if (!mediaUrl) return;
      items.push({
        ...base, position: i, mediaType: video ? 'video' : 'image', mediaUrl,
        previewUrl: pickWidth((meta.p || []).map((p) => ({ url: decodeHtml(p.u), width: p.x })), 640) || (video ? null : mediaUrl),
        width: s.x || null, height: s.y || null,
        altText: gi.caption || null,
      });
    });
    return items;
  }

  const rv = (src.secure_media && src.secure_media.reddit_video) || (src.media && src.media.reddit_video) || (src.preview && src.preview.reddit_video_preview);
  if (rv && rv.fallback_url) {
    return [{
      ...base, position: 0, mediaType: 'video',
      mediaUrl: String(rv.fallback_url).replace(/\?source=fallback$/, ''),
      hlsUrl: rv.hls_url ? decodeHtml(rv.hls_url) : null,
      hasAudio: !rv.is_gif && !!rv.hls_url,
      previewUrl: prev.previewUrl, width: rv.width || prev.width, height: rv.height || prev.height, duration: rv.duration || null,
    }];
  }

  if (REDGIFS_LINK.test(url)) {
    return [{ ...base, position: 0, mediaType: 'video', mediaUrl: url, previewUrl: null, resolve: 'redgifs', width: prev.width, height: prev.height }];
  }

  if (host && hostBlocked(host) && !hostMatches(host, 'redd.it')) return [];

  const isGifLike = /\.(gif|gifv)(\?|$)/i.test(url);
  if (isGifLike && prev.mp4) {
    return [{ ...base, position: 0, mediaType: 'video', mediaUrl: prev.mp4, previewUrl: prev.previewUrl, width: prev.width, height: prev.height }];
  }
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
    return [{ ...base, position: 0, mediaType: 'video', mediaUrl: url, previewUrl: prev.previewUrl, width: prev.width, height: prev.height }];
  }
  if (hostMatches(host, 'imgur.com') && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) {
    const norm = normalizeMediaUrl(url);
    if (!norm) return []; // album
    return [{ ...base, position: 0, mediaType: /\.mp4$/.test(norm) ? 'video' : 'image', mediaUrl: norm, previewUrl: prev.previewUrl, width: prev.width, height: prev.height }];
  }
  if (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(url) || hostMatches(host, 'i.redd.it')) {
    return [{ ...base, position: 0, mediaType: 'image', mediaUrl: url, previewUrl: prev.previewUrl || url, width: prev.width, height: prev.height }];
  }
  return []; // text / unsupported external link
}

/** Atom entries from the .rss transport -> items (no scores / dimensions available). */
function fromRssEntry(entry) {
  const id = String(entry.id || '').replace(/^t3_/, '') || (entry.link || '').split('/comments/')[1]?.split('/')[0];
  if (!id) return [];
  const author = (entry.author || '').replace(/^\/?u\//, '') || null;
  const sub = ((entry.link || '').match(/\/r\/([^/]+)\//) || [])[1] || null;
  const direct = entry.media.find((m) => looksLikeDirectMedia(m.url) && /redd\.it|imgur\.com/.test(m.url));
  const redgifsLink = (entry.links || []).find((u) => REDGIFS_LINK.test(u));
  const redgifs = redgifsLink ? { url: redgifsLink, type: 'video' } : entry.media.find((m) => REDGIFS_LINK.test(m.url));
  const any = direct || entry.media.find((m) => /preview\.redd\.it|i\.redd\.it/.test(m.url));
  const pick = redgifs || any;
  if (!pick) return [];
  const mediaUrl = pick.url.replace(/&amp;/g, '&');
  const common = { sourceId: id, position: 0, title: entry.title, author, community: sub, score: 0, postedAt: entry.published, permalink: entry.link, nsfw: 'explicit', trusted: true, tags: [] };
  if (redgifs) return [{ ...common, mediaType: 'video', mediaUrl, resolve: 'redgifs' }];
  return [{ ...common, mediaType: pick.type, mediaUrl, previewUrl: pick.type === 'image' ? mediaUrl : null }];
}

/* ------------------------------------------------------------- transports */
function listingPath(feed, sort, t) {
  if (feed.kind === 'user') return `/user/${encodeURIComponent(feed.target)}/submitted`;
  return `/r/${encodeURIComponent(feed.target)}/${sort}`;
}

function qs(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function viaOauth(path, params) {
  const t = await oauthToken();
  if (!t) return null;
  const json = await http.json(`${config.baseUrls.redditOauth}${path}?${qs({ ...params, raw_json: 1 })}`, {
    headers: { authorization: `Bearer ${t}`, 'user-agent': config.redditUserAgent },
  });
  return { children: (json.data && json.data.children) || [], after: json.data && json.data.after, via: 'oauth' };
}

async function viaJson(origin, path, params, label) {
  const json = await http.json(`${origin}${path}.json?${qs({ ...params, raw_json: 1 })}`, {
    headers: { 'user-agent': config.redditUserAgent },
  });
  if (!json || !json.data) throw new Error('unexpected Reddit JSON shape');
  return { children: json.data.children || [], after: json.data.after, via: label };
}

async function viaRss(path, params) {
  const text = await http.text(`${base}${path}.rss?${qs({ limit: params.limit, sort: params.sort, t: params.t })}`, {
    headers: { 'user-agent': config.redditUserAgent, accept: 'application/atom+xml, application/xml' },
  });
  const feed = rss.parseFeed(text, base);
  return { items: feed.entries.flatMap(fromRssEntry), after: null, via: 'rss' };
}

async function viaArchive(feed, params) {
  const q = { limit: Math.min(params.limit || 100, 100), sort: 'desc', ...(feed.kind === 'user' ? { author: feed.target } : { subreddit: feed.target }) };
  const json = await http.json(`${config.baseUrls.redditArchive}/api/posts/search?${qs(q)}`);
  const rows = Array.isArray(json) ? json : json.data || [];
  return { children: rows, after: null, via: 'archive' };
}

/** Walk the transport ladder; returns the first page that works plus notes about failures. */
async function fetchPage(feed, sort, params) {
  const path = listingPath(feed, sort);
  const attempts = [
    () => viaOauth(path, params),
    () => viaJson(base, path, params, 'json'),
    () => viaJson(oldBase, path, params, 'old'),
    () => viaRss(path, params),
    () => viaArchive(feed, params),
  ];
  const notes = [];
  let firstErr;
  for (const attempt of attempts) {
    try {
      const page = await attempt();
      if (page) { page.notes = notes; return page; }
    } catch (e) {
      if (!firstErr) firstErr = e; // the primary failure is the one worth reporting, not the last mirror's
      notes.push(`${e.status || e.code || 'err'} ${String(e.message).slice(0, 80)}`);
      if (e.status === 404 || e.status === 410) break; // banned/private/unknown: no point trying mirrors
    }
  }
  if (!firstErr) firstErr = new Error('no Reddit transport available');
  if (notes.length > 1) firstErr.message += ` (${notes.length - 1} fallback${notes.length > 2 ? 's' : ''} also failed)`;
  throw firstErr;
}

async function fetchProfile(name) {
  try {
    const t = await oauthToken();
    const json = t
      ? await http.json(`${config.baseUrls.redditOauth}/user/${encodeURIComponent(name)}/about?raw_json=1`, { headers: { authorization: `Bearer ${t}`, 'user-agent': config.redditUserAgent } })
      : await http.json(`${base}/user/${encodeURIComponent(name)}/about.json?raw_json=1`, { headers: { 'user-agent': config.redditUserAgent } });
    const d = json.data || {};
    const sr = d.subreddit || {};
    return {
      displayName: sr.title || d.name || name,
      bio: sr.public_description || null,
      avatarUrl: decodeHtml(d.snoovatar_img || sr.icon_img || d.icon_img || '') || null,
      bannerUrl: decodeHtml(sr.banner_img || '') || null,
    };
  } catch { return null; }
}

module.exports = {
  platform: 'reddit',
  label: 'Reddit',
  color: '#ff4500',
  kinds: ['community', 'user'],
  intervalMin: { community: 90, user: 240 },
  parsePost, fromRssEntry,
  isConfigured() {
    return config.creds.redditClientId && config.creds.redditClientSecret
      ? { ok: true, note: 'OAuth enabled' }
      : { ok: true, note: 'Public mode — add REDDIT_CLIENT_ID/SECRET for reliable access' };
  },

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    const first = !cursor.newestAt;
    // First pass: breadth (top of the month + hot). After that: incremental "new".
    const passes = first && feed.kind === 'community'
      ? [{ sort: 'top', t: 'month' }, { sort: 'hot' }]
      : [{ sort: 'new' }];
    const items = [];
    const notes = new Set();
    let via = null;
    let newest = cursor.newestAt || null;

    for (const pass of passes) {
      let after = null;
      const maxPages = first ? 3 : 2;
      for (let page = 0; page < maxPages; page++) {
        if (ctx.aborted()) break;
        const res = await fetchPage(feed, pass.sort, { limit: Math.min(ctx.limit || 100, 100), t: pass.t, after, sort: feed.kind === 'user' ? 'new' : undefined });
        via = via || res.via;
        (res.notes || []).forEach((n) => notes.add(n));
        const parsed = res.items || res.children.flatMap(parsePost);
        let reachedKnown = false;
        for (const it of parsed) {
          if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
          if (!first && pass.sort === 'new' && cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
          items.push(it);
        }
        after = res.after;
        if (!after || reachedKnown) break;
      }
    }

    let profile;
    if (feed.kind === 'user' && (ctx.needProfile || first)) profile = await fetchProfile(feed.target);
    return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via, notes: [...notes] };
  },
};
