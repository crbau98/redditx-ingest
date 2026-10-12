'use strict';
/**
 * Generic RSS 2.0 / Atom / RDF / JSON Feed adapter.
 *
 * This is the "pull from anywhere" escape hatch: a creator's own site, a
 * Tumblr blog (/rss), a Mastodon profile (.rss), a Bluesky profile
 * (bsky.app/profile/<handle>/rss), a WordPress/Ghost gallery... anything that
 * publishes a feed works, and feeds are *meant* to be machine-read so they do
 * not break the way HTML scraping does.
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('rss', 800);
const { toIso, htmlToText, absUrl, clip } = require('./util');
const { looksLikeDirectMedia, looksLikeVideo, hostBlocked, hostOf } = require('../lib/mediaurl');

const IMG_JUNK = /(?:^|\/)(?:avatar|emoji|icon|logo|favicon|sprite|badge|pixel|spacer|blank|tracking|gravatar)|\/emoji\/|\.svg(?:\?|$)|\/wp-includes\/|feedburner|doubleclick|googleads|stats\.wp\.com|pixel\.wp\.com|gravatar\.com/i;
const MAX_PER_ENTRY = 12;

const kindOf = (url, mime) => {
  if (/^video\//i.test(mime || '') || looksLikeVideo(url)) return 'video';
  return 'image';
};

function mediaFromHtml(html, base) {
  if (!html) return [];
  const $ = cheerio.load(`<div>${html}</div>`, null, false);
  const out = [];
  $('video').each((_, v) => {
    const poster = absUrl($(v).attr('poster'), base);
    const src = absUrl($(v).attr('src') || $(v).find('source').first().attr('src'), base);
    if (src) out.push({ url: src, type: 'video', preview: poster });
  });
  // <a href="full.jpg"><img src="thumb.jpg"></a> — prefer the full-size link
  $('a[href]').each((_, a) => {
    const href = absUrl($(a).attr('href'), base);
    if (!href || !looksLikeDirectMedia(href)) return;
    const img = $(a).find('img').first();
    out.push({ url: href, type: kindOf(href), preview: img.length ? absUrl(img.attr('src'), base) : null });
  });
  $('img[src]').each((_, i) => {
    const src = absUrl($(i).attr('src') || $(i).attr('data-src'), base);
    if (!src || IMG_JUNK.test(src)) return;
    const w = parseInt($(i).attr('width'), 10); const h = parseInt($(i).attr('height'), 10);
    if ((w && w < 160) || (h && h < 160)) return;
    out.push({ url: src, type: 'image', width: w || null, height: h || null, alt: $(i).attr('alt') || null });
  });
  return out;
}

/** Every outbound http(s) link in an HTML fragment (used to spot e.g. RedGIFs pages inside feed entries). */
function linksFromHtml(html, base) {
  if (!html) return [];
  const $ = cheerio.load(`<div>${html}</div>`, null, false);
  const out = [];
  $('a[href]').each((_, a) => { const u = absUrl($(a).attr('href'), base); if (u && /^https?:/i.test(u)) out.push(u); });
  return [...new Set(out)];
}

