'use strict';
/**
 * Web page adapter + link-in-bio adapter.
 *
 *   web / page       read the media on one page (OpenGraph, JSON-LD, <video>,
 *                    <picture><source srcset>, linked full-size images).
 *                    Honors robots.txt, X-Robots-Tag, <meta name="robots">,
 *                    <meta name="pinterest" content="nopin">, HTTP 451, and
 *                    DMCA / creator takedown tombstones.
 *   linkinbio / page crawl a Linktree-style hub (HTML + __NEXT_DATA__ / JSON-LD /
 *                    hydration JSON) for *profile links*; the engine turns them
 *                    into feeds for the same creator.
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('web', 1000);
const { absUrl, clip, uniq, bestSrcset } = require('./util');
const { extractLinks } = require('../lib/links');
const { hostOf, hostBlocked, looksLikeDirectMedia, looksLikeVideo } = require('../lib/mediaurl');
const { checkHtmlOptOut } = require('../lib/takedowns');
const browser4 = require('../lib/browser4');
const brightdata = require('../lib/brightdata');
const settingsStore = require('../settings');
const hoststrategy = require('../engine/hoststrategy');
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

function metaAll($, ...names) {
  const out = [];
  for (const n of names) {
    $(`meta[property="${n}"], meta[name="${n}"]`).each((_, el) => {
      const v = $(el).attr('content');
      if (v && v.trim()) out.push(v.trim());
    });
  }
  return uniq(out);
}

/** Parse ISO 8601 duration (e.g. PT1M30S) or numeric seconds. */
function parseDuration(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) return Math.round(val);
  const s = String(val).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m) return null;
  const sec = (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  return sec > 0 ? Math.round(sec) : null;
}

/** Walk JSON-LD or hydration JSON trees to extract structured media and outbound profile links. */
function walkJsonLdNode(node, pageUrl, pushMedia, rawUrls, metaOut) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLdNode(item, pageUrl, pushMedia, rawUrls, metaOut);
    return;
  }
  if (Array.isArray(node['@graph'])) {
    walkJsonLdNode(node['@graph'], pageUrl, pushMedia, rawUrls, metaOut);
  }

  const rawType = node['@type'] || node.type || '';
  const types = (Array.isArray(rawType) ? rawType : [rawType]).map((t) => String(t || '').replace(/^https?:\/\/schema\.org\//i, '').toLowerCase());

  if (node.sameAs) {
    const sameAsList = Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs];
    for (const u of sameAsList) {
      if (typeof u === 'string' && u.trim()) rawUrls.push(absUrl(u.trim(), pageUrl) || u.trim());
    }
  }

  if (!metaOut.title && typeof node.name === 'string' && node.name.trim()) metaOut.title = node.name.trim();
  if (!metaOut.description && typeof node.description === 'string' && node.description.trim()) metaOut.description = node.description.trim();

  const thumbOf = (t) => {
    if (!t) return null;
    if (typeof t === 'string') return absUrl(t, pageUrl);
    if (Array.isArray(t)) return thumbOf(t[0]);
    if (typeof t === 'object') return absUrl(t.contentUrl || t.url || t.thumbnailUrl, pageUrl);
    return null;
  };

  if (types.includes('videoobject') || types.includes('clip')) {
    const vUrl = absUrl(node.contentUrl || (looksLikeDirectMedia(node.embedUrl || '') ? node.embedUrl : null) || (looksLikeVideo(node.url || '') ? node.url : null), pageUrl);
    if (vUrl) {
      pushMedia({
        url: vUrl,
        type: 'video',
        preview: thumbOf(node.thumbnailUrl || node.thumbnail || node.image),
        width: parseInt(node.width, 10) || null,
        height: parseInt(node.height, 10) || null,
        duration: parseDuration(node.duration),
        alt: (typeof node.name === 'string' && node.name) || (typeof node.description === 'string' && node.description) || null,
      });
    }
  }

  if (types.includes('imageobject')) {
    const iUrl = absUrl(node.contentUrl || node.url, pageUrl);
    if (iUrl && !IMG_JUNK.test(iUrl)) {
      pushMedia({
        url: iUrl,
        type: 'image',
        preview: thumbOf(node.thumbnailUrl || node.thumbnail) || iUrl,
        width: parseInt(node.width, 10) || null,
        height: parseInt(node.height, 10) || null,
        alt: (typeof node.caption === 'string' && node.caption) || (typeof node.name === 'string' && node.name) || null,
      });
    }
  }

  if (types.some((t) => ['socialmediaposting', 'article', 'blogposting', 'newsarticle', 'webpage', 'profilepage', 'imagegallery', 'mediagallery'].includes(t))) {
    for (const sub of [node.video, node.image, node.sharedContent, node.associatedMedia, node.mainEntity, node.about, node.author, node.creator]) {
      if (!sub) continue;
      if (typeof sub === 'string') {
        const u = absUrl(sub, pageUrl);
        if (u && !IMG_JUNK.test(u) && looksLikeDirectMedia(u)) {
          pushMedia({ url: u, type: looksLikeVideo(u) ? 'video' : 'image' });
        }
      } else {
        walkJsonLdNode(sub, pageUrl, pushMedia, rawUrls, metaOut);
      }
    }
  } else {
    for (const sub of [node.video, node.image, node.sharedContent, node.associatedMedia, node.mainEntity, node.author, node.creator]) {
      if (sub && typeof sub === 'object') walkJsonLdNode(sub, pageUrl, pushMedia, rawUrls, metaOut);
    }
  }
}

