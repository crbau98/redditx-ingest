'use strict';
/**
 * Yandex Images as a discovery source (keyword search), behind the YANDEX_IMAGES flag (default ON; YANDEX_IMAGES=0 turns it off).
 *
 *   GET {YANDEX_BASE_URL}/images/search?text=<query>   (a normal browser User-Agent)
 *
 * The results are in the page's own data-state / data-bem attributes as HTML-escaped JSON. Every object that carries
 * `origUrl` and `snippet.url` is one result. We read the PAGE (snippet.url) as the ingestion target, never origUrl: the
 * index's copy of the picture is not fetched, and no third-party CDN is hotlinked. Results marked `censored` are dropped.
 *
 * The owner accepted that yandex.com/robots.txt disallows /images/* (see README "Yandex Images"). This is the only
 * deviation of its kind; every item still goes through the page reader (robots, takedowns, safety, scope) downstream.
 *
 * A CAPTCHA page cools THIS provider down (its own cooldown and limiter key), never the other web-search providers, and the
 * reason is reported in status() exactly like Bing's.
 */
const cheerio = require('cheerio');
const config = require('../config');
const http = require('../sources/http').forPlatform('yandex', 1500);
const { looksLikeVideo, hostOf } = require('./mediaurl');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const COOLDOWN_MS = 30 * 60 * 1000;
let cooldownUntil = 0;
const health = { ok: 0, empty: 0, failed: 0, lastAt: null, lastError: null, cooldownUntil: null };

const enabled = () => !!config.yandexImages;
const base = () => String(config.yandexBase || 'https://yandex.com').replace(/\/+$/, '');

/** Unescape the HTML attribute encoding of the JSON inside data-state / data-bem. */
function unescapeAttr(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Every JSON object in the page's data-state / data-bem attributes, parsed (attributes that are not JSON are skipped). */
function jsonAttributes(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/data-(?:state|bem)='([^']*)'|data-(?:state|bem)="([^"]*)"/g)) {
    try { out.push(JSON.parse(unescapeAttr(m[1] !== undefined ? m[1] : m[2]))); } catch { /* not JSON */ }
  }
  return out;
}

/** Is this answer a CAPTCHA (or a block) page rather than results? */
function isCaptcha(html) {
  return /showcaptcha|CheckboxCaptcha|smart-captcha|captcha-form/i.test(String(html || '').slice(0, 200000));
}

/**
 * Keyword results from a Yandex image results page. Returns page-level records shaped like bingImages()'s, with imageUrl and
 * mediaUrl set to null: the page is the ingestion target and the index's image is never used.
 */
