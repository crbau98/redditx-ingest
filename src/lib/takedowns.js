'use strict';
/**
 * First-class Creator Takedown & Opt-Out Honoring.
 *
 * Enforces two layers of creator consent / takedown compliance:
 *   1. Web & HTML opt-out signals (`X-Robots-Tag`, `<meta name="robots">`,
 *      `<meta name="pinterest" content="nopin">`, HTTP 451, and DMCA / creator
 *      takedown tombstones).
 *   2. Active takedown registry (`takedowns` table: creator, handle, url, domain)
 *      checked prospectively in `pipeline.js` / `discovery.js` / `lookup.js` and
 *      applied retroactively on insert via `repo.takedowns.add()`.
 */
const paid = require('./paid');
const { extractLinks } = require('./links');

const KINDS = ['creator', 'handle', 'url', 'domain'];

function normalizeHandle(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  // Allow platform:handle or bare handle
  if (s.includes(':')) {
    const [plat, rest] = s.split(':', 2);
    const cleanRest = String(rest || '').replace(/^[@/]+|^u\/|^r\//, '').replace(/\/+$/, '').trim();
    return cleanRest ? `${plat.trim()}:${cleanRest}` : '';
  }
  s = s.replace(/^[@/]+|^u\/|^r\//, '').replace(/\/+$/, '').trim();
  return s;
}

function normalizeCreator(raw) {
  if (!raw) return '';
  return String(raw).trim().toLowerCase().replace(/^[@/]+|^u\//, '').replace(/\/+$/, '').trim();
}

function normalizeUrl(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s) && /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) {
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const search = u.search || '';
    return `${host}${path}${search}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/^https?:\/\/(?:www\.)?/, '').replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function normalizeDomain(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).hostname.toLowerCase(); } catch { /* fallback below */ }
  } else {
    s = s.split('/')[0].split('?')[0].split('#')[0];
  }
  return s.replace(/^(?:www|m|mobile)\./, '').replace(/^\.+|\.+$/g, '');
}

function normalize(kind, value) {
  const k = String(kind || '').trim().toLowerCase();
  if (!KINDS.includes(k)) {
    const err = new Error(`Invalid takedown kind "${kind}". Expected one of: ${KINDS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  let v = '';
  if (k === 'creator') v = normalizeCreator(value);
  else if (k === 'handle') v = normalizeHandle(value);
  else if (k === 'url') v = normalizeUrl(value);
  else if (k === 'domain') v = normalizeDomain(value);
  if (!v) {
    const err = new Error(`Takedown value for kind "${k}" cannot be empty`);
    err.status = 400;
    throw err;
  }
  return { kind: k, value: v };
}

function hostOf(raw) {
  if (!raw) return '';
  try {
    return new URL(String(raw)).hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
  } catch {
    return normalizeDomain(raw);
  }
}

const ROBOTS_OPTOUT_RE = /\b(noindex|noimageindex|none)\b/i;
const META_TAG_RE = /<meta\b[^>]*>/gi;
const ATTR_NAME_RE = /\b(?:name|property)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;
const ATTR_CONTENT_RE = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;

const TOMBSTONE_PATTERNS = [
  { re: /removed in response to a dmca/i, reason: 'tombstone:dmca' },
  { re: /taken down by the copyright owner/i, reason: 'tombstone:copyright-owner' },
  { re: /removed at the request of the creator/i, reason: 'tombstone:creator-request' },
  { re: /\b451\s+unavailable for legal reasons\b/i, reason: 'tombstone:http-451' },
  { re: /unavailable for legal reasons/i, reason: 'tombstone:legal' },
  { re: /this (?:content|media|post|page|video|image) has been removed (?:due to|in response to) a (?:copyright|dmca)/i, reason: 'tombstone:copyright' },
  { re: /removed due to a copyright (?:claim|complaint|notice)/i, reason: 'tombstone:copyright-claim' },
  { re: /dmca takedown (?:notice|request)/i, reason: 'tombstone:dmca-notice' },
];

/**
 * Inspect HTTP status, response headers, and HTML body for creator opt-out or
 * DMCA/legal takedown signals.
 *
 * @param {string} html
 * @param {object} [headers]
 * @param {number} [status]
 * @returns {{ optedOut: boolean, reason: string | null }}
 */
function checkHtmlOptOut(html, headers = {}, status = 200) {
  if (Number(status) === 451) {
    return { optedOut: true, reason: 'http-451-legal' };
  }

  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      const key = String(k).toLowerCase();
      if (key === 'x-robots-tag') {
        const joined = Array.isArray(v) ? v.join(', ') : String(v || '');
        const m = joined.match(ROBOTS_OPTOUT_RE);
        if (m) return { optedOut: true, reason: `x-robots-tag:${m[1].toLowerCase()}` };
      }
    }
  }

  const text = String(html || '');
  if (!text) return { optedOut: false, reason: null };

  const metaTags = text.match(META_TAG_RE) || [];
  for (const tag of metaTags) {
    const nm = tag.match(ATTR_NAME_RE);
    const cm = tag.match(ATTR_CONTENT_RE);
    if (!nm || !cm) continue;
    const name = (nm[1] || nm[2] || nm[3] || '').trim().toLowerCase();
    const content = (cm[1] || cm[2] || cm[3] || '').trim().toLowerCase();
    if (!name || !content) continue;
    if (name === 'robots' || name === 'googlebot' || name === 'bingbot' || name === 'prism') {
      const m = content.match(ROBOTS_OPTOUT_RE);
      if (m) return { optedOut: true, reason: `meta-robots:${m[1].toLowerCase()}` };
    }
    if (name === 'pinterest' && /\bnopin\b/i.test(content)) {
      return { optedOut: true, reason: 'meta-pinterest:nopin' };
    }
  }

  for (const { re, reason } of TOMBSTONE_PATTERNS) {
    if (re.test(text)) {
      return { optedOut: true, reason };
    }
  }

  return { optedOut: false, reason: null };
}

function getActiveTakedowns(explicitList) {
  if (Array.isArray(explicitList)) return explicitList;
  try {
    const repo = require('../db/repo');
    if (repo.takedowns && typeof repo.takedowns.all === 'function') {
      return repo.takedowns.all();
    }
  } catch { /* DB not initialized */ }
  return [];
}

function urlMatches(candidateUrl, takedownValue) {
  const norm = normalizeUrl(candidateUrl);
  if (!norm || !takedownValue) return false;
  return norm === takedownValue || norm.startsWith(`${takedownValue}/`) || norm.startsWith(`${takedownValue}?`);
}

function domainMatches(candidateUrlOrHost, takedownDomain) {
  const h = hostOf(candidateUrlOrHost);
  if (!h || !takedownDomain) return false;
  return h === takedownDomain || h.endsWith(`.${takedownDomain}`);
}

function handleMatches(candidateHandle, platform, takedownValue) {
  if (!candidateHandle || !takedownValue) return false;
  const h = normalizeHandle(candidateHandle);
  if (!h) return false;
  const bare = h.includes(':') ? h.split(':', 2)[1] : h;
  if (takedownValue.includes(':')) {
    const [tdPlat, tdBare] = takedownValue.split(':', 2);
    if (platform && String(platform).toLowerCase() !== tdPlat) return false;
    return bare === tdBare;
  }
  return bare === takedownValue || h === takedownValue;
}

function creatorMatches(candidateCreator, takedownValue) {
  if (!candidateCreator || !takedownValue) return false;
  const c = normalizeCreator(candidateCreator);
  const td = normalizeCreator(takedownValue);
  if (!c || !td) return false;
  if (c === td) return true;
  const stripPrefix = (s) => s.replace(/^creator[-_]/, '');
  return stripPrefix(c) === stripPrefix(td);
}

/**
 * Check an incoming pipeline item (and its feed / resolved creator) against active takedowns.
 * Returns `{ blocked: true, reason: 'takedown', takedown }` or `null`.
 */
function checkItem(item, feed = null, explicitList = null, extraCreator = null) {
  if (!item) return null;
  if (typeof item === 'string') return checkUrl(item, explicitList);

  const list = getActiveTakedowns(explicitList);
  if (!list.length) return null;

  const platform = item.platform || (feed && feed.platform) || null;

  // Gather candidate creator identifiers
  const creatorIds = new Set();
  for (const c of [
    item.creatorId, item.creator_id, item.creatorHandle, item.creator_handle,
    feed && feed.creator_id,
    extraCreator && extraCreator.id,
    extraCreator && extraCreator.handle,
    extraCreator && extraCreator.display_name,
  ]) {
    if (c) creatorIds.add(String(c));
  }

  // Gather candidate handles
  const handles = new Set();
  for (const h of [
    item.author,
    item.authorName,
    item.creatorHandle,
    item.creator_handle,
    item.repostOf && item.repostOf.handle,
    item.forwardFrom && item.forwardFrom.handle,
    feed && ['user', 'channel', 'page'].includes(feed.kind) ? feed.target : null,
    extraCreator && extraCreator.handle,
  ]) {
    const norm = normalizeHandle(h);
    if (norm) handles.add(norm);
  }

  // Gather paid handles mentioned in text or links
  const linkStrings = Array.isArray(item.links)
    ? item.links.map((l) => (l && typeof l === 'object' ? l.url || l.handle || '' : l)).filter(Boolean)
    : [];
  const paidHits = paid.findPaidHandles([item.title, item.text, item.description, item.altText, ...linkStrings].filter(Boolean).join('\n'));
  const urls = new Set();
  for (const ph of paidHits) {
    handles.add(normalizeHandle(ph.handle));
    const url = paid.pageUrl(ph.service, ph.handle);
    if (url) urls.add(url);
  }

  // Gather candidate URLs
  for (const u of [
    item.permalink, item.source_url, item.sourceUrl,
    item.mediaUrl, item.media_url,
    item.previewUrl, item.preview_url,
    item.thumbnailUrl, item.thumbnail_url,
    feed && (feed.kind === 'page' || /^https?:\/\//i.test(String(feed.target || ''))) ? feed.target : null,
    ...linkStrings,
  ]) {
    if (u && typeof u === 'string') urls.add(u);
  }

  // Also extract social / link-hub links from text/title/description
  for (const blob of [item.title, item.text, item.description, ...linkStrings]) {
    if (!blob) continue;
    for (const l of extractLinks(String(blob))) {
      if (l.handle) handles.add(normalizeHandle(l.handle));
      if (l.url) urls.add(l.url);
    }
  }

  for (const td of list) {
    const k = td.kind;
    const v = td.value;
    if (k === 'creator') {
      for (const cid of creatorIds) {
        if (creatorMatches(cid, v)) return { blocked: true, reason: 'takedown', takedown: td };
      }
      for (const h of handles) {
        if (creatorMatches(h, v)) return { blocked: true, reason: 'takedown', takedown: td };
      }
    } else if (k === 'handle') {
      for (const h of handles) {
        if (handleMatches(h, platform, v)) return { blocked: true, reason: 'takedown', takedown: td };
      }
      for (const cid of creatorIds) {
        if (handleMatches(cid, platform, v)) return { blocked: true, reason: 'takedown', takedown: td };
      }
    } else if (k === 'url') {
      for (const u of urls) {
        if (urlMatches(u, v)) return { blocked: true, reason: 'takedown', takedown: td };
      }
    } else if (k === 'domain') {
      for (const u of urls) {
        if (domainMatches(u, v)) return { blocked: true, reason: 'takedown', takedown: td };
      }
    }
  }

  return null;
}

function checkUrl(url, explicitList = null) {
  if (!url) return null;
  const list = getActiveTakedowns(explicitList);
  if (!list.length) return null;
  const extracted = extractLinks(String(url));
  for (const td of list) {
    if (td.kind === 'url' && urlMatches(url, td.value)) {
      return { blocked: true, reason: 'takedown', takedown: td };
    }
    if (td.kind === 'domain' && domainMatches(url, td.value)) {
      return { blocked: true, reason: 'takedown', takedown: td };
    }
    if (td.kind === 'handle' || td.kind === 'creator') {
      for (const l of extracted) {
        if (l.handle && (handleMatches(l.handle, l.platform, td.value) || creatorMatches(l.handle, td.value))) {
          return { blocked: true, reason: 'takedown', takedown: td };
        }
      }
    }
  }
  return null;
}

function checkHandle(handle, platform = null, explicitList = null) {
  if (!handle) return null;
  const list = getActiveTakedowns(explicitList);
  if (!list.length) return null;
  for (const td of list) {
    if (td.kind === 'handle' && handleMatches(handle, platform, td.value)) {
      return { blocked: true, reason: 'takedown', takedown: td };
    }
    if (td.kind === 'creator' && creatorMatches(handle, td.value)) {
      return { blocked: true, reason: 'takedown', takedown: td };
    }
  }
  return null;
}

module.exports = {
  KINDS,
  normalize,
  normalizeHandle,
  normalizeCreator,
  normalizeUrl,
  normalizeDomain,
  checkHtmlOptOut,
  checkItem,
  check: checkItem,
  checkUrl,
  checkHandle,
  urlMatches,
  domainMatches,
  handleMatches,
  creatorMatches,
};
