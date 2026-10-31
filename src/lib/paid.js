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
  'OnlyFans': { hosts: ['onlyfans.com'], trace: true },
  'Fansly': { hosts: ['fansly.com'], trace: true },
  'JustFor.Fans': { hosts: ['justfor.fans'], trace: true },
  'ManyVids': { hosts: ['manyvids.com'], trace: false },
  'LoyalFans': { hosts: ['loyalfans.com'], trace: false },
  'Fanvue': { hosts: ['fanvue.com'], trace: false },
  'FanCentro': { hosts: ['fancentro.com'], trace: false },
  'Clips4Sale': { hosts: ['clips4sale.com'], trace: false },
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
  'models', 'creators', 'categories', 'tags', 'new', 'trending', 'popular', 'store', 'merch', 'gift', 'wallet', 'payouts']);
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,40}$/;
const NOT_HANDLES = new Set(['link', 'links', 'in', 'is', 'bio', 'below', 'above', 'free', 'now', 'here', 'the', 'my', 'and', 'on', 'at', 'for',
  'sale', 'off', 'promo', 'subscribe', 'sub', 'dm', 'dms', 'open', 'only', 'fansly', 'fansly.com', 'fans', 'justfor', 'justforfans', 'justfor.fans', 'jff',
  'onlyfans', 'onlyfans.com', 'check', 'new', 'page', 'account', 'vip',
  'click', 'tap', 'see', 'join', 'com']);

function normal(h) {
  const s = String(h || '').replace(/^@/, '').replace(/[.\-_]+$/, '').toLowerCase();
  if (!HANDLE.test(s) || RESERVED.has(s) || NOT_HANDLES.has(s) || /^\d+$/.test(s)) return null;
  return s;
}

/** fansly.com/<name> (plus /<name>/posts style deep links) → name. */
function fanslyHandle(input) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  if (!matches(url.hostname.toLowerCase().replace(/^www\./, ''), 'fansly.com')) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (!parts.length) return null;
  return normal(parts[0]);
}

/** justfor.fans/<name> → name. */
function jffHandle(input) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  if (!matches(url.hostname.toLowerCase().replace(/^www\./, ''), 'justfor.fans')) return null;
  const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (!parts.length) return null;
  return normal(parts[0]);
}

const PARSERS = { 'OnlyFans': ofHandle, 'Fansly': fanslyHandle, 'JustFor.Fans': jffHandle };

/** Canonical handle for a paid page URL, or null for site pages / other services. */
function paidHandle(service, url) {
  if (!Object.prototype.hasOwnProperty.call(PARSERS, service)) return null;
  const fn = PARSERS[service];
  return typeof fn === 'function' ? fn(url) : null;
}

const LINK_RES = {
  'OnlyFans': /(?:https?:\/\/)?(?:www\.)?onlyfans\.com\/[^\s<>"'`)\]}|,]+/gi,
  'Fansly': /(?:https?:\/\/)?(?:www\.)?fansly\.com\/[^\s<>"'`)\]}|,]+/gi,
  'JustFor.Fans': /(?:https?:\/\/)?(?:www\.)?justfor\.fans\/[^\s<>"'`)\]}|,]+/gi,
};
const PROSE_RES = {
  'OnlyFans': /\b(?:only\s?fans|onlyfans)\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'Fansly': /\bfansly\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
  'JustFor.Fans': /\b(?:justfor\.?fans|jff)\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi,
};

/** Every distinct {service, handle} a text names, in order. OnlyFans, Fansly and JustFor.Fans. */
function findPaidHandles(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const add = (service, h) => { if (h && !seen.has(`${service}:${h}`)) { seen.add(`${service}:${h}`); out.push({ service, handle: h }); } };
  for (const [service, re] of Object.entries(LINK_RES)) {
    re.lastIndex = 0;
    for (const m of s.match(re) || []) add(service, PARSERS[service](m.replace(/[.,;:!?]+$/, '')));
  }
  for (const [service, re] of Object.entries(PROSE_RES)) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) add(service, normal(m[1]));
  }
  // keep the OnlyFans order identical to findOnlyFans for callers that migrate gradually
  void findOnlyFans;
  return out;
}

const CANONICAL = { 'OnlyFans': (h) => `https://onlyfans.com/${h}`, 'Fansly': (h) => `https://fansly.com/${h}`, 'JustFor.Fans': (h) => `https://justfor.fans/${h}` };
const PAID_HOSTS = { 'OnlyFans': 'onlyfans.com', 'Fansly': 'fansly.com', 'JustFor.Fans': 'justfor.fans' };
/** Canonical page URL for a traced paid service, or null. */
function pageUrl(service, handle) {
  const host = PAID_HOSTS[service];
  return host && handle ? `https://${host}/${String(handle).toLowerCase()}` : null;
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

module.exports = { SERVICES, serviceOf, fanslyHandle, jffHandle, paidHandle, findPaidHandles, paidLink, creatorPaid, pageUrl, pageLinked, PAID_HOSTS,
  ofHandle, findOnlyFans, freeHint, ofLink, creatorOnlyFans };
