'use strict';
/**
 * Web page adapter + link-in-bio adapter.
 *
 *   web / page       read the media on one page (OpenGraph, <video>, linked
 *                    full-size images). Honors robots.txt.
 *   linkinbio / page crawl a Linktree-style hub for *profile links*; the
 *                    engine turns them into feeds for the same creator.
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('web', 1000);
const { absUrl, clip, uniq, bestSrcset } = require('./util');
const { extractLinks } = require('../lib/links');
const { hostOf, hostBlocked, looksLikeDirectMedia, looksLikeVideo } = require('../lib/mediaurl');
const rss = require('./rss');

/* --------------------------------------------------------------- robots.txt */
const robotsCache = new Map();

/**
 * robots.txt -> the rules that apply to us: the group naming PRISM if there is one, otherwise "*".
 * Consecutive User-agent lines share a group (RFC 9309).
 */
function parseRobots(txt) {
  const groups = [];
  let cur = null; let lastWasAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const m = raw.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (cur && v && (k === 'disallow' || k === 'allow')) cur.rules.push({ allow: k === 'allow', pattern: v });
  }
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && /prism/.test(a)));
  return (own.length ? own : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
}

/** Robots path pattern -> RegExp ("*" wildcard, trailing "$" anchor, otherwise a prefix match). */
function robotsPattern(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Longest matching rule wins; Allow beats Disallow on a tie; no matching rule = allowed. */
function pathAllowed(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!robotsPattern(r.pattern).test(path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

async function robotsAllows(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || entry.expires < Date.now()) {
    let rules = [];
    try {
      const res = await http.raw(`${key}/robots.txt`, { maxBytes: 500_000, retries: 0, headers: { accept: 'text/plain, */*;q=0.5' } });
      const body = res.body.toString('utf8');
      const ctype = String(res.headers['content-type'] || '');
      // Only a real robots.txt counts. A 404/5xx, a soft-404 HTML page or a login wall means "no rules" - it must
      // never read as "everything is disallowed" (that would silently zero every web feed on that site).
      if (res.status >= 200 && res.status < 300 && !/html/i.test(ctype) && !/^\s*</.test(body)) rules = parseRobots(body);
    } catch { rules = []; } // unreachable = no rules
    entry = { rules, expires: Date.now() + 3600_000 };
    robotsCache.set(key, entry);
  }
  return pathAllowed(entry.rules, u.pathname + u.search);
}

const IMG_JUNK = /(?:^|[\/_.-])(?:avatar|emoji|icon|logo|favicon|sprite|badge|pixel|spacer|blank|tracking|gravatar|banner-ad)(?:[\/_.-]|$)|\.svg(?:\?|$)|\/ads?\//i;

function metaContent($, ...names) {
  for (const n of names) {
    const v = $(`meta[property="${n}"]`).attr('content') || $(`meta[name="${n}"]`).attr('content');
    if (v) return v.trim();
  }
  return null;
}

function extractPage(html, pageUrl0) {
  const $ = cheerio.load(html);
  // Relative URLs resolve against <base href> when the page has one.
  const pageUrl = absUrl($('base[href]').first().attr('href'), pageUrl0) || pageUrl0;
  const media = [];
  const seen = new Set();
  const push = (m) => { if (m.url && !seen.has(m.url) && !hostBlocked(hostOf(m.url))) { seen.add(m.url); media.push(m); } };

  const ogVideo = absUrl(metaContent($, 'og:video:secure_url', 'og:video', 'og:video:url', 'twitter:player:stream'), pageUrl);
  const ogImage = absUrl(metaContent($, 'og:image', 'twitter:image'), pageUrl);
  if (ogVideo && looksLikeDirectMedia(ogVideo)) push({ url: ogVideo, type: 'video', preview: ogImage });

  $('video').each((_, v) => {
    const src = absUrl($(v).attr('src') || $(v).find('source').first().attr('src'), pageUrl);
    if (src) push({ url: src, type: 'video', preview: absUrl($(v).attr('poster'), pageUrl) });
  });
  $('a[href]').each((_, a) => {
    const href = absUrl($(a).attr('href'), pageUrl);
    if (!href || !looksLikeDirectMedia(href) || IMG_JUNK.test(href)) return;
    const img = $(a).find('img').first();
    push({ url: href, type: looksLikeVideo(href) ? 'video' : 'image', preview: img.length ? absUrl(img.attr('src') || img.attr('data-src'), pageUrl) : null });
  });
  $('img').each((_, i) => {
    const el = $(i);
    const src = absUrl(bestSrcset(el.attr('srcset') || el.attr('data-srcset'), pageUrl) || el.attr('src') || el.attr('data-src') || el.attr('data-lazy-src') || el.attr('data-original'), pageUrl);
    if (!src || src.startsWith('data:') || IMG_JUNK.test(src)) return;
    const w = parseInt(el.attr('width'), 10); const h = parseInt(el.attr('height'), 10);
    if ((w && w < 200) || (h && h < 200)) return;
    push({ url: src, type: 'image', width: w || null, height: h || null, alt: el.attr('alt') || null });
  });
  if (!media.length && ogImage && !IMG_JUNK.test(ogImage)) push({ url: ogImage, type: 'image' });

  return {
    title: metaContent($, 'og:title', 'twitter:title') || $('title').first().text().trim() || null,
    description: metaContent($, 'og:description', 'description'),
    image: ogImage,
    siteName: metaContent($, 'og:site_name'),
    feedUrl: absUrl($('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"], link[rel="alternate"][type*="feed+json"]').first().attr('href'), pageUrl),
    media: media.slice(0, 40),
    $,
  };
}

const webAdapter = {
  platform: 'web',
  label: 'Web page',
  color: '#94a3b8',
  kinds: ['page'],
  intervalMin: { page: 720 },
  extractPage,
  isConfigured: () => ({ ok: true }),

  async fetch(feed, ctx) {
    if (!(await robotsAllows(feed.target))) throw Object.assign(new Error('Blocked by robots.txt'), { skip: true });
    const html = await http.text(feed.target, { headers: { accept: 'text/html,application/xhtml+xml' }, maxBytes: 3_000_000 });
    const page = extractPage(html, feed.target);
    const items = page.media.map((m, i) => ({
      sourceId: `${feed.target}#${m.url}`.slice(0, 220),
      position: i,
      title: clip(m.alt || page.title || '', 200),
      author: page.siteName || hostOf(feed.target),
      score: 0,
      permalink: feed.target,
      mediaType: m.type,
      mediaUrl: m.url,
      previewUrl: m.preview || (m.type === 'image' ? m.url : null),
      width: m.width || null,
      height: m.height || null,
      tags: [],
      probe: true,
    }));
    const profile = { displayName: page.siteName || page.title, bio: page.description, avatarUrl: page.image };
    // The page advertises a feed? Offer it so the engine can promote it.
    return { items, profile, discoveredFeed: page.feedUrl ? { platform: 'rss', kind: 'feed', target: page.feedUrl } : null, via: 'html' };
  },
};

const linkInBioAdapter = {
  platform: 'linkinbio',
  label: 'Link-in-bio',
  color: '#22d3ee',
  kinds: ['page'],
  intervalMin: { page: 4320 },
  isConfigured: () => ({ ok: true }),

  /** Never yields media; yields profile + discovered links. */
  async fetch(feed) {
    const html = await http.text(feed.target, { headers: { accept: 'text/html' }, maxBytes: 2_000_000 });
    const page = extractPage(html, feed.target);
    // Hrefs from anchors plus URLs embedded in hydration JSON (Linktree/Beacons __NEXT_DATA__, Nuxt, inline state).
    const hrefs = [];
    page.$('a[href]').each((_, a) => hrefs.push(absUrl(page.$(a).attr('href'), feed.target)));
    // JSON escapes slashes/ampersands three ways (\/ , \u002F , \u0026); undo them so one pattern finds every URL.
    const plain = html.replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const jsonUrls = (plain.match(/https?:\/\/[^"'\s<>\\]+/g) || []).map((u) => u.replace(/[),.;]+$/, ''));
    // Click-tracking wrappers (?url=https%3A%2F%2Fx.com%2F...) hide the real destination: add it.
    const unwrapped = [...hrefs, ...jsonUrls].flatMap((h) => {
      try {
        const u = new URL(h);
        return ['url', 'u', 'link', 'target', 'to', 'redirect', 'redirect_url', 'dest', 'destination'].map((k) => u.searchParams.get(k)).filter((v) => /^https?:\/\//i.test(v || ''));
      } catch { return []; }
    });
    const links = extractLinks(uniq([...hrefs, ...jsonUrls, ...unwrapped]).join(' '))
      .filter((l) => l.platform !== 'web' && l.platform !== 'linkinbio')
      .slice(0, 30);
    return {
      items: [],
      profile: { displayName: page.title && page.title.replace(/\s*[|\-–·].*$/, '').trim(), bio: page.description, avatarUrl: page.image, links },
      via: 'html',
    };
  },
};

module.exports = { webAdapter, linkInBioAdapter, extractPage, robotsAllows, parseRobots, pathAllowed };
