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
const net = require('../lib/net');
const limiter = require('../lib/limiter');
const { toIso, htmlToText, absUrl, clip, bestSrcset } = require('./util');
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
  // <a href="full.jpg"><img src="thumb.jpg"></a> — prefer the full-size link, and don't also emit its thumbnail as a second item
  const thumbsOfLinked = new Set();
  $('a[href]').each((_, a) => {
    const href = absUrl($(a).attr('href'), base);
    if (!href || !looksLikeDirectMedia(href)) return;
    const img = $(a).find('img').first();
    const preview = img.length ? absUrl(img.attr('src') || img.attr('data-src'), base) : null;
    if (preview) thumbsOfLinked.add(preview);
    out.push({ url: href, type: kindOf(href), preview });
  });
  $('img').each((_, i) => {
    const el = $(i);
    // Lazy-loaders put a 1px data: placeholder in src and the real file in data-src / data-lazy-src / data-original / srcset.
    let src = el.attr('src');
    if (!src || /^data:/i.test(src)) src = el.attr('data-src') || el.attr('data-lazy-src') || el.attr('data-original') || null;
    src = bestSrcset(el.attr('srcset') || el.attr('data-srcset'), base) || absUrl(src, base);
    if (!src || /^data:/i.test(src) || IMG_JUNK.test(src) || thumbsOfLinked.has(src)) return;
    const w = parseInt(el.attr('width'), 10); const h = parseInt(el.attr('height'), 10);
    if ((w && w < 160) || (h && h < 160)) return;
    out.push({ url: src, type: 'image', width: w || null, height: h || null, alt: el.attr('alt') || null });
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

/** Entry date. `published` wins over `updated` (an edited old post must not look new) whichever comes first in the XML. */
function dateOf(e) {
  for (const sel of ['pubDate', 'published', 'dc\\:date', 'updated']) {
    const iso = toIso(e.children(sel).first().text().trim());
    if (iso) return iso;
  }
  return null;
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
      const thumbs = [];
      e.find('media\\:thumbnail').each((_, n) => { const u = absUrl($(n).attr('url'), baseUrl); if (u) thumbs.push(u); });
      // a video enclosure has no poster of its own; the entry's media:thumbnail is it (PeerTube, WordPress video, podcasts)
      const posterFor = (type) => (type === 'video' ? thumbs[0] || null : null);
      e.children('enclosure').each((_, n) => {
        const url = absUrl($(n).attr('url'), baseUrl); const type = $(n).attr('type') || '';
        if (url && (/^(image|video)\//.test(type) || looksLikeDirectMedia(url))) { const k = kindOf(url, type); media.push({ url, type: k, preview: posterFor(k) }); }
      });
      e.children('link[rel="enclosure"]').each((_, n) => {
        const url = absUrl($(n).attr('href'), baseUrl); const type = $(n).attr('type') || '';
        if (url) { const k = kindOf(url, type); media.push({ url, type: k, preview: posterFor(k) }); }
      });
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
        published: dateOf(e),
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
    if (it.banner_image && it.banner_image !== it.image) media.push({ url: absUrl(it.banner_image, baseUrl), type: 'image' });
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
      // a video's poster here is the entry's media:thumbnail, often a channel or podcast artwork reused by every entry: it says nothing
      // about WHICH video this is, so the pipeline must not take its perceptual hash as the video's (it would drop the second one)
      ...(m.type === 'video' && m.preview ? { posterShared: true } : {}),
      width: m.width || null,
      height: m.height || null,
      altText: m.alt || null,
      tags: entry.categories,
      links: entry.links || [], // every link in the post: checked like any other link
      probe: true, // unknown hosts: verify before trusting
    });
  });
  return items;
}

