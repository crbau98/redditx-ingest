/**
 * Which picture a grid card should download.
 *
 * Grids carry two builds of a post: `thumb_url`, a ~360px WebP made by engine/thumbs.js (about 10-20 KB), and the
 * platform's own `preview_url` / `thumbnail_url` (typically 40-100 KB and up). The card used to offer them as a
 * 1x / 2x pair, so every 2x phone screen took the big one even though a phone column is ~170 CSS px wide
 * (340 device px), which the 360px thumbnail already fills.
 *
 * Now the card takes the thumbnail whenever it covers the slot at up to 2x density, and the preview only where the
 * thumbnail would have to be stretched (a one-column layout, a large desktop rail on a 2x screen). Density is capped
 * at 2x on purpose: a 3x phone shows a 2x grid picture as sharp as a 2x phone does, and the bytes are not worth it.
 *
 * Pure functions (no DOM reads) so they can be tested on their own.
 */

/** Width of the thumbnails engine/thumbs.js writes. */
export const THUMB_PX = 360;
/** A picture shown up to ~15% larger than its pixels is not visibly softer: the thumbnail covers slots up to this many device px. */
export const THUMB_FIT_PX = Math.round(THUMB_PX * 1.15);
/** Pixel density the grid asks for at most. */
export const DENSITY_CAP = 2;
/** `.rail .card { width: clamp(168px, 22vw, 240px) }` (css/app.css). */
export const railWidth = (viewportWidth) => Math.min(240, Math.max(168, Math.round(viewportWidth * 0.22)));

/**
 * The URL a card's <img> should load, or null when the post has no still to show.
 * @param item     the media row from the API
 * @param proxy    maps a source URL to the URL the browser may load (dom.js `proxied`)
 * @param width    the CSS width the card is laid out at (masonry columns), or 0 for a rail card
 * @param viewport the window's inner width, used for rail cards
 * @param dpr      the screen's device pixel ratio
 * @param isVideo  a video has no usable media_url as a still
 */
export function cardImage(item, { proxy, width = 0, viewport = 390, dpr = 1, isVideo = false }) {
  const large = item.preview_url || item.thumbnail_url || (!isVideo ? item.media_url : null);
  if (!item.thumb_url) return { src: large ? proxy(large) : null, fallback: null };
  const slot = (width > 0 ? width : railWidth(viewport)) * Math.min(Math.max(dpr, 1), DENSITY_CAP);
  // The thumbnail is the first try; when it 404s (store row without a stored build, expired object-store
  // key) the card falls back to the platform preview instead of leaving a blank tile (see components/card.js).
  if (slot <= THUMB_FIT_PX || !large) return { src: proxy(item.thumb_url), fallback: large ? proxy(large) : null };
  return { src: proxy(large), fallback: null };
}

export function stillChain(item) {
  if (!item) return [];
  const urls = [item.thumb_url, item.preview_url, item.thumbnail_url];
  if (item.media_type === 'image') urls.push(item.media_url);
  const out = [];
  for (const u of urls) if (u && !out.includes(u)) out.push(u);
  return out;
}

/**
 * The pictures to fall back through when an image post's file (or one of its stills) cannot be shown, best first: the platform
 * preview, the platform thumbnail, our 360px thumbnail, and last the file itself. The file is an UPGRADE over these, never a
 * replacement: when it fails (error, 404, or a host's "not found" stub picture) one of the stills stays on screen, and "no
 * longer available" is for a post where every one of them failed. A signed preview URL (Reddit's `s=` is tied to its width) is
 * used exactly as stored, never rewritten to another width.
 */
export function fallbackStills(item) {
  if (!item) return [];
  const urls = [item.preview_url, item.thumbnail_url, item.thumb_url];
  if (item.media_type === 'image') urls.push(item.media_url);
  const out = [];
  for (const u of urls) if (u && !out.includes(u)) out.push(u);
  return out;
}

/**
 * The small picture of a post for tiles that are a few dozen CSS px wide (the viewer's filmstrip and dock, related rails,
 * its blurred backdrop, the video poster, a Reels poster, the search strip): the thumbnail when there is one, else the
 * platform preview. Posts that came from a grid have already downloaded their thumbnail, so these tiles then cost no request at all.
 */
export function tileImage(item) {
  return stillChain(item)[0] || null;
}

/**
 * A video with no still at all (no thumb, preview or thumbnail: no poster pattern exists for its source) shows its own first
 * frame instead of a blank tile: the clip loaded with preload=metadata at #t=0.1 (a media fragment, so Safari paints that frame
 * too). No canvas, so no CORS read of the pixels. HLS playlists cannot play in a bare <video> on most browsers: none.
 * @returns {string|null} the src to give a muted, paused <video>, or null when the item has a still or cannot do this
 */
export function firstFrameSrc(item, proxy) {
  if (!item || item.media_type !== 'video' || stillChain(item).length) return null;
  const url = item.media_url;
  if (!url || /\.m3u8(\?|#|$)/i.test(url)) return null;
  return `${proxy(url)}#t=0.1`;
}
