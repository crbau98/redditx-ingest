'use strict';
/**
 * Leaked paid content stays out of PRISM, whatever source it reaches us through.
 *
 * Reposts of a creator's PUBLIC posts are welcome from any page (fan accounts, Tumblr reblogs, X reposts, blogs).
 * What is refused is paid content taken from behind a paywall:
 *   - leak and tube-rip sites, and the file hosts leak posts point to: an item whose media, permalink, preview or any
 *     link in its text lives on one of them is dropped before anything is downloaded, and such pages are never followed
 *     as sources (lib/links.js) or kept as creator links;
 *   - posts that advertise themselves as leaks ("OF leak", "leaked onlyfans", "mega pack", "DM for links").
 *
 * GayForFans and its family (FetishForFans, GFFShorts, the adultcdn.media host) repost male creators' paid videos
 * without consent, so they head the list. Admins add more domains in Settings → Sources ("Extra leak domains").
 * The face-identity thread (A4 web sweep) uses the same checks, so one list governs both.
 */

const LEAK_DOMAINS = [
  // GayForFans family
  'gayforfans.com', 'fetishforfans.com', 'gffshorts.com', 'adultcdn.media',
  // OnlyFans / Fansly / Patreon leak mirrors and archives
  'coomer.su', 'coomer.party', 'coomer.st', 'kemono.su', 'kemono.party', 'kemono.cr',
  'fapello.com', 'fapello.su', 'fapopedia.net', 'fapodrop.com', 'fapellas.com', 'leakedzone.com', 'leakedmodels.com',
  'thothub.to', 'thothub.tv', 'thothub.lol', 'thotsbay.com', 'thotsbay.tv', 'thotslife.com', 'thotporn.tv',
  'nudostar.com', 'nudostar.tv', 'onlyfansleaks.com', 'leaks.pics', 'leakimages.com', 'influencersgonewild.com',
  'onlyleaks.co', 'leakedbb.com', 'hotleak.vip', 'hotleaks.tv', 'xleaks.org', 'leakgallery.com', 'fanleaks.club',
  'erothots.co', 'sxyprn.com', 'porntrex.com', 'gayleaks.com', 'gayofleaks.com', 'boyfriendtv.com', 'gaymaletube.com',
  'gayfans.net', 'onlygayvideo.com', 'gayforit.eu', 'gaystream.pw', 'gay0day.com', 'gaypornleaks.com',
  // Leak forums
  'simpcity.su', 'simpcity.cr', 'socialmediagirls.com', 'forums.socialmediagirls.com', 'planetsuzy.org',
  // File and video lockers leak posts link to
  'mega.nz', 'mega.io', 'mega.co.nz', 'gofile.io', 'pixeldrain.com', 'bunkr.si', 'bunkr.su', 'bunkr.ru', 'bunkr.la',
  'bunkr.is', 'bunkr.ac', 'bunkr.black', 'bunkrr.su', 'bunkr.cr', 'cyberdrop.me', 'cyberdrop.cc', 'saint.to', 'saint2.su',
  'turbo.cr', 'jpg.church', 'jpg5.su', 'jpg6.su', 'pixl.li', 'anonfiles.com', 'mediafire.com', 'krakenfiles.com',
  'doodstream.com', 'dood.wf', 'dood.la', 'dood.so', 'ds2play.com', 'streamtape.com', 'streamtape.to', 'vidoza.net',
  'filemoon.sx', 'k2s.cc', 'keep2share.cc', 'fboom.me', 'tezfiles.com', 'rapidgator.net', 'uploaded.net', 'nitroflare.com',
  'katfile.com', 'fikper.com', 'workupload.com', 'send.cm', 'sendvid.com',
];

// Words a leak post uses about itself. Whole words only ("leaking" is not a leak).
const LEAK_TEXT = [
  /\b(?:only\s*fans|onlyfans|fansly|justfor\.?fans|jff|patreon|manyvids|premium|paid|vip)\s*(?:content\s*)?(?:leak|leaks|leaked)\b/i,
  /\bOF\s*(?:leak|leaks|leaked)\b/,   // "OF" in capitals only: "a lot of leaks" is not about OnlyFans
  /\b(?:leak|leaks|leaked)\s*(?:only\s*fans|onlyfans|fansly|justfor\.?fans|jff|patreon|content|videos?|vids|pics|nudes|pack|folder|sex\s*tape)\b/i,
  /\b(?:leak|leaks|leaked)\s*(?:from\s*)?(?:his|my)?\s*OF\b/,
  /#(?:onlyfans|of|fansly|gay)?leaks?\b/i,
  /\bmega\s*(?:link|links|folder|pack|drive|collection)\b/i,
  /\b(?:dm|message|msg)\s*(?:me\s*)?for\s*(?:the\s*)?(?:mega|folder|leaks?|leaked|siterip)\b/i,
  /\b(?:paywall|onlyfans|fansly|justfor\.?fans)\s*bypass\b/i,
  /(?<!\bmy\s)\b(?:full|entire)\s*(?:onlyfans|of|fansly|justfor\.?fans|jff)\s*(?:pack|archive|siterip|rip|dump|folder|mega)\b/i,
  /\bsite\s*-?\s*rip\b/i,
];

const host = (h) => String(h || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
const matches = (h, d) => h === d || h.endsWith(`.${d}`);
const hostOfUrl = (u) => { try { return host(new URL(u).hostname); } catch { return ''; } };

let extraCache = { raw: null, list: [] };
/** Admin-added domains (Settings → Sources, one per line). */
function extraDomains() {
  let raw = '';
  try { raw = require('../settings').get().leakDomains || ''; } catch { return []; }
  if (raw === extraCache.raw) return extraCache.list;
  const list = String(raw).split(/[\s,]+/).map((d) => host(d.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  extraCache = { raw, list };
  return list;
}

/** Is this host (or a parent domain) a leak site, tube-rip or file locker? */
function isLeakHost(h) {
  const x = host(h);
  if (!x) return false;
  return LEAK_DOMAINS.some((d) => matches(x, d)) || extraDomains().some((d) => matches(x, d));
}

/** Is this URL on a leak site? */
function isLeakUrl(url) { return isLeakHost(hostOfUrl(url)); }

/** Does this text advertise leaked paid content? Returns the matched phrase, or null. */
function leakText(...parts) {
  const t = parts.flat(Infinity).filter((x) => typeof x === 'string' && x).join(' \n ');
  if (!t) return null;
  for (const re of LEAK_TEXT) { const m = re.exec(t); if (m) return m[0].trim().slice(0, 60); }
  for (const u of t.match(/(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b(?:mega\.nz|gofile\.io|pixeldrain\.com|bunkr\.[a-z]+|cyberdrop\.me)\/[^\s<>"')\]]+/gi) || []) {
    if (isLeakUrl(/^https?:/i.test(u) ? u : `https://${u}`)) return hostOfUrl(/^https?:/i.test(u) ? u : `https://${u}`);
  }
  return null;
}

/**
 * The pipeline's leak gate for one ingest item.
 * @returns {null | {rule: string}}  null = keep
 */
function checkItem(item) {
  for (const u of [item.mediaUrl, item.permalink, item.previewUrl, item.hlsUrl, ...(item.links || [])]) {
    if (typeof u === 'string' && u && isLeakUrl(u)) return { rule: `leak-site:${hostOfUrl(u)}` };
  }
  const phrase = leakText(item.title, item.text, item.altText, item.tags);
  return phrase ? { rule: `leak-text:${phrase}` } : null;
}

module.exports = { LEAK_DOMAINS, isLeakHost, isLeakUrl, leakText, checkItem };
