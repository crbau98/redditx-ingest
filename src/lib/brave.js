'use strict';
/**
 * Brave Search API client (https://api.search.brave.com) + DuckDuckGo HTML/lite
 * fallback (`ddgWeb` / `ddgUrls`) when `BRAVE_SEARCH_KEY` / `BRAVE_API_KEY` is
 * not configured so web, image, and video search work out-of-the-box.
 *
 * Everything the engines return is accepted now: public creator pages, galleries,
 * paid subscription pages and mirror sites alike are surfaced for ingestion,
 * and the admin's safety, takedown and male-only scope gates decide what publishes.
 */
const cheerio = require('cheerio');
const config = require('../config');
const http = require('../sources/http').forPlatform('brave', 1100); // free plan: 1 request / second
const ddgHttp = require('../sources/http').forPlatform('ddg', 900);
const repo = require('../db/repo');
const { hostOf, looksLikeDirectMedia, looksLikeVideo } = require('./mediaurl');

const today = () => new Date().toISOString().slice(0, 10);

function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('brave.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}

function record() {
  const u = usage();
  repo.settings.set('brave.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}

const apiKey = () => {
  if (process.env.BRAVE_SEARCH_KEY !== undefined) return process.env.BRAVE_SEARCH_KEY;
  if (process.env.BRAVE_API_KEY !== undefined) return process.env.BRAVE_API_KEY;
  if (process.env.BRAVE_SEARCH_API_KEY !== undefined) return process.env.BRAVE_SEARCH_API_KEY;
  return config.creds.braveKey || '';
};
const configured = () => !!apiKey();

/** "1, 18000" style X-RateLimit-* headers: [per-second, per-month] values. */
const pair = (h) => String(h || '').split(',').map((x) => Number(x.trim()));
const strip = (s) => {
  let out = String(s || '');
  let prev;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, '');
  } while (out !== prev);
  return out.trim();
};

function parseVideoDuration(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && Number.isFinite(val)) return Math.round(val);
  const s = String(val).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map((x) => Number(x));
  if (parts.length === 2 && parts.every(Number.isFinite)) return (parts[0] * 60) + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  return val;
}

/**
 * Unwrap a DuckDuckGo redirect href (`/l/?uddg=...` or `https://duckduckgo.com/l/?uddg=...`)
 * or direct result link.
 */
function unwrapDdgHref(rawHref) {
  if (!rawHref) return null;
  let href = String(rawHref).trim();
  if (href.startsWith('//')) href = `https:${href}`;
  else if (href.startsWith('/')) href = `https://duckduckgo.com${href}`;
  try {
    const u = new URL(href);
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    if (h === 'duckduckgo.com' || h.endsWith('.duckduckgo.com')) {
      const uddg = u.searchParams.get('uddg') || u.searchParams.get('u');
      if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
      return null;
    }
    if (/^https?:$/.test(u.protocol)) return u.href;
  } catch { /* ignore */ }
  return null;
}

/**
 * Parse DuckDuckGo HTML / lite search results into `{ url, title, description, source }`.
 */
function ddgUrls(html) {
  const text = String(html || '');
  if (!text) return [];
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();

  const push = (rawUrl, title, description) => {
    const url = unwrapDdgHref(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      title: strip(title || ''),
      description: strip(description || ''),
      source: 'ddg',
    });
  };

  // Standard html.duckduckgo.com result blocks
  $('.result, .web-result, .results_links').each((_, el) => {
    const node = $(el);
    const a = node.find('a.result__a, a.result-link, h2 a').first();
    const href = a.attr('href') || node.find('a.result__url').attr('href');
    const title = a.text();
    const snippet = node.find('.result__snippet, .result-snippet').text();
    if (href) push(href, title, snippet);
  });

  // DuckDuckGo lite or generic anchors with uddg=
  $('a[href]').each((_, a) => {
    const el = $(a);
    const href = el.attr('href');
    if (!href) return;
    if (href.includes('uddg=') || el.hasClass('result-link') || el.hasClass('result__a')) {
      push(href, el.text(), '');
    }
  });

  return out;
}

