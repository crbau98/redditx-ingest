'use strict';
/**
 * GayForFans adapter (gayforfans.com — the ranked directory of gay male OnlyFans performers).
 *
 *   user  target "https://gayforfans.com/performer/<slug>"   one performer's page: every video he
 *         has on the site is fetched through its own page and ingested as HLS (the site serves
 *         /play/<id>/manifest, which its robots.txt explicitly allows for that pattern).
 *
 * Items are creator-owned (the page *is* his), so they carry `trusted: true`; the engine's safety,
 * takedown, male-scope and picture gates still run on every one of them.
 *
 * Discovery (engine/discovery.js `gffDiscovery`) walks the public /performer directory — ranked by
 * popularity, 75 pages — and registers the top performers as feeds.
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('gff', 900);
const { clip, toIso } = require('./util');
const { robotsAllows } = require('./web');

const PAGE_VIDEOS = 14;   // video pages read per run (each is one full page fetch)
const SEEN_KEEP = 400;    // remembered video slugs in the feed cursor

function durationOf(iso) {
  const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/** The VideoObject block of a video page: {name, contentUrl (HLS manifest), thumbnailUrl, uploadDate, duration}. */
function videoObject(html) {
  const $ = cheerio.load(html);
  let out = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (out) return;
    let j;
    try { j = JSON.parse($(el).text()); } catch { return; }
    const list = Array.isArray(j) ? j : [j, ...(j && j['@graph'] ? j['@graph'] : [])];
    for (const node of list) if (node && node['@type'] === 'VideoObject' && node.contentUrl) out = node;
  });
  return out;
}

/** The performer page: display name, avatar, and the video page links (newest first as listed). */
function performerPage(html) {
  const $ = cheerio.load(html);
  const name = ($('h1').first().text() || '').trim() || null;
  const avatar = $('meta[property="og:image"]').attr('content')
    || $('img[alt]').filter((i, el) => !/GayForFans|placeholder/i.test($(el).attr('alt') || '')).first().attr('src')
    || null;
  const videos = [];
  const seen = new Set();
  $('a[href*="/video/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/video\/([a-z0-9-]{6,})/i);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    videos.push({ slug: m[1], url: /^https?:/i.test(href) ? href : `https://gayforfans.com${href}`, title: ($(el).text() || '').replace(/\s+/g, ' ').trim() });
  });
  return { name, avatar, videos };
}

module.exports = {
  platform: 'gff',
  label: 'GayForFans',
  color: '#38bdf8',
  kinds: ['user'],
  intervalMin: { user: 360 },
  isConfigured: () => ({ ok: true }),

  /** Parse a gayforfans performer URL into a feed spec. */
  parse(input) {
    const m = String(input || '').match(/gayforfans\.com\/performer\/([a-z0-9-]{3,})/i);
    if (!m) return null;
    return { platform: 'gff', kind: 'user', target: `https://gayforfans.com/performer/${m[1]}`, ingestable: true, label: m[1], url: `https://gayforfans.com/performer/${m[1]}` };
  },

  async fetch(feed, ctx = {}) {
    const notes = [];
    const items = [];
    if (!(await robotsAllows(feed.target))) return { items: [], notes: ['robots.txt disallows this page'], via: 'gff' };

    let html;
    try {
      html = await http.text(feed.target, { maxBytes: 3_000_000, retries: 1, headers: { accept: 'text/html' } });
    } catch (e) {
      return { items: [], notes: [`gayforfans: ${e.message}`], via: 'gff' };
    }
    const page = performerPage(String(html));
    const seen = new Set((ctx.cursor && ctx.cursor.seen) || []);
    const fresh = page.videos.filter((v) => !seen.has(v.slug)).slice(0, PAGE_VIDEOS);
    if (!fresh.length && page.videos.length) notes.push('gayforfans: no new videos since the last run');

    for (const v of fresh) {
      if (ctx.aborted && ctx.aborted()) break;
      let vh;
      try {
        vh = await http.text(v.url, { maxBytes: 3_000_000, retries: 1, headers: { accept: 'text/html' } });
      } catch (e) {
        notes.push(`gayforfans: ${v.slug} — ${e.message}`);
        seen.add(v.slug);
        continue;
      }
      seen.add(v.slug);
      const vo = videoObject(String(vh));
      if (!vo || !vo.contentUrl) continue;
      items.push({
        sourceId: `gff-${v.slug}`,
        position: 0,
        title: clip(vo.name || v.title || page.name || v.slug, 200),
        body: clip(vo.description || '', 2000),
        author: page.name || v.slug,
        score: 0,
        postedAt: toIso(vo.uploadDate),
        permalink: v.url,
        mediaType: 'video',
        mediaUrl: vo.contentUrl,
        hlsUrl: vo.contentUrl,
        previewUrl: vo.thumbnailUrl || null,
        thumbnailUrl: vo.thumbnailUrl || null,
        duration: durationOf(vo.duration),
        tags: [],
        nsfw: 'explicit',
        trusted: true,
      });
      if (ctx.limit && items.length >= ctx.limit) break;
    }

    const kept = [...seen].slice(-SEEN_KEEP);
    return {
      items,
      cursor: { seen: kept },
      profile: page.name ? { displayName: page.name, avatarUrl: page.avatar, bio: null, links: [] } : null,
      notes,
      via: 'gff-html',
    };
  },
};
