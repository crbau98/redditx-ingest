'use strict';
/**
 * Paid creator pages (link-outs only). Everything here is pure string parsing of links people publish
 * about themselves: the content behind those pages is the creator's paid work, and PRISM reads it like
 * any other public page when it reaches it; the paid-page tracing itself looks for the person's other
 * free public accounts.
 *
 *   serviceOf(url)        'OnlyFans' | 'Fansly' | ... or null when the URL is not a paid creator page
 *   paidHandle(service, url)  canonical handle/slug for the page, or null for site pages
 *   findPaidHandles(text)     every [{service, handle}] a bio or post names (links, bare "fansly.com/x",
 *                             "Fansly: @x" prose) for OnlyFans, Fansly and JustFor.Fans — the three services
 *                             discovery traces to free public accounts
 *   paidLink(service, handle, {free, url})  the external-link object stored on a creator
 *   creatorPaid(c)            stored paid links other than OnlyFans (which keeps its own badge/CTA)
 *
 * OnlyFans parsing itself lives in lib/onlyfans.js and is re-exported here for one import site.
 */

const { ofHandle, findOnlyFans, freeHint, ofLink, creatorOnlyFans } = require('./onlyfans');

/** Paid creator platforms PRISM keeps as profile link-outs. `trace` = discovery follows the page's free
 * public accounts the way it does OnlyFans (handle-based lookups + web search; the page itself is just another public page now). */
const SERVICES = {
  'OnlyFans': { hosts: ['onlyfans.com', 'only.fans'], trace: true },
  'Fansly': { hosts: ['fansly.com', 'fans.ly'], trace: true },
  'JustFor.Fans': { hosts: ['justfor.fans', 'justforfans.com'], trace: true },
  'ManyVids': { hosts: ['manyvids.com'], trace: true },
  'LoyalFans': { hosts: ['loyalfans.com'], trace: true },
  'Fanvue': { hosts: ['fanvue.com'], trace: true },
  'FanCentro': { hosts: ['fancentro.com'], trace: true },
  'Clips4Sale': { hosts: ['clips4sale.com'], trace: true },
  'Patreon': { hosts: ['patreon.com'], trace: true },
};

const HOST2SERVICE = {};
for (const [service, { hosts }] of Object.entries(SERVICES)) for (const host of hosts) HOST2SERVICE[host] = service;

