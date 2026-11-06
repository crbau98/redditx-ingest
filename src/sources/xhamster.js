'use strict';
/**
 * xHamster adapter — one gay creator's page: https://xhamster.com/gay/creators/<slug>.
 *
 * Why this source: it is the only gay-creator directory that answers one plain GET with no login, no
 * API key and no proxy, and whose robots.txt allows the bare creator URL (only the newest/best/most-*
 * sub-tabs and pages 6-50 are disallowed). The `/gay/` prefix is the male scope; the page is a
 * creator-owned feed: items are trusted (the `/gay/` category is the male scope), while the hard
 * female/trans vocabulary check and the safety, physique and picture gates still run on every item.
 *
 * The creator page is server-rendered: `window.initials` carries the creator (name, avatar,
 * subscribers, view count) and the newest videos (id, title, duration, created, thumbnails, page
 * URL). The video page carries the stream: its `<link rel="preload" as="fetch">` points at the HLS
 * playlist (h264 preferred over av1), and `videoModel` carries the description and the poster.
 * Media links are signed and expire within hours, so engine/playback.js asks resolve() for a fresh
 * playlist when the proxy reports one dead (see `canRefresh` there).
 *
 * Feed kind:
 *   user - one creator page
 */
const http = require('./http').forPlatform('xhamster', 1200);
const { clip, toIso, isChallengeText } = require('./util');
const { robotsAllows } = require('./web');

// xHamster serves the same public HTML to a normal browser; the identified PRISM agent gets the
// same page today, but the browser identity is what the robots.txt check uses too.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const pageHeaders = () => ({ accept: 'text/html,application/xhtml+xml', 'user-agent': BROWSER_UA });

const FIRST_ITEMS = 24;   // a first read takes the creator's newest page
const RUN_ITEMS = 8;      // every later run reads a handful of video pages
const PROBE_ITEMS = 2;    // "does this creator page exist?" reads two
const SEEN_KEEP = 400;    // remembered video ids in the feed cursor
const CHALLENGE_COOLDOWN_MS = 45 * 60 * 1000;
// Slugs that are navigation, not creators (`/gay/creators/all`, `/2`, `/contest`, ...).
const RESERVED = new Set(['all', 'newest', 'best', 'most-commented', 'most-viewed', 'top', 'trending', 'countries', 'contest', 'categories', 'pornstars', 'videos', 'shorts', 'moments', 'channels']);
const SLUG = /^[a-z0-9][a-z0-9_-]{1,60}$/i;

const creatorUrl = (slug) => `https://xhamster.com/gay/creators/${slug}`;

function challengeError() {
  const e = new Error('xHamster is showing a bot check — the site blocked this read');
  e.status = 503;
  e.retryAfter = CHALLENGE_COOLDOWN_MS;
  e.challenged = true;
  return e;
}

