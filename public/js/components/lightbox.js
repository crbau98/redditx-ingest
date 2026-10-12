import { h, icon, proxied, fmt, avatar, toast, copyText, openModal } from '../dom.js';
import { get, post } from '../api.js';
import { favorites, follows, prefs, history as viewHistory, tastes, collections, platformLabel, platformColor, bus } from '../store.js';
import { parse, href, setParam } from '../router.js';
import { openReport } from './report.js';
import { attachVideo, releaseVideo, isM3u8 } from './video.js';
import { openCollectionPicker } from './collections.js';
import { playFlip, heartBurst } from './fx.js';
import { makeZoomable } from './zoom.js';

let S = null; // the single active lightbox session
const viewed = new Set();
const relCache = new Map(); // media id -> related items

/* ------------------------------------------------------------------ public */
export function openLightbox(items, index, { loadMore } = {}) {
  if (S) { S.items = items; S.loadMore = loadMore; show(index); return; }
  start(items, loadMore);
  S.pushed = true;
  show(index, { push: true });
}

/** Call on every hashchange: opens/closes the viewer to match the `m` param. */
export function syncFromUrl() {
  const m = parse().query.get('m');
  if (!m) { if (S) destroy(); return; }
  if (S && S.items[S.index] && S.items[S.index].id === m) return;
  if (S) { const i = S.items.findIndex((x) => x.id === m); if (i >= 0) { show(i); return; } }
  openById(m);
}

export const isOpen = () => !!S;

async function openById(id) {
  if (!S) start([], null);
  S.loading = true; render();
  try {
    const item = await get(`/api/media/${id}`);
    const related = await get(`/api/media/${id}/related`, { limit: 24 }).catch(() => []);
    if (!S) return;
    S.items = [item, ...related];
    S.loading = false;
    show(0);
  } catch (e) {
    toast(e.status === 404 ? 'That item is no longer available' : e.message, 'err');
    if (S) destroy();
    setParam('m', null);
  }
}

/* ------------------------------------------------------------------- build */
function start(items, loadMore) {
  const root = document.getElementById('lightbox-root');
  S = { items, index: -1, loadMore, info: window.matchMedia('(min-width: 900px)').matches, root, video: null, pushed: false, loading: false };
  S.el = h('div', { class: 'lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media viewer' });
  S.top = h('div', { class: 'lb-top' });
  S.stage = h('div', { class: 'lb-stage' });
  // Ambient mode: a blurred, saturated copy of the current media glows behind it (two layers crossfade).
  S.amb = [h('div', { class: 'lb-ambient' }), h('div', { class: 'lb-ambient' })];
  S.ambIdx = 0;
  S.info$ = h('aside', { class: 'lb-info', 'aria-label': 'Details' });
  S.prev = h('button', { class: 'lb-nav prev', 'aria-label': 'Previous', onclick: () => nav(-1) }, icon('chev-l', 'lg'));
  S.next = h('button', { class: 'lb-nav next', 'aria-label': 'Next', onclick: () => nav(1) }, icon('chev-r', 'lg'));
  S.stage.append(S.prev, S.next);
  // Filmstrip: neighbours of the current item, for jumping around a long sequence (desktop).
  S.strip = h('div', { class: 'lb-strip', role: 'listbox', 'aria-label': 'More in this sequence' });
  S.el.append(S.amb[0], S.amb[1], S.top, S.stage, S.strip, S.info$);
  root.replaceChildren(S.el);
  document.body.classList.add('no-scroll');
  document.addEventListener('keydown', onKey);
  S.offFav = bus.on('fav', () => S && paintTop());
  S.offFollow = bus.on('follow', () => S && paintInfo());
  S.offColl = bus.on('collections', () => S && paintTop());
  wireGestures();
  render();
}

function destroy() {
  if (!S) return;
  document.removeEventListener('keydown', onKey);
  clearSlide();
  S.offFav && S.offFav(); S.offFollow && S.offFollow(); S.offColl && S.offColl();
  teardownVideo();
  S.root.replaceChildren();
  S = null;
  document.body.classList.toggle('no-scroll', !!document.getElementById('modal-root').children.length);
}

export function closeLightbox() {
  if (!S) return;
  if (S.pushed) { history.back(); setTimeout(() => { if (S) { destroy(); setParam('m', null); } }, 250); }
  else { setParam('m', null); destroy(); }
}

