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

function startPreview(media, item) {
  if (!prefs.previews) return;
  if (media.querySelector('video') || !item.media_url || /\.m3u8(\?|$)/i.test(item.media_url)) return;
  while (live.size >= MAX_LIVE) stopPreview([...live][0]);
  const v = h('video', { muted: true, loop: true, playsinline: true, preload: 'metadata', 'aria-hidden': 'true', tabindex: '-1' });
  v.muted = true;
  v.src = proxied(item.media_url);
  v.addEventListener('playing', () => { v.style.opacity = 1; }, { once: true });
  v.style.opacity = 0;
  v.style.transition = 'opacity .25s';
  media.appendChild(v);
  live.add(media);
  v.play().catch(() => stopPreview(media));
}

function stopPreview(media) {
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

/** One media card. `open(item)` is called when the media is activated. */
// The first few cards a page renders are above the fold: load them eagerly at high priority so the
// largest paint is not held back by lazy-loading heuristics. The router re-arms this per page.
let eagerLeft = 0;
export function primeEager(n = 6) { eagerLeft = n; }

export function mediaCard(item, { open, compact = false, why = null } = {}) {
  const ratio = item.width && item.height ? Math.min(Math.max(item.width / item.height, 0.55), 1.9) : 0.8;
  const isVideo = item.media_type === 'video';
  const src = item.preview_url || item.thumbnail_url || (!isVideo ? item.media_url : null);

  const here = parse();
  const media = h('a', { class: 'card-media', href: href(here.path, { ...Object.fromEntries(here.query), m: item.id }), style: { aspectRatio: String(ratio) }, 'aria-label': item.title || 'Open media' });
  media._item = item;
  // Placeholder tinted per item, so a loading grid reads as colour rather than grey boxes.
  let hue = 0; for (let i = 0; i < 8 && i < item.id.length; i++) hue = (hue * 31 + item.id.charCodeAt(i)) % 360;
  media.appendChild(h('div', { class: 'ph', style: { '--h': String(hue) } }));
  if (src) {
    const eager = eagerLeft > 0 && eagerLeft--;
    const img = h('img', { class: 'loading', alt: item.title || '', loading: eager ? 'eager' : 'lazy', fetchpriority: eager ? 'high' : 'auto', decoding: 'async', src: proxied(src) });
    img.addEventListener('load', () => { img.classList.remove('loading'); });
    img.addEventListener('error', () => { img.remove(); reportBroken(item.id); });
    media.appendChild(img);
  }
  if (why) media.appendChild(h('span', { class: 'card-why', title: 'Why you are seeing this' }, icon('sparkle', 'sm'), why));
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
      media.addEventListener('mouseenter', () => startPreview(media, item));
      media.addEventListener('mouseleave', () => stopPreview(media));
    } else if (io) io.observe(media);
  }

  const fav = h('button', { class: `card-fav${favorites.has(item.id) ? ' on' : ''}`, 'aria-label': 'Save', 'aria-pressed': String(favorites.has(item.id)),
    onclick: (e) => {
      e.preventDefault(); e.stopPropagation();
      if (favorites.toggle(item.id, item)) { const r = e.currentTarget.getBoundingClientRect(); heartBurst(r.left + r.width / 2, r.top + r.height / 2); }
    } }, icon('heart'));
  const off = bus.on('fav', (d) => {
    if (!media.isConnected) { off(); return; }
    if (!d.id || d.id === item.id) { const on = favorites.has(item.id); fav.classList.toggle('on', on); fav.setAttribute('aria-pressed', String(on)); }
  });

  const card = h('article', { class: `card${compact ? ' compact' : ''}`, dataset: { id: item.id } }, media, fav);
  if (!compact) {
    card.appendChild(h('div', { class: 'card-foot' },
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
