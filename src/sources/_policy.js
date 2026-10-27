'use strict';
/**
 * Hard deny layer. Public, creator-published, non-access-controlled content only.
 * Checked BEFORE any network call, before any subprocess spawn, before any
 * lead or profile link is written. This is a policy floor, not a preference.
 */

/** Subscription platforms. Reading them means circumventing access control. */
const PAYWALL_HOSTS = [
  'onlyfans.com', 'onlyfans.me', 'of.tc',
  'patreon.com', 'patreonusercontent.com',
  'manyvids.com', 'mvsdn.com',
  'iwantclips.com', 'iwantempire.com',
  'loyalfans.com', 'fancentro.com', 'fanvue.com',
  'avnstars.com', 'admireme.vip', 'unlockd.me',
  'scrileconnect.com', 'friendsonly.me', 'unfiltrd.com',
];

/** Leak / scrape-mirror aggregators. Never a source, never a lead, never a link. */
const LEAK_HOSTS = [
  'bunkr.si', 'bunkr.ru', 'bunkrr.su', 'cyberdrop.me',
  'nudostar.com', 'nudostar.tv', 'dirtyship.com',
  'pornleaks.in', 'onlyfansleaks.io', 'ofleaks.cc',
];

const PAYWALL_SET = new Set(PAYWALL_HOSTS);
const DENY_HOSTS = new Set([...PAYWALL_HOSTS, ...LEAK_HOSTS]);

/**
 * Extractor ALLOWLIST. Only these may be handed to yt-dlp/gallery-dl.
 * Criteria: free public pages, creator-published, no account required to view.
 * Unknown host => refused. Extend with EXTRACTOR_ALLOWLIST_EXTRA if you own the call.
 */
const EXTRACTOR_ALLOW = new Set([
  'youtube.com', 'youtu.be', 'm.youtube.com',
  'vimeo.com', 'dailymotion.com', 'rumble.com', 'odysee.com',
  'twitch.tv', 'clips.twitch.tv',
  'peertube.tv', 'tilvids.com',
  'bsky.app',
  'x.com', 'twitter.com',
  'tumblr.com',
  'reddit.com', 'old.reddit.com', 'v.redd.it', 'i.redd.it',
  'redgifs.com',
  'imgur.com', 'i.imgur.com',
  'flickr.com', 'soundcloud.com',
  'pornhub.com', 'xvideos.com', 'xhamster.com', 'spankbang.com',
  'thisvid.com', 'boyfriendtv.com', 'gaymaletube.com', 'eporner.com',
]);

function normHost(input) {
  try {
    const s = String(input);
    const u = s.includes('://') ? new URL(s) : new URL(`https://${s}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

/** Registrable-suffix match: foo.bar.onlyfans.com is denied by onlyfans.com. */
function hostMatches(host, set) {
  if (!host) return false;
  if (set.has(host)) return true;
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/** @returns {{denied:boolean, reason?:string, host?:string}} */
function checkUrl(url) {
  const host = normHost(url);
  if (!host) return { denied: true, reason: 'unparseable-url' };
  if (hostMatches(host, DENY_HOSTS)) {
    return { denied: true, reason: hostMatches(host, PAYWALL_SET) ? 'paywall' : 'leak-aggregator', host };
  }
  return { denied: false, host };
}

function isDenied(url) { return checkUrl(url).denied; }

function extractorAllowed(url) {
  const c = checkUrl(url);
  if (c.denied) return { allowed: false, reason: c.reason, host: c.host };
  const extra = String(process.env.EXTRACTOR_ALLOWLIST_EXTRA || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allow = extra.length ? new Set([...EXTRACTOR_ALLOW, ...extra]) : EXTRACTOR_ALLOW;
  if (!hostMatches(c.host, allow)) return { allowed: false, reason: 'not-on-allowlist', host: c.host };
  return { allowed: true, host: c.host };
}

/** Strip denied links from free text so a denied domain never lands in the DB. */
function scrubText(text, max = 2000) {
  if (!text) return '';
  return String(text).slice(0, max)
    .replace(/https?:\/\/[^\s<>"')]+/gi, (m) => (isDenied(m) ? '[removed]' : m));
}

module.exports = {
  PAYWALL_HOSTS, LEAK_HOSTS, DENY_HOSTS, EXTRACTOR_ALLOW,
  normHost, hostMatches, checkUrl, isDenied, extractorAllowed, scrubText,
};
