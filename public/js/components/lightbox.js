import { h, icon, proxied, fmt, avatar, toast, copyText, openModal } from '../dom.js';
import { get, post, reportBroken } from '../api.js';
import { favorites, follows, prefs, history as viewHistory, tastes, collections, platformLabel, platformColor, bus } from '../store.js';
import { parse, href, setParam } from '../router.js';
import { openReport } from './report.js';
import { attachVideo, releaseVideo, isM3u8 } from './video.js';
import { openCollectionPicker } from './collections.js';
import { playFlip, heartBurst, haptic } from './fx.js';
import { makeZoomable } from './zoom.js';
import { viewerExit } from './transitions.js';
import { openElsewhere } from './elsewhere.js';

let S = null; // the single active lightbox session
const viewed = new Set();
const relCache = new Map(); // media id -> related items
const byCreator = new Map(); // creator id -> { at, items } his latest posts

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
  S.prev = h('button', { class: 'lb-nav prev', 'aria-label': 'Previous (←)', title: 'Previous (← / J)', onclick: () => nav(-1) }, icon('chev-l', 'lg'));
  S.next = h('button', { class: 'lb-nav next', 'aria-label': 'Next (→)', title: 'Next (→ / K)', onclick: () => nav(1) }, icon('chev-r', 'lg'));
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
  if (!S.silent) viewerExit(S.stage.querySelector(':scope > img, :scope > video'), cur() && cur().id); // fly back into its card
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
  S.dir = delta;
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
  slideIn();
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
  const dl = downloadLink(it);
  if (dl) dl.append(h('span', { class: 'lb-lab', 'aria-hidden': 'true' }, 'File'));
  S.top.replaceChildren(
    h('button', { class: 'btn icon', 'aria-label': 'Close viewer', title: 'Close (Esc)', onclick: closeLightbox }, icon('x')),
    h('div', { class: 'lb-title' },
      h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, it.title || it.creator_name || 'Untitled'), h('div', { class: 's' }, [it.creator_name || it.author, platformLabel(it.platform), fmt.ago(it.posted_at)].filter(Boolean).join(' · ')))),
    h('span', { class: 'lb-count' }, `${S.index + 1} / ${S.items.length}`),
    // on desktop these sit in the top bar; on a phone they become a labelled dock under your thumb
    h('div', { class: 'lb-actions', role: 'toolbar', 'aria-label': 'Viewer actions' },
    h('button', { class: `btn icon fav${faved ? ' on' : ''}`, 'aria-label': faved ? 'Remove from saved' : 'Save', 'aria-pressed': String(faved), title: 'Save (F)', onclick: () => toggleFav(it) }, icon('heart'), h('span', { class: 'lb-lab', 'aria-hidden': 'true' }, 'Save')),
    h('button', { class: `btn icon${collections.containing(it.id).length ? ' on' : ''}`, 'aria-label': 'Add to collection', title: 'Add to collection (C)', onclick: () => openCollectionPicker(it) }, icon('bookmark'), h('span', { class: 'lb-lab', 'aria-hidden': 'true' }, 'Collect')),
    h('button', { class: 'btn icon', 'aria-label': 'Share link', title: 'Copy link', onclick: () => share(it) }, icon('share'), h('span', { class: 'lb-lab', 'aria-hidden': 'true' }, 'Share')),
    dl,
    h('button', { class: `btn icon hide-mobile${S.slide ? ' on' : ''}`, 'aria-label': S.slide ? 'Stop slideshow' : 'Start slideshow', 'aria-pressed': String(!!S.slide), title: 'Slideshow (S)', onclick: toggleSlideshow }, icon(S.slide ? 'pause' : 'play', S.slide ? '' : 'fill')),
    h('button', { class: 'btn icon hide-mobile', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: showHelp }, icon('sliders')),
    h('button', { class: `btn icon${S.info ? ' on' : ''}`, 'aria-label': 'Details', 'aria-pressed': String(S.info), title: 'Details (I) — swipe up on touch', onclick: () => setInfo(!S.info) }, icon('info'), h('span', { class: 'lb-lab', 'aria-hidden': 'true' }, 'Details'))));
}

function setInfo(on) {
  if (!S) return;
  S.info = on;
  S.el.classList.toggle('info-open', on);
  if (on) S.el.classList.remove('chrome-off');
  paintTop();
}