const cur = () => (S && S.items[S.index]) || null;

function render() {
  if (!S) return;
  S.el.classList.toggle('info-open', S.info);
  if (S.loading) {
    S.stage.replaceChildren(S.prev, S.next, h('div', { class: 'lb-loading row' }, h('div', { class: 'spinner' }), 'Loading…'));
    S.top.replaceChildren(h('button', { class: 'btn icon', 'aria-label': 'Close', onclick: closeLightbox }, icon('x')));
  }
}

function nav(delta) {
  if (!S) return;
  const next = S.index + delta;
  if (next < 0) return;
  if (next >= S.items.length) {
    if (S.loadMore) S.loadMore().then((items) => { if (S && items) { S.items = items; if (S.items.length > next) show(next); } });
    return;
  }
  show(next);
}

function show(i, { push = false } = {}) {
  if (!S) return;
  const it = S.items[i];
  if (!it) return;
  S.index = i;
  const target = parse();
  if (target.query.get('m') !== it.id) setParam('m', it.id, { replace: !push });
  paintTop(); paintStage(it); paintInfo(); paintStrip();
  scheduleSlide();
  S.prev.disabled = i === 0;
  S.next.disabled = i >= S.items.length - 1 && !S.loadMore;
  // keep the feed ahead of the viewer, and warm the next image
  if (S.loadMore && i >= S.items.length - 5) S.loadMore().then((items) => { if (S && items && items.length > S.items.length) S.items = items; });
  const n = S.items[i + 1];
  if (n && n.media_type === 'image') { const pre = new Image(); pre.src = proxied(n.media_url); }
  if (!viewed.has(it.id)) { viewed.add(it.id); post(`/api/media/${it.id}/view`).catch(() => {}); }
  viewHistory.add(it.id);
  tastes.record(it, 1);
}

/* ------------------------------------------------- download / slideshow / help */
const isHlsOnly = (it) => isM3u8(it.media_url);

function downloadLink(it) {
  if (isHlsOnly(it)) return null; // streams cannot be saved as a single file
  const ext = (String(it.media_url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i) || [])[1] || (it.media_type === 'video' ? 'mp4' : 'jpg');
  const name = `${(it.creator_handle || it.author || 'prism').replace(/[^a-z0-9_-]+/gi, '')}-${it.id.slice(0, 8)}.${ext}`;
  return h('a', { class: 'btn icon', href: proxied(it.media_url), download: name, 'aria-label': 'Download', title: 'Download', rel: 'noopener' }, icon('download'));
}

const SLIDE_MS = 4500;
function clearSlide() { if (S && S.slideTimer) { clearTimeout(S.slideTimer); S.slideTimer = null; } }

function scheduleSlide() {
  if (!S || !S.slide) return;
  clearSlide();
  const it = cur();
  if (!it) return;
  const v = S.stage.querySelector('video');
  if (it.media_type === 'video' && v) {
    v.loop = false;                                   // let clips play through, then advance
    v.addEventListener('ended', () => { if (S && S.slide) nav(1); }, { once: true });
    S.slideTimer = setTimeout(() => { if (S && S.slide) nav(1); }, 45000); // safety net for stalled streams
  } else {
    S.slideTimer = setTimeout(() => { if (S && S.slide) nav(1); }, SLIDE_MS);
  }
}

function toggleSlideshow() {
  if (!S) return;
  S.slide = !S.slide;
  if (S.slide) { toast('Slideshow started — press S to stop'); scheduleSlide(); } else { clearSlide(); const v = S.stage.querySelector('video'); if (v) v.loop = true; toast('Slideshow stopped'); }
  paintTop();
}

