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
const { absUrl, clip, uniq } = require('./util');
const { extractLinks } = require('../lib/links');
const { hostOf, hostBlocked, looksLikeDirectMedia, looksLikeVideo } = require('../lib/mediaurl');
const rss = require('./rss');

/* --------------------------------------------------------------- robots.txt */
const robotsCache = new Map();
async function robotsAllows(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const key = u.origin;
  let rules = robotsCache.get(key);
  if (!rules || rules.expires < Date.now()) {
    let disallow = [];
    try {
      const txt = await http.text(`${key}/robots.txt`, { maxBytes: 200_000, retries: 0 });
      let applies = false;
      for (const raw of txt.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        if (/^user-agent$/i.test(k)) applies = v.trim() === '*' || /prism/i.test(v);
        else if (applies && /^disallow$/i.test(k) && v.trim()) disallow.push(v.trim());
      }
    } catch { disallow = []; } // no robots.txt (or unreachable) = allowed
    rules = { disallow, expires: Date.now() + 3600_000 };
    robotsCache.set(key, rules);
  }
  const path = u.pathname + u.search;
  return !rules.disallow.some((d) => path.startsWith(d.replace(/\*$/, '')));
}

const IMG_JUNK = /(?:^|[\/_.-])(?:avatar|emoji|icon|logo|favicon|sprite|badge|pixel|spacer|blank|tracking|gravatar|banner-ad)(?:[\/_.-]|$)|\.svg(?:\?|$)|\/ads?\//i;

function metaContent($, ...names) {
  for (const n of names) {
    const v = $(`meta[property="${n}"]`).attr('content') || $(`meta[name="${n}"]`).attr('content');
    if (v) return v.trim();
  }
  return null;
}

function bestSrcset(srcset, base) {
  const cands = String(srcset || '').split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]).map((p) => ({ url: absUrl(p[0], base), w: parseInt(p[1], 10) || 0 }));
  cands.sort((a, b) => b.w - a.w);
  return cands[0] && cands[0].url;
}

function extractPage(html, pageUrl) {
  const $ = cheerio.load(html);
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
    const src = absUrl(bestSrcset(el.attr('srcset') || el.attr('data-srcset'), pageUrl) || el.attr('src') || el.attr('data-src') || el.attr('data-original'), pageUrl);
    if (!src || IMG_JUNK.test(src) || src.startsWith('data:')) return;
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
    // Hrefs from anchors plus URLs embedded in hydration JSON (Linktree et al.)
    const hrefs = [];
    page.$('a[href]').each((_, a) => hrefs.push(absUrl(page.$(a).attr('href'), feed.target)));
    const jsonUrls = (html.match(/https?:\\?\/\\?\/[^"'\s<>\\]+(?:\\\/[^"'\s<>\\]*)*/g) || []).map((u) => u.replace(/\\\//g, '/'));
    const links = extractLinks(uniq([...hrefs, ...jsonUrls]).join(' '))
      .filter((l) => l.platform !== 'web' && l.platform !== 'linkinbio')
      .slice(0, 30);
    return {
      items: [],
      profile: { displayName: page.title && page.title.replace(/\s*[|\-–·].*$/, '').trim(), bio: page.description, avatarUrl: page.image, links },
      via: 'html',
    };
  },
};

module.exports = { webAdapter, linkInBioAdapter, extractPage, robotsAllows };
