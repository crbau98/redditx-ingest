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
 * Not listed, because they could not be verified from here: preview.redd.it (403 to every request tried),
 * video.twimg.com, n1-n4.coomer.st, v.redd.it, gfycat, anything on gff.network or phncdn.com (those need a Referer).
 *
 * `video: true` hosts may also serve <video> and <source> files. Everything else is images only.
 *
 * DIRECT_MEDIA=0 puts everything back through the proxy (the list comes out empty, the CSP stays 'self').
 */
const HOSTS = [
  { host: 'i.redd.it' },
  { host: 'i.imgur.com' },
  { host: 'cdn.bsky.app' },
  { host: 'pbs.twimg.com' },
  { host: 'img.coomer.st' },
  { host: 'media.redgifs.com', video: true },
];

const enabled = () => String(process.env.DIRECT_MEDIA ?? '1').trim() !== '0';

/** What the client needs: hosts for pictures, and the subset that may also serve video. Empty when switched off. */
function clientConfig() {
  if (!enabled()) return { enabled: false, images: [], video: [] };
  return { enabled: true, images: HOSTS.map((h) => h.host), video: HOSTS.filter((h) => h.video).map((h) => h.host) };
}

/** Exact origins for the CSP, never wildcards. */
function cspSources() {
  const c = clientConfig();
  return { img: c.images.map((h) => `https://${h}`), media: c.video.map((h) => `https://${h}`) };
}

module.exports = { HOSTS, enabled, clientConfig, cspSources };