const hostOf = (input) => { try { return new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const matches = (h, d) => h === d || h.endsWith(`.${d}`);

/** Which paid service does this URL belong to, if any? */
function serviceOf(url) {
  const h = hostOf(url);
  for (const [dom, service] of Object.entries(HOST2SERVICE)) if (matches(h, dom)) return service;
  return null;
}

// First path segments that are site pages, not people (shared by the handle-style services).
const RESERVED = new Set(['login', 'signup', 'register', 'auth', 'about', 'help', 'faq', 'contact', 'blog', 'terms', 'privacy',
  'support', 'explore', 'search', 'home', 'feed', 'messages', 'notifications', 'settings', 'collections', 'videos', 'photos',
  'pictures', 'clips', 'sale', 'models', 'creators', 'categories', 'tags', 'new', 'trending', 'popular', 'store', 'merch', 'gift', 'wallet', 'payouts']);
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,40}$/;
const NOT_HANDLES = new Set(['link', 'links', 'in', 'is', 'bio', 'below', 'above', 'free', 'now', 'here', 'the', 'my', 'and', 'on', 'at', 'for',
  'sale', 'off', 'promo', 'subscribe', 'sub', 'dm', 'dms', 'open', 'only', 'fansly', 'fansly.com', 'fans', 'justfor', 'justforfans', 'justfor.fans', 'jff',
  'onlyfans', 'onlyfans.com', 'check', 'new', 'page', 'account', 'vip',
  'click', 'tap', 'see', 'join', 'com']);
/** Headline words that sit after an em dash in a title ("Best Gay OnlyFans — Top Models …"): a
 * separator followed by one of these is typography, not a username. Applied to prose matches only. */
const NOT_PROSE = new Set(['top', 'best', 'hottest', 'models', 'model', 'ranked', 'ranking', 'official', 'all', 'every', 'biggest',
  'famous', 'popular', 'list', 'lists', 'accounts', 'profiles', 'creators', 'stars', 'star', 'gay', 'male', 'men', 'man',
  'guide', 'update', 'updated', 'daily', '2025', '2026', 'edition', 'full', 'free', 'hot', 'new', 'sh', 'girls', 'backed', 'subscribers', 'complete', 'privately', 'for', 'from', 'to', 'guide',
  // generic nouns the separator regex picks up out of headlines and captions ("OnlyFans is porn")
  'porn', 'blowjob', 'squirt', 'threesome', 'sex', 'nude', 'nudes', 'nsfw', 'adult', 'content', 'videos', 'video',
  'pics', 'photos', 'leaked', 'leak', 'reddit', 'twitter', 'instagram', 'telegram', 'tiktok', 'youtube', 'discord']);

function normal(h) {
  const s = String(h || '').replace(/^@/, '').replace(/[.\-_]+$/, '').toLowerCase();
  if (!HANDLE.test(s) || RESERVED.has(s) || NOT_HANDLES.has(s) || /^\d+$/.test(s)) return null;
  return s;
}

/** fansly.com/<name> (plus /<name>/posts style deep links) → name. */
function fanslyHandle(input) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  const h = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!matches(h, 'fansly.com') && !matches(h, 'fans.ly')) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (!parts.length) return null;
  return normal(parts[0]);
}

/** justfor.fans/<name> → name. */
function jffHandle(input) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  const h = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!matches(h, 'justfor.fans') && !matches(h, 'justforfans.com')) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (!parts.length) return null;
  return normal(parts[0]);
}

/**
 * A paid service whose page URL is /<handle>, with an optional section segment in front
 * (ManyVids /model/<name>, Clips4Sale /store/<name>). The first segment that is not a
 * site word is the handle.
 */
const SECTION_WORDS = new Set(['store', 'stores', 'model', 'models', 'user', 'users', 'profile', 'p', 'creator', 'creators']);
function pathHandle(input) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const name = parts.find((p) => !SECTION_WORDS.has(p.toLowerCase()));
  return name ? normal(name) : null;
}

const PARSERS = { 'OnlyFans': ofHandle, 'Fansly': fanslyHandle, 'JustFor.Fans': jffHandle,
  'ManyVids': pathHandle, 'LoyalFans': pathHandle, 'Fanvue': pathHandle, 'FanCentro': pathHandle, 'Clips4Sale': pathHandle,
  'Patreon': pathHandle };

/** Canonical handle for a paid page URL, or null for site pages / other services. */
function paidHandle(service, url) {
  if (!Object.prototype.hasOwnProperty.call(PARSERS, service)) return null;
  const fn = PARSERS[service];
  return typeof fn === 'function' ? fn(url) : null;
}