function parseSerp(html, { count = 30 } = {}) {
  const out = [];
  const seen = new Set();
  const walk = (o) => {
    if (out.length >= count) return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    if (typeof o.origUrl === 'string' && o.snippet && typeof o.snippet === 'object') {
      const page = String(o.snippet.url || '').trim();
      if (/^https?:\/\//i.test(page) && !o.censored && !seen.has(page)) {
        seen.add(page);
        const title = String(o.snippet.title || o.alt || '').trim();
        out.push({
          url: page,
          pageUrl: page,
          imageUrl: null,
          mediaUrl: null,
          title,
          description: '',
          source: String(o.snippet.domain || hostOf(page) || 'yandex'),
          thumbnailUrl: null,
          width: Number(o.width) || null,
          height: Number(o.height) || null,
          type: 'image',
          mediaType: looksLikeVideo(o.origUrl) ? 'video' : 'image',
        });
      }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  for (const j of jsonAttributes(html)) walk(j);
  return out;
}

/**
 * Keyword search. Throws `{skip, captcha}` errors that the caller treats as "this provider is unavailable right now"; a
 * CAPTCHA also starts this provider's own cooldown.
 */
async function keywordImages(query, { count = 30 } = {}) {
  if (!enabled()) throw Object.assign(new Error('Yandex Images is off (YANDEX_IMAGES=0)'), { skip: true });
  if (Date.now() < cooldownUntil) throw Object.assign(new Error(`Yandex is cooling down after a CAPTCHA (until ${new Date(cooldownUntil).toISOString()})`), { skip: true });
  const q = String(query || '').trim();
  if (!q) return [];
  let html;
  try {
    html = await http.text(`${base()}/images/search?text=${encodeURIComponent(q)}`, {
      timeout: 15000, retries: 0, headers: { 'user-agent': UA, 'accept-language': 'en', accept: 'text/html,application/xhtml+xml' },
    });
  } catch (e) {
    health.failed++; health.lastAt = new Date().toISOString(); health.lastError = String(e.message || e).slice(0, 160);
    throw Object.assign(new Error(`Yandex Images request failed: ${health.lastError}`), { skip: true });
  }
  if (isCaptcha(html)) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    health.cooldownUntil = new Date(cooldownUntil).toISOString();
    health.failed++; health.lastAt = new Date().toISOString(); health.lastError = 'Yandex asked for a CAPTCHA';
    throw Object.assign(new Error(`Yandex asked for a CAPTCHA — cooling down ${COOLDOWN_MS / 60000} min`), { skip: true, captcha: true });
  }
  const results = parseSerp(html, { count });
  if (results.length) { health.ok++; health.lastError = null; } else { health.empty++; }
  health.lastAt = new Date().toISOString();
  return results;
}

/**
 * Reverse-image mirror candidates for one picture: the 'Sites containing information about the image' list. Two requests:
 * the imageview page (its tab link carries cbir_page=sites), then that list. Returns page-level candidates only; the thumbnail
 * is never used. These are review-queue candidates for the caller, never an automatic creator match.
 */
async function cbirSites(imageUrl, { count = 30 } = {}) {
  if (!enabled()) throw Object.assign(new Error('Yandex Images is off (YANDEX_IMAGES=0)'), { skip: true });
  if (Date.now() < cooldownUntil) throw Object.assign(new Error('Yandex is cooling down after a CAPTCHA'), { skip: true });
  if (!/^https?:\/\//i.test(String(imageUrl || ''))) return [];
  const get = async (url) => {
    const html = await http.text(url, { timeout: 15000, retries: 0, headers: { 'user-agent': UA, 'accept-language': 'en', accept: 'text/html,application/xhtml+xml' } });
    if (isCaptcha(html)) {
      cooldownUntil = Date.now() + COOLDOWN_MS;
      health.cooldownUntil = new Date(cooldownUntil).toISOString();
      health.failed++; health.lastAt = new Date().toISOString(); health.lastError = 'Yandex asked for a CAPTCHA';
      throw Object.assign(new Error(`Yandex asked for a CAPTCHA — cooling down ${COOLDOWN_MS / 60000} min`), { skip: true, captcha: true });
    }
    return String(html || '');
  };
  const first = await get(`${base()}/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`);
  const m = first.match(/href="([^"]*cbir_page=sites[^"]*)"/);
  if (!m) return [];
  const sitesPath = m[1].replace(/&amp;/g, '&');
  const sitesHtml = await get(new URL(sitesPath, base()).toString());
  const $ = cheerio.load(sitesHtml);
  const out = [];
  const seen = new Set();
  $('li.CbirSites-Item').each((_, el) => {
    if (out.length >= count) return;
    const a = $(el).find('.CbirSites-ItemTitle a[href]').first();
    const page = String(a.attr('href') || '').trim();
    if (!/^https?:\/\//i.test(page) || seen.has(page)) return;
    seen.add(page);
    out.push({ url: page, pageUrl: page, title: String(a.text() || '').replace(/\s+/g, ' ').trim(), source: hostOf(page) || 'yandex', type: 'mirror-candidate' });
  });
  health.ok += out.length ? 1 : 0; health.empty += out.length ? 0 : 1; health.lastAt = new Date().toISOString();
  return out;
}

function status() {
  return { enabled: enabled(), cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null, ...health };
}
function _reset() { cooldownUntil = 0; Object.assign(health, { ok: 0, empty: 0, failed: 0, lastAt: null, lastError: null, cooldownUntil: null }); }

module.exports = { keywordImages, cbirSites, parseSerp, isCaptcha, status, enabled, _reset, UA };
