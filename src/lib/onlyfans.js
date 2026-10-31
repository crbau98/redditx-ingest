'use strict';
/**
 * OnlyFans awareness. What it uses is what creators publish for free: the link to their page, whether they say
 * the page is free or on sale, and the public promo accounts they post from everywhere else.
 *
 *   ofHandle(url)       canonical handle of an onlyfans.com profile link, or null
 *   findOnlyFans(text)  every OF handle a bio or post names (links, bare "onlyfans.com/x", "OnlyFans: @x")
 *   freeHint(text)      does the text say the page is free / discounted?
 *   ofLink(handle)      the external-link object stored on a creator
 *   creatorOnlyFans(c)  {handle, url, free} for a creator's stored links, or null
 */

// First path segments on onlyfans.com that are site pages, not people.
const RESERVED = new Set(['my', 'action', 'api', 'api2', 'files', 'terms', 'privacy', 'help', 'about', 'legal', 'login', 'signup', 'register', 'auth',
  'faq', 'contact', 'blog', 'how', 'transparency', 'cookies', 'complaints', 'dmca', 'brand', 'brandassets', 'onlyfanstv', 'ofradio', 'search', 'home',
  'posts', 'chats', 'notifications', 'settings', 'bookmarks', 'lists', 'subscriptions', 'collections', 'vault', 'statements', 'support', 'careers',
  'aup', 'usc2257', 'contract', 'acceptable-use-policy', 'tos', 'referrals', 'stories', 'streams', 'explore', 'feed', 'oauth', 'pages', 'p', 'u']);
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,40}$/;
// Words that follow "OnlyFans:" in prose but are not usernames.
const NOT_HANDLES = new Set(['link', 'links', 'in', 'is', 'bio', 'below', 'above', 'free', 'now', 'here', 'the', 'my', 'and', 'on', 'at', 'for', 'sale', 'off',
  'promo', 'subscribe', 'sub', 'dm', 'dms', 'open', 'only', 'onlyfans', 'onlyfans.com', 'of', 'check', 'new', 'page', 'account', 'vip', 'click', 'tap', 'see', 'join', 'com']);

function normal(h) {
  const s = String(h || '').replace(/^@/, '').replace(/[.\-_]+$/, '').toLowerCase();
  if (!HANDLE.test(s) || RESERVED.has(s) || NOT_HANDLES.has(s) || /^\d+$/.test(s)) return null;
  return s;
}

/** onlyfans.com/<name>, /<name>/c12 (campaign link), /<postId>/<name> → name. */
function ofHandle(input) {
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'onlyfans.com' && !host.endsWith('.onlyfans.com')) return null;
  if (host !== 'onlyfans.com') return null; // cdn / static hosts
  const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (!parts.length) return null;
  if (/^\d+$/.test(parts[0]) && parts[1]) return normal(parts[1]); // post permalink: /<id>/<name>
  return normal(parts[0]);
}

const LINK_RE = /(?:https?:\/\/)?(?:www\.)?onlyfans\.com\/[^\s<>"'`)\]}|,]+/gi;
const PROSE_RE = /\b(?:only\s?fans|onlyfans)\s*(?:[:=\-–—→>]|\bis\b)\s*@?([A-Za-z0-9][A-Za-z0-9_.-]{1,40})/gi;

/** Every distinct OF handle a text names, in order. */
function findOnlyFans(text) {
  const s = String(text || '');
  const out = [];
  const add = (h) => { if (h && !out.includes(h)) out.push(h); };
  for (const m of s.match(LINK_RE) || []) add(ofHandle(m.replace(/[.,;:!?]+$/, '')));
  for (const m of s.matchAll(PROSE_RE)) add(normal(m[1]));
  return out;
}

/** "FREE OF", "free onlyfans", "$0", "70% off", "sale" near a mention of the page. */
const FREE_RE = /\bfree\s+(?:only\s?fans|of\b|page|sub(?:scription)?|trial)|\b(?:only\s?fans|of)\s*(?:is|now)?\s*free\b|\$\s?0(?:\.00)?\b|\b\d{2}\s?%\s?off\b|\bfree\s+for\s+\d+\s+days\b/i;
const freeHint = (text) => FREE_RE.test(String(text || ''));

function ofLink(handle, { free = false } = {}) {
  const l = { platform: 'external', service: 'OnlyFans', label: `OnlyFans · ${handle}`, url: `https://onlyfans.com/${handle}`, handle };
  if (free) l.free = true;
  return l;
}

/** The creator's OnlyFans page from their stored links (first one wins), or null. */
function creatorOnlyFans(c) {
  let links = c && c.links;
  if (typeof links === 'string') { try { links = JSON.parse(links); } catch { links = []; } }
  for (const l of Array.isArray(links) ? links : []) {
    const handle = l && (l.handle || (l.url && ofHandle(l.url)));
    if (handle && (l.service === 'OnlyFans' || /onlyfans\.com/i.test(l.url || ''))) return { handle, url: `https://onlyfans.com/${handle}`, free: !!l.free };
  }
  return null;
}

module.exports = { ofHandle, findOnlyFans, freeHint, ofLink, creatorOnlyFans, normal };
