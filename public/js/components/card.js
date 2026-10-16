import { reportBroken } from '../api.js';
import { h, icon, proxied, fmt, avatar } from '../dom.js';
import { favorites, history as viewHistory, prefs, platformLabel, platformColor, bus } from '../store.js';
import { parse, href } from '../router.js';
import { rememberFlip, heartBurst } from './fx.js';

/* ---- hover / in-view video previews ------------------------------------
 * Only a couple of <video> elements are ever alive at once, so a grid of
 * hundreds of clips costs almost nothing. Desktop: play on hover.
 * Touch: play when the card is mostly in view. */
const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const live = new Set();
const MAX_LIVE = 2;

// Touch previews (which start on their own) wait until the page has loaded and settled, so clips
// never compete with the first screen of images. None at all on data saver or a 2G/3G link.
const conn = navigator.connection || {};
const slowLink = () => conn.saveData || /(^|-)2g$|^3g$/.test(conn.effectiveType || '');
let previewsReady = false;
const pending = new Set();
const armPreviews = () => setTimeout(() => {
  previewsReady = true;
  for (const media of pending) if (media.isConnected) startPreview(media, media._item);
  pending.clear();
}, 1200);
if (document.readyState === 'complete') armPreviews(); else window.addEventListener('load', armPreviews, { once: true });

function startPreview(media, item) {
  if (!prefs.previews || slowLink()) return;
  if (!previewsReady && !canHover) { pending.add(media); return; } // a hover is explicit intent: no wait
  if (media.querySelector('video') || !item.media_url || /\.m3u8(\?|$)/i.test(item.media_url)) return;
  while (live.size >= MAX_LIVE) stopPreview([...live][0]);
  const v = h('video', { muted: true, loop: true, playsinline: true, preload: 'metadata', 'aria-hidden': 'true', tabindex: '-1' });
  v.muted = true;
  v.src = proxied(item.media_url);
  v.addEventListener('playing', () => { v.style.opacity = 1; }, { once: true });
  v.style.opacity = 0;
  v.style.transition = 'opacity var(--dur-base) var(--spring-settle)';
  media.appendChild(v);
  live.add(media);
  v.play().catch(() => stopPreview(media));
}

function stopPreview(media) {
  if (media._hoverTimer) { clearTimeout(media._hoverTimer); media._hoverTimer = 0; }
  pending.delete(media);
  const v = media.querySelector('video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
  live.delete(media);
}

const io = !canHover && 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const media = e.target;
      if (e.isIntersecting && e.intersectionRatio > 0.65) startPreview(media, media._item);
      else stopPreview(media);
    }
  }, { threshold: [0, 0.65, 1] })
  : null;

/* ---- off-screen media relief for deep masonry feeds ---------------------
 * Cards more than ~2.5 viewports away release decoded <img> bitmaps and any
 * lingering <video> element while keeping their exact aspect-ratio box and
 * dominant-color tint. Scrolling back restores src/srcset from HTTP cache. */
const reliefIo = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const media = e.target;
      if (!e.isIntersecting) {
        stopPreview(media);
        const img = media._img;
        if (img && media._loaded && !media._parked) {
          img.removeAttribute('src');
          if (media._srcset) img.removeAttribute('srcset');
          media._parked = true;
        }
      } else if (media._parked && media._img) {
        if (media._srcset) media._img.srcset = media._srcset;
        media._img.src = media._src;
        media._parked = false;
      }
    }
  }, { rootMargin: '2400px 0px', threshold: 0 })
  : null;

// One listener repaints the save buttons for every card on the page. (A listener per card was only
// dropped at the next save, so a long scroll session piled up thousands of them.)
bus.on('fav', (d) => {
  const sel = d && d.id ? `.card[data-id="${CSS.escape(d.id)}"] > .card-fav` : '.card > .card-fav';
  for (const b of document.querySelectorAll(sel)) {
    const on = favorites.has(b.parentElement.dataset.id);
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  }
});

/** Release any observers and active preview held for a card before removing or parking it. */
export function releaseCard(card) {
  const media = card && card._media;
  if (!media) return;
  stopPreview(media);
  if (io) io.unobserve(media);
  if (reliefIo) reliefIo.unobserve(media);
}

