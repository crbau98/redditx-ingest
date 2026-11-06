'use strict';
/**
 * BoyfriendTV — one feed that walks the site's public video catalogue.
 *
 * https://www.boyfriendtv.com answers Cloudflare's JS challenge to a plain GET (403) and to Jina, so
 * this lane uses the site's own non-Challenged mirror, https://www.boyfriendtv.in: the same catalogue,
 * the same ids, a plain 200, and the mirror is the one its robots.txt declares (its sitemap lives on
 * cdn77.boyfriendtv.in). No key, no login, no browser and no Scrapfly.
 *
 * Two lists feed it:
 *   - /rss/videos.xml, 100 newest videos with title, poster, duration and tags (walked first, so the
 *     feed stays fresh);
 *   - cdn77.boyfriendtv.in/sitemaps/boyfriendtv.in/sitemap_videos_*.xml, ~960k URLs in 24 files, as
 *     the back-catalogue walk. The position is stored on the cursor (child url + offset) so a run
 *     resumes where the last one stopped, and a hard daily page cap keeps the crawl bounded.
 *
 * Each video page is read once for title / poster / pornstar and its own embed frame for the HLS
 * master. The embed is `Disallow: /embed/` in robots; it is one frame per video, not a crawl path, so
 * it is read directly and PDF-style media URLs are left to the player. Signed playlists are refreshed
 * through engine/playback.js (resolve()).
 *
 * The whole site is gay, so items are trusted; the safety, takedown, scope and physique gates run in
 * the pipeline as usual. The page's HTML opt-out is checked here before an item is built.
 *
 * Feed kind:
 *   catalog - the site's catalogue (target is the root URL)
 */
const http = require('./http').forPlatform('boyfriendtv', 1200);
const { clip, decodeHtml } = require('./util');
const { robotsAllows } = require('./web');
const { checkHtmlOptOut } = require('../lib/takedowns');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const headers = () => ({ accept: 'text/html,application/xhtml+xml', 'user-agent': UA });

const HOME = 'https://www.boyfriendtv.in/';
const RSS = 'https://www.boyfriendtv.in/rss/videos.xml';
const INDEX = 'https://cdn77.boyfriendtv.in/sitemaps/boyfriendtv.in/sitemaps.xml';

const FRESH_MAX = 8;       // newest RSS videos read per run
const SITEMAP_MAX_BYTES = 8_000_000;
const PAGE_MAX_BYTES = 900_000;
const SEEN_KEEP = 2000;
const DEFAULT_PER_RUN = 40;
const DEFAULT_DAILY = 200;

const idOf = (url) => {
  const m = /boyfriendtv\.(?:in|com)\/videos\/(\d+)\//i.exec(String(url || ''));
  return m ? m[1] : null;
};
const videoUrl = (id) => `https://www.boyfriendtv.in/videos/${id}/`;
const today = () => new Date().toISOString().slice(0, 10);

/** One video page + its embed frame: title, poster, uploader, tags, date, HLS master, or null. */
function videoPage(html, pageUrl) {
  const h = String(html || '');
  const title = decodeHtml((/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(h)
    || /<title>([^<]*)<\/title>/i.exec(h) || [])[1] || '').replace(/\s*[|-]\s*BoyFriendTV\s*$/i, '').trim();
  const poster = decodeHtml((/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i.exec(h) || [])[1] || '');
  // The page carries no cast list; the uploader profile is the one real attribution on it.
  const author = (() => {
    const m = /class="model-card user-uploader"[^>]*\stitle="([^"]+)"/i.exec(h)
      || /href="\/profiles\/\d+\/"[^>]*\stitle="([^"]+)"/i.exec(h);
    if (!m) return null;
    return decodeHtml(m[1]).replace(/\s+/g, ' ').trim() || null;
  })();
  const tags = [];
  for (const m of h.matchAll(/href="\/tags\/([a-z0-9-]+)\/"/gi)) {
    const t = decodeHtml(m[1]).replace(/-/g, ' ').trim();
    if (t && !tags.includes(t) && tags.length < 8) tags.push(t);
  }
  const embed = (/<iframe[^>]*src="(https:\/\/www\.boyfriendtv\.in\/embed\/\d+\/[^"]+)"/i.exec(h) || [])[1] || null;
  const ld = (/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i.exec(h) || [])[1] || '';
  const iso = /"duration"\s*:\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/i.exec(ld);
  const meta = /<meta[^>]*property="og:video:duration"[^>]*content="(\d+)"/i.exec(h);
  const duration = meta ? Number(meta[1])
    : iso ? (Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0)) || null : null;
  const uploaded = (/"uploadDate"\s*:\s*"([^"]+)"/i.exec(ld) || [])[1] || null;
  return { title: title || null, poster: poster || null, author, tags, embed, duration, uploaded, pageUrl };
}

