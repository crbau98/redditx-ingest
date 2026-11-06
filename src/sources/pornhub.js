'use strict';
/**
 * Pornhub adapter — one male performer's page: https://www.pornhub.com/model/<slug> (the same
 * markup serves /pornstar/<slug>).
 *
 * Why this source: it is the second-largest gay creator directory that answers one plain GET with no
 * login, no API key and no proxy. robots.txt allows the bare model/pornstar page and the video page
 * (`Allow: /view_video.php*t=*`); only the sub-pages (/model/<slug>/<sub>, /model/<slug>/live,
 * paid clips) are off limits. The gay directory (https://www.pornhub.com/gay/pornstars) is allowed
 * too, so the source can find performers on its own.
 *
 * The model page is server-rendered: every card carries `data-video-vkey`, `data-segment`, the title,
 * the duration, the picture and the age. The video page carries `flashvars_<id>`, whose
 * `mediaDefinitions` list the HLS playlists per quality (h264 + AAC, plays in every browser here).
 *
 * Male scope: a model page mixes segments, so only cards whose own `data-segment` is `gay` are read.
 * Items are trusted (the site labels the segment), like an xHamster /gay/ creator page; the hard
 * female/trans vocabulary check, safety, physique and picture gates still run on every item.
 *
 * Stream links are signed (`exp=` / `e=` epoch) and stop working within hours, so
 * engine/playback.js asks resolve() for a fresh playlist when the proxy reports one dead.
 *
 * Feed kind:
 *   user - one model / pornstar page
 */
const http = require('./http').forPlatform('pornhub', 1200);
const { clip, isChallengeText } = require('./util');
const { robotsAllows } = require('./web');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const pageHeaders = () => ({ accept: 'text/html,application/xhtml+xml', 'user-agent': BROWSER_UA });

const FIRST_ITEMS = 24;
const RUN_ITEMS = 8;
const PROBE_ITEMS = 2;
const SEEN_KEEP = 400;
const CHALLENGE_COOLDOWN_MS = 45 * 60 * 1000;
// Sub-pages of a model page (robots.txt disallows /model/*/*), so only the bare page is a feed.
const RESERVED = new Set(['all', 'videos', 'photos', 'live', 'clips', 'about']);
const SLUG = /^[a-z0-9][a-z0-9_-]{1,60}$/i;

const videoUrl = (vkey) => `https://www.pornhub.com/view_video.php?viewkey=${vkey}`;

function challengeError() {
  const e = new Error('Pornhub is showing a bot check — the site blocked this read');
  e.status = 503;
  e.retryAfter = CHALLENGE_COOLDOWN_MS;
  e.challenged = true;
  return e;
}

const decode = (s) => String(s || '')
  .replace(/&#0?39;/g, "'").replace(/&#34;|&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .trim();
const stripTags = (s) => decode(String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));

/** `18:01` or `1:02:03` -> seconds. */
function durationOf(text) {
  const parts = String(text || '').trim().split(':').map((n) => Number(n));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** `14.4M`, `70.9K`, `1,234` -> a number. */
function countOf(text) {
  const m = /([\d.,]+)\s*([KMB])?/i.exec(String(text || ''));
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] || '').toUpperCase();
  return Math.round(n * (unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'B' ? 1e9 : 1));
}

const UNITS = { second: 1e3, minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };
/** `3 weeks ago` -> ISO. A tube page dates its cards in words, not timestamps. */
function relativeIso(text, now = Date.now()) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  if (/^(just now|now|today)$/.test(s)) return new Date(now).toISOString();
  if (/^yesterday$/.test(s)) return new Date(now - 86400e3).toISOString();
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/.exec(s);
  if (!m) return null;
  // The tube site sometimes prints a nonsense age ("56 years ago" on a 2024 clip). Anything older than
  // four decades is that bug, not a date, so it is left out rather than stored as 1970.
  if (m[2] === 'year' && Number(m[1]) > 40) return null;
  return new Date(now - Number(m[1]) * UNITS[m[2]]).toISOString();
}