function showHelp() {
  const rows = [['← / →  (J / K)', 'Previous / next'], ['F', 'Save to favourites'], ['C', 'Add to a collection'], ['Click · scroll · pinch', 'Zoom the image (+ / − / 0 too)'], ['Drag', 'Pan while zoomed'], ['I', 'Show or hide details'], ['M', 'Mute video'], ['Space', 'Play / pause video'], ['S', 'Start / stop slideshow'], ['Esc', 'Close'], ['/', 'Search (outside the viewer)'], ['Ctrl / ⌘ + K', 'Command palette (outside the viewer)'], ['Double-click', 'Save the image'], ['Swipe ← →', 'Navigate (touch)'], ['Swipe ↓', 'Close (touch)']];
  const m = openModal({ title: 'Keyboard shortcuts', body: h('dl', { class: 'kv', style: { gridTemplateColumns: 'auto 1fr' } }, rows.map(([k, d]) => [h('dt', null, h('kbd', { class: 'kbd' }, k)), h('dd', { style: { textAlign: 'left' } }, d)])), actions: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Got it')] });
}

/* ---------------------------------------------------------------- top bar */
function paintTop() {
  const it = cur();
  if (!S || !it) return;
  const faved = favorites.has(it.id);
  S.top.replaceChildren(
    h('button', { class: 'btn icon', 'aria-label': 'Close viewer', onclick: closeLightbox }, icon('x')),
    h('div', { class: 'lb-title' },
      h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, it.title || it.creator_name || 'Untitled'), h('div', { class: 's' }, [it.creator_name || it.author, platformLabel(it.platform), fmt.ago(it.posted_at)].filter(Boolean).join(' · ')))),
    h('span', { class: 'lb-count' }, `${S.index + 1} / ${S.items.length}`),
    h('button', { class: `btn icon fav${faved ? ' on' : ''}`, 'aria-label': faved ? 'Remove from saved' : 'Save', 'aria-pressed': String(faved), title: 'Save (F)', onclick: () => toggleFav(it) }, icon('heart')),
    h('button', { class: `btn icon${collections.containing(it.id).length ? ' on' : ''}`, 'aria-label': 'Add to collection', title: 'Add to collection (C)', onclick: () => openCollectionPicker(it) }, icon('bookmark')),
    h('button', { class: 'btn icon', 'aria-label': 'Share link', title: 'Copy link', onclick: () => share(it) }, icon('share')),
    downloadLink(it),
    h('button', { class: `btn icon hide-mobile${S.slide ? ' on' : ''}`, 'aria-label': S.slide ? 'Stop slideshow' : 'Start slideshow', 'aria-pressed': String(!!S.slide), title: 'Slideshow (S)', onclick: toggleSlideshow }, icon(S.slide ? 'pause' : 'play', S.slide ? '' : 'fill')),
    h('button', { class: 'btn icon hide-mobile', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: showHelp }, icon('sliders')),
    h('button', { class: `btn icon${S.info ? ' on' : ''}`, 'aria-label': 'Details', 'aria-pressed': String(S.info), title: 'Details (I)', onclick: () => { S.info = !S.info; S.el.classList.toggle('info-open', S.info); paintTop(); } }, icon('info')));
}

function toggleFav(it, burst = false) {
  const on = favorites.toggle(it.id, it);
  if (burst && on) {
    const b = h('div', { class: 'lb-heart-burst' }, icon('heart', 'fill'));
    S.stage.appendChild(b); setTimeout(() => b.remove(), 750);
    const r = S.stage.getBoundingClientRect(); heartBurst(r.left + r.width / 2, r.top + r.height / 2, { count: 14 });
  }
  toast(on ? 'Saved' : 'Removed from saved');
}

async function share(it) {
  const url = location.href;
  if (navigator.share && window.matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title: it.title || 'PRISM', url }); return; } catch { /* fall through */ } }
  toast((await copyText(url)) ? 'Link copied' : 'Could not copy link');
}

/* ------------------------------------------------------------------ stage */
function teardownVideo() {
  if (!S) return;
  if (S.video) { S.video.destroy(); S.video = null; }
  releaseVideo(S.stage.querySelector('video'));
}

function paintAmbient(it) {
  const src = it.preview_url || it.thumbnail_url || (it.media_type === 'image' ? it.media_url : null);
  const next = S.amb[S.ambIdx ^ 1]; const cur = S.amb[S.ambIdx];
  if (!src) { cur.classList.remove('on'); next.classList.remove('on'); return; }
  next.style.backgroundImage = `url("${proxied(src)}")`;
  next.classList.add('on'); cur.classList.remove('on');
  S.ambIdx ^= 1;
}