/** `window.initials` is the page's whole server-rendered state. */
function initials(html) {
  const m = /window\.initials\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(String(html || ''));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** The HLS playlist the video page preloads (h264 before av1: every player here decodes h264). */
function hlsUrlFrom(html) {
  const all = String(html || '').match(/https:\/\/video[a-z0-9.-]*xhcdn\.com\/[^"'\s\\]+\.m3u8/g) || [];
  return all.find((u) => /h264/i.test(u)) || all.find((u) => !/av1/i.test(u)) || all[0] || null;
}

/** A direct MP4 URL from xplayerSettings (shorts pages publish these unencrypted; video pages do not). */
function mp4UrlFrom(xplayer) {
  const h264 = (xplayer && xplayer.sources && xplayer.sources.standard && xplayer.sources.standard.h264) || [];
  const real = h264.filter((s) => s && /^https?:\/\//.test(String(s.url || '')));
  const best = real.slice().sort((a, b) => Number(String(b.quality || '').replace('p', '')) - Number(String(a.quality || '').replace('p', '')))[0];
  return best ? best.url : null;
}

function pickArray(component) {
  if (!component || typeof component !== 'object') return [];
  const arr = (component.videoListProps && component.videoListProps.videoThumbProps) || component.videoThumbProps;
  return Array.isArray(arr) ? arr : [];
}

/** Parse a creator page: the man, his counts, and his newest videos. */
function creatorPage(html) {
  const d = initials(html);
  if (!d) return null;
  const info = (d.infoComponent && d.infoComponent.pornstarTop) || {};
  const subs = d.infoComponent && d.infoComponent.subscribeButtonsProps;
  const videos = new Map();
  for (const key of ['newestVideoSectionComponent', 'momentsListComponent', 'publisherVideoSectionComponent', 'recommendedVideoSectionComponent']) {
    for (const v of pickArray(d[key])) {
      if (!v || !v.pageURL) continue;
      const id = String(v.id || v.pageURL);
      if (!videos.has(id)) videos.set(id, v);
    }
  }
  const list = [...videos.values()]
    .map((v) => ({
      id: String(v.id || ''),
      url: /^https?:/i.test(v.pageURL) ? v.pageURL : `https://xhamster.com${v.pageURL.startsWith('/') ? '' : '/'}${v.pageURL}`,
      title: v.title || null,
      created: Number(v.created) || null,
      duration: Number(v.duration) || null,
      thumb: v.imageURL || v.thumbURL || null,
      preview: v.previewThumbURL || v.thumbURL || null,
      views: Number(v.views) || 0,
    }))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  return {
    name: info.name || null,
    avatar: info.thumbUrl || null,
    subscribers: Number(subs && subs.subscribeButtonProps && subs.subscribeButtonProps.subscribers) || null,
    views: Number(info.viewsCount) || null,
    videoCount: Number(info.videoCount) || null,
    country: info.translatedCountryName || null,
    videos: list,
  };
}

/** Parse a video page: title, description, duration, poster and the stream. */
function videoPage(html, fallback = {}) {
  const d = initials(html) || {};
  const lp = d.layoutPage || {};
  const vm = d.videoModel || lp.momentProps || lp.videoProps || {};
  const x = d.xplayerSettings || {};
  const model = (vm.videoModel && typeof vm.videoModel === 'object') ? vm.videoModel : vm;
  const hls = hlsUrlFrom(html);
  const mp4 = mp4UrlFrom(x);
  return {
    title: model.title || fallback.title || null,
    body: model.description || '',
    duration: Number(model.duration) || Number(x.duration) || fallback.duration || null,
    created: Number(model.created) || fallback.created || null,
    author: (model.author && model.author.name) || null,
    thumb: model.imageURL || model.thumbURL || x.poster || fallback.thumb || null,
    preview: model.thumbURL || model.previewThumbURL || fallback.preview || null,
    hls,
    mp4,
    views: Number(model.views) || 0,
  };
}

/**
 * One creator feed. `feed.target` is the canonical creator URL; a bare slug is accepted too.
 * @param {{kind: string, target: string}} feed
 * @param {{limit?: number, probe?: boolean, cursor?: object, aborted?: () => boolean}} ctx
 */
async function fetchFeed(feed, ctx = {}) {
  const notes = [];
  const parsed = parse(feed.target);
  const target = parsed ? parsed.target : String(feed.target || '');
  if (!parsed) return { items: [], notes: ['not an xHamster gay creator page'], via: 'xhamster' };
  if (!(await robotsAllows(target, { userAgent: BROWSER_UA }))) {
    return { items: [], notes: ['robots.txt disallows this creator page'], via: 'xhamster' };
  }

  let html;
  try {
    html = await http.text(target, { maxBytes: 2_500_000, retries: 1, headers: pageHeaders() });
  } catch (e) {
    if (isChallengeText(e.body)) throw challengeError();
    throw e;
  }
  if (isChallengeText(html)) throw challengeError();
  const page = creatorPage(String(html));
  if (!page) return { items: [], notes: ['creator page could not be read'], via: 'xhamster' };

  const seen = new Set((ctx.cursor && ctx.cursor.seen) || []);
  const asked = Number(ctx.limit) || 0;
  const cap = ctx.probe ? Math.min(PROBE_ITEMS, asked || PROBE_ITEMS) : (!seen.size ? FIRST_ITEMS : RUN_ITEMS);
  const fresh = page.videos.filter((v) => v.id && !seen.has(v.id)).slice(0, cap);
  if (!fresh.length && page.videos.length) notes.push('xhamster: no new videos since the last run');

  const items = [];
  for (const v of fresh) {
    if (ctx.aborted && ctx.aborted()) break;
    let vh;
    try {
      if (!(await robotsAllows(v.url, { userAgent: BROWSER_UA }))) { seen.add(v.id); continue; }
      vh = await http.text(v.url, { maxBytes: 2_500_000, retries: 1, headers: pageHeaders() });
    } catch (e) {
      if (isChallengeText(e.body)) throw challengeError();
      notes.push(`xhamster: ${v.id} — ${e.message}`);
      seen.add(v.id); // a dead video must not be retried on every run
      continue;
    }
    if (isChallengeText(vh)) throw challengeError();
    seen.add(v.id);
    const page2 = videoPage(String(vh), v);
    const stream = page2.hls || page2.mp4;
    if (!stream) { notes.push(`xhamster: ${v.id} has no readable stream`); continue; }
    items.push({
      sourceId: `xhamster-${v.id}`,
      position: 0,
      title: clip(page2.title || v.title || page.name || page2.author || v.id, 200),
      body: clip(page2.body || '', 2000),
      author: page.name || page2.author || null,
      score: page2.views || v.views || 0,
      postedAt: toIso(page2.created || v.created),
      permalink: v.url,
      mediaType: 'video',
      mediaUrl: stream,
      hlsUrl: page2.hls || null,
      previewUrl: page2.preview || page2.thumb || v.preview || v.thumb || null,
      thumbnailUrl: page2.thumb || v.thumb || null,
      duration: page2.duration ? Math.round(page2.duration) : null,
      tags: [],
      // The `/gay/` creator page is male by the site's own category, like a GayForFans performer page:
      // trusted, so a title with no male word of its own is not pushed to review. The hard female /
      // trans vocabulary check and the safety, physique and picture gates still run on every item.
      nsfw: 'explicit',
      trusted: true,
    });
    if (asked && items.length >= asked) break;
  }

  const kept = [...seen].slice(-SEEN_KEEP);
  return {
    items,
    cursor: { seen: kept },
    profile: page.name ? {
      displayName: page.name,
      avatarUrl: page.avatar,
      bannerUrl: null,
      bio: null,
      links: [{ platform: 'external', service: 'xHamster', label: `xHamster · ${page.name}`, url: target, handle: page.name }],
    } : null,
    notes,
    via: 'xhamster-html',
  };
}

/** Parse an xHamster gay creator URL (or bare slug) into a feed spec. */
function parse(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let slug = null;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?xhamster\.com\/gay\/creators\/([a-z0-9][a-z0-9_-]{1,60})\/?(?:[?#].*)?$/i);
  if (m) slug = m[1];
  else if (SLUG.test(s)) slug = s;
  if (!slug || /^\d+$/.test(slug) || RESERVED.has(slug.toLowerCase())) return null;
  const url = creatorUrl(slug.toLowerCase());
  return { platform: 'xhamster', kind: 'user', target: url, ingestable: true, label: `${slug.toLowerCase()} (xHamster)`, url };
}

/** A fresh stream link for a video page whose signed HLS playlist expired (see engine/playback.js). */
async function resolve(pageUrl) {
  const url = /^https?:/i.test(String(pageUrl || '')) ? String(pageUrl) : null;
  if (!url || !/xhamster\.com\//i.test(url)) return null;
  if (!(await robotsAllows(url, { userAgent: BROWSER_UA }))) return null;
  const html = await http.text(url, { maxBytes: 2_500_000, retries: 1, headers: pageHeaders() });
  if (isChallengeText(html)) return null;
  const page = videoPage(String(html));
  const stream = page.hls || page.mp4;
  return stream ? { mediaUrl: stream, previewUrl: page.preview || page.thumb || null } : null;
}

module.exports = {
  _creatorPage: creatorPage,
  _videoPage: videoPage,
  _initials: initials,
  _hlsUrlFrom: hlsUrlFrom,
  platform: 'xhamster',
  label: 'xHamster',
  color: '#f97316',
  kinds: ['user'],
  intervalMin: { user: 240 },
  isConfigured: () => ({ ok: true, note: 'public creator pages, no key' }),
  parse,
  fetch: fetchFeed,
  resolve,
};