/** A JS object literal at `i` (page_params is not JSON: keys can be bare and it embeds HTML). */
function objectAt(text, i) {
  let depth = 0; let quote = null;
  for (let p = i; p < text.length; p++) {
    const c = text[p];
    if (quote) {
      if (c === '\\') { p++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return text.slice(i, p + 1); }
  }
  return null;
}

/** The player config: `var flashvars_<videoId> = {...}`. */
function flashvars(html) {
  const m = /var\s+flashvars_\d+\s*=\s*\{/.exec(String(html || ''));
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  const text = objectAt(String(html), start);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** The model/pornstar page: the man, his picture, and every card, newest first. */
function modelPage(html) {
  const h = String(html || '');
  const name = stripTags((/<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/.exec(h) || /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(h) || [])[1]) || null;
  const avatar = (/"getAvatar"\s+src="([^"]+)"/.exec(h) || /<img[^>]*class="[^"]*avatar[^"]*"[^>]*\ssrc="([^"]+)"/.exec(h) || /<meta property="og:image" content="([^"]+)"/.exec(h) || [])[1] || null;
  const videos = [];
  const seen = new Set();
  const re = /<li class="pcVideoListItem/g;
  let m;
  while ((m = re.exec(h))) {
    const close = h.indexOf('</li>', m.index);
    const block = h.slice(m.index, close === -1 ? h.length : close + 5);
    const vkey = (/data-video-vkey="([a-z0-9]+)"/i.exec(block) || [])[1];
    if (!vkey || seen.has(vkey)) continue;
    const segment = ((/data-segment="([a-z]*)"/i.exec(block) || [])[1] || '').toLowerCase();
    if (segment !== 'gay') continue; // a model page mixes segments; the gay label is the male scope
    seen.add(vkey);
    const title = decode((/href="\/view_video\.php\?viewkey=[a-z0-9]+"\s+title="([^"]*)"/i.exec(block) || [])[1] || '');
    const thumb = (/src="(https:\/\/[^"]+phncdn\.com[^"]+)"/i.exec(block) || [])[1] || null;
    const added = (/<var class="added">([^<]*)<\/var>/i.exec(block) || [])[1] || null;
    const durText = (/<var class="duration">([^<]*)<\/var>/i.exec(block) || [])[1] || null;
    const viewsText = (/<span class="views"><var>([^<]*)<\/var>/i.exec(block) || [])[1] || null;
    videos.push({
      vkey,
      url: videoUrl(vkey),
      title,
      duration: durationOf(durText),
      postedAt: relativeIso(added),
      thumb,
      views: countOf(viewsText),
    });
  }
  // The cards already come newest-first; a page whose dates are words ("3 weeks ago") would lose that
  // order to a second-precision sort, so the page order is kept and the date only feeds postedAt.
  return { name, avatar: avatar ? decode(avatar) : null, videos };}

/** The video page: title, date, poster, and the best HLS playlist. */
function videoPage(html) {
  const h = String(html || '');
  const fv = flashvars(h) || {};
  const defs = Array.isArray(fv.mediaDefinitions) ? fv.mediaDefinitions : [];
  const hls = defs
    .filter((d) => d && /hls/i.test(String(d.format || '')) && /^https?:\/\//.test(String(d.videoUrl || '')))
    .sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0))[0];
  const info = (/<div class="videoInfo">([^<]*)<\/div>/i.exec(h) || [])[1] || null;
  const titleTag = (/<title>([^<]*)<\/title>/i.exec(h) || [])[1] || null;
  const cleanTitle = titleTag ? decode(titleTag).replace(/\s*[-|]\s*Pornhub[^-|]*$/i, '').trim() : null;
  return {
    title: decode(fv.video_title || '') || cleanTitle,
    body: '',
    duration: Number(fv.video_duration) || null,
    postedAt: relativeIso(info),
    author: null,
    thumb: decode(fv.image_url || '') || null,
    preview: null,
    hls: hls ? decode(hls.videoUrl) : null,
    views: 0,
  };
}

/**
 * One performer feed. `feed.target` is the canonical model/pornstar URL.
 * @param {{kind: string, target: string}} feed
 * @param {{limit?: number, probe?: boolean, cursor?: object, aborted?: () => boolean}} ctx
 */
async function fetchFeed(feed, ctx = {}) {
  const notes = [];
  const parsed = parse(feed.target);
  if (!parsed) return { items: [], notes: ['not a Pornhub model or pornstar page'], via: 'pornhub' };
  const target = parsed.target;
  if (!(await robotsAllows(target, { userAgent: BROWSER_UA }))) {
    return { items: [], notes: ['robots.txt disallows this page'], via: 'pornhub' };
  }

  let html;
  try {
    html = await http.text(target, { maxBytes: 3_000_000, retries: 1, headers: pageHeaders() });
  } catch (e) {
    if (isChallengeText(e.body)) throw challengeError();
    throw e;
  }
  if (isChallengeText(html)) throw challengeError();
  const page = modelPage(String(html));
  if (!page.videos.length) {
    // A page with no cards may simply be empty; a page with no cards and no name is a wall.
    if (!page.name) return { items: [], notes: ['performer page could not be read'], via: 'pornhub' };
    return { items: [], notes: ['pornhub: no gay videos on this page'], via: 'pornhub', profile: profileOf(page, target) };
  }

  const seen = new Set((ctx.cursor && ctx.cursor.seen) || []);
  const asked = Number(ctx.limit) || 0;
  const cap = ctx.probe ? Math.min(PROBE_ITEMS, asked || PROBE_ITEMS) : (!seen.size ? FIRST_ITEMS : RUN_ITEMS);
  const fresh = page.videos.filter((v) => !seen.has(v.vkey)).slice(0, cap);
  if (!fresh.length && page.videos.length) notes.push('pornhub: no new videos since the last run');

  const items = [];
  for (const v of fresh) {
    if (ctx.aborted && ctx.aborted()) break;
    let vh;
    try {
      vh = await http.text(v.url, { maxBytes: 3_000_000, retries: 1, headers: pageHeaders() });
    } catch (e) {
      if (isChallengeText(e.body)) throw challengeError();
      notes.push(`pornhub: ${v.vkey} — ${e.message}`);
      seen.add(v.vkey); // a dead video must not be retried on every run
      continue;
    }
    if (isChallengeText(vh)) throw challengeError();
    seen.add(v.vkey);
    const page2 = videoPage(String(vh));
    if (!page2.hls) { notes.push(`pornhub: ${v.vkey} has no readable stream`); continue; }
    items.push({
      sourceId: `pornhub-${v.vkey}`,
      position: 0,
      title: clip(page2.title || v.title || page.name || v.vkey, 200),
      body: clip(page2.body || '', 2000),
      author: page.name || page2.author || null,
      score: v.views || page2.views || 0,
      postedAt: page2.postedAt || v.postedAt || null,
      permalink: v.url,
      mediaType: 'video',
      mediaUrl: page2.hls,
      hlsUrl: page2.hls,
      previewUrl: page2.thumb || v.thumb || null,
      thumbnailUrl: page2.thumb || v.thumb || null,
      duration: Math.round(page2.duration || v.duration || 0) || null,
      tags: [],
      // The site's own `data-segment="gay"` is the male scope, like an xHamster /gay/ page; the hard
      // female/trans vocabulary check and the safety, physique and picture gates still run.
      nsfw: 'explicit',
      trusted: true,
    });
    if (asked && items.length >= asked) break;
  }

  return {
    items,
    cursor: { seen: [...seen].slice(-SEEN_KEEP) },
    profile: profileOf(page, target),
    notes,
    via: 'pornhub-html',
  };
}

function profileOf(page, target) {
  if (!page.name) return null;
  return {
    displayName: page.name,
    avatarUrl: page.avatar,
    bannerUrl: null,
    bio: null,
    links: [{ platform: 'external', service: 'Pornhub', label: `Pornhub · ${page.name}`, url: target, handle: page.name }],
  };
}

/** Canonical model/pornstar URL, or null. Sub-pages (/videos, /photos, /live) are not feeds. */
function canonical(input) {
  const s = String(input || '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?pornhub\.com\/(model|pornstar)\/([a-z0-9][a-z0-9_-]{1,60})\/?$/i);
  if (!m) return null;
  const slug = m[2].toLowerCase();
  if (/^\d+$/.test(slug) || RESERVED.has(slug)) return null;
  return { kind: m[1].toLowerCase(), slug, target: `https://www.pornhub.com/${m[1].toLowerCase()}/${slug}` };
}

function parse(input) {
  const c = canonical(input);
  if (!c) return null;
  return { platform: 'pornhub', kind: 'user', target: c.target, ingestable: true, label: `${c.slug} (Pornhub)`, url: c.target };
}

/**
 * The gay performer directory (https://www.pornhub.com/gay/pornstars): 25-32 cards a page.
 * @returns {Array<{url: string, name: string, slug: string, kind: string, views: number}>}
 */
function modelsFromDirectory(html) {
  const h = String(html || '');
  const out = [];
  const seen = new Set();
  const re = /<li class="modelLi[^"]*"[\s\S]{0,2500}?<\/li>/g;
  let m;
  while ((m = re.exec(h))) {
    const block = m[0];
    const link = /href="\/(model|pornstar)\/([a-z0-9][a-z0-9_-]{1,60})"/i.exec(block);
    if (!link) continue;
    const slug = link[2].toLowerCase();
    if (seen.has(slug) || /^\d+$/.test(slug) || RESERVED.has(slug)) continue;
    seen.add(slug);
    const name = stripTags((/alt="([^"]+)"/i.exec(block) || [])[1] || slug);
    const views = countOf((/<span class="viewsNumber[^"]*">([^<]*)</i.exec(block) || [])[1] || '');
    out.push({ url: `https://www.pornhub.com/${link[1].toLowerCase()}/${slug}`, name, slug, kind: link[1].toLowerCase(), views });
  }
  return out;
}

/** A fresh playlist for a video page whose signed HLS link expired (see engine/playback.js). */
async function resolve(pageUrl) {
  const url = /^https?:/i.test(String(pageUrl || '')) ? String(pageUrl) : null;
  if (!url || !/pornhub\.com\/view_video\.php/i.test(url)) return null;
  if (!(await robotsAllows(url, { userAgent: BROWSER_UA }))) return null;
  const html = await http.text(url, { maxBytes: 3_000_000, retries: 1, headers: pageHeaders() });
  if (isChallengeText(html)) return null;
  const page = videoPage(String(html));
  return page.hls ? { mediaUrl: page.hls, previewUrl: page.thumb || null } : null;
}

module.exports = {
  _modelPage: modelPage,
  _videoPage: videoPage,
  _flashvars: flashvars,
  _relativeIso: relativeIso,
  _durationOf: durationOf,
  _countOf: countOf,
  platform: 'pornhub',
  label: 'Pornhub',
  color: '#f59e0b',
  kinds: ['user'],
  intervalMin: { user: 240 },
  isConfigured: () => ({ ok: true, note: 'public model pages, no key' }),
  parse,
  fetch: fetchFeed,
  resolve,
  modelsFromDirectory,
};