/**
 * Query DuckDuckGo HTML endpoint as an out-of-the-box fallback when Brave API key is not configured.
 */
async function ddgWeb(query, { count = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q || !ddgReachable()) return [];
  const rawBase = String(process.env.DDG_HTML_URL || process.env.DDG_BASE_URL || (config.baseUrls && config.baseUrls.ddg) || 'https://html.duckduckgo.com').replace(/\/+$/, '');
  const url = rawBase.endsWith('/html')
    ? `${rawBase}/?q=${encodeURIComponent(q)}&kp=-2`
    : `${rawBase}/html/?q=${encodeURIComponent(q)}&kp=-2`;
  try {
    const html = await ddgHttp.text(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      timeout: 8000,
      retries: 0,
    });
    return ddgUrls(html).slice(0, count);
  } catch {
    return [];
  }
}

/** DDG's HTML endpoint is unreachable from some hosts (tests, some networks): skip the wait there. */
const ddgReachable = () => !config.isTest || !!(process.env.DDG_BASE_URL || process.env.DDG_HTML_URL);

async function braveRequest(path, params, { budget = 40 } = {}) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('BRAVE_API_KEY is not set'), { skip: true });
  if (usage().count >= budget) throw Object.assign(new Error(`Brave daily budget reached (${budget}/day; raise Settings → Brave searches per day or set SEARXNG_URL for free fallback)`), { budget: true });
  const baseUrl = String(process.env.BRAVE_BASE_URL || config.baseUrls.brave || 'https://api.search.brave.com').replace(/\/+$/, '');
  const cleanPath = baseUrl.endsWith('/res/v1') && path.startsWith('/res/v1') ? path.slice('/res/v1'.length) : path;
  const url = `${baseUrl}${cleanPath}?${params}`;
  const headers = { accept: 'application/json', 'x-subscription-token': key };
  let res = await http.raw(url, { headers, retries: 0 });
  if (res.status === 429) {
    if (pair(res.headers['x-ratelimit-remaining'])[1] === 0) throw Object.assign(new Error('Brave monthly quota is used up (HTTP 429, plan quota exhausted until next month)'), { status: 429, budget: true });
    const wait = Math.min(Math.max((pair(res.headers['x-ratelimit-reset'])[0] || 1) * 1000, 1100), 5000);
    await new Promise((r) => setTimeout(r, wait));
    res = await http.raw(url, { headers, retries: 0 });
    if (res.status === 429) throw Object.assign(new Error('Brave rate limit hit (HTTP 429, 1 req/s on the free plan); will retry on the next discovery run'), { status: 429, retryAfter: wait * 4 });
  }
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error(`Brave rejected the API key (HTTP ${res.status}); check BRAVE_API_KEY and that the plan includes Web Search`), { skip: true, status: res.status });
  }
  if (res.status === 422) {
    throw Object.assign(new Error('Brave rejected the query (HTTP 422 — invalid parameters, not the API key)'), { status: res.status });
  }
  if (res.status >= 400) throw Object.assign(new Error(`Brave search failed (HTTP ${res.status})`), { status: res.status });
  let json;
  try { json = JSON.parse(res.body.toString('utf8')); } catch { throw Object.assign(new Error('Brave returned a non-JSON response'), { status: res.status }); }
  record();
  return json;
}

/**
 * Direct Brave Web Search API call (used by `websearch.js` provider list).
 * @param {string} q
 * @param {{count?: number, budget?: number}} opts budget = max calls per day
 * @returns {Promise<Array<{url: string, title: string, description: string}>>}
 */
async function search(q, { count = 20, budget = 40 } = {}) {
  const qs = `q=${encodeURIComponent(q)}&count=${Math.min(20, count)}&safesearch=off&spellcheck=0&text_decorations=0`;
  const json = await braveRequest('/res/v1/web/search', qs, { budget });
  return ((json.web && json.web.results) || [])
    .map((r) => ({ url: r.url, title: strip(r.title), description: strip(r.description) }))
    .filter((r) => !!r.url);
}