/** Bytes -> text honouring a BOM, the HTTP charset or the XML declaration (feeds in ISO-8859-1 / Windows-1252 are still common). */
function decodeBody(buf, contentType) {
  let cs = (/charset=["']?([\w.:-]+)/i.exec(contentType || '') || [])[1];
  if (buf[0] === 0xff && buf[1] === 0xfe) cs = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) cs = 'utf-16be';
  else if (!cs) cs = (/^\s*<\?xml[^>]*encoding=["']([\w.:-]+)["']/i.exec(buf.subarray(0, 200).toString('latin1')) || [])[1];
  if (!cs || /^utf-?8$/i.test(cs)) return buf.toString('utf8');
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';
// A sitemap counts as XML even when the host serves it as text/html (a common WordPress/AIO-SEO and
// Project1 misconfiguration): the root element is the proof, never the Content-Type.
const looksLikeSitemap = (text) => /<(?:urlset|sitemapindex)[\s>]/i.test(text.slice(0, 4000));
const looksLikeHtml = (text, ctype) => !looksLikeSitemap(text) && (/^\s*(?:<!doctype\s+html|<html)/i.test(text.slice(0, 2000))
  || (/text\/html/i.test(ctype || '') && !/<(?:rss|feed|rdf:rdf)\b/i.test(text.slice(0, 4000))));

/* ------------------------------------------------------------------ sitemaps */
/**
 * A studio sitemap is a feed of *pages*, not of media: it lists scene or model URLs and each page is
 * then read like any web page (robots, age gate, takedowns and the paid-host ladder all apply, because
 * the page goes through the web adapter). Sitemaps can hold thousands of URLs, so a run reads a small
 * number of the newest and remembers the rest, and says in the notes which studio actually yielded.
 *
 * The two real-world shapes this has to survive:
 *   cockyboys.com  https -> http -> https, 301 + 302, tiny urlset of section pages
 *   gaywire.com    /sitemap.xml answers the JavaScript tour shell with text/html and no XML at all
 */
const SITEMAP_PAGES = 4;       // pages read per run unless the setting says otherwise
const SITEMAP_PAGES_MAX = 12;
const SITEMAP_SEEN = 400;      // page URLs remembered so a sitemap is not read twice
const ASSET_PATH = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|m4v|m3u8|mp3|ogg|wav|zip|rar|7z|pdf|docx?|xlsx?|css|js|json|txt)(?:$|\?)/i;
const TAXONOMY_PATH = /(?:^|\/)(?:categor(?:y|ies)|tags?|genero|geschlecht|kategorie(?:n)?|categoria|categorias|search|comments?)(?:\/|$)/i;

const hostKey = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

/** `<loc>` values, CDATA included (AIO SEO wraps them). Absolute http(s) only, de-duplicated. */
function sitemapLocs(xml, baseUrl) {
  const out = [];
  const re = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const raw = (m[1] || m[2] || '').replace(/&amp;/g, '&').trim();
    const u = absUrl(raw, baseUrl);
    if (u && /^https?:/i.test(u)) out.push(u.split('#')[0]);
  }
  return [...new Set(out)];
}

/** Per-URL lastmod, so an index and a urlset can both be walked newest first. */
function sitemapLastmods(xml, baseUrl) {
  const map = new Map();
  const re = /<url>\s*<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>[\s\S]*?<lastmod>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/lastmod>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const u = absUrl((m[1] || m[2] || '').trim(), baseUrl);
    const iso = toIso((m[3] || m[4] || '').trim());
    if (u && iso) map.set(u, iso);
  }
  return map;
}

/** Child sitemaps of an index, with their lastmod, newest first. */
function sitemapChildren(xml, baseUrl) {
  const out = [];
  const re = /<sitemap>\s*<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>(?:[\s\S]*?<lastmod>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/lastmod>)?/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const u = absUrl((m[1] || m[2] || '').trim(), baseUrl);
    if (u && /^https?:/i.test(u)) out.push({ url: u, lastmod: toIso((m[3] || m[4] || '').trim()) });
  }
  return out.sort((a, b) => String(b.lastmod || '').localeCompare(String(a.lastmod || '')));
}

/** How likely a sitemap URL is a content page: an id segment and depth help, taxonomy paths hurt. */
function pageScore(u) {
  let score = 0;
  try {
    const p = new URL(u).pathname;
    const segs = p.split('/').filter(Boolean);
    if (segs.some((s) => /^\d{3,}$/.test(s))) score += 2;
    if (segs.length >= 2) score += 1;
    if (TAXONOMY_PATH.test(p)) score -= 2;
  } catch { return 0; }
  return score;
}

/** Newest first by lastmod when the sitemap has one, otherwise by page shape and document order (WP writes oldest first). */
function orderPages(urls, lastmods) {
  const dated = urls.filter((u) => lastmods.has(u));
  if (dated.length === urls.length) return [...urls].sort((a, b) => lastmods.get(b).localeCompare(lastmods.get(a)));
  const reversed = [...urls].reverse();
  return reversed.sort((a, b) => pageScore(b) - pageScore(a));
}
const guessedFeedPaths = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'];