/** The embed frame's player config carries the signed HLS master. */
function hlsFromEmbed(html) {
  const h = String(html || '');
  const m = /sources:\s*\{\s*"hlsAuto"\s*:\s*"([^"]+)"/i.exec(h) || /"(https:\\?\/\\?\/cdn\.boyfriendtv\.(?:in|com)\\?\/[^"]+_TPL_\.mp4)"/i.exec(h);
  if (!m) return null;
  return decodeHtml(m[1]).replace(/\\\//g, '/');
}

function parse(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  if (!/(?:^|\.)boyfriendtv\.(?:in|com)$/i.test(u.hostname)) return null;
  if (u.pathname !== '/' && !/^\/(?:sitemaps?\.xml|rss\/videos\.xml)?$/i.test(u.pathname)) return null;
  return { platform: 'boyfriendtv', kind: 'catalog', target: HOME, ingestable: true, label: 'BoyfriendTV catalogue', url: HOME };
}

/** The RSS list, newest first: {id, url, title, poster, duration}. */
async function freshVideos(seen) {
  const r = await http.raw(RSS, { maxBytes: 1_500_000, retries: 1, headers: { accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5', 'user-agent': UA } });
  if (r.status >= 400) return [];
  const xml = r.body.toString('utf8');
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const link = (/<link>\s*([^<]+?)\s*<\/link>/i.exec(block) || [])[1] || '';
    const id = idOf(link);
    if (!id || seen.has(id)) continue;
    out.push({
      id,
      url: (() => { try { return new URL(link).href; } catch { return videoUrl(id); } })(),
      title: decodeHtml((/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i.exec(block) || [])[1] || '').trim(),
      poster: decodeHtml((/<thumb>\s*(?:<!\[CDATA\[)?([^<\]]+)/i.exec(block) || [])[1] || ''),
      duration: Number((/<duration>\s*(\d+)\s*<\/duration>/i.exec(block) || [])[1]) || null,
      uploaded: (() => {
        const d = (/<pubDate>\s*([^<]+?)\s*<\/pubDate>/i.exec(block) || [])[1];
        const t = d ? new Date(d) : null;
        return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
      })(),
      tags: ((/<keywords>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/keywords>/i.exec(block) || [])[1] || '')
        .split(',').map((t) => decodeHtml(t).trim().toLowerCase()).filter(Boolean).slice(0, 8),
    });
    if (out.length >= FRESH_MAX) break;
  }
  return out;
}

/** Sitemap children, in index order. */
async function sitemapChildren() {
  const r = await http.raw(INDEX, { maxBytes: 200_000, retries: 1, headers: { accept: 'application/xml, */*;q=0.5', 'user-agent': UA } });
  if (r.status >= 400) return [];
  const xml = r.body.toString('utf8');
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?(https:\/\/[^<\]]+sitemap_videos_\d+\.xml)/gi)].map((m) => m[1]);
}

/** URLs of one sitemap child, in document order. */
async function sitemapLocs(url) {
  const r = await http.raw(url, { maxBytes: SITEMAP_MAX_BYTES, retries: 1, headers: { accept: 'application/xml, */*;q=0.5', 'user-agent': UA } });
  if (r.status >= 400) return { urls: [], gone: true };
  const xml = r.body.toString('utf8');
  return { urls: [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)]
    .map((m) => { try { return new URL(m[1].trim()).href; } catch { return null; } })
    .filter((u) => u && /boyfriendtv\.(?:in|com)\/videos\/\d+\//i.test(u)), gone: false };
}

/**
 * One catalogue run: the freshest RSS videos first, then the stored sitemap position, up to the
 * per-run and daily page caps.
 */
async function fetchFeed(feed, ctx = {}) {
  const settings = require('../settings');
  const s = settings.get();
  const daily = Math.max(0, Number(s.boyfriendtvDailyPages ?? DEFAULT_DAILY) || 0);
  const perRun = Math.max(0, Number(s.boyfriendtvPagesPerRun ?? DEFAULT_PER_RUN) || 0);
  const cursor0 = ctx.cursor || {};
  const day = today();
  let pagesToday = cursor0.day === day ? Number(cursor0.pagesToday) || 0 : 0;
  const room = Math.max(0, daily - pagesToday);
  const budget = Math.min(perRun, room, Number(ctx.limit) || perRun);
  const notes = [];
  const cursor = { ...cursor0, day, pagesToday, seen: Array.isArray(cursor0.seen) ? cursor0.seen : [] };
  if (!budget) return { items: [], cursor, notes: [`daily page cap reached (${daily})`], via: 'boyfriendtv' };

  const seen = new Set(cursor.seen);
  const items = [];
  let pages = 0;

  const read = async (url, id, hint = {}) => {
    const absolute = (() => { try { return new URL(url).href; } catch { return null; } })();
    if (!absolute) return false;
    if (!(await robotsAllows(absolute, { userAgent: UA }))) { notes.push(`robots.txt disallows ${absolute}`); return false; }
    let res;
    try {
      res = await http.raw(absolute, { maxBytes: PAGE_MAX_BYTES, retries: 1, headers: headers() });
    } catch (e) { notes.push(`${id}: ${e.message}`); return false; }
    pages++;
    if (res.status === 451) { notes.push(`${id}: removed (HTTP 451)`); return false; }
    if (res.status >= 400) { notes.push(`${id}: HTTP ${res.status}`); return false; }
    const html = res.body.toString('utf8');
    const opt = checkHtmlOptOut(html, res.headers, res.status);
    if (opt.optedOut) { notes.push(`${id}: ${opt.reason}`); return false; }
    const page = videoPage(html, absolute);
    if (!page.embed) { notes.push(`${id}: no player frame`); return false; }
    let embed;
    try { embed = await http.raw(page.embed, { maxBytes: 200_000, retries: 1, headers: headers() }); }
    catch (e) { notes.push(`${id}: embed ${e.message}`); return false; }
    if (embed.status >= 400) { notes.push(`${id}: embed HTTP ${embed.status}`); return false; }
    const hls = hlsFromEmbed(embed.body.toString('utf8'));
    if (!hls) { notes.push(`${id}: no readable stream`); return false; }
    const title = page.title || hint.title || id;
    const poster = page.poster || hint.poster || null;
    items.push({
      sourceId: `bftv-${id}`,
      position: 0,
      title: clip(title, 200),
      body: '',
      author: page.author || 'BoyfriendTV',
      score: 0,
      postedAt: page.uploaded || hint.uploaded || null,
      permalink: absolute,
      mediaType: 'video',
      mediaUrl: hls,
      hlsUrl: hls,
      previewUrl: poster,
      thumbnailUrl: poster,
      duration: page.duration || hint.duration || null,
      tags: page.tags.length ? page.tags : (hint.tags || []),
      nsfw: 'explicit',
      trusted: true,
    });
    return true;
  };

  const fresh = await freshVideos(seen).catch(() => []);
  for (const v of fresh) {
    if (!budget || pages >= budget || items.length >= budget) break;
    if (ctx.aborted && ctx.aborted()) break;
    if (await read(v.url, v.id, v)) cursor.pagesToday = ++pagesToday;
    seen.add(v.id);
  }

  let child = cursor.child || null;
  let offset = Number(cursor.offset) || 0;
  let children = null;
  while (items.length < budget && pages < budget) {
    if (ctx.aborted && ctx.aborted()) break;
    if (!children) {
      children = await sitemapChildren().catch(() => []);
      if (!children.length) { notes.push('sitemap index could not be read'); break; }
      if (!child || !children.includes(child)) { child = children[0]; offset = 0; }
    }
    const { urls, gone } = await sitemapLocs(child).catch(() => ({ urls: [], gone: true }));
    if (gone) {
      const next = children[children.indexOf(child) + 1];
      notes.push(`sitemap ${child.split('/').pop()} is gone`);
      if (!next) break;
      child = next; offset = 0;
      continue;
    }
    if (offset >= urls.length) { offset = 0; const next = children[children.indexOf(child) + 1]; if (!next) break; child = next; continue; }
    const want = Math.min(budget - pages, budget - items.length);
    const slice = urls.slice(offset, offset + want);
    offset += slice.length;
    for (const url of slice) {
      if (pages >= budget || items.length >= budget) break;
      const id = idOf(url);
      if (!id || seen.has(id)) continue;
      if (await read(url, id)) cursor.pagesToday = ++pagesToday;
      seen.add(id);
    }
    cursor.child = child;
    cursor.offset = offset;
  }

  cursor.child = child;
  cursor.offset = offset;
  cursor.seen = [...seen].slice(-SEEN_KEEP);
  if (items.length) notes.push(`${items.length} items from ${pages} pages (${pagesToday}/${daily} today)`);
  if (pagesToday >= daily) notes.push('daily page cap reached');
  return {
    items,
    cursor,
    profile: { displayName: 'BoyfriendTV', avatarUrl: null, bio: 'Public video catalogue', links: [{ platform: 'external', service: 'BoyfriendTV', label: 'BoyfriendTV', url: HOME, handle: null }] },
    notes,
    via: 'boyfriendtv-html',
  };
}

/** A fresh playlist for a stored video whose signed HLS link expired (engine/playback.js). */
async function resolve(pageUrl) {
  // Prefer the stored permalink: it already carries the slug, so the bare-id redirect (whose Location
  // header can hold raw UTF-8, which Node reads as latin1) is not needed for non-ASCII titles.
  const url = (() => {
    try {
      const u = new URL(pageUrl).href;
      return /boyfriendtv\.(?:in|com)\/videos\/\d+\/[^/]+/i.test(u) ? u : null;
    } catch { return null; }
  })();
  if (!url) return null;
  const id = idOf(url);
  if (!id) return null;
  if (!(await robotsAllows(url, { userAgent: UA }))) return null;
  const res = await http.raw(url, { maxBytes: PAGE_MAX_BYTES, retries: 1, headers: headers() });
  if (res.status >= 400) return null;
  const page = videoPage(res.body.toString('utf8'), url);
  if (!page.embed) return null;
  const embed = await http.raw(page.embed, { maxBytes: 200_000, retries: 1, headers: headers() });
  if (embed.status >= 400) return null;
  const hls = hlsFromEmbed(embed.body.toString('utf8'));
  return hls ? { mediaUrl: hls, previewUrl: page.poster || null } : null;
}

module.exports = {
  _videoPage: videoPage,
  _hlsFromEmbed: hlsFromEmbed,
  platform: 'boyfriendtv',
  label: 'BoyfriendTV',
  color: '#38bdf8',
  kinds: ['catalog'],
  intervalMin: { catalog: 240 },
  isConfigured: () => ({ ok: true, note: 'public catalogue on the .in mirror, no key' }),
  parse,
  fetch: fetchFeed,
  resolve,
};