/** Walk arbitrary hydration JSON (__NEXT_DATA__, Beacons/Linktree/Snipfeed/Bento state) to collect links and profile metadata. */
function walkHydrationJson(node, pageUrl, rawUrls, metaOut, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) {
    for (const item of node) walkHydrationJson(item, pageUrl, rawUrls, metaOut, depth + 1);
    return;
  }

  for (const [k, v] of Object.entries(node)) {
    const key = k.toLowerCase();
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) continue;
      if (['url', 'href', 'link', 'externalurl', 'targeturl', 'profileurl', 'socialurl', 'destination', 'redirect', 'website', 'uri'].includes(key)) {
        if (/^https?:\/\//i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) {
          rawUrls.push(absUrl(s, pageUrl) || s);
        }
      } else if (key === 'sameas') {
        rawUrls.push(absUrl(s, pageUrl) || s);
      } else if (!metaOut.title && (key === 'pagetitle' || key === 'displayname' || key === 'username' || key === 'title') && s.length <= 120) {
        metaOut.title = s;
      } else if (!metaOut.description && (key === 'bio' || key === 'description') && s.length <= 1000) {
        metaOut.description = s;
      } else if (!metaOut.avatar && (key === 'profilepictureurl' || key === 'avatarurl' || key === 'avatar' || key === 'profileimage') && /^https?:\/\//i.test(s)) {
        metaOut.avatar = s;
      } else if (/^https?:\/\//i.test(s) && s.length < 400) {
        rawUrls.push(s);
      }
    } else if (v && typeof v === 'object') {
      walkHydrationJson(v, pageUrl, rawUrls, metaOut, depth + 1);
    }
  }
}