/** Parse any supported feed document. Never throws on malformed entries. */
function parseFeed(text, baseUrl) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) return parseJsonFeed(JSON.parse(trimmed), baseUrl);

  const $ = cheerio.load(trimmed, { xmlMode: true });
  const isAtom = $('feed').length > 0;
  const root = isAtom ? $('feed').first() : $('channel').first();
  const feed = {
    title: (isAtom ? root.children('title') : root.children('title')).first().text().trim() || null,
    image: absUrl(
      isAtom ? (root.children('logo').first().text() || root.children('icon').first().text())
        : (root.children('image').first().children('url').first().text() || root.find('itunes\\:image').first().attr('href')),
      baseUrl),
    description: (root.children('subtitle, description').first().text() || '').trim() || null,
    link: null,
    entries: [],
  };
  const entries = $(isAtom ? 'entry' : 'item');
  entries.each((_, el) => {
    const e = $(el);
    try {
      const linkEl = e.children('link').filter((_, l) => !$(l).attr('rel') || $(l).attr('rel') === 'alternate').first();
      const link = absUrl(linkEl.attr('href') || linkEl.text(), baseUrl);
      const content = e.children('content\\:encoded').first().text() || e.children('content').first().text()
        || e.children('description').first().text() || e.children('summary').first().text();
      const media = [];
      e.children('enclosure').each((_, n) => {
        const url = absUrl($(n).attr('url'), baseUrl); const type = $(n).attr('type') || '';
        if (url && (/^(image|video)\//.test(type) || looksLikeDirectMedia(url))) media.push({ url, type: kindOf(url, type) });
      });
      e.children('link[rel="enclosure"]').each((_, n) => {
        const url = absUrl($(n).attr('href'), baseUrl); const type = $(n).attr('type') || '';
        if (url) media.push({ url, type: kindOf(url, type) });
      });
      const thumbs = [];
      e.find('media\\:thumbnail').each((_, n) => { const u = absUrl($(n).attr('url'), baseUrl); if (u) thumbs.push(u); });
      e.find('media\\:content').each((_, n) => {
        const url = absUrl($(n).attr('url'), baseUrl); const type = $(n).attr('type') || $(n).attr('medium') || '';
        if (!url) return;
        const w = parseInt($(n).attr('width'), 10); const h = parseInt($(n).attr('height'), 10);
        media.push({ url, type: kindOf(url, /video/.test(type) ? 'video/x' : type), width: w || null, height: h || null, preview: thumbs[0] || null });
      });
      const htmlMedia = mediaFromHtml(content, link || baseUrl);
      const seen = new Set(media.map((m) => m.url));
      for (const m of htmlMedia) if (!seen.has(m.url)) { seen.add(m.url); media.push(m); }
      if (!media.length && thumbs[0]) media.push({ url: thumbs[0], type: 'image' });
      feed.entries.push({
        id: e.children('guid, id').first().text().trim() || link,
        title: e.children('title').first().text().trim(),
        link,
        published: toIso(e.children('pubDate, published, updated, dc\\:date').first().text().trim()),
        author: (e.children('dc\\:creator').first().text() || e.children('author').first().children('name').first().text() || e.children('author').first().text()).trim() || null,
        text: htmlToText(content, 400),
        links: linksFromHtml(content, link || baseUrl),
        categories: e.children('category').map((_, c) => $(c).attr('term') || $(c).text()).get().filter(Boolean).slice(0, 12),
        media: media.slice(0, MAX_PER_ENTRY),
      });
    } catch { /* skip malformed entry */ }
  });
  return feed;
}

function parseJsonFeed(json, baseUrl) {
  const feed = { title: json.title || null, image: json.icon || json.favicon || null, description: json.description || null, link: json.home_page_url || null, entries: [] };
  for (const it of json.items || []) {
    const media = [];
    if (it.image) media.push({ url: absUrl(it.image, baseUrl), type: 'image' });
    for (const a of it.attachments || []) {
      if (a && a.url && /^(image|video)\//.test(a.mime_type || '')) media.push({ url: absUrl(a.url, baseUrl), type: kindOf(a.url, a.mime_type) });
    }
    const seen = new Set(media.map((m) => m.url));
    for (const m of mediaFromHtml(it.content_html || '', it.url || baseUrl)) if (!seen.has(m.url)) { seen.add(m.url); media.push(m); }
    feed.entries.push({
      id: it.id || it.url, title: it.title || '', link: it.url || null, published: toIso(it.date_published || it.date_modified),
      author: (it.authors && it.authors[0] && it.authors[0].name) || (it.author && it.author.name) || null,
      text: htmlToText(it.content_html || it.content_text || it.summary || '', 400),
      links: linksFromHtml(it.content_html || '', it.url || baseUrl),
      categories: (it.tags || []).slice(0, 12), media: media.filter((m) => m.url).slice(0, MAX_PER_ENTRY),
    });
  }
  return feed;
}

function entryToItems(entry, feed, ctx = {}) {
  const items = [];
  const author = entry.author || feed.title || null;
  entry.media.forEach((m, i) => {
    if (!m.url || hostBlocked(hostOf(m.url))) return;
    items.push({
      sourceId: String(entry.id || entry.link || m.url).slice(0, 200),
      position: i,
      title: clip(entry.title || entry.text || feed.title || '', 200),
      text: entry.text,
      author,
      community: ctx.community || null,
      score: 0,
      postedAt: entry.published,
      permalink: entry.link,
      mediaType: m.type,
      mediaUrl: m.url,
      previewUrl: m.preview || (m.type === 'image' ? m.url : null),
      width: m.width || null,
      height: m.height || null,
      altText: m.alt || null,
      tags: entry.categories,
      probe: true, // unknown hosts: verify before trusting
    });
  });
  return items;
}

module.exports = {
  platform: 'rss',
  label: 'RSS / Atom',
  color: '#f59e0b',
  kinds: ['feed'],
  intervalMin: { feed: 120 },
  parseFeed, mediaFromHtml, entryToItems,
  isConfigured: () => ({ ok: true }),

  async fetch(feed, ctx) {
    const text = await http.text(feed.target, { headers: { accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.5' }, maxBytes: 4_000_000 });
    const parsed = parseFeed(text, feed.target);
    const cursor = ctx.cursor || {};
    const items = [];
    let newest = cursor.newestAt || null;
    for (const entry of parsed.entries.slice(0, ctx.limit || 40)) {
      if (entry.published && newest && entry.published <= cursor.newestAt && !ctx.force) continue;
      if (entry.published && (!newest || entry.published > newest)) newest = entry.published;
      items.push(...entryToItems(entry, parsed));
    }
    return {
      items,
      cursor: newest ? { newestAt: newest } : undefined,
      profile: { displayName: parsed.title, avatarUrl: parsed.image, bio: parsed.description },
      via: 'feed',
    };
  },
};
