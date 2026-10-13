'use strict';
/**
 * Parse anything a person might paste ("https://x.com/foo", "r/gaybros",
 * "u/someone", "@user@mastodon.social", "foo.bsky.social", an RSS URL, a
 * Linktree) into a typed target the ingestion engine understands.
 *
 * Platforms fall in three groups:
 *   ingestable  - we have an adapter and the content is public.
 *   linkinbio   - a hub page we crawl for *other* profile links.
 *   external    - paywalled / closed platforms. We keep the link so it can be
 *                 shown on the creator page (and send fans to the creator's
 *                 own pages) but never scrape them.
 */

const config = require('../config');
const { ofHandle } = require('./onlyfans');

const EXTERNAL = {
  'onlyfans.com': 'OnlyFans',
  'fansly.com': 'Fansly',
  'patreon.com': 'Patreon',
  'instagram.com': 'Instagram',
  'tiktok.com': 'TikTok',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'twitch.tv': 'Twitch',
  'snapchat.com': 'Snapchat',
  'throne.com': 'Throne',
  'fanvue.com': 'Fanvue',
  'justfor.fans': 'JustFor.Fans',
  'manyvids.com': 'ManyVids',
  'clips4sale.com': 'Clips4Sale',
  'pornhub.com': 'Pornhub',
  'cashapp.com': 'Cash App',
  'cash.app': 'Cash App',
  'venmo.com': 'Venmo',
  'amazon.com': 'Amazon',
  'ko-fi.com': 'Ko-fi',
  'discord.gg': 'Discord',
  'discord.com': 'Discord',
  'facebook.com': 'Facebook',
  'threads.net': 'Threads',
  'threads.com': 'Threads',
  'grindr.com': 'Grindr',
};

const LINKINBIO = [
  'linktr.ee', 'allmylinks.com', 'beacons.ai', 'carrd.co', 'solo.to', 'lnk.bio',
  'bio.site', 'linkin.bio', 'hoo.be', 'campsite.bio', 'bio.link', 'direct.me',
  'linkpop.com', 'withkoji.com', 'taplink.cc', 'msha.ke', 'stan.store',
];

const X_RESERVED = new Set([
  'i', 'home', 'intent', 'share', 'search', 'hashtag', 'explore', 'settings',
  'notifications', 'messages', 'compose', 'login', 'signup', 'tos', 'privacy',
  'about', 'download', 'jobs', 'status', 'following', 'followers', 'lists',
]);
const NOT_MASTODON_HOSTS = [
  'medium.com', 'tiktok.com', 'youtube.com', 'threads.net', 'threads.com',
  'instagram.com', 'substack.com', 'x.com', 'twitter.com', 'bsky.app',
  'reddit.com', 'tumblr.com', 'linktr.ee', 'patreon.com',
];

/** Misskey-family servers usually say so in their name; anything else is treated as Mastodon-compatible
 * (and the Mastodon adapter still detects Misskey via NodeInfo at fetch time). */
const isMisskeyHost = (h) => /(^|\.)(misskey|sharkey|firefish|iceshrimp|calckey|catodon)[.-]|^(misskey|sharkey)\./i.test(h);

/** PeerTube has no tell-tale path for a bare `/c/<name>` (Lemmy uses it too), so the host has to say so. */
const isPeertubeHost = (h) => (config.peertubeInstances || []).includes(h) || /(^|\.)peertube[.-]|^(peertube|tube)\./i.test(h);

// First path segments on www.tumblr.com that are pages, not blogs.
const TUMBLR_PAGES = new Set(['tagged', 'search', 'explore', 'dashboard', 'settings', 'login', 'register', 'likes', 'following', 'inbox', 'new', 'edit',
  'reblog', 'share', 'about', 'policy', 'privacy', 'terms', 'docs', 'themes', 'apps', 'jobs', 'press', 'help', 'support', 'logo', 'buy', 'mobile',
  'follow', 'ask', 'blog', 'communities', 'activity', 'domains', 'privacy-policy', 'safe-mode', 'rss', 'oembed', 'svc', 'tumblr']);
