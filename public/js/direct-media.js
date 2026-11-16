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
let storeHost = ''; // the reserved store host name while stored media is redirected to the bucket (cfg.store), else ''

/** Apply the server's list. Anything else (undefined, enabled:false) means "all through the proxy". */
export function configureDirectMedia(cfg) {
  const ok = cfg && cfg.enabled !== false && Array.isArray(cfg.images);
  images = new Set(ok ? cfg.images.map((h) => String(h).toLowerCase()) : []);
  video = new Set(ok && Array.isArray(cfg.video) ? cfg.video.map((h) => String(h).toLowerCase()) : []);
  storeHost = cfg && typeof cfg.store === 'string' ? cfg.store.toLowerCase() : ''; // independent of `enabled`: STORE_DIRECT has its own switch
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

/**
 * Will the browser end up on another origin for this src? True for a direct CDN URL, and for a same-origin /api/proxy URL of
 * stored media while the server redirects those to the bucket. Such a picture cannot be read back from a canvas (no CORS), so
 * the colour and backdrop readers skip it instead of downloading it for nothing. (Not for the error fallback: a proxy URL is
 * already the fallback, so isDirectSrc stays false for it.)
 */
export function isCrossOriginSrc(src) {
  if (isDirectSrc(src)) return true;
  if (!storeHost || typeof src !== 'string' || !src.startsWith('/api/proxy?')) return false;
  const q = new URLSearchParams(src.slice('/api/proxy?'.length));
  if (q.get('mark')) return false; // the watermarked download is always relayed
  try { return new URL(q.get('url') || '').hostname.toLowerCase() === storeHost; } catch { return false; }
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
  p.onload = () => { if (isMissingStub(src, p.naturalWidth, p.naturalHeight)) p.onerror(); }; // a "found" picture that is the host's 404 stub
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

/**
 * i.redd.it answers a missing file with status 404 and a 130x60 PNG body (1048 bytes). An <img> treats that as a good
 * load, so no error fires and the tile would show the stub instead of falling back. Through the proxy the same 404 became
 * JSON, which did fire. A direct i.redd.it picture of exactly that size is therefore handled as a failed load.
 * (Probed 2026-11-16: no other listed host answers a missing file with an image.)
 */
export function isMissingStub(src, width, height) {
  if (width !== 130 || height !== 60 || typeof src !== 'string') return false;
  try { return new URL(src).hostname.toLowerCase() === 'i.redd.it'; } catch { return false; }
}