const LINK_RES = {
  'OnlyFans': /(?:https?:\/\/)?(?:www\.)?(?:onlyfans\.com|only\.fans)\/[^\s<>"'`)\]}|,]+/gi,
  'Fansly': /(?:https?:\/\/)?(?:www\.)?(?:fansly\.com|fans\.ly)\/[^\s<>"'`)\]}|,]+/gi,
  'JustFor.Fans': /(?:https?:\/\/)?(?:www\.)?(?:justfor\.fans|justforfans\.com)\/[^\s<>"'`)\]}|,]+/gi,
  'ManyVids': /(?:https?:\/\/)?(?:www\.)?manyvids\.com\/[^\s<>"'`)\]}|,]+/gi,
  'LoyalFans': /(?:https?:\/\/)?(?:www\.)?loyalfans\.com\/[^\s<>"'`)\]}|,]+/gi,
  'Fanvue': /(?:https?:\/\/)?(?:www\.)?fanvue\.com\/[^\s<>"'`)\]}|,]+/gi,
  'FanCentro': /(?:https?:\/\/)?(?:www\.)?fancentro\.com\/[^\s<>"'`)\]}|,]+/gi,
  'Clips4Sale': /(?:https?:\/\/)?(?:www\.)?clips4sale\.com\/[^\s<>"'`)\]}|,]+/gi,
  'Patreon': /(?:https?:\/\/)?(?:www\.)?patreon\.com\/[^\s<>"'`)\]}|,]+/gi,
};
const PROSE_RES = {
  'OnlyFans': /\b(?:only\s?fans|onlyfans)\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'Fansly': /\bfansly\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'JustFor.Fans': /\b(?:justfor\.?fans|jff)\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'ManyVids': /\bmanyvids\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'LoyalFans': /\bloyalfans\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'Fanvue': /\bfanvue\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'FanCentro': /\bfancentro\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'Clips4Sale': /\bclips4sale\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'Patreon': /\bpatreon\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
};

/**
 * Is a prose match a username, or somebody else's URL path?
 * The separator regex sees `vicesnob.com/onlyfans-creator-debanking-2026/` as "OnlyFans" + "-" +
 * "creator-debanking-2026", and `.../onlyfans-debanking-featured.jpg` as a handle ending in a
 * file name — 37 junk leads in one harvest. Three rules, all path-shaped evidence:
 *   1. the "handle" is followed by / ? or # → it is a path segment, not a name
 *   2. it ends in a file extension       → it is a file, not a name
 *   3. it ends in -YYYY (a slug year)    → it is a WordPress slug, not a name
 * Only prose matches are held to this: a real paid-page URL goes through its own parser, which
 * extracts exactly one handle and never sees these shapes.
 */
/** Shape evidence that a match is somebody's path or file, not a username. Applied to BOTH the URL
 * and the prose match path — a real paid-page URL extracts exactly one handle and never looks like this. */
function looksLikePath(h) {
  if (/\.(jpe?g|png|gif|webp|avif|svg|mp4|webm|html?|php)$/i.test(h)) return true; // a file name
  if (/-\d{4}$/.test(h)) return true;                                                // a slug ending in a year
  // Multi-segment slugs ("alternatives-for-creators", "models-to-follow"): a real username rarely
  // carries two or more hyphens; a path segment routinely does.
  if ((h.match(/-/g) || []).length >= 2) return true;
  return false;
}

/** Every dot/dash/underscore segment is a headline word: "complete-guide" is a category, not a person. */
function allSegmentsHeadline(h) {
  const segs = String(h).split(/[._-]/).filter(Boolean);
  return segs.length > 1 && segs.every((w) => NOT_PROSE.has(w.toLowerCase()));
}

/** The gate both match paths share: not a headline word, not a path, not a category slug. */
function plausibleHandle(h) {
  return !!h && !NOT_PROSE.has(String(h).toLowerCase()) && !looksLikePath(h) && !allSegmentsHeadline(h);
}

function isPathNotName(source, endIndex, h) {
  const next = source[endIndex];
  if (next === '/' || next === '?' || next === '#') return true;
  return looksLikePath(h);
}

/** Every distinct {service, handle} a text names, in order. OnlyFans, Fansly and JustFor.Fans. */
function findPaidHandles(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const add = (service, h) => { if (h && !seen.has(`${service}:${h}`)) { seen.add(`${service}:${h}`); out.push({ service, handle: h }); } };
  for (const [service, re] of Object.entries(LINK_RES)) {
    re.lastIndex = 0;
    for (const m of s.match(re) || []) {
      const h = PARSERS[service](m.replace(/[.,;:!?]+$/, ''));
      // A URL whose path is a headline word (onlyfans.com/top, .../complete-guide) is a page,
      // not a person: the same gate applies to both match paths.
      if (plausibleHandle(h)) add(service, h);
    }
  }
  for (const [service, re] of Object.entries(PROSE_RES)) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const h = normal(m[1]);
      // A separator + headline word ("OnlyFans — Top Models") is typography, not a username,
      // and a separator inside somebody else's URL path is not a username either.
      if (plausibleHandle(h) && !isPathNotName(s, m.index + m[0].length, h)) add(service, h);
    }
  }
  // keep the OnlyFans order identical to findOnlyFans for callers that migrate gradually
  void findOnlyFans;
  return out;
}

const CANONICAL = { 'OnlyFans': (h) => `https://onlyfans.com/${h}`, 'Fansly': (h) => `https://fansly.com/${h}`, 'JustFor.Fans': (h) => `https://justfor.fans/${h}`,
  'ManyVids': (h) => `https://manyvids.com/${h}`, 'LoyalFans': (h) => `https://loyalfans.com/${h}`, 'Fanvue': (h) => `https://fanvue.com/${h}`,
  'FanCentro': (h) => `https://fancentro.com/${h}`, 'Clips4Sale': (h) => `https://clips4sale.com/store/${h}`, 'Patreon': (h) => `https://patreon.com/${h}` };
const PAID_HOSTS = { 'OnlyFans': 'onlyfans.com', 'Fansly': 'fansly.com', 'JustFor.Fans': 'justfor.fans',
  'ManyVids': 'manyvids.com', 'LoyalFans': 'loyalfans.com', 'Fanvue': 'fanvue.com',
  'FanCentro': 'fancentro.com', 'Clips4Sale': 'clips4sale.com', 'Patreon': 'patreon.com' };
/** Canonical page URL for a traced paid service, or null. */
function pageUrl(service, handle) {
  const build = CANONICAL[service];
  return build && handle ? build(String(handle).toLowerCase()) : null;
}
/** Does this text link the exact paid page (the profile-link proof)? */
function pageLinked(service, text, handle) {
  const want = String(handle || '').toLowerCase();
  if (!want) return false;
  if (service === 'OnlyFans' && findOnlyFans(text).includes(want)) return true;
  if (findPaidHandles(text).some((p) => p.service === service && p.handle === want)) return true;
  const host = PAID_HOSTS[service];
  return !!host && String(text || '').toLowerCase().includes(`${host}/${want}`);
}

/** The external-link object stored on a creator for a paid page. */
function paidLink(service, handle, { free = false, url = null } = {}) {
  if (service === 'OnlyFans') return ofLink(handle, { free });
  const canonicalBuilder = Object.prototype.hasOwnProperty.call(CANONICAL, service) ? CANONICAL[service] : null;
  const linkUrl = url || (handle && typeof canonicalBuilder === 'function' ? canonicalBuilder(handle) : null);
  const l = { platform: 'external', service, label: handle ? `${service} · ${handle}` : service, url: linkUrl, ...(handle ? { handle } : {}) };
  if (free) l.free = true;
  return l;
}

/** Stored paid links other than OnlyFans (which keeps its own badge and header CTA). */
function creatorPaid(c) {
  let links = c && c.links;
  if (typeof links === 'string') { try { links = JSON.parse(links); } catch { links = []; } }
  return (Array.isArray(links) ? links : []).filter((l) => l && l.url && serviceOf(l.url) && l.service !== 'OnlyFans' && !/onlyfans\.com/i.test(l.url || ''));
}

module.exports = { isPathNotName, plausibleHandle, SERVICES, serviceOf, fanslyHandle, jffHandle, paidHandle, findPaidHandles, paidLink, creatorPaid, pageUrl, pageLinked, PAID_HOSTS,
  ofHandle, findOnlyFans, freeHint, ofLink, creatorOnlyFans };