function unwrapTrackingUrls(urls) {
  return urls.flatMap((h) => {
    try {
      const u = new URL(h);
      return ['url', 'u', 'link', 'target', 'to', 'redirect', 'redirect_url', 'dest', 'destination']
        .map((k) => u.searchParams.get(k))
        .filter((v) => /^https?:\/\//i.test(v || ''));
    } catch { return []; }
  });
}

function extractPage(html, pageUrl0, opts = {}) {
  const rawHtml = String(html || '');
  const $ = cheerio.load(rawHtml);
  const pageUrl = absUrl($('base[href]').first().attr('href'), pageUrl0) || pageUrl0;

  const optOut = checkHtmlOptOut(rawHtml, opts.headers || {}, opts.status || 200);
  const title0 = metaContent($, 'og:title', 'twitter:title') || $('title').first().text().trim() || null;
  const desc0 = metaContent($, 'og:description', 'twitter:description', 'description');
  const siteName = metaContent($, 'og:site_name');

  if (optOut.optedOut) {
    return {
      title: title0,
      description: desc0,
      image: null,
      siteName,
      feedUrl: null,
      feeds: [],
      media: [],
      links: [],
      optedOut: true,
      optOutReason: optOut.reason,
      $,
    };
  }

  const media = [];
  const seen = new Set();
  const push = (m) => {
    if (!m || !m.url) return;
    if (seen.has(m.url) || hostBlocked(hostOf(m.url))) return;
    seen.add(m.url);
    media.push(m);
  };

  const ogImages = metaAll($, 'og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')
    .map((u) => absUrl(u, pageUrl))
    .filter(Boolean);
  const ogImage = ogImages[0] || null;

  const ogVideos = metaAll($, 'og:video:secure_url', 'og:video', 'og:video:url', 'twitter:player:stream')
    .map((u) => absUrl(u, pageUrl))
    .filter(Boolean);

  for (const v of ogVideos) {
    if (looksLikeDirectMedia(v) || looksLikeVideo(v)) {
      push({ url: v, type: 'video', preview: ogImage });
    }
  }

  const rawUrls = [];
  const ldMeta = { title: null, description: null, avatar: null };

  // JSON-LD structured data (VideoObject, ImageObject, SocialMediaPosting, sameAs)
  $('script[type="application/ld+json"]').each((_, s) => {
    const txt = $(s).contents().text().trim();
    if (!txt) return;
    try {
      const parsed = JSON.parse(txt);
      walkJsonLdNode(parsed, pageUrl, push, rawUrls, ldMeta);
    } catch { /* ignore malformed JSON-LD */ }
  });

  // Next.js / Nuxt / link-hub hydration JSON (__NEXT_DATA__, application/json scripts)
  $('script#__NEXT_DATA__, script[type="application/json"]').each((_, s) => {
    const txt = $(s).contents().text().trim();
    if (!txt) return;
    try {
      const parsed = JSON.parse(txt);
      walkHydrationJson(parsed, pageUrl, rawUrls, ldMeta, 0);
    } catch { /* ignore malformed JSON */ }
  });

  $('video').each((_, v) => {
    const poster = absUrl($(v).attr('poster'), pageUrl);
    const vSrc = absUrl($(v).attr('src') || $(v).attr('data-src'), pageUrl);
    if (vSrc) push({ url: vSrc, type: 'video', preview: poster || ogImage });
    $(v).find('source').each((__, srcEl) => {
      const s = absUrl($(srcEl).attr('src') || $(srcEl).attr('data-src'), pageUrl);
      if (s) push({ url: s, type: 'video', preview: poster || ogImage });
    });
  });

  // <picture><source srcset> high-resolution responsive sources
  $('picture source, source[srcset], source[data-srcset]').each((_, s) => {
    const el = $(s);
    const typeAttr = String(el.attr('type') || '').toLowerCase();
    if (typeAttr.startsWith('video/')) {
      const vSrc = absUrl(el.attr('src') || bestSrcset(el.attr('srcset'), pageUrl), pageUrl);
      if (vSrc) push({ url: vSrc, type: 'video', preview: ogImage });
      return;
    }
    const best = absUrl(bestSrcset(el.attr('srcset') || el.attr('data-srcset'), pageUrl), pageUrl);
    if (!best || best.startsWith('data:') || IMG_JUNK.test(best)) return;
    push({ url: best, type: looksLikeVideo(best) ? 'video' : 'image' });
  });

  $('a[href]').each((_, a) => {
    const href = absUrl($(a).attr('href'), pageUrl);
    if (!href) return;
    rawUrls.push(href);
    if (!looksLikeDirectMedia(href) || IMG_JUNK.test(href)) return;
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

  // Multiple OpenGraph / Twitter images
  for (const img of ogImages) {
    if (img && !IMG_JUNK.test(img) && (ogImages.length > 1 || !media.length)) {
      push({ url: img, type: 'image' });
    }
  }

  // RSS / Atom / JSON Feed <link rel="alternate"> discovery
  const feeds = [];
  $('link[rel~="alternate"]').each((_, l) => {
    const el = $(l);
    const type = String(el.attr('type') || '').toLowerCase();
    const href = absUrl(el.attr('href'), pageUrl);
    if (!href) return;
    if (
      type.includes('rss') ||
      type.includes('atom') ||
      type.includes('feed+json') ||
      ((type.includes('xml') || !type) && /\.(?:rss|atom|xml)(?:\?|$)|\/(?:feed|rss|atom)\b/i.test(href))
    ) {
      if (!feeds.includes(href)) feeds.push(href);
    }
  });

  // Unescape inline hydration JSON URLs so link-in-bio extraction catches everything
  const plain = rawHtml.replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  const jsonUrls = (plain.match(/https?:\/\/[^"'\s<>\\]+/g) || []).map((u) => u.replace(/[),.;]+$/, ''));
  const allCandidateUrls = uniq([...rawUrls, ...jsonUrls]);
  const unwrapped = unwrapTrackingUrls(allCandidateUrls);
  const links = extractLinks(uniq([...allCandidateUrls, ...unwrapped]).join(' '))
    .filter((l) => l.platform !== 'web' && l.platform !== 'linkinbio')
    .slice(0, 40);

  return {
    title: title0 || ldMeta.title || null,
    description: desc0 || ldMeta.description || null,
    image: ogImage || ldMeta.avatar || null,
    siteName,
    feedUrl: feeds[0] || null,
    feeds,
    media: media.slice(0, opts.maxMedia || 40),
    links,
    optedOut: false,
    optOutReason: null,
    $,
    pageUrl,
  };
}

/* ------------------------------------------------------- Browser4 rendering */
const RENDERED_MAX_MEDIA = 120; // a scrolled gallery holds far more than the 40 a static page is capped at

/** Fold the pages of one render (the page plus its "next page" follow-ups) into the shape extractPage returns. */
function mergeRendered(pages) {
  const parsed = pages.map((p) => extractPage(p.html, p.url, { headers: {}, status: 200, maxMedia: RENDERED_MAX_MEDIA }));
  const first = parsed[0];
  if (first.optedOut) return first; // the rendered DOM opts out (noindex, nopin ...): same rule as the plain path
  const media = []; const seen = new Set(); const links = []; const seenLinks = new Set(); const feeds = [];
  for (const p of parsed) {
    if (p.optedOut) continue;
    for (const m of p.media) if (!seen.has(m.url)) { seen.add(m.url); media.push(m); }
    for (const l of p.links) { const k = l.url || l.target; if (!seenLinks.has(k)) { seenLinks.add(k); links.push(l); } }
    for (const f of p.feeds || []) if (!feeds.includes(f)) feeds.push(f);
  }
  return { ...first, media: media.slice(0, RENDERED_MAX_MEDIA), links: links.slice(0, 40), feeds, feedUrl: feeds[0] || null, docs: parsed.filter((p) => !p.optedOut).map((p) => ({ $: p.$, url: p.pageUrl })) };
}

/**
 * Read the page in a real browser if the settings ask for it AND what PRISM has learned about this host says it pays
 * (engine/hoststrategy.js). Returns null when it is not wanted, or
 *   {page, notes, pages, scrolls}  the merged, parsed render
 *   {error}                        the render failed (the plain result then stands; the reason becomes a run note)
 *   {skipped}                      the plain read showed nothing but the host's history says rendering will not help now
 *   need 'media'  web pages: wanted in 'fallback' mode when the plain download showed no media
 *   need 'links'  link-in-bio hubs: wanted when it showed no profile links
 * The browser is never used to get around a refusal: it runs only after a plain download that SUCCEEDED but showed nothing,
 * and a bot-challenge page makes PRISM leave that host alone for a while (never solves or evades it).
 */
async function browserRead(feed, plain, need) {
  if (!browser4.enabled()) return null;
  const cfg = settingsStore.get();
  if (cfg.browser4Mode === 'off') return null;
  const found = need === 'media' ? plain.media.length : plain.links.length;
  const host = hostOf(feed.target);
  const verdict = hoststrategy.decide(host, { mode: cfg.browser4Mode, found });
  if (!verdict.render) {
    hoststrategy.record(host, { found });
    return found === 0 ? { skipped: verdict.why } : null;
  }
  try {
    const r = await browser4.renderPages(feed.target, {
      scrolls: need === 'media' ? cfg.browser4Scrolls : Math.min(2, cfg.browser4Scrolls),
      pages: need === 'media' ? cfg.browser4Pages : 1,
      allowUrl: robotsAllows,
    });
    const page = mergeRendered(r.pages);
    // a page that opts out says nothing about whether rendering works on this host
    hoststrategy.record(host, { found, rendered: page.optedOut ? null : (need === 'media' ? page.media.length : page.links.length) });
    return { page, notes: r.notes, pages: r.pages.length, scrolls: r.pages.reduce((n, p) => n + Math.max(0, p.scrolls), 0) };
  } catch (e) {
    if (e.challenge) hoststrategy.record(host, { found, challenge: true });
    return { error: e };
  }
}

/** Did the plain download get a REFUSAL (as opposed to a missing page, a login wall or a legal block)? */
const REFUSED_STATUS = new Set([403, 429, 503]);

/**
 * A public page that REFUSED PRISM - the plain request got 403 / 429 / 503, or the local browser was met with a bot-challenge -
 * read through Bright Data instead: the Web Unlocker (HTML) and, when BRIGHTDATA_BROWSER_WSS is set and the page needs
 * JavaScript, the remote Browser API. Opt-in (setting brightdataUnlocker) and paid, so:
 *   - it runs only AFTER robots.txt allowed the page and only for those refusals (never 401 login walls, 404/410 gone, 451 legal);
 *   - lib/brightdata.unlock() and the remote render refuse leak sites, paywalled hosts, takedowns and private addresses before
 *     anything leaves PRISM, and extractPage still applies noindex / nopin / takedown opt-outs to what comes back;
 *   - a daily budget caps the spend and a host where unlocking keeps finding nothing is backed off (engine/hoststrategy.js).
 * Returns null when not applicable, else {page, via, notes, info} / {skipped} / {error}.
 */
async function unlockedRead(feed, need) {
  const cfg = settingsStore.get();
  if (cfg.brightdataUnlocker !== 'fallback' || !cfg.brightdataUnlockBudget) return null;
  if (!brightdata.unlockerConfigured() && !(brightdata.browserConfigured() && browser4.enabled())) return null;
  // robots.txt first, inside this function, because the link-in-bio adapter does not consult it on its own
  if (!(await robotsAllows(feed.target))) return { skipped: 'robots.txt disallows this page' };
  const host = hostOf(feed.target);
  const verdict = hoststrategy.decideUnlock(host);
  if (!verdict.unlock) return { skipped: verdict.why };
  const count = (pg) => (need === 'media' ? pg.media.length : pg.links.length);
  let spent = false; // credit was used: whatever happens next, an empty outcome must feed the back-off
  try {
    let page = null; let via = null; const notes = [];
    if (brightdata.unlockerConfigured()) {
      let u;
      try { u = await brightdata.unlock(feed.target, { budget: cfg.brightdataUnlockBudget }); spent = true; } catch (e) { if (e.status && !e.skip && !e.budget) spent = true; throw e; }
      page = extractPage(u.html, feed.target, { headers: {}, status: 200, maxMedia: RENDERED_MAX_MEDIA });
      via = 'brightdata-unlocker';
    }
    // The unlocked HTML holds nothing but the page is a JavaScript shell: let the remote browser run it.
    if ((!page || (!page.optedOut && count(page) === 0)) && brightdata.browserConfigured() && browser4.enabled()) {
      brightdata.reserveUnlock(cfg.brightdataUnlockBudget); spent = true;
      const r = await browser4.renderPages(feed.target, { remote: true, scrolls: need === 'media' ? cfg.browser4Scrolls : 2, pages: need === 'media' ? cfg.browser4Pages : 1, allowUrl: robotsAllows });
      page = mergeRendered(r.pages); via = r.via; notes.push(...r.notes);
    }
    if (!page) return null;
    if (!page.optedOut) hoststrategy.recordUnlock(host, { found: count(page) }); // an opt-out says nothing about whether unlocking pays
    return { page, via, notes };
  } catch (e) {
    if (spent) hoststrategy.recordUnlock(host, { found: 0 });
    return { error: e };
  }
}

/** Follow a page's same-site links as new web feeds (opt-in setting; feeds made this way never expand further). */
function maybeExpand(feed, page) {
  const cfg = settingsStore.get();
  if (!browser4.enabled() || !cfg.browser4AutoExpand || feed.origin === 'expand' || !cfg.browser4ExpandPerRun) return 0;
  try {
    const docs = page.docs || (page.$ ? [{ $: page.$, url: page.pageUrl || feed.target }] : []);
    return require('../engine/expand').adoptLinks(feed, docs, cfg).created;
  } catch { return 0; }
}

async function fetchHtmlWithMeta(targetUrl, maxBytes = 3_000_000) {
  try {
    const res = await http.raw(targetUrl, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      maxBytes,
    });
    return {
      html: res.body.toString('utf8'),
      headers: res.headers || {},
      status: res.status || 200,
    };
  } catch (e) {
    if (e && Number(e.status) === 451) {
      return { html: '', headers: {}, status: 451 };
    }
    throw e;
  }
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
    const { html, headers, status } = await fetchHtmlWithMeta(feed.target, 3_000_000);
    let page = extractPage(html, feed.target, { headers, status });
    let via = 'html';
    const notes = []; // problems and limits (the engine keeps notes[0] as the feed's last_error)
    const info = [];  // what went well (the engine logs it)
    let refused = REFUSED_STATUS.has(status);
    if (!page.optedOut && status < 400) {
      const b = await browserRead(feed, page, 'media');
      if (b && b.skipped) info.push(`Browser4 not used: ${b.skipped}`);
      else if (b && b.error) { notes.push(`Browser4: ${b.error.message}`); if (b.error.challenge) refused = true; }
      else if (b) {
        notes.push(...b.notes.map((n) => `Browser4: ${n}`));
        if (b.page.optedOut) page = b.page;
        else if (b.page.media.length >= page.media.length) {
          page = b.page; via = 'browser4';
          info.push(`Browser4 read ${b.pages} page${b.pages === 1 ? '' : 's'}, scrolled ${b.scrolls}×, found ${page.media.length} media`);
        }
      }
    }
    if (refused && !page.optedOut) {
      const u = await unlockedRead(feed, 'media');
      if (u && u.skipped) info.push(`Bright Data not used: ${u.skipped}`);
      else if (u && u.error) notes.push(`Bright Data: ${u.error.message}`);
      else if (u) {
        notes.push(...u.notes.map((n) => `Bright Data: ${n}`));
        if (u.page.optedOut) page = u.page;
        else if (u.page.media.length) { page = u.page; via = u.via; info.push(`${u.via === 'brightdata-browser' ? 'Bright Data Browser API' : 'Bright Data Web Unlocker'} got past the refusal: ${page.media.length} media`); }
      }
    }
    if (page.optedOut) {
      return {
        items: [],
        profile: null,
        discovered: [],
        discoveredFeed: null,
        optedOut: true,
        optOutReason: page.optOutReason,
        notes: [`Skipped page (${page.optOutReason})`],
        via,
      };
    }
    const expanded = maybeExpand(feed, page);
    if (expanded) info.push(`Browser4 auto-expand added ${expanded} same-site page feed${expanded === 1 ? '' : 's'}`);
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
      duration: m.duration || null,
      tags: [],
      probe: true,
    }));
    const profile = { displayName: page.siteName || page.title, bio: page.description, avatarUrl: page.image, links: page.links };
    return {
      items,
      profile,
      discovered: page.links,
      feedUrl: page.feedUrl || null,
      feeds: page.feeds || [],
      discoveredFeed: page.feedUrl ? { platform: 'rss', kind: 'feed', target: page.feedUrl } : null,
      discoveredFeeds: (page.feeds || []).map((u) => ({ platform: 'rss', kind: 'feed', target: u })),
      notes,
      info,
      via,
    };
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
    const { html, headers, status } = await fetchHtmlWithMeta(feed.target, 2_000_000);
    let page = extractPage(html, feed.target, { headers, status });
    let via = 'html';
    const notes = [];
    const info = [];
    let refused = REFUSED_STATUS.has(status);
    // Hubs built by JavaScript (Beacons, Bento and friends) have no links in their HTML: read the finished page.
    if (!page.optedOut && status < 400) {
      const b = await browserRead(feed, page, 'links');
      if (b && b.skipped) info.push(`Browser4 not used: ${b.skipped}`);
      else if (b && b.error) { notes.push(`Browser4: ${b.error.message}`); if (b.error.challenge) refused = true; }
      else if (b) {
        if (b.page.optedOut) page = b.page;
        else if (b.page.links.length >= page.links.length) { page = b.page; via = 'browser4'; info.push(`Browser4 found ${page.links.length} profile links`); }
      }
    }
    if (refused && !page.optedOut) {
      const u = await unlockedRead(feed, 'links');
      if (u && u.skipped) info.push(`Bright Data not used: ${u.skipped}`);
      else if (u && u.error) notes.push(`Bright Data: ${u.error.message}`);
      else if (u) {
        if (u.page.optedOut) page = u.page;
        else if (u.page.links.length) { page = u.page; via = u.via; info.push(`Bright Data got past the refusal: ${page.links.length} profile links`); }
      }
    }
    if (page.optedOut) {
      return {
        items: [],
        discovered: [],
        profile: { displayName: null, bio: null, avatarUrl: null, links: [] },
        optedOut: true,
        optOutReason: page.optOutReason,
        notes: [`Skipped link-in-bio (${page.optOutReason})`],
        via,
      };
    }
    const discovered = page.links.slice(0, 30);
    return {
      items: [],
      discovered,
      profile: {
        displayName: page.title && page.title.replace(/\s*[|\-–·].*$/, '').trim(),
        bio: page.description,
        avatarUrl: page.image,
        links: discovered,
      },
      feedUrl: page.feedUrl || null,
      feeds: page.feeds || [],
      discoveredFeed: page.feedUrl ? { platform: 'rss', kind: 'feed', target: page.feedUrl } : null,
      discoveredFeeds: (page.feeds || []).map((u) => ({ platform: 'rss', kind: 'feed', target: u })),
      notes,
      info,
      via,
    };
  },
};

module.exports = { webAdapter, linkInBioAdapter, extractPage, robotsAllows, parseRobots, pathAllowed, checkHtmlOptOut };