/** One media card. `open(item)` is called when the media is activated. */
// `eager: true` is only the first viewport row (one card per column). Everything else stays lazy
// at the default fetch priority so a long page does not compete with that first row.
export function mediaCard(item, { open, compact = false, why = null, eager = false } = {}) {
  const ratio = item.width && item.height ? Math.min(Math.max(item.width / item.height, 0.55), 1.9) : 0.8;
  const isVideo = item.media_type === 'video';
  // Grids load the small thumbnail build when it exists (engine/thumbs.js, ~360px WebP),
  // pairing it with the platform preview at 2x when distinct. The full file only loads in the viewer.
  const raw1x = item.thumb_url || item.preview_url || item.thumbnail_url || (!isVideo ? item.media_url : null);
  const raw2x = item.thumb_url ? (item.preview_url || item.thumbnail_url || null) : null;
  const src = raw1x ? proxied(raw1x) : null;
  const srcset = src && raw2x && raw2x !== raw1x ? `${src} 1x, ${proxied(raw2x)} 2x` : null;

  const here = parse();
  const media = h('a', { class: 'card-media', href: href(here.path, { ...Object.fromEntries(here.query), m: item.id }), style: { aspectRatio: String(ratio) }, 'aria-label': item.title || 'Open media' });
  media._item = item;
  // Placeholder tinted per item, so a loading grid reads as colour rather than grey boxes.
  // When the server measured a dominant colour (engine/thumbs.js), use it directly.
  let hue = 0; for (let i = 0; i < 8 && i < item.id.length; i++) hue = (hue * 31 + item.id.charCodeAt(i)) % 360;
  const ph = h('div', { class: 'ph', style: item.tint && /^#[0-9a-f]{6}$/i.test(item.tint) ? { background: item.tint } : { '--h': String(hue) } });
  media.appendChild(ph);
  if (src) {
    const img = h('img', { class: 'loading', alt: item.title || '', loading: eager ? 'eager' : 'lazy', fetchpriority: eager ? 'high' : 'auto', decoding: 'async', src, srcset });
    media._img = img; media._src = src; media._srcset = srcset;
    // The placeholder's shimmer stops as soon as the image is in: a grid of finished cards must not
    // keep animating underneath (it repainted every visible card, every frame, forever).
    img.addEventListener('load', () => { media._loaded = true; img.classList.remove('loading'); ph.classList.add('done'); });
    img.addEventListener('error', () => { media._img = null; img.remove(); ph.classList.add('done'); reportBroken(item.id); });
    media.appendChild(img);
    if (reliefIo) reliefIo.observe(media);
  } else ph.classList.add('done');
  // On full cards the "why" chip rides in the caption over the image; compact cards keep it on the media.
  const whyChip = why ? h('span', { class: 'card-why', title: 'Why you are seeing this' }, icon('sparkle', 'sm'), why) : null;
  if (whyChip && compact) media.appendChild(whyChip);
  media.appendChild(h('div', { class: 'card-badges' },
    isVideo ? h('span', { class: 'pill' }, icon('play', 'fill'), item.duration ? fmt.duration(item.duration) : 'Video') : null,
    item.nsfw_level === 'suggestive' ? h('span', { class: 'pill' }, 'Suggestive') : null,
    viewHistory.has(item.id) ? h('span', { class: 'pill seen', title: 'You opened this before' }, icon('eye', 'sm'), 'Seen') : null));
  media.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    rememberFlip(media);
    open && open(item);
  });
  if (isVideo) {
    if (canHover) {
      media.addEventListener('mouseenter', () => {
        clearTimeout(media._hoverTimer);
        media._hoverTimer = setTimeout(() => startPreview(media, item), 65);
      });
      media.addEventListener('mouseleave', () => stopPreview(media));
    } else if (io) io.observe(media);
  }

  const fav = h('button', { class: `card-fav${favorites.has(item.id) ? ' on' : ''}`, 'aria-label': 'Save', 'aria-pressed': String(favorites.has(item.id)),
    onclick: (e) => {
      e.preventDefault(); e.stopPropagation();
      if (favorites.toggle(item.id, item)) { const r = e.currentTarget.getBoundingClientRect(); heartBurst(r.left + r.width / 2, r.top + r.height / 2); }
    } }, icon('heart'));

  const card = h('article', { class: `card${compact ? ' compact' : ''}`, dataset: { id: item.id } }, media, fav);
  card._media = media;
  if (!compact) {
    card.appendChild(h('div', { class: 'card-foot' },
      whyChip,
      item.title ? h('div', { class: 'card-title' }, item.title) : null,
      h('div', { class: 'card-meta' },
        item.creator_id ? h('a', { href: href(`/creator/${item.creator_id}`), class: 'row', style: { gap: '6px', minWidth: 0 }, onclick: (e) => e.stopPropagation() }, avatar(item, 20), h('span', { class: 'truncate' }, item.creator_name || item.creator_handle || item.author)) : h('span', { class: 'truncate' }, item.author || ''),
        h('span', { class: 'grow' }),
        h('span', { class: 'badge plat', style: { '--c': platformColor(item.platform) } }, platformLabel(item.platform)))));
  }
  return card;
}

export function cardSkeletons(n = 8) {
  return Array.from({ length: n }, (_, i) => h('div', { class: 'skeleton', style: { height: `${180 + ((i * 53) % 160)}px`, borderRadius: '16px' } }));
}