/** GET a feed with conditional-request validators. -> {notModified} | {text, url, headers} */
async function load(url, validators = {}) {
  const headers = { accept: FEED_ACCEPT };
  if (validators.etag) headers['if-none-match'] = validators.etag;
  if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;
  const res = await http.raw(url, { headers, maxBytes: 4_000_000 });
  if (res.status === 304) return { notModified: true };
  if (res.status >= 400) {
    const retryAfter = net.parseRetryAfter(res.headers['retry-after']);
    if (res.status === 429) limiter.penalize(http.key, Math.min(retryAfter || 30000, require('./http').MAX_SHARED_HOLD_MS));
    throw new net.HttpError(`HTTP ${res.status} for ${url}`, { status: res.status, url, retryAfter });
  }
  return { text: decodeBody(res.body, res.headers['content-type']), url: res.url || url, headers: res.headers, ctype: res.headers['content-type'] };
}

/** The page links to its feed (or sits at a conventional path): find and fetch it. Returns null when nothing is a feed. */
async function discover(html, pageUrl) {
  const $ = cheerio.load(html);
  const found = [];
  $('link[rel~="alternate"]').each((_, l) => {
    const type = String($(l).attr('type') || '');
    if (/rss|atom|feed\+json|json/i.test(type) && !/comments/i.test($(l).attr('title') || '')) { const u = absUrl($(l).attr('href'), pageUrl); if (u) found.push(u); }
  });
  const origin = new URL(pageUrl).origin;
  const candidates = [...new Set([...found, ...guessedFeedPaths.map((p) => origin + p)])].slice(0, 7);
  for (const c of candidates) {
    try {
      const got = await load(c);
      if (got.notModified) continue;
      if (!looksLikeHtml(got.text, got.ctype) && (got.text.trim().startsWith('{') || /<(?:rss|feed|rdf:rdf)\b/i.test(got.text.slice(0, 4000)))) return got;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Read a sitemap feed: walk an index to a urlset, pick a capped number of new pages, and read each
 * page through the web adapter. Per-studio yield goes into the notes (the engine keeps notes[0] as
 * the feed's last_error), and the pages tried are remembered so the next run moves on.
 */
async function fetchSitemap(feed, ctx, got) {
  const notes = [];
  const settings = require('../settings');
  const cap = Math.min(SITEMAP_PAGES_MAX, Number(settings.get().sitemapPagesPerRun ?? SITEMAP_PAGES) || 0);
  if (cap <= 0) return { items: [], via: 'sitemap', notes: ['sitemap reading is off (sitemapPagesPerRun = 0)'] };

  let xml = got.text;
  let base = got.url;
  let lastmods = sitemapLastmods(xml, base);
  let urls = [];
  if (/<sitemapindex[\s>]/i.test(xml)) {
    // An index: try the newest children (a stale entry is common; the child list is not proof it exists).
    for (const child of sitemapChildren(xml, base).filter((c) => hostKey(c.url) === hostKey(feed.target)).slice(0, 3)) {
      if (ctx.aborted()) break;
      let inner;
      try { inner = await load(child.url); } catch (e) { notes.push(`${hostKey(child.url)}: sitemap ${child.url.split('/').pop()} — ${e.message}`); continue; }
      if (inner.notModified || !looksLikeSitemap(inner.text)) continue;
      xml = inner.text; base = inner.url;
      lastmods = sitemapLastmods(xml, base);
      if (!urls.length) urls = sitemapLocs(xml, base);
      break;
    }
    if (!urls.length) return { items: [], via: 'sitemap', notes: [...notes, 'sitemap index listed no readable child sitemap'] };
  } else {
    urls = sitemapLocs(xml, base);
  }

  return readPages(feed, ctx, urls, lastmods, notes, cap, base);
}

/** Read the chosen pages through the web adapter and count the yield per studio. */
async function readPages(feed, ctx, urls, lastmods, notes, cap, base) {
  const own = hostKey(feed.target);
  const seen = new Set(Array.isArray(ctx.cursor && ctx.cursor.seen) ? ctx.cursor.seen : []);
  const candidates = urls
    .filter((u) => hostKey(u) === own && u !== feed.target && !ASSET_PATH.test((() => { try { return new URL(u).pathname; } catch { return ''; } })()))
    .filter((u) => !seen.has(u));
  if (!candidates.length) return { items: [], via: 'sitemap', notes: [...notes, 'no new pages in the sitemap'] };

  const picked = orderPages(candidates, lastmods).slice(0, cap);
  const web = require('./web'); // lazy: web requires this module
  const items = [];
  const tally = new Map();
  for (const page of picked) {
    if (ctx.aborted()) break;
    const host = hostKey(page);
    const t = tally.get(host) || { pages: 0, items: 0, failed: 0 };
    t.pages++;
    try {
      const r = await web.webAdapter.fetch({ platform: 'web', kind: 'page', target: page, origin: feed.origin }, ctx);
      const got = (r.items || []).length;
      t.items += got;
      items.push(...(r.items || []));
      (r.notes || []).forEach((n) => notes.push(`${host}: ${n}`));
    } catch (e) {
      t.failed++;
      notes.push(`${host}: ${e.message}`);
    }
    tally.set(host, t);
  }
  // Which studio yielded what: a sitemap that only lists navigation pages must be visible as such.
  for (const [host, t] of tally) notes.push(`${host}: ${t.items} item${t.items === 1 ? '' : 's'} from ${t.pages} page${t.pages === 1 ? '' : 's'}${t.failed ? `, ${t.failed} failed` : ''}`);
  const nextSeen = [...seen, ...picked.map((u) => u)].slice(-SITEMAP_SEEN);
  return {
    items,
    cursor: { seen: nextSeen },
    profile: { displayName: hostKey(base), avatarUrl: null, bio: `Sitemap ${base}` },
    via: 'sitemap',
    notes,
  };
}

module.exports = {
  platform: 'rss',
  label: 'RSS / Atom',
  color: '#f59e0b',
  kinds: ['feed'],
  intervalMin: { feed: 120 },
  parseFeed, mediaFromHtml, entryToItems, decodeBody, load, looksLikeHtml, looksLikeSitemap, sitemapLocs, sitemapChildren,
  isConfigured: () => ({ ok: true }),

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    // Conditional GET: an unchanged feed costs one 304 instead of a full download and re-parse (skipped on forced runs).
    let got = await load(feed.target, ctx.force ? {} : { etag: cursor.etag, lastModified: cursor.lastModified });
    if (got.notModified) return { items: [], via: 'feed-304' };
    let via = 'feed';
    const sitemapish = looksLikeSitemap(got.text) || /sitemap[^/]*\.xml$/i.test((() => { try { return new URL(feed.target).pathname; } catch { return ''; } })());
    if (looksLikeSitemap(got.text)) return fetchSitemap(feed, ctx, got);
    if (looksLikeHtml(got.text, got.ctype)) {
      // A site URL instead of a feed URL: follow <link rel="alternate"> (or a conventional path) rather than silently finding nothing.
      const found = await discover(got.text, got.url);
      if (!found) throw Object.assign(new Error(`${feed.target} is a web page, not a feed, and advertises no RSS/Atom/JSON feed`), { status: 422 });
      got = found; via = 'feed-discovered';
      // A sitemap URL that answers the site's JavaScript shell (gaywire): the site's own feed still lists
      // the pages, even when the entries carry no media. Read those pages like sitemap pages.
      if (sitemapish) {
        const s = require('../settings');
        const cap = Math.min(SITEMAP_PAGES_MAX, Number(s.get().sitemapPagesPerRun ?? SITEMAP_PAGES) || 0);
        if (cap > 0) {
          let entries = [];
          try { entries = parseFeed(got.text, got.url).entries; } catch { entries = []; }
          const links = entries.map((e) => e.link).filter((u) => u && /^https?:/i.test(u));
          if (links.length) {
            const lastmods = new Map(entries.filter((e) => e.link && e.published).map((e) => [e.link, e.published]));
            return { ...(await readPages(feed, ctx, links, lastmods, [`${hostKey(got.url)}: sitemap is the JavaScript shell; read its feed instead`], cap, got.url)) };
          }
        }
      }
    }
    let parsed;
    try { parsed = parseFeed(got.text, got.url); } catch (e) { throw Object.assign(new Error(`Not a valid feed: ${e.message}`), { status: 422 }); }
    // Some feeds list oldest-first; the newest N is what we want.
    const dated = parsed.entries.filter((e) => e.published);
    if (dated.length > 1 && dated[0].published < dated[dated.length - 1].published) parsed.entries.reverse();

    const items = [];
    let newest = cursor.newestAt || null;
    for (const entry of parsed.entries.slice(0, ctx.limit || 40)) {
      if (entry.published && newest && entry.published <= cursor.newestAt && !ctx.force) continue;
      if (entry.published && (!newest || entry.published > newest)) newest = entry.published;
      items.push(...entryToItems(entry, parsed));
    }
    const etag = got.headers && got.headers.etag; const lastModified = got.headers && got.headers['last-modified'];
    const next = { ...(newest ? { newestAt: newest } : {}), ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
    return {
      items,
      cursor: Object.keys(next).length ? next : undefined,
      profile: { displayName: parsed.title, avatarUrl: parsed.image, bio: parsed.description },
      via,
    };
  },
};
