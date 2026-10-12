'use strict';
/**
 * URL-level media helpers: host classification, junk detection, normalisation.
 * (No network here — the engine decides when a probe is warranted.)
 */
const config = require('../config');
const { hostnameOf } = require('./net');

// Stock-photo / search / generic hosts that are never creator media.
const BLOCKED_HOSTS = [
  'shutterstock.com', 'gettyimages.com', 'istockphoto.com', 'unsplash.com', 'pexels.com',
  'pixabay.com', 'wikimedia.org', 'wikipedia.org', 'flickr.com', 'staticflickr.com',
  'alamy.com', 'dreamstime.com', 'depositphotos.com', 'adobe.com', 'freepik.com',
  'vectorstock.com', '123rf.com', 'giphy.com', 'tenor.com', 'youtube.com', 'youtu.be',
  'ytimg.com', 'vimeo.com', 'vimeocdn.com', 'tiktok.com', 'google.com', 'gstatic.com',
  'bing.com', 'bing.net', 'duckduckgo.com', 'placeholder.com', 'placehold.co',
  'placekitten.com', 'loremflickr.com', 'picsum.photos',
];

// CDNs that serve user media directly.
// Media we keep ourselves (Telegram downloads) lives in the object store under a reserved name that never resolves
// (config.storeHost; lib/net.js serves it straight from the bucket, so no DNS or third party is involved).
const STORE_HOST = config.storeHost;

const TRUSTED_HOSTS = [
  STORE_HOST,
  'redd.it', 'redditmedia.com', 'redditstatic.com', 'imgur.com', 'redgifs.com',
  'gfycat.com', 'twimg.com', 'bsky.app', 'bsky.social', 'bsky.network',
];

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v|m3u8)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|gifv)(\?|#|$)/i;

const hostOf = (url) => hostnameOf(url).replace(/^www\./, '');
const hostMatches = (h, d) => h === d || h.endsWith('.' + d);

function hostBlocked(h) { return !h || BLOCKED_HOSTS.some((d) => hostMatches(h, d)); }
function hostTrusted(h) { return !!h && TRUSTED_HOSTS.some((d) => hostMatches(h, d)); }
function looksLikeDirectMedia(url) { return MEDIA_EXT.test(String(url || '')); }
function looksLikeVideo(url) { return VIDEO_EXT.test(String(url || '')); }

function normalizeImgur(url) {
  try {
    const u = new URL(url);
    if (!hostMatches(u.hostname.toLowerCase(), 'imgur.com')) return url;
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    const first = parts[0] || '';
    if (/^(a|gallery|t|user|r)$/i.test(first)) return null; // albums need an API key now
    const id = first.replace(/\.[^.]+$/, '');
    if (!id) return null;
    if (/\.(gifv|mp4|webm)$/i.test(u.pathname)) return `https://i.imgur.com/${id}.mp4`;
    if (/\.[a-z0-9]{3,4}$/i.test(first)) return `https://i.imgur.com/${first}`;
    return `https://i.imgur.com/${id}.jpg`;
  } catch { return url; }
}

function normalizeMediaUrl(url) {
  if (!url) return null;
  return normalizeImgur(String(url).replace(/&amp;/g, '&'));
}

function isJunkTitle(title = '') {
  return /image you are requesting does not exist|no longer available|probably deleted|shutterstock|getty images|stock photo|royalty.?free/i.test(String(title));
}

/** Stable key for de-duplicating the same file seen via different posts. */
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Reddit preview/signature params and CDN cache-busters do not change the file.
    for (const k of [...u.searchParams.keys()]) {
      if (/^(s|v|width|format|auto|crop|ixlib|ixid|t|utm_.*|cb|cachebust|_)$/i.test(k)) u.searchParams.delete(k);
    }
    return `${u.hostname.toLowerCase()}${u.pathname}${u.search}`;
  } catch { return String(url); }
}

module.exports = {
  STORE_HOST, BLOCKED_HOSTS, TRUSTED_HOSTS, hostOf, hostMatches, hostBlocked, hostTrusted,
  looksLikeDirectMedia, looksLikeVideo, normalizeMediaUrl, normalizeImgur,
  isJunkTitle, canonicalUrl,
};