/**
 * Brave Web Search with automatic DuckDuckGo HTML fallback when `BRAVE_SEARCH_KEY` / `BRAVE_API_KEY` is not set.
 */
async function web(q, { count = 20, budget = 40 } = {}) {
  if (!configured()) {
    return ddgWeb(q, { count });
  }
  try {
    const res = await search(q, { count, budget });
    return res;
  } catch (e) {
    if (e && (e.skip || e.budget)) {
      return ddgWeb(q, { count });
    }
    throw e;
  }
}

/**
 * Keyless Bing image search: DuckDuckGo's HTML endpoint times out from many hosts, so Bing's
 * `/images/async` feed (HTML with `murl` / `purl` / `t` fields, HTML-escaped) is the out-of-the-box
 * fallback. Results carry the picture URL, the page it came from and its title — exactly the shape
 * Brave's image search returns.
 */
async function bingImages(query, { count = 30 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=1&count=${Math.min(Math.max(count, 10), 60)}&mmasync=1`;
  const html = await ddgHttp.text(url, {
    timeout: 15000,
    headers: { 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml' },
    retries: 1,
  });
  const text = String(html || '');
  const out = [];
  const seen = new Set();
  const field = (block, key) => {
    const m = block.match(new RegExp(`${key}&quot;:&quot;([\\s\\S]*?)(?:&quot;|")`));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') : null;
  };
  for (const block of text.split('m="').slice(1, Math.max(count, 10) + 10)) {
    const img = field(block, 'murl') || field(block, 'mediaurl');
    const page = field(block, 'purl');
    const title = field(block, 't');
    if (!img || !/^https?:\/\//i.test(img)) continue;
    const key = `${img}|${page || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: page || img,
      pageUrl: page || img,
      title: title || '',
      description: '',
      source: hostOf(page || img) || 'bing',
      imageUrl: img,
      mediaUrl: img,
      thumbnailUrl: null,
      width: null,
      height: null,
      type: 'image',
      mediaType: looksLikeVideo(img) ? 'video' : 'image',
    });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Brave Image Search (`https://api.search.brave.com/res/v1/images/search`) with automatic DDG/Bing fallback.
 */
async function images(q, { count = 20, budget = 40 } = {}) {
  if (!configured()) {
    // Image search needs actual picture URLs: DDG's HTML results rarely carry them, Bing's image feed does.
    if (config.bingEnabled) {
      try {
        const bingHits = await bingImages(q, { count });
        if (bingHits.length) return bingHits;
      } catch { /* fall back to DDG */ }
    }
    try {
      const hits = await ddgWeb(q, { count });
      if (hits.length) {        return hits
          .filter((r) => r.url)
          .map((r) => ({
            url: r.url,
            pageUrl: r.url,
            title: r.title,
            description: r.description || '',
            source: hostOf(r.url) || 'ddg',
            imageUrl: looksLikeDirectMedia(r.url) && !looksLikeVideo(r.url) ? r.url : null,
            mediaUrl: looksLikeDirectMedia(r.url) ? r.url : null,
            thumbnailUrl: null,
            width: null,
            height: null,
            type: 'image',
          }));
      }
    } catch { /* fall through to Bing */ }
    return config.bingEnabled ? bingImages(q, { count }) : [];
  }

  let json;
  try {
    const qs = `q=${encodeURIComponent(q)}&count=${Math.min(50, count)}&safesearch=off&spellcheck=0`;
    json = await braveRequest('/res/v1/images/search', qs, { budget });
  } catch (e) {
    if (e && (e.skip || e.budget)) {
      try {
        const hits = await ddgWeb(q, { count });
        if (hits.length) {
          return hits
            .filter((r) => r.url)
            .map((r) => ({
              url: r.url,
              pageUrl: r.url,
              title: r.title,
              description: r.description || '',
              source: hostOf(r.url) || 'ddg',
              imageUrl: null,
              mediaUrl: null,
              thumbnailUrl: null,
              width: null,
              height: null,
              type: 'image',
            }));
        }
      } catch { /* fall through to Bing */ }
      return config.bingEnabled ? bingImages(q, { count }) : [];
    }
    throw e;
  }

  const raw = Array.isArray(json.results) ? json.results : (json.images && json.images.results) || [];
  return raw
    .map((r) => {
      const pageUrl = r.url || r.page_url || null;
      const imgUrl = (r.properties && r.properties.url) || r.image_url || (r.thumbnail && r.thumbnail.src) || null;
      const thumbUrl = (r.thumbnail && r.thumbnail.src) || imgUrl || null;
      return {
        url: pageUrl || imgUrl,
        pageUrl,
        title: strip(r.title || ''),
        description: strip(r.description || ''),
        source: r.source || hostOf(pageUrl || imgUrl || ''),
        imageUrl: imgUrl,
        mediaUrl: imgUrl || pageUrl,
        thumbnailUrl: thumbUrl,
        width: (r.properties && Number(r.properties.width)) || Number(r.width) || null,
        height: (r.properties && Number(r.properties.height)) || Number(r.height) || null,
        type: 'image',
        mediaType: 'image',
      };
    })
    .filter((r) => !!r.url);
}

/**
 * Brave Video Search (`https://api.search.brave.com/res/v1/videos/search`) with automatic DDG fallback.
 */
async function videos(q, { count = 20, budget = 40 } = {}) {
  const mapDdgVideos = (hits) => hits
    .filter((r) => !!r.url)
    .map((r) => ({
      url: r.url,
      pageUrl: r.url,
      title: r.title,
      description: r.description || '',
      source: hostOf(r.url) || 'ddg',
      mediaUrl: looksLikeVideo(r.url) ? r.url : null,
      thumbnailUrl: null,
      duration: null,
      publisher: hostOf(r.url) || null,
      creator: null,
      type: 'video',
    }));

  if (!configured()) {
    const hits = await ddgWeb(`${q} (site:redgifs.com OR site:x.com OR site:reddit.com OR site:bsky.app OR video)`, { count });
    return mapDdgVideos(hits);
  }

  let json;
  try {
    const qs = `q=${encodeURIComponent(q)}&count=${Math.min(50, count)}&safesearch=off&spellcheck=0`;
    json = await braveRequest('/res/v1/videos/search', qs, { budget });
  } catch (e) {
    if (e && (e.skip || e.budget)) {
      const hits = await ddgWeb(`${q} (site:redgifs.com OR site:x.com OR site:reddit.com OR site:bsky.app OR video)`, { count });
      return mapDdgVideos(hits);
    }
    throw e;
  }

  const raw = Array.isArray(json.results) ? json.results : (json.videos && json.videos.results) || [];
  return raw
    .map((r) => {
      const pageUrl = r.url || r.page_url || null;
      const thumbUrl = (r.thumbnail && r.thumbnail.src) || r.thumbnail_url || null;
      const vidMeta = r.video || {};
      const mediaUrl = (r.properties && r.properties.url) || vidMeta.content_url || (looksLikeVideo(pageUrl || '') ? pageUrl : null);
      return {
        url: pageUrl || mediaUrl,
        pageUrl,
        title: strip(r.title || ''),
        description: strip(r.description || ''),
        source: r.source || vidMeta.publisher || hostOf(pageUrl || ''),
        mediaUrl: mediaUrl || pageUrl,
        thumbnailUrl: thumbUrl,
        duration: parseVideoDuration(vidMeta.duration || r.duration || null),
        publisher: vidMeta.publisher || null,
        creator: vidMeta.creator || r.creator || null,
        type: 'video',
        mediaType: 'video',
      };
    })
    .filter((r) => !!r.url);
}

module.exports = {
  search,
  web,
  images,
  videos,
  ddgWeb,
  ddgUrls,
  bingImages,
  usage,
  configured,
};