/** Touch: a tap on the media hides the controls for an unobstructed look; another brings them back. */
function toggleChrome() {
  if (!S) return;
  if (S.info && phoneLayout()) { setInfo(false); return; } // a tap outside the details sheet closes it
  S.el.classList.toggle('chrome-off');
}
const phoneLayout = () => window.matchMedia('(max-width: 900px)').matches;

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
    S.zoom = makeZoomable(img, S.stage, { onSingleClick: () => {
      // touch: tap toggles the controls (pinch zooms); a tap on a zoomed image still zooms back out
      if (S && S.lastPointer !== 'mouse' && !(S.zoom && S.zoom.scale > 1)) {
        if (performance.now() - (S.dragEnd || 0) > 600) toggleChrome(); // a click synthesized after a swipe is not a tap
        return false;
      }
      return true;
    } });
    img.addEventListener('dblclick', () => { if (img.classList.contains('zoomed')) return; toggleFav(it, true); });
    img.addEventListener('error', () => { reportBroken(it.id); S.stage.replaceChildren(...keep, h('div', { class: 'lb-loading' }, 'This image is no longer available at its source.')); });
  }
}

/* ------------------------------------------------------------------- info */
function paintInfo() {
  const it = cur();
  if (!S || !it) return;
  const box = S.info$;
  const rel = h('div', { class: 'lb-related' });
  const moreFrom = it.creator_id ? creatorStrip(it) : null;
  box.replaceChildren(
    it.creator_id ? h('div', { class: 'lb-creator' },
      // the name link beside it carries the label; this one is a larger pointer target only
      h('a', { href: href(`/creator/${it.creator_id}`), tabindex: '-1', 'aria-hidden': 'true', onclick: () => closeSilently() }, avatar(it, 44)),
      h('div', { class: 'grow' }, h('a', { href: href(`/creator/${it.creator_id}`), class: 'creator-name', onclick: () => closeSilently() }, it.creator_name || it.creator_handle), h('div', { class: 'creator-handle' }, `@${it.creator_handle || it.author}`)),
      h('button', { class: `btn sm${follows.has(it.creator_id) ? '' : ' primary'}`, onclick: () => { const on = follows.toggle({ id: it.creator_id, handle: it.creator_handle, display_name: it.creator_name }); toast(on ? 'Following' : 'Unfollowed'); } }, follows.has(it.creator_id) ? 'Following' : 'Follow')) : null,
    it.creator_id ? moreFrom : null,
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
    it.also && it.also.length ? h('div', { class: 'tagrow' }, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Also on'), it.also.map((a) => h('a', { class: 'tag', href: a.source_url, target: '_blank', rel: 'noopener noreferrer nofollow', title: [a.author, a.community].filter(Boolean).join(' · ') }, platformLabel(a.platform)))) : null,
    h('div', { class: 'row wrap' },
      it.source_url ? h('a', { class: 'btn sm', href: it.source_url, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('external', 'sm'), 'View original') : null,
      h('button', { class: 'btn sm ghost', title: 'Recommend less from this creator and these tags', onclick: (e) => { tastes.dislike(it); e.currentTarget.disabled = true; toast('Got it. “For you” will show less like this'); } }, icon('x', 'sm'), 'Not interested'),
      imageUrl(it) ? h('button', { class: 'btn sm ghost', title: 'Find this picture elsewhere on the web', onclick: () => openImageSearch(it) }, icon('search', 'sm'), 'Search this image') : null,
      h('button', { class: 'btn sm ghost', onclick: () => openReport({ mediaId: it.id }) }, icon('flag', 'sm'), 'Report')),
    h('div', null, h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', margin: '4px 0 10px' } }, 'More like this'), rel));
  const paintRelated = (items) => {
    if (!S || cur() !== it) return;
    if (!items.length) { rel.replaceWith(h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Nothing related yet.')); return; }
    rel.replaceChildren(...items.map((r) => h('a', {
      href: href(parse().path, { ...Object.fromEntries(parse().query), m: r.id }),
      style: { backgroundImage: `url("${proxied(r.preview_url || r.thumbnail_url || (r.media_type === 'image' ? r.media_url : ''))}")` }, 'aria-label': r.title || 'Related',
      onclick: (e) => { e.preventDefault(); jumpTo(r); },
    }, r.media_type === 'video' ? h('span', { class: 'pill', style: { position: 'absolute', left: '6px', top: '6px' } }, icon('play', 'fill')) : null)));
  };
  if (relCache.has(it.id)) paintRelated(relCache.get(it.id));
  else get(`/api/media/${it.id}/related`, { limit: 9 }).then((items) => { relCache.set(it.id, items); paintRelated(items); }).catch(() => {});
}

/** The picture's own public address (never our proxy): reverse image search engines fetch it themselves. */
const imageUrl = (it) => {
  const u = it.preview_url || it.thumbnail_url || (it.media_type === 'image' ? it.media_url : null);
  return u && /^https?:\/\//i.test(u) ? u : null;
};

/** "Search this image": the same picture on Google Lens, Bing and TinEye, each in a new tab. */
function openImageSearch(it) {
  const u = encodeURIComponent(imageUrl(it));
  const engines = [
    ['Google Lens', 'Faces, products and pages with this picture', `https://lens.google.com/uploadbyurl?url=${u}`],
    ['Bing Visual Search', 'Similar images and where they appear', `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${u}`],
    ['TinEye', 'Exact copies, oldest first', `https://tineye.com/search?url=${u}`],
  ];
  const m = openModal({ title: 'Search this image', sub: 'Opens in a new tab. The search engine fetches the picture from its source.',
    body: h('div', { class: 'where-body' }, engines.map(([name, sub, url]) => h('a', { class: 'where-row', href: url, target: '_blank', rel: 'noopener noreferrer nofollow', onclick: () => m.close() },
      h('span', { class: 'where-dot link' }, icon('search', 'sm')), h('span', { class: 'where-txt' }, h('b', null, name), h('small', null, sub)), icon('external', 'sm')))) });
}

/** Open an item from a side list (related, more from him): step to it if it is in the sequence, else slot it in next. */
function jumpTo(r) {
  if (!S) return;
  const idx = S.items.findIndex((x) => x.id === r.id);
  if (idx >= 0) show(idx); else { S.items.splice(S.index + 1, 0, r); S.dir = 1; show(S.index + 1); }
}

/** "More from him": his latest posts as a strip, plus every other place he posts. */
function creatorStrip(it) {
  const name = it.creator_name || it.creator_handle || 'him';
  const strip = h('div', { class: 'lb-more-strip', role: 'list' });
  const el = h('section', { class: 'lb-more', 'aria-label': `More from ${name}` },
    h('div', { class: 'lb-more-head' },
      h('span', { class: 'lb-more-title' }, `More from ${name}`),
      h('button', { class: 'btn sm ghost', title: 'His other accounts and pages', onclick: () => openElsewhere(it.creator_id, { name, onNavigate: closeSilently }) }, icon('link', 'sm'), 'Where else he posts')),
    strip);
  const paint = (items) => {
    if (!S || cur() !== it) return;
    const list = items.filter((x) => x.id !== it.id).slice(0, 8);
    if (!list.length) { strip.remove(); return; }
    strip.replaceChildren(...list.map((r) => {
      const src = r.preview_url || r.thumbnail_url || (r.media_type === 'image' ? r.media_url : '');
      return h('a', { class: 'lb-more-thumb', role: 'listitem', href: href(parse().path, { ...Object.fromEntries(parse().query), m: r.id }), 'aria-label': r.title || `Post by ${name}`,
        style: src ? { backgroundImage: `url("${proxied(src)}")` } : null, onclick: (e) => { e.preventDefault(); jumpTo(r); } },
      r.media_type === 'video' ? h('span', { class: 'pill' }, icon('play', 'fill')) : null);
    }));
  };
  const hit = byCreator.get(it.creator_id);
  if (hit && Date.now() - hit.at < 120000) paint(hit.items);
  else {
    strip.append(...Array.from({ length: 4 }, () => h('span', { class: 'lb-more-thumb skeleton' })));
    get(`/api/creators/${it.creator_id}/media`, { sort: 'recent', limit: 9 }).then((r) => {
      byCreator.set(it.creator_id, { at: Date.now(), items: r.items });
      if (byCreator.size > 40) byCreator.delete(byCreator.keys().next().value);
      paint(r.items);
    }).catch(() => strip.remove());
  }
  return el;
}

/** Navigating away from the viewer via a link inside it: drop the overlay without touching history. */
function closeSilently() { if (S) { S.pushed = false; S.silent = true; destroy(); } }

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
    case 'i': case 'I': setInfo(!S.info); break;
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

/** The next item glides in from the side it was swiped (or stepped) from. */
function slideIn() {
  const dir = S.dir; S.dir = 0;
  if (!dir || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const m = S.stage.querySelector('img, video');
  if (m && m.animate) m.animate([{ transform: `translateX(${dir * 56}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

/*
 * Touch gestures, all of which follow the finger while it moves:
 *   swipe left / right  next / previous (rubber-bands at either end)
 *   drag down           close, fading the viewer out as you pull
 *   swipe up            open the details sheet
 *   tap                 hide / show the controls (see toggleChrome)
 * A second finger hands over to pinch-zoom; a zoomed image pans instead (zoom.js).
 */
function wireGestures() {
  let g = null;
  let fingers = 0;
  const media = () => S && S.stage.querySelector('img, video');
  const reset = (animate) => {
    const m = media();
    if (m) { m.style.transition = animate ? 'transform .26s cubic-bezier(.2,.8,.2,1), opacity .2s' : 'none'; m.style.transform = ''; m.style.opacity = ''; }
    if (S) { S.el.classList.remove('dragging'); S.el.style.removeProperty('--drag'); }
  };
  const onControls = (e) => {
    const v = e.target.closest('video');
    return v && e.clientY > v.getBoundingClientRect().bottom - 56; // the native scrubber and buttons
  };
  // capture phase: counts fingers and notes the input type before zoom.js sees the event
  S.stage.addEventListener('pointerdown', (e) => {
    S.lastPointer = e.pointerType;
    if (e.pointerType === 'mouse') return;
    fingers++;
    if (fingers > 1 && g) { g = null; reset(true); }
  }, true);
  const lift = (e) => { if (e.pointerType !== 'mouse') fingers = Math.max(0, fingers - 1); };
  S.stage.addEventListener('pointerup', lift, true);
  S.stage.addEventListener('pointercancel', lift, true);

  S.stage.addEventListener('pointerdown', (e) => {
    g = null;
    if (e.pointerType === 'mouse' || fingers > 1 || e.target.closest('button') || onControls(e)) return;
    if (S.stage.classList.contains('zoomed-wrap')) return;
    g = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, axis: null, dx: 0, dy: 0, onMedia: !!e.target.closest('img, video') };
  });
  S.stage.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    g.dx = e.clientX - g.x; g.dy = e.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(g.dx, g.dy) < 10) return;
      g.axis = Math.abs(g.dx) > Math.abs(g.dy) ? 'x' : g.dy > 0 ? 'down' : 'up';
    }
    const m = media();
    if (!m) return;
    m.style.transition = 'none';
    if (g.axis === 'x') {
      const blocked = (g.dx > 0 && S.index === 0) || (g.dx < 0 && S.index >= S.items.length - 1 && !S.loadMore);
      m.style.transform = `translateX(${blocked ? g.dx / 4 : g.dx}px) rotate(${(blocked ? 0 : g.dx) / 90}deg)`;
    } else if (g.axis === 'down') {
      const dy = Math.max(0, g.dy);
      m.style.transform = `translate(${g.dx / 3}px, ${dy}px) scale(${1 - Math.min(dy / 1400, 0.3)})`;
      S.el.classList.add('dragging');
      S.el.style.setProperty('--drag', Math.min(dy / 360, 1).toFixed(3));
    } else {
      m.style.transform = `translateY(${Math.max(g.dy, -120) / 3}px)`;
    }
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { axis, dx, dy, onMedia } = g;
    if (axis) S.dragEnd = performance.now();
    const fast = performance.now() - g.t < 260; // a flick needs less distance
    g = null;
    if (!axis) {
      // a tap on a video or the dark area around the media (images report their own taps through zoom.js)
      if (!onMedia || e.target.closest('video')) toggleChrome();
      return;
    }
    const m = media();
    if (axis === 'x' && (Math.abs(dx) > 80 || (fast && Math.abs(dx) > 30))) {
      const d = dx < 0 ? 1 : -1;
      const blocked = (d < 0 && S.index === 0) || (d > 0 && S.index >= S.items.length - 1 && !S.loadMore);
      if (blocked) { reset(true); return; }
      if (d > 0 && S.index >= S.items.length - 1) {
        // last loaded item: only move on if another page actually arrives (no exit into nothing)
        reset(true);
        // the prefetch may land first and grow S.items itself, so compare against the index we wanted
        const want = S.index + 1;
        S.loadMore().then((items) => {
          if (!S) return;
          if (items && items.length > S.items.length) S.items = items;
          if (S.index === want - 1 && S.items.length > want) { S.dir = 1; show(want); }
        });
        return;
      }
      haptic(8);
      if (m) { m.style.transition = 'transform .16s ease-in, opacity .16s'; m.style.transform = `translateX(${-d * window.innerWidth * 0.6}px) rotate(${-d * 4}deg)`; m.style.opacity = '0'; }
      setTimeout(() => {
        nav(d);
        // the next page may still be loading (or there is none): never leave the old item invisible
        setTimeout(() => { if (m && m.isConnected) reset(true); }, 700);
      }, 140);
    } else if (axis === 'down' && (dy > 120 || (fast && dy > 50))) {
      if (m) { m.style.transition = 'transform .2s ease-in, opacity .2s'; m.style.transform = `translateY(${window.innerHeight * 0.5}px) scale(.7)`; m.style.opacity = '0'; }
      S.el.style.setProperty('--drag', '1');
      setTimeout(closeLightbox, 160);
    } else if (axis === 'up' && (dy < -70 || (fast && dy < -30))) {
      reset(true);
      if (!S.info) setInfo(true);
    } else reset(true);
  };
  S.stage.addEventListener('pointerup', end);
  // the browser took the touch away: drop the gesture, never act on it
  S.stage.addEventListener('pointercancel', (e) => { if (g && e.pointerId === g.id) { g = null; reset(true); } });
  // clicking the dark backdrop (not the media) closes on desktop
  S.stage.addEventListener('click', (e) => { if (e.target === S.stage && S.lastPointer === 'mouse') closeLightbox(); });
}
