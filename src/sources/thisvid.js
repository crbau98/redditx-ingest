'use strict';
/**
 * ThisVid — one member's public video list.
 *
 * https://thisvid.com/members/<id>/public_videos/ lists that member's public clips with no login.
 * robots.txt Disallow: /members/ (the profile area), but /videos/<slug>/ is allowed and carries the
 * KVS flashvars with a signed MP4. Operator-pasted member URLs are read for the list only; each
 * video page still goes through robotsAllows. No key, no browser, no Scrapfly.
 *
 * The site is adult and predominantly gay-male amateur; items are trusted for the male scope, and
 * the pipeline's safety / female / physique / picture gates still run on every item.
 *
 * Feed kind:
 *   user - one member's public_videos list (target is the member id or a members URL)
 */
const http = require('./http').forPlatform('thisvid', 1500);
const { clip, decodeHtml } = require('./util');
const { robotsAllows } = require('./web');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const headers = () => ({ accept: 'text/html,application/xhtml+xml', 'user-agent': UA });

const FIRST_ITEMS = 12;
const RUN_ITEMS = 6;
const PROBE_ITEMS = 2;
const SEEN_KEEP = 400;
const PAGE_MAX = 1_200_000;
const MEMBER_RE = /^(?:https?:\/\/)?(?:www\.)?thisvid\.com\/members\/(\d+)(?:\/(?:public_videos|favourite_videos)?\/?)?(?:[?#].*)?$/i;

const memberUrl = (id) => `https://thisvid.com/members/${id}/public_videos/`;
const memberPageUrl = (id, page) => (page > 1
  ? `https://thisvid.com/members/${id}/public_videos/${page}/`
  : memberUrl(id));

function absUrl(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  if (s.startsWith('//')) return `https:${s}`;
  try { return new URL(s, 'https://thisvid.com/').href; } catch { return null; }
}

/** Member display name + avatar + public video URLs from a public_videos HTML page. */
function memberPage(html) {
  const h = String(html || '');
  const title = decodeHtml((/<title>([^<]*)<\/title>/i.exec(h) || [])[1] || '');
  const name = title.replace(/\s*'s\s+Public Videos.*$/i, '').replace(/\s*\|\s*ThisVid\.com.*$/i, '').trim() || null;
  const avatar = absUrl((/contents\/avatars\/[^"'>\s]+/i.exec(h) || [])[0] || '');
  const videos = [];
  const seen = new Set();
  for (const m of h.matchAll(/href="(https:\/\/thisvid\.com\/videos\/[a-z0-9_-]+\/)"/gi)) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    videos.push({ url, slug: /\/videos\/([a-z0-9_-]+)\//i.exec(url)[1] });
  }
  const pages = [...h.matchAll(/\/members\/\d+\/public_videos\/(\d+)\//gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 1);
  const maxPage = pages.length ? Math.max(...pages) : 1;
  return { name, avatar: avatar || null, videos, maxPage };
}

/** KVS flashvars on a video page: title, poster, duration, signed MP4. */
function videoPage(html, fallback = {}) {
  const h = String(html || '');
  const title = decodeHtml((/video_title:\s*'((?:\\'|[^'])*)'/i.exec(h)
    || /<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i.exec(h)
    || /<title>([^<]*)<\/title>/i.exec(h) || [])[1] || '')
    .replace(/\\'/g, "'")
    .replace(/\s*-\s*ThisVid\.com\s*$/i, '').trim();
  const poster = absUrl(decodeHtml((/preview_url:\s*'([^']+)'/i.exec(h)
    || /<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i.exec(h) || [])[1] || ''));
  const mediaUrl = decodeHtml((/video_url:\s*'((?:\\'|[^'])*)'/i.exec(h) || [])[1] || '').replace(/\\'/g, "'") || null;
  const altUrl = decodeHtml((/video_alt_url:\s*'((?:\\'|[^'])*)'/i.exec(h) || [])[1] || '').replace(/\\'/g, "'") || null;
  const videoId = (/video_id:\s*'(\d+)'/i.exec(h) || [])[1] || null;
  const cats = decodeHtml((/video_categories:\s*'([^']*)'/i.exec(h) || [])[1] || '');
  const tags = decodeHtml((/video_tags:\s*'([^']*)'/i.exec(h) || [])[1] || '')
    .split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8);
  const durTxt = (/class="duration"[^>]*>\s*([\d:]+)/i.exec(h) || [])[1] || '';
  const duration = (() => {
    const p = durTxt.split(':').map(Number);
    if (p.some((n) => !Number.isFinite(n))) return null;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return null;
  })();
  const author = decodeHtml((/class="author"[^>]*href="https:\/\/thisvid\.com\/members\/\d+\/"[^>]*>([^<]+)/i.exec(h) || [])[1] || '').trim() || null;
  return {
    title: title || fallback.title || null,
    poster: poster || fallback.poster || null,
    mediaUrl: mediaUrl || altUrl || null,
    videoId,
    tags: tags.length ? tags : (cats ? cats.split(',').map((t) => t.trim()).filter(Boolean) : []),
    duration,
    author,
  };
}

function parse(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = MEMBER_RE.exec(s) || (/^(\d{3,10})$/.exec(s));
  if (!m) return null;
  const id = m[1];
  const url = memberUrl(id);
  return { platform: 'thisvid', kind: 'user', target: id, ingestable: true, label: `ThisVid · ${id}`, url };
}

async function fetchFeed(feed, ctx = {}) {
  const notes = [];
  const parsed = parse(feed.target) || parse(feed.url);
  if (!parsed) return { items: [], notes: ['not a ThisVid member page'], via: 'thisvid' };
  const id = parsed.target;
  const cursor0 = ctx.cursor || {};
  const seen = new Set(Array.isArray(cursor0.seen) ? cursor0.seen : []);
  const listPage = Math.max(1, Number(cursor0.page) || 1);
  const asked = Number(ctx.limit) || 0;
  const cap = ctx.probe ? Math.min(PROBE_ITEMS, asked || PROBE_ITEMS) : (!seen.size ? FIRST_ITEMS : RUN_ITEMS);

  let listHtml;
  try {
    // /members/ is Disallow in robots.txt; the operator pastes a known creator URL. Video pages are checked below.
    listHtml = await http.text(memberPageUrl(id, listPage), { maxBytes: PAGE_MAX, retries: 1, headers: headers() });
  } catch (e) {
    return { items: [], notes: [`member list: ${e.message}`], via: 'thisvid' };
  }
  const page = memberPage(listHtml);
  if (!page.videos.length) {
    return {
      items: [],
      cursor: { seen: [...seen].slice(-SEEN_KEEP), page: listPage },
      profile: page.name ? { displayName: page.name, avatarUrl: page.avatar, bio: null, links: [{ platform: 'external', service: 'ThisVid', label: `ThisVid · ${page.name}`, url: memberUrl(id), handle: page.name }] } : null,
      notes: ['no public videos on this page'],
      via: 'thisvid-html',
    };
  }

  const fresh = page.videos.filter((v) => v.slug && !seen.has(v.slug)).slice(0, cap);
  if (!fresh.length && page.videos.length) notes.push('thisvid: no new videos since the last run');

  const items = [];
  for (const v of fresh) {
    if (ctx.aborted && ctx.aborted()) break;
    if (!(await robotsAllows(v.url, { userAgent: UA }))) { seen.add(v.slug); notes.push(`robots.txt disallows ${v.url}`); continue; }
    let vh;
    try {
      vh = await http.text(v.url, { maxBytes: PAGE_MAX, retries: 1, headers: headers() });
    } catch (e) {
      notes.push(`${v.slug}: ${e.message}`);
      seen.add(v.slug);
      continue;
    }
    seen.add(v.slug);
    const vp = videoPage(vh);
    if (!vp.mediaUrl) { notes.push(`${v.slug}: no readable stream`); continue; }
    items.push({
      sourceId: `thisvid-${vp.videoId || v.slug}`,
      position: 0,
      title: clip(vp.title || v.slug, 200),
      body: '',
      author: page.name || vp.author || null,
      score: 0,
      postedAt: null,
      permalink: v.url,
      mediaType: 'video',
      mediaUrl: vp.mediaUrl,
      previewUrl: vp.poster,
      thumbnailUrl: vp.poster,
      duration: vp.duration,
      tags: vp.tags,
      nsfw: 'explicit',
      trusted: true,
    });
    if (asked && items.length >= asked) break;
  }

  // Advance the list page once every URL on this page is in `seen` (and a later page exists).
  let nextPage = listPage;
  if (page.videos.length && page.videos.every((v) => seen.has(v.slug)) && listPage < page.maxPage) {
    nextPage = listPage + 1;
  }

  return {
    items,
    cursor: { seen: [...seen].slice(-SEEN_KEEP), page: nextPage },
    profile: page.name ? {
      displayName: page.name,
      avatarUrl: page.avatar,
      bannerUrl: null,
      bio: null,
      links: [{ platform: 'external', service: 'ThisVid', label: `ThisVid · ${page.name}`, url: memberUrl(id), handle: page.name }],
    } : null,
    notes,
    via: 'thisvid-html',
  };
}

async function resolve(pageUrl) {
  const url = /^https?:/i.test(String(pageUrl || '')) ? String(pageUrl) : null;
  if (!url || !/thisvid\.com\/videos\//i.test(url)) return null;
  if (!(await robotsAllows(url, { userAgent: UA }))) return null;
  const html = await http.text(url, { maxBytes: PAGE_MAX, retries: 1, headers: headers() });
  const page = videoPage(html);
  return page.mediaUrl ? { mediaUrl: page.mediaUrl, previewUrl: page.poster || null } : null;
}

module.exports = {
  _memberPage: memberPage,
  _videoPage: videoPage,
  platform: 'thisvid',
  label: 'ThisVid',
  color: '#e11d48',
  kinds: ['user'],
  intervalMin: { user: 240 },
  isConfigured: () => ({ ok: true, note: 'public member video lists, no key' }),
  parse,
  fetch: fetchFeed,
  resolve,
};
