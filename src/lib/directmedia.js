'use strict';
/**
 * Hosts the browser may load media from directly, without going through /api/proxy (which is Railway egress).
 *
 * The list is the single source: the Content-Security-Policy (src/app.js) and the client (/api/meta, public/js/dom.js)
 * both read it from here, so they cannot drift apart. A host is listed only after a live probe showed it serves
 * its files with no Referer (the app sends `Referrer-Policy: no-referrer`) and no blocking Cross-Origin-Resource-Policy.
 * Hosts that need a Referer, the object store, HLS (manifests and segments are rewritten by the proxy) and the
 * watermarked download all stay on the proxy, as does any host not listed.
 *
 * Probe, 2026-11-16, from a server network, one image or clip per host, no Referer vs a foreign Referer:
 *   i.redd.it          200/200  images              cdn.bsky.app     200/200  images and avatars
 *   i.imgur.com        200/200  images              pbs.twimg.com    200/200  images (CORP cross-origin)
 *   img.coomer.st      200/200  icons, banners      media.redgifs.com 200/403 (blocks a foreign Referer, serves none): video OK
 *   preview.redd.it, cf.preview.redd.it  200 with no Referer: 14 of 14 live URLs from prod's own data, in curl and in Chromium as
 *                      <img referrerpolicy=no-referrer> (re-probed 2026-11-16; the first probe's 403 came from Reddit's listing API).
 *                      A missing or badly signed URL answers 403 with an HTML body, so a failed load still fires onerror.
 * Not listed, because they could not be verified from here: video.twimg.com, n1-n4.coomer.st, v.redd.it, gfycat, anything on gff.network or phncdn.com (those need a Referer).
 *
 * `video: true` hosts may also serve <video> and <source> files. Everything else is images only.
 *
 * DIRECT_MEDIA=0 puts everything back through the proxy (the list comes out empty, the CSP stays 'self').
 */
const HOSTS = [
  { host: 'i.redd.it' },
  { host: 'preview.redd.it' },
  { host: 'cf.preview.redd.it' },
  { host: 'i.imgur.com' },
  { host: 'cdn.bsky.app' },
  { host: 'pbs.twimg.com' },
  { host: 'img.coomer.st' },
  { host: 'media.redgifs.com', video: true },
];

const enabled = () => String(process.env.DIRECT_MEDIA ?? '1').trim() !== '0';

/**
 * Stored media (config.storeHost, S3 mode) is a second direct source: /api/proxy answers it with a redirect to a presigned
 * bucket URL (lib/objectstore.directUrl). Its origin is the one extra source in the CSP. STORE_DIRECT=0 switches it off
 * independently of DIRECT_MEDIA.
 */
const storeOrigin = () => require('./objectstore').directOrigin();

/**
 * What the client needs: hosts for pictures, the subset that may also serve video, and `store` (the reserved store host name
 * when stored media is redirected to the bucket, else false; the client uses it to skip pixel reads of such pictures).
 * `images`/`video` are empty when DIRECT_MEDIA=0.
 */
function clientConfig() {
  const store = storeOrigin() ? require('../config').storeHost : false;
  if (!enabled()) return { enabled: false, images: [], video: [], store };
  return { enabled: true, images: HOSTS.map((h) => h.host), video: HOSTS.filter((h) => h.video).map((h) => h.host), store };
}

/**
 * Exact origins for the CSP, never wildcards. The bucket origin is added to img-src and media-src (the redirect lands there) and
 * to connect-src: with offline content on, the service worker re-fetches pictures itself and that fetch follows the redirect.
 */
function cspSources() {
  const c = clientConfig();
  const bucket = storeOrigin();
  return { img: [...c.images.map((h) => `https://${h}`), ...(bucket ? [bucket] : [])], media: [...c.video.map((h) => `https://${h}`), ...(bucket ? [bucket] : [])], connect: bucket ? [bucket] : [] };
}

module.exports = { HOSTS, enabled, clientConfig, cspSources, storeOrigin };
