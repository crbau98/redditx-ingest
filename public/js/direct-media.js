/**
 * Which remote media the browser loads straight from its CDN instead of through /api/proxy (Railway egress).
 * No DOM and no imports, so it can be tested under node.
 *
 * The host lists come from the server (/api/meta -> directMedia, the same constant the Content-Security-Policy is built
 * from), so the page never tries a host the CSP would refuse. Until the list arrives, or when the server sends none
 * (DIRECT_MEDIA=0), every URL goes through the proxy exactly as before.
 *
 *   images   hosts for pictures
 *   video    the subset that may also serve video files (.mp4, .webm, …)
 *
 * Never direct: a playlist (.m3u8; the proxy rewrites its segments), http, a host not on the list, a same-origin path.
 */

const VIDEO_FILE = /\.(mp4|webm|mov|m4v|gifv)(?:[?#]|$)/i;
const PLAYLIST = /\.m3u8(?:[?#]|$)/i;

let images = new Set();
let video = new Set();

/** Apply the server's list. Anything else (undefined, enabled:false) means "all through the proxy". */
export function configureDirectMedia(cfg) {
  const ok = cfg && cfg.enabled !== false && Array.isArray(cfg.images);
  images = new Set(ok ? cfg.images.map((h) => String(h).toLowerCase()) : []);
  video = new Set(ok && Array.isArray(cfg.video) ? cfg.video.map((h) => String(h).toLowerCase()) : []);
}

export const proxyUrl = (url) => `/api/proxy?url=${encodeURIComponent(url)}`;

/** May this absolute URL be loaded directly? */
export function directAllowed(url) {
  if (!images.size || typeof url !== 'string' || !url.startsWith('https://')) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password || u.port) return false; // default port only: the CSP source has no port, so :8443 would be blocked
  const host = u.hostname.toLowerCase();
  if (!images.has(host)) return false;
  const path = u.pathname + u.search;
  if (PLAYLIST.test(path)) return false;
  if (VIDEO_FILE.test(u.pathname) && !video.has(host)) return false;
  return true;
}

/** The URL to put in a src: the direct one when allowed, otherwise the proxy. Local paths pass through. */
export function mediaSrc(url) {
  if (!url) return '';
  if (url.startsWith('/') || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return directAllowed(url) ? url : proxyUrl(url);
}

/** Is this src a direct one (so a failure may be retried through the proxy)? */
export const isDirectSrc = (src) => directAllowed(src);

/** The same-origin URL for a direct src, for the one retry and for downloads that need the server (watermark). */
export const viaProxy = (srcOrUrl) => (srcOrUrl && srcOrUrl.startsWith('/') ? srcOrUrl : proxyUrl(srcOrUrl));

/**
 * Load a picture to see whether it works. If the URL was direct and fails, try the proxy once: `onProxy(proxyUrl)` says
 * the proxy worked (the caller swaps to it), `onFail()` that nothing did.
 */
export function probeImage(src, onFail, onProxy) {
  const p = new Image();
  p.onerror = () => {
    if (!isDirectSrc(src)) { onFail && onFail(); return; }
    const alt = viaProxy(src);
    const q = new Image();
    q.onload = () => onProxy && onProxy(alt);
    q.onerror = () => onFail && onFail();
    q.src = alt;
  };
  p.src = src;
}