function paintStrip() {
  if (!S || !S.strip) return;
  const n = S.items.length;
  if (n < 2) { S.strip.replaceChildren(); return; }
  const from = Math.max(0, S.index - 14); const to = Math.min(n, S.index + 15);
  const thumbs = [];
  for (let i = from; i < to; i++) {
    const x = S.items[i];
    const src = x.preview_url || x.thumbnail_url || (x.media_type === 'image' ? x.media_url : '');
    thumbs.push(h('button', { class: `lb-thumb${i === S.index ? ' on' : ''}`, role: 'option', 'aria-selected': String(i === S.index), 'aria-label': x.title || `Item ${i + 1}`, style: src ? { backgroundImage: `url("${proxied(src)}")` } : null, onclick: () => show(i) },
      x.media_type === 'video' ? icon('play', 'fill') : null));
  }
  S.strip.replaceChildren(...thumbs);
  const on = S.strip.querySelector('.on');
  if (on) requestAnimationFrame(() => { S.strip.scrollTo({ left: on.offsetLeft - S.strip.clientWidth / 2 + on.offsetWidth / 2, behavior: 'smooth' }); });
}

function paintStage(it) {
  teardownVideo();
  S.zoom = null;
  paintAmbient(it);
  S.stage.classList.remove('zoomed-wrap');
  const keep = [S.prev, S.next];
  if (it.media_type === 'video') {
    const v = h('video', { controls: true, playsinline: true, loop: true, autoplay: true, preload: 'auto', poster: it.preview_url ? proxied(it.preview_url) : null, 'aria-label': it.title || 'Video' });
    v.muted = prefs.muted;
    v.addEventListener('volumechange', () => { prefs.muted = v.muted; });
    S.stage.replaceChildren(...keep, v);
    S.video = attachVideo(v, it);
    playFlip(v);
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  } else {
    const preview = it.preview_url || it.thumbnail_url;
    const img = h('img', { alt: it.title || '', draggable: 'false', src: proxied(preview || it.media_url) });
    S.stage.replaceChildren(...keep, img);
    playFlip(img);
    if (preview) {
      const full = new Image();
      full.onload = () => { if (img.isConnected) img.src = full.src; };
      full.src = proxied(it.media_url);
    }
    S.zoom = makeZoomable(img, S.stage);
    img.addEventListener('dblclick', () => { if (img.classList.contains('zoomed')) return; toggleFav(it, true); });
    img.addEventListener('error', () => S.stage.replaceChildren(...keep, h('div', { class: 'lb-loading' }, 'This image is no longer available at its source.')));
  }
}