// <x>.tumblr.com hosts that are infrastructure, not blogs.
const TUMBLR_HOSTS = new Set(['www', 'assets', 'static', 'api', 'at', 'media', 'staff', 'engineering', 'support', 'help', 'vtt', 'va', 'embed', 'px', 'platform', 'cdn']);
const TUMBLR_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const tumblrTag = (raw) => { try { return decodeURIComponent(String(raw).replace(/\+/g, ' ')).trim().replace(/^#/, ''); } catch { return String(raw).trim(); } };

const host = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const matches = (h, d) => h === d || h.endsWith('.' + d);

function out(platform, kind, target, extra = {}) {
  return { platform, kind, target, ingestable: true, ...extra };
}

/**
 * @param {string} input   URL, handle, "r/sub", "@user@host", ...
 * @param {{platform?: string}} [hint] disambiguate bare handles
 * @returns {object|null}  {platform, kind, target, label?, url?, ingestable, external?}
 */
function parseProfile(input, hint = {}) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  raw = raw.replace(/^<|>$/g, '').replace(/[),.;]+$/g, '');

  // ---- shorthand forms --------------------------------------------------
  let m = raw.match(/^\/?r\/([A-Za-z0-9_]{2,40})\/?$/);
  if (m) return out('reddit', 'community', m[1].toLowerCase(), { label: `r/${m[1]}` });
  m = raw.match(/^\/?u(?:ser)?\/([A-Za-z0-9_-]{3,40})\/?$/);
  if (m) return out('reddit', 'user', m[1], { label: `u/${m[1]}` });
  m = raw.match(/^misskey:@?([A-Za-z0-9_]+)@([A-Za-z0-9.-]+\.[a-z]{2,})$/i);
  if (m) return out('misskey', 'user', `${m[1]}@${m[2].toLowerCase()}`, { label: `@${m[1]}@${m[2]}` });
  m = raw.match(/^peertube:@?([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+\.[a-z]{2,})$/i);
  if (m) return out('peertube', 'user', `${m[1]}@${m[2].toLowerCase()}`, { label: `${m[1]}@${m[2].toLowerCase()} (PeerTube)` });
  m = raw.match(/^tumblr:([A-Za-z0-9][A-Za-z0-9.-]{0,60})$/i);
  if (m) return out('tumblr', 'user', m[1].toLowerCase().replace(/\.tumblr\.com$/, ''), { label: `${m[1]} (Tumblr)` });
  m = raw.match(/^@?([A-Za-z0-9_]+)@([A-Za-z0-9.-]+\.[a-z]{2,})$/i);
  if (m) {
    const inst = m[2].toLowerCase();
    if (hint.platform === 'peertube') return out('peertube', 'user', `${m[1]}@${inst}`, { label: `${m[1]}@${inst} (PeerTube)` });
    const pl = hint.platform === 'misskey' || isMisskeyHost(inst) ? 'misskey' : 'mastodon';
    return out(pl, 'user', `${m[1]}@${inst}`, { label: `@${m[1]}@${m[2]}` });
  }
  m = raw.match(/^at:\/\/([^/\s]+)\/app\.bsky\.(feed\.generator|graph\.list)\/([A-Za-z0-9._~-]+)$/);
  if (m) return out('bluesky', m[2] === 'feed.generator' ? 'feedgen' : 'list', raw, { label: `${m[2] === 'feed.generator' ? 'Feed' : 'List'} ${m[3]} by ${m[1]}` });
  m = raw.match(/^@?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.(?:social|app|com|net|org|xyz|blog|dev|me|io|lol|gay|lgbt))$/i);
  if (m && !/^https?:/i.test(raw) && (hint.platform === 'bluesky' || /\.bsky\.|\.social$|\.xyz$|\.gay$/i.test(m[1]))) {
    return out('bluesky', 'user', m[1].toLowerCase(), { label: `@${m[1]}` });
  }
  m = raw.match(/^@([A-Za-z0-9_]{1,30})$/);
  if (m) {
    const p = hint.platform;
    if (p === 'x') return out('x', 'user', m[1], { label: `@${m[1]}` });
    if (p === 'redgifs') return out('redgifs', 'user', m[1].toLowerCase(), { label: m[1] });
    if (p === 'reddit') return out('reddit', 'user', m[1], { label: `u/${m[1]}` });
    return null; // ambiguous without a hint
  }

  // ---- URLs -----------------------------------------------------------------
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const h = host(url.hostname);
  if (!h.includes('.')) return null;
  const parts = url.pathname.split('/').filter(Boolean);

  if (matches(h, 'reddit.com') || h === 'redd.it') {
    if ((parts[0] === 'r') && parts[1]) return out('reddit', 'community', parts[1].toLowerCase(), { label: `r/${parts[1]}`, url: url.href });
    if ((parts[0] === 'u' || parts[0] === 'user') && parts[1]) return out('reddit', 'user', parts[1], { label: `u/${parts[1]}`, url: url.href });
    return null;
  }

  if (matches(h, 'x.com') || matches(h, 'twitter.com')) {
    const name = parts[0];
    if (!name || X_RESERVED.has(name.toLowerCase()) || !/^[A-Za-z0-9_]{1,15}$/.test(name)) return null;
    return out('x', 'user', name, { label: `@${name}`, url: `https://x.com/${name}` });
  }

  if (h === 'bsky.app') {
    if (parts[0] === 'profile' && parts[1] && parts[2] === 'feed' && parts[3]) {
      return out('bluesky', 'feedgen', `at://${parts[1].toLowerCase()}/app.bsky.feed.generator/${parts[3]}`, { label: `Feed ${parts[3]} by @${parts[1]}`, url: url.href });
    }
    if (parts[0] === 'profile' && parts[1] && parts[2] === 'lists' && parts[3]) {
      return out('bluesky', 'list', `at://${parts[1].toLowerCase()}/app.bsky.graph.list/${parts[3]}`, { label: `List ${parts[3]} by @${parts[1]}`, url: url.href });
    }
    if (parts[0] === 'profile' && parts[1] && parts.length <= 2) return out('bluesky', 'user', parts[1].toLowerCase(), { label: `@${parts[1]}`, url: url.href });
    return null;
  }

  if (matches(h, 'redgifs.com')) {
    if ((parts[0] === 'users' || parts[0] === 'u') && parts[1]) return out('redgifs', 'user', parts[1].toLowerCase(), { label: parts[1], url: url.href });
    if (parts[0] === 'niches' && parts[1]) return out('redgifs', 'niche', parts[1].toLowerCase(), { label: parts[1], url: url.href });
    return null; // single-gif links are handled by resolvers, not as feeds
  }

  if (h === 't.me' || h === 'telegram.me' || h === 'telegram.dog') {
    const name = parts[0] === 's' ? parts[1] : parts[0];
    // invite links (+abc / joinchat) and bare numeric message links are not channels we can follow
    if (name && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name) && name.toLowerCase() !== 'joinchat') return out('telegram', 'user', name, { label: `t.me/${name}`, url: `https://t.me/${name}` });
    return { platform: 'external', kind: 'link', target: url.href, ingestable: false, external: true, label: 'Telegram', service: 'Telegram', url: url.href };
  }

  if (matches(h, 'tumblr.com')) {
    if (h === 'tumblr.com') { // www.tumblr.com/…
      if (parts[0] === 'tagged' && parts[1]) { const tag = tumblrTag(parts[1]); return tag ? out('tumblr', 'tag', tag.toLowerCase(), { label: `#${tag} (Tumblr)`, url: url.href }) : null; }
      const name = parts[0] === 'blog' ? (parts[1] === 'view' ? parts[2] : parts[1]) : parts[0];
      if (name && !TUMBLR_PAGES.has(name.toLowerCase()) && TUMBLR_NAME.test(name)) return out('tumblr', 'user', name.toLowerCase(), { label: `${name} (Tumblr)`, url: `https://${name.toLowerCase()}.tumblr.com` });
      return null;
    }
    const blog = h.replace(/\.tumblr\.com$/, '');
    if (blog.includes('.') || TUMBLR_HOSTS.has(blog) || !TUMBLR_NAME.test(blog)) return null; // media CDN and asset hosts
    if (parts[0] === 'tagged' && parts[1]) { const tag = tumblrTag(parts[1]); return tag ? out('tumblr', 'tag', `${tag.toLowerCase()}@${blog}`, { label: `#${tag} on ${blog} (Tumblr)`, url: url.href }) : null; }
    return out('tumblr', 'user', blog, { label: `${blog} (Tumblr)`, url: `https://${blog}.tumblr.com` });
  }

  for (const lb of LINKINBIO) {
    if (matches(h, lb)) return { platform: 'linkinbio', kind: 'page', target: url.href, ingestable: true, label: `${h}${url.pathname}`.replace(/\/$/, ''), url: url.href };
  }

  // OnlyFans: one canonical link per person (campaign / post links collapse to the profile); site pages are not links.
  if (matches(h, 'onlyfans.com')) {
    const handle = ofHandle(url.href);
    if (!handle) return null;
    return { platform: 'external', kind: 'link', target: `https://onlyfans.com/${handle}`, ingestable: false, external: true, label: `OnlyFans · ${handle}`, service: 'OnlyFans', url: `https://onlyfans.com/${handle}`, handle };
  }

  for (const [dom, label] of Object.entries(EXTERNAL)) {
    if (matches(h, dom)) {
      return { platform: 'external', kind: 'link', target: url.href, ingestable: false, external: true, label: `${label}${parts[0] ? ` · ${parts[0].replace(/^@/, '')}` : ''}`, service: label, url: url.href };
    }
  }

  // Fediverse: /@user  or /users/user
  if (!NOT_MASTODON_HOSTS.some((d) => matches(h, d))) {
    if (parts[0] && /^@[A-Za-z0-9_.-]+$/.test(parts[0]) && parts.length === 1) {
      const user = parts[0].slice(1);
      if (isMisskeyHost(h)) return out('misskey', 'user', `${user}@${h}`, { label: `@${user}@${h}`, url: url.href });
      return out('mastodon', 'user', `${user}@${h}`, { label: `@${user}@${h}`, url: url.href });
    }
    if (parts[0] === 'users' && parts[1] && parts.length === 2) {
      return out('mastodon', 'user', `${parts[1]}@${h}`, { label: `@${parts[1]}@${h}`, url: url.href });
    }
    // PeerTube: /a/<account>, /accounts/<account>, /c/<channel>/videos, /video-channels/<channel>
    // (a bare /c/<name> is Lemmy unless the host is a known PeerTube server).
    if ((parts[0] === 'a' || parts[0] === 'accounts') && parts[1] && /^[A-Za-z0-9_.@-]+$/.test(parts[1])) {
      const acct = parts[1].includes('@') ? parts[1] : `${parts[1]}@${h}`;
      return out('peertube', 'user', acct.toLowerCase(), { label: `${acct.toLowerCase()} (PeerTube)`, url: url.href });
    }
    if (((parts[0] === 'c' && (parts.length >= 3 || isPeertubeHost(h))) || parts[0] === 'video-channels') && parts[1] && /^[A-Za-z0-9_.@-]+$/.test(parts[1])) {
      const chan = parts[1].includes('@') ? parts[1] : `${parts[1]}@${h}`;
      return out('peertube', 'channel', chan.toLowerCase(), { label: `${chan.toLowerCase()} (PeerTube channel)`, url: url.href });
    }
    // Lemmy: /c/community@instance or /c/community, /u/user
    if (parts[0] === 'c' && parts[1] && !matches(h, 'youtube.com')) {
      const [name, inst] = parts[1].split('@');
      return out('lemmy', 'community', `${name}@${inst || h}`, { label: `c/${name}@${inst || h}`, url: url.href });
    }
  }

  // Feeds
  if (/\.(rss|atom|xml)$/i.test(url.pathname) || /\/(feed|rss|atom)(\.xml)?\/?$/i.test(url.pathname) || /\.json$/i.test(url.pathname) && /feed/i.test(url.pathname)) {
    return out('rss', 'feed', url.href, { label: h + url.pathname, url: url.href });
  }

  // Anything else is a web page we can try to read media from.
  return { platform: 'web', kind: 'page', target: url.href, ingestable: true, label: h + (url.pathname === '/' ? '' : url.pathname), url: url.href };
}

