import { h, icon, proxied, fmt, avatar, toast, copyText, emptyState } from '../dom.js';
import { get, post } from '../api.js';
import { navigate, href } from '../router.js';
import { prefs, favorites, follows, history as viewHistory, tastes, collections, platformLabel, bus } from '../store.js';
import { attachVideo, releaseVideo } from '../components/video.js';
import { openCollectionPicker } from '../components/collections.js';
import { openLightbox, isOpen as lightboxOpen } from '../components/lightbox.js';
import { heartBurst } from '../components/fx.js';

const SORTS = [['foryou', 'For you'], ['trending', 'Trending'], ['random', 'Shuffle'], ['recent', 'Newest'], ['top', 'Top']];
const PAGE = 12;

/**
 * Reels: one item at a time, full screen, swipe (or scroll / arrow keys) to the next.
 * Only the visible slide holds a playing video; its neighbours keep just a poster,
 * so an endless session never piles up decoders or connections.
 */
export async function reels(root, { query }) {
  document.title = 'Reels — PRISM';
  const f = {
    type: query.get('type') ?? 'video', sort: query.get('sort') || (tastes.ready() ? 'foryou' : 'trending'), platform: query.get('platform') || '', tag: query.get('tag') || '',
    community: query.get('community') || '', creator: query.get('creator') || '', q: query.get('q') || '', following: query.get('following') || '',
  };
  const set = (patch) => navigate('/reels', { ...f, ...patch }, { replace: true });
  const followIds = f.following ? follows.list().map((c) => c.id).slice(0, 100) : null;
  let seed = Math.floor(Math.random() * 1e6);

  const slides = [];
  let page = 0; let done = false; let loading = false; let active = -1; let destroyed = false;
  const viewed = new Set();

  document.body.classList.add('reels-mode');
  const track = h('div', { class: 'reels-track', tabindex: '-1' });
  const muteBtn = h('button', { class: 'btn icon ghost', 'aria-label': 'Toggle sound', title: 'Sound (M)', onclick: () => setMuted(!prefs.muted) });
  const paintMute = () => muteBtn.replaceChildren(icon(prefs.muted ? 'mute' : 'volume'));
  paintMute();

  const context = f.sort === 'foryou' && !f.creator && !f.tag && !f.community && !f.q && !f.following && !f.platform ? 'For you' : f.creator ? 'Creator' : f.following ? 'Following' : f.tag ? `#${f.tag}` : f.community || (f.q ? `“${f.q}”` : (f.platform ? platformLabel(f.platform) : ((SORTS.find((x) => x[0] === f.sort) || [])[1] || 'Reels')));
  const top = h('div', { class: 'reels-top' },
    h('button', { class: 'btn icon ghost', 'aria-label': 'Back', title: 'Back', onclick: () => (window.history.length > 1 ? window.history.back() : navigate('/')) }, icon('chev-l')),
    h('div', { class: 'reels-title truncate' }, icon('film', 'sm'), context),
    h('div', { class: 'seg sm', role: 'group', 'aria-label': 'Media type' }, [['video', 'Videos'], ['all', 'All'], ['image', 'Photos']].map(([v, l]) => h('button', { class: f.type === v ? 'on' : '', 'aria-pressed': String(f.type === v), onclick: () => set({ type: v }) }, l))),
    h('select', { class: 'select sm', 'aria-label': 'Order', onchange: (e) => set({ sort: e.target.value }) }, SORTS.map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l))),
    muteBtn);
  const shell = h('div', { class: 'reels', role: 'region', 'aria-label': 'Reels' }, top, track);
  root.replaceChildren(shell);

  function setMuted(m) {
    prefs.muted = m; paintMute();
    const s = slides[active]; const v = s && s.el.querySelector('video');
    if (v) { v.muted = m; if (!m) v.play().catch(() => {}); }
  }

  /* --------------------------------------------------------------- slides */
  function slide(it, index) {
    const isVideo = it.media_type === 'video';
    const poster = it.preview_url || it.thumbnail_url || (!isVideo ? it.media_url : null);
    const stage = h('div', { class: 'reel-stage' });
    const bg = h('div', { class: 'reel-bg', style: poster ? { backgroundImage: `url("${proxied(poster)}")` } : {} });
    const bar = h('div', { class: 'reel-progress' }, h('i'));
    const favBtn = h('button', { class: 'reel-act', 'aria-label': 'Save' }, icon('heart'), h('span', null, 'Save'));
    const paintFav = () => { const on = favorites.has(it.id); favBtn.classList.toggle('on', on); favBtn.setAttribute('aria-pressed', String(on)); favBtn.querySelector('svg').classList.toggle('fill', on); };
    favBtn.addEventListener('click', () => { const on = favorites.toggle(it.id, it); toast(on ? 'Saved' : 'Removed from saved'); if (on) { const r = favBtn.getBoundingClientRect(); heartBurst(r.left + r.width / 2, r.top + 20); } });
    const collBtn = h('button', { class: 'reel-act', 'aria-label': 'Add to collection', onclick: () => openCollectionPicker(it) }, icon('bookmark'), h('span', null, 'Collect'));
    const paintColl = () => collBtn.classList.toggle('on', collections.containing(it.id).length > 0);
    paintFav(); paintColl();

    const followBtn = it.creator_id ? h('button', { class: 'btn sm reel-follow' }) : null;
    const paintFollow = () => { if (!followBtn) return; const on = follows.has(it.creator_id); followBtn.textContent = on ? 'Following' : 'Follow'; followBtn.classList.toggle('primary', !on); };
    if (followBtn) followBtn.addEventListener('click', () => { const on = follows.toggle({ id: it.creator_id, handle: it.creator_handle, display_name: it.creator_name }); toast(on ? `Following ${it.creator_name || it.creator_handle}` : 'Unfollowed'); });
    paintFollow();

    const meta = h('div', { class: 'reel-meta' },
      it.creator_id ? h('div', { class: 'row', style: { gap: '10px' } },
        h('a', { href: href(`/creator/${it.creator_id}`), class: 'row', style: { gap: '10px', minWidth: 0 } }, avatar(it, 40), h('div', { style: { minWidth: 0 } }, h('div', { class: 'reel-name truncate' }, it.creator_name || it.creator_handle), h('div', { class: 'reel-handle truncate' }, `@${it.creator_handle || it.author} · ${platformLabel(it.platform)}`))),
        followBtn) : h('div', { class: 'reel-handle' }, [it.author, platformLabel(it.platform)].filter(Boolean).join(' · ')),
      it.title ? h('p', { class: 'reel-caption' }, it.title) : null,
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        (it.tags || []).filter((t) => t !== it.platform).slice(0, 4).map((t) => h('a', { class: 'reel-tag', href: href('/reels', { tag: t, type: f.type || 'all' }) }, `#${t}`)),
        h('span', { class: 'reel-handle' }, fmt.ago(it.posted_at))));

    const rail = h('div', { class: 'reel-rail' },
      favBtn, collBtn,
      h('button', { class: 'reel-act', 'aria-label': 'Details', onclick: () => openLightbox(slides.map((s) => s.it), index) }, icon('info'), h('span', null, 'Details')),
      h('button', { class: 'reel-act', 'aria-label': 'Copy link', onclick: async () => { const url = `${location.origin}${location.pathname}${href('/explore', { m: it.id })}`; toast((await copyText(url)) ? 'Link copied' : 'Could not copy'); } }, icon('share'), h('span', null, 'Share')),
      it.source_url ? h('a', { class: 'reel-act', href: it.source_url, target: '_blank', rel: 'noopener noreferrer nofollow', 'aria-label': 'View original' }, icon('external'), h('span', null, 'Source')) : null);

    const el = h('section', { class: 'reel', dataset: { index: String(index) }, 'aria-label': it.title || `Item ${index + 1}` }, bg, stage, meta, rail, isVideo ? bar : null);
    const s = { it, el, stage, bar, isVideo, poster, handle: null, mounted: false, paintFav, paintColl, paintFollow };

    // tap: play/pause; double tap: save with a heart burst
    let lastTap = 0; let tapTimer = null;
    stage.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastTap < 280) {
        clearTimeout(tapTimer); lastTap = 0;
        if (!favorites.has(it.id)) favorites.toggle(it.id, it);
        const sr = stage.getBoundingClientRect(); heartBurst(sr.left + sr.width / 2, sr.top + sr.height / 2, { count: 14 });
        const b = h('div', { class: 'lb-heart-burst' }, icon('heart', 'fill')); stage.appendChild(b); setTimeout(() => b.remove(), 750);
        return;
      }
      lastTap = now;
      tapTimer = setTimeout(() => { const v = stage.querySelector('video'); if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); } }, 280);
    });
    return s;
  }

  function mount(s) {
    if (s.mounted) return;
    s.mounted = true;
    if (s.isVideo) {
      const v = h('video', { playsinline: true, loop: true, preload: 'none', poster: s.poster ? proxied(s.poster) : null, 'aria-label': s.it.title || 'Video' });
      v.muted = prefs.muted;
      v.addEventListener('timeupdate', () => { if (v.duration) s.bar.firstChild.style.width = `${(v.currentTime / v.duration) * 100}%`; });
      s.stage.replaceChildren(v);
    } else {
      const preview = s.it.preview_url || s.it.thumbnail_url;
      const img = h('img', { alt: s.it.title || '', src: proxied(preview || s.it.media_url), decoding: 'async', draggable: 'false' });
      if (preview) { const full = new Image(); full.onload = () => { if (img.isConnected) img.src = full.src; }; full.src = proxied(s.it.media_url); }
      img.addEventListener('error', () => s.stage.replaceChildren(h('div', { class: 'reel-gone' }, 'This item is no longer available at its source.')));
      s.stage.replaceChildren(img);
    }
  }
  function unmount(s) {
    if (!s.mounted) return;
    deactivate(s);
    s.mounted = false;
    s.stage.replaceChildren();
  }
  function activate(s) {
    mount(s);
    if (!viewed.has(s.it.id)) { viewed.add(s.it.id); post(`/api/media/${s.it.id}/view`).catch(() => {}); }
    viewHistory.add(s.it.id);
    tastes.record(s.it, 1);
    if (!s.isVideo) return;
    const v = s.stage.querySelector('video');
    if (!v) return;
    v.muted = prefs.muted;
    if (!s.handle) s.handle = attachVideo(v, s.it);
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  }
  function deactivate(s) {
    if (!s.isVideo) return;
    if (s.handle) { s.handle.destroy(); s.handle = null; }
    releaseVideo(s.stage.querySelector('video'));
  }

  function setActive(i) {
    if (i === active || !slides[i]) return;
    active = i;
    slides.forEach((s, k) => {
      if (k === i) activate(s);
      else if (Math.abs(k - i) <= 2) { deactivate(s); mount(s); }
      else unmount(s);
    });
    if (i >= slides.length - 4) load();
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) setActive(Number(e.target.dataset.index));
  }, { root: track, threshold: [0.6] });

  /* --------------------------------------------------------------- paging */
  async function load() {
    if (loading || done || destroyed) return;
    loading = true;
    try {
      const forYou = f.sort === 'foryou' && !f.creator && !f.tag && !f.community && !f.q && !f.following && !f.platform;
      const res = forYou ? await get('/api/recommend', { ...tastes.query({ exclude: viewHistory.list().slice(0, 100) }), type: f.type === 'all' ? undefined : f.type, seed, page, limit: PAGE }) : await get('/api/media', {
        type: f.type === 'all' ? undefined : f.type, sort: f.sort === 'foryou' ? 'trending' : f.sort, platform: f.platform, tag: f.tag, community: f.community, creator: f.creator, q: f.q,
        creators: followIds ? (followIds.length ? followIds.join(',') : '00000000-0000-0000-0000-000000000000') : undefined,
        seed: f.sort === 'random' ? seed : undefined, page, limit: PAGE,
      });
      if (destroyed) return;
      page++;
      if (res.items.length < PAGE) done = true;
      const fresh = prefs.hideSeen ? res.items.filter((it) => !viewHistory.has(it.id)) : res.items;
      for (const it of fresh) {
        if (slides.some((s) => s.it.id === it.id)) continue;
        const s = slide(it, slides.length);
        slides.push(s); track.appendChild(s.el); io.observe(s.el);
      }
      if (done) track.appendChild(endSlide());
      if (!slides.length && !done) { loading = false; return load(); }
      if (active < 0 && slides.length) setActive(0);
    } catch (e) {
      if (!slides.length) track.replaceChildren(h('div', { class: 'reel reel-end' }, emptyState({ icon: 'alert', title: 'Couldn’t load', text: e.message, actions: [h('button', { class: 'btn primary', onclick: () => { loading = false; load(); } }, 'Try again')] })));
      else toast(e.message || 'Could not load more', 'err');
    } finally { loading = false; }
  }

  function endSlide() {
    return h('section', { class: 'reel reel-end' }, slides.length
      ? emptyState({ icon: 'sparkle', title: 'You’re all caught up', text: `That’s everything for ${context}.`, actions: [h('button', { class: 'btn primary', onclick: () => (f.sort === 'random' ? restart() : set({ sort: 'random' })) }, icon('shuffle', 'sm'), 'Shuffle again'), h('a', { class: 'btn', href: href('/explore', { type: f.type === 'all' ? '' : f.type, tag: f.tag, platform: f.platform, community: f.community, q: f.q }) }, 'Open in Explore')] })
      : emptyState({ icon: 'film', title: 'Nothing to play', text: f.type === 'video' ? 'No videos match. Try “All” to include photos.' : 'Nothing matches these filters yet.', actions: [f.type === 'video' ? h('button', { class: 'btn primary', onclick: () => set({ type: 'all' }) }, 'Show photos too') : null, h('a', { class: 'btn', href: href('/explore') }, 'Explore')].filter(Boolean) }));
  }

  /** Start over in place (a new shuffle) without a route change. */
  function restart() {
    slides.forEach((s) => { unmount(s); io.unobserve(s.el); });
    slides.length = 0; page = 0; done = false; active = -1; seed = Math.floor(Math.random() * 1e6);
    track.replaceChildren(); track.scrollTop = 0;
    load();
  }

  /* ---------------------------------------------------------------- input */
  const go = (d) => { const s = slides[Math.max(0, Math.min(slides.length - 1, active + d))]; if (s) s.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const onKey = (e) => {
    if (lightboxOpen() || document.getElementById('modal-root').children.length || e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const s = slides[active];
    switch (e.key) {
      case 'ArrowDown': case 'j': case 'PageDown': e.preventDefault(); go(1); break;
      case 'ArrowUp': case 'k': case 'PageUp': e.preventDefault(); go(-1); break;
      case ' ': { e.preventDefault(); const v = s && s.stage.querySelector('video'); if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); } break; }
      case 'm': case 'M': setMuted(!prefs.muted); break;
      case 'f': case 'F': if (s) favorites.toggle(s.it.id, s.it); break;
      case 'c': case 'C': if (s) openCollectionPicker(s.it); break;
      case 'i': case 'I': case 'Enter': if (s) openLightbox(slides.map((x) => x.it), active); break;
      default:
    }
  };
  document.addEventListener('keydown', onKey);
  const offs = [
    bus.on('fav', () => slides.forEach((s) => s.paintFav())),
    bus.on('collections', () => slides.forEach((s) => s.paintColl())),
    bus.on('follow', () => slides.forEach((s) => s.paintFollow())),
  ];
  // Pause when the tab is hidden; resume when it returns.
  const onVis = () => { const v = slides[active] && slides[active].stage.querySelector('video'); if (!v) return; if (document.hidden) v.pause(); else if (!lightboxOpen()) v.play().catch(() => {}); };
  document.addEventListener('visibilitychange', onVis);
  // The viewer has its own player: pause ours while it is open.
  const onHash = () => { const v = slides[active] && slides[active].stage.querySelector('video'); if (v && lightboxOpen()) v.pause(); };
  window.addEventListener('hashchange', onHash);

  await load();
  track.focus({ preventScroll: true });
  // First visit: show how to move on, then get out of the way.
  if (!prefs.reelsHint && slides.length > 1) {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const hint = h('div', { class: 'reel-hint', role: 'status' }, icon(touch ? 'up' : 'chev-d', 'sm'), touch ? 'Swipe up for the next one · double-tap to save' : '↓ or J for the next one · M for sound · F to save');
    shell.appendChild(hint);
    const done = () => { hint.remove(); prefs.reelsHint = true; track.removeEventListener('scroll', done); };
    track.addEventListener('scroll', done, { passive: true, once: true });
    setTimeout(done, 6000);
  }

  return () => {
    destroyed = true;
    io.disconnect();
    slides.forEach(unmount);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('hashchange', onHash);
    offs.forEach((off) => off());
    document.body.classList.remove('reels-mode');
  };
}