/* ------------------------------------------------------------------- info */
function paintInfo() {
  const it = cur();
  if (!S || !it) return;
  const box = S.info$;
  const rel = h('div', { class: 'lb-related' });
  box.replaceChildren(
    it.creator_id ? h('div', { class: 'lb-creator' },
      h('a', { href: href(`/creator/${it.creator_id}`), onclick: () => closeSilently() }, avatar(it, 44)),
      h('div', { class: 'grow' }, h('a', { href: href(`/creator/${it.creator_id}`), class: 'creator-name', onclick: () => closeSilently() }, it.creator_name || it.creator_handle), h('div', { class: 'creator-handle' }, `@${it.creator_handle || it.author}`)),
      h('button', { class: `btn sm${follows.has(it.creator_id) ? '' : ' primary'}`, onclick: () => { const on = follows.toggle({ id: it.creator_id, handle: it.creator_handle, display_name: it.creator_name }); toast(on ? 'Following' : 'Unfollowed'); } }, follows.has(it.creator_id) ? 'Following' : 'Follow')) : null,
    it.title ? h('h3', null, it.title) : null,
    it.description ? h('p', { class: 'muted', style: { whiteSpace: 'pre-line', fontSize: '14px' } }, it.description.slice(0, 400)) : null,
    h('dl', { class: 'kv' },
      h('dt', null, 'Source'), h('dd', null, h('span', { class: 'badge plat', style: { '--c': platformColor(it.platform) } }, platformLabel(it.platform))),
      it.community ? [h('dt', null, 'Community'), h('dd', null, it.community)] : null,
      h('dt', null, 'Posted'), h('dd', null, fmt.ago(it.posted_at)),
      it.score ? [h('dt', null, 'Score'), h('dd', { class: 'num' }, fmt.int(it.score))] : null,
      it.width ? [h('dt', null, 'Size'), h('dd', { class: 'num' }, `${it.width} × ${it.height}`)] : null,
      it.duration ? [h('dt', null, 'Length'), h('dd', null, fmt.duration(it.duration))] : null),
    it.tags && it.tags.length ? h('div', { class: 'tagrow' }, it.tags.filter((t) => t !== it.platform).map((t) => h('a', { class: 'tag', href: href('/explore', { tag: t }), onclick: () => closeSilently() }, `#${t}`))) : null,
    h('div', { class: 'row wrap' },
      it.source_url ? h('a', { class: 'btn sm', href: it.source_url, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('external', 'sm'), 'View original') : null,
      h('button', { class: 'btn sm ghost', onclick: () => openReport({ mediaId: it.id }) }, icon('flag', 'sm'), 'Report')),
    h('div', null, h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', margin: '4px 0 10px' } }, 'More like this'), rel));
  const paintRelated = (items) => {
    if (!S || cur() !== it) return;
    if (!items.length) { rel.replaceWith(h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Nothing related yet.')); return; }
    rel.replaceChildren(...items.map((r) => h('a', {
      href: href(parse().path, { ...Object.fromEntries(parse().query), m: r.id }),
      style: { backgroundImage: `url("${proxied(r.preview_url || r.thumbnail_url || (r.media_type === 'image' ? r.media_url : ''))}")` }, 'aria-label': r.title || 'Related',
      onclick: (e) => { e.preventDefault(); const idx = S.items.findIndex((x) => x.id === r.id); if (idx >= 0) show(idx); else { S.items.splice(S.index + 1, 0, r); show(S.index + 1); } },
    }, r.media_type === 'video' ? h('span', { class: 'pill', style: { position: 'absolute', left: '6px', top: '6px' } }, icon('play', 'fill')) : null)));
  };
  if (relCache.has(it.id)) paintRelated(relCache.get(it.id));
  else get(`/api/media/${it.id}/related`, { limit: 9 }).then((items) => { relCache.set(it.id, items); paintRelated(items); }).catch(() => {});
}

/** Navigating away from the viewer via a link inside it: drop the overlay without touching history. */
function closeSilently() { if (S) { S.pushed = false; destroy(); } }

/* ---------------------------------------------------------------- input */
function onKey(e) {
  if (!S || e.target.closest('input, textarea, select')) return;
  if (document.getElementById('modal-root').children.length) return;
  const it = cur();
  switch (e.key) {
    case 'Escape': e.preventDefault(); closeLightbox(); break;
    case 'ArrowLeft': case 'k': nav(-1); break;
    case 'ArrowRight': case 'j': nav(1); break;
    case 'f': case 'F': if (it) toggleFav(it, true); break;
    case 'c': case 'C': if (it) openCollectionPicker(it); break;
    case 'i': case 'I': S.info = !S.info; S.el.classList.toggle('info-open', S.info); paintTop(); break;
    case 's': case 'S': toggleSlideshow(); break;
    case '?': showHelp(); break;
    case 'm': case 'M': { const v = S.stage.querySelector('video'); if (v) v.muted = !v.muted; break; }
    case '+': case '=': if (S.zoom) { e.preventDefault(); S.zoom.zoomBy(1.6); } break;
    case '-': if (S.zoom) { e.preventDefault(); S.zoom.zoomBy(1 / 1.6); } break;
    case '0': if (S.zoom) { e.preventDefault(); S.zoom.reset(); } break;
    case ' ': { const v = S.stage.querySelector('video'); if (v) { e.preventDefault(); if (v.paused) v.play(); else v.pause(); } break; }
    default:
  }
}

function wireGestures() {
  let start = null;
  S.stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('video, button')) { start = null; return; }
    if (S.stage.classList.contains('zoomed-wrap')) { start = null; return; }
    start = { x: e.clientX, y: e.clientY };
  });
  S.stage.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x; const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) nav(dx < 0 ? 1 : -1);
    else if (dy > 110 && dy > Math.abs(dx) * 1.5) closeLightbox();
  });
  S.stage.addEventListener('pointercancel', () => { start = null; });
  // clicking the dark backdrop (not the media) closes on desktop
  S.stage.addEventListener('click', (e) => { if (e.target === S.stage && window.matchMedia('(hover: hover)').matches) closeLightbox(); });
}