/** Pull every parseable profile link out of free text (bios, link pages). */
function extractLinks(text) {
  const found = [];
  const seen = new Set();
  // Full URLs, plus the bare "onlyfans.com/name" / "linktr.ee/name" people type into bios.
  const urlRe = /(?:https?:\/\/|www\.)[^\s<>"')\]]+|(?<![\w./@-])(?:onlyfans\.com|fansly\.com|justfor\.fans|linktr\.ee|allmylinks\.com|beacons\.ai)\/[^\s<>"')\]]+/gi;
  for (const u of String(text || '').match(urlRe) || []) {
    const p = parseProfile(u);
    if (!p) continue;
    const key = `${p.platform}:${p.kind}:${String(p.target).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(p);
  }
  return found;
}

function profileUrl(platform, kind, target) {
  switch (platform) {
    case 'reddit': return kind === 'community' ? `https://www.reddit.com/r/${target}` : `https://www.reddit.com/user/${target}`;
    case 'x': return `https://x.com/${target}`;
    case 'bluesky': {
      const m = String(target).match(/^at:\/\/([^/]+)\/app\.bsky\.(feed\.generator|graph\.list)\/(.+)$/);
      if (m) return `https://bsky.app/profile/${m[1]}/${m[2] === 'feed.generator' ? 'feed' : 'lists'}/${m[3]}`;
      return `https://bsky.app/profile/${target}`;
    }
    case 'misskey': { const [u, i] = String(target).split('@'); return i ? `https://${i}/@${u}` : null; }
    case 'redgifs': return kind === 'niche' ? `https://www.redgifs.com/niches/${target}` : `https://www.redgifs.com/users/${target}`;
    case 'telegram': return `https://t.me/${target}`;
    case 'mastodon': { const [u, i] = String(target).split('@'); return i ? `https://${i}/@${u}` : null; }
    case 'lemmy': { const [c, i] = String(target).split('@'); return i ? `https://${i}/c/${c}` : null; }
    case 'peertube': {
      const [n, i] = String(target).split('@');
      if (!i) return null;
      return kind === 'channel' ? `https://${i}/c/${n}` : kind === 'user' ? `https://${i}/a/${n}` : null;
    }
    case 'tumblr': {
      const base = (b) => (/^https?:/i.test(b) ? b : /\./.test(b) ? `https://${b}` : `https://${b}.tumblr.com`);
      if (kind === 'tag') { const [tag, blog] = String(target).split('@'); return blog ? `${base(blog)}/tagged/${encodeURIComponent(tag).replace(/%20/g, '+')}` : `https://www.tumblr.com/tagged/${encodeURIComponent(tag).replace(/%20/g, '+')}`; }
      return base(String(target));
    }
    case 'rss': case 'web': case 'linkinbio': return /^https?:/.test(target) ? target : null;
    default: return null;
  }
}

module.exports = { parseProfile, extractLinks, profileUrl, isMisskeyHost, isPeertubeHost, EXTERNAL, LINKINBIO };
