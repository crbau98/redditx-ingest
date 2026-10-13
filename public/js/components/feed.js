import { h, icon, emptyState } from '../dom.js';
import { get } from '../api.js';
import { prefs, history, bus } from '../store.js';
import { createMasonry } from './masonry.js';
import { mediaCard } from './card.js';
import { openLightbox } from './lightbox.js';
import { routeKey } from '../router.js';

/* Feeds remember what they had loaded, per page, for a while after you leave. Coming back
 * (Back from a creator, or from the viewer's links) rebuilds the grid synchronously from this,
 * so the router can put you back at the same scroll position instead of at the top of a
 * freshly fetched, possibly reshuffled list. */
const STASH_MS = 15 * 60 * 1000;
const STASH_MAX = 10;
const stash = new Map();

// the whole id list must count (a removed 41st save is a different list), but keys stay short
const hashIds = (ids) => { let x = 0; for (const c of ids.join(',')) x = (Math.imul(x, 31) + c.charCodeAt(0)) | 0; return `${ids.length}:${x >>> 0}`; };

/** Forget remembered feeds: all of them, or those of one page (a routeKey). */
export function dropFeedStash(key) {
  if (!key) { stash.clear(); return; }
  for (const k of stash.keys()) if (k.startsWith(`${key}|`)) stash.delete(k);
}

/**
 * Infinite media feed. Owns the masonry, paging, empty/error states and the
 * lightbox "sequence" so next/prev walk the same list the user is looking at
 * (and keep loading more as they go).
 */
export function createFeed({ query = {}, endpoint = '/api/media', pageSize, empty, onTotal, onDone, ids, hideSeen = false, why = null }) {
  const root = h('div', { class: 'feed' });
  const masonry = createMasonry({ density: prefs.density, render: (item, d) => mediaCard(item, { open: openAt, compact: d === 's', why: why ? why(item) : null }) });
  const sentinel = h('div', { class: 'loadmore' });
  root.append(masonry.el, sentinel);

  let page = 0;
  let total = null;
  let loading = false;
  let done = false;
  let destroyed = false;
  let errored = false;
  let hidden = 0;
  let fetched = 0; // raw items received (masonry may hold fewer when hiding seen ones)
  let seed = Math.floor(Math.random() * 1e6);
  let limit = pageSize || (prefs.density === 's' ? 48 : 36);
  // what makes two feeds "the same list": per-visit random seeds and exclusions don't count
  const { seed: _s, exclude: _e, ...stable } = query;
  const stashKey = `${routeKey()}|${endpoint}|${JSON.stringify(stable)}|${hideSeen ? 1 : 0}|${ids ? hashIds(ids) : ''}`;

  function openAt(item) {
    const idx = masonry.items.findIndex((m) => m.id === item.id);
    openLightbox(masonry.items, Math.max(0, idx), { loadMore: () => load().then(() => masonry.items) });
  }

  // a caller arriving while a page is in flight (the viewer at the last item) waits for that page
  let inflight = null;
  function load() {
    if (loading && inflight) return inflight;
    inflight = loadPage();
    return inflight;
  }

  async function loadPage() {
    if (loading || done || destroyed) return;
    loading = true; errored = false;
    sentinel.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const idSlice = ids ? ids.slice(page * limit, (page + 1) * limit) : undefined;
      const res = await get(endpoint, { ...query, page: ids ? 0 : page, limit, seed: query.sort === 'random' ? seed : query.seed, ids: idSlice ? idSlice.join(',') : undefined, nocount: !ids && page > 0 ? '1' : undefined });
      if (destroyed) return;
      if (ids) res.items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); // keep "most recently saved first"
      if (ids) total = ids.length; else if (res.total !== null && res.total !== undefined) total = res.total;
      if (onTotal && (page === 0 || ids)) onTotal(total);
      // "Hide seen": drop anything this device already opened. Paging still follows the server's pages.
      const fresh = hideSeen ? res.items.filter((it) => !history.has(it.id)) : res.items;
      hidden += res.items.length - fresh.length;
      fetched += res.items.length;
      if (fresh.length) masonry.add(fresh);
      page++;
      done = ids ? page * limit >= ids.length : (res.items.length < limit || fetched >= total);
      if (!masonry.items.length && done && hidden) {
        sentinel.replaceChildren(emptyState({ icon: 'eye', title: 'You’ve seen everything here', text: `${hidden} item${hidden === 1 ? ' is' : 's are'} hidden because you already opened ${hidden === 1 ? 'it' : 'them'}. Turn off “Hide seen” to show them again.` }));
      } else if (!masonry.items.length && done) {
        sentinel.replaceChildren(empty || emptyState({ icon: 'search', title: 'Nothing here yet', text: 'Try changing the filters or search terms.' }));
      } else if (!masonry.items.length) {
        sentinel.replaceChildren(h('div', { class: 'spinner' }));
      } else if (done) {
        sentinel.replaceChildren(h('span', { class: 'muted' }, hidden ? `You’ve reached the end · ${hidden} seen item${hidden === 1 ? '' : 's'} hidden` : 'You’ve reached the end'));
        if (onDone) onDone(masonry.items.length);
      } else sentinel.replaceChildren();
    } catch (e) {
      errored = true;
      sentinel.replaceChildren(h('div', { class: 'stack', style: { justifyItems: 'center' } }, h('span', { class: 'muted' }, e.message || 'Could not load'), h('button', { class: 'btn sm', onclick: () => { load(); } }, icon('refresh', 'sm'), 'Retry')));
    } finally { loading = false; }
    keepFilled();
  }

  // IntersectionObserver only fires on *changes*. If a page of results does not push the sentinel
  // out of range (tall screens, small pages) nothing would ever fire again, so check explicitly.
  function keepFilled() {
    if (destroyed || done || errored) return;
    requestAnimationFrame(() => {
      if (destroyed || loading || done || errored || !root.isConnected) return;
      if (sentinel.getBoundingClientRect().top < window.innerHeight + 1100) load();
    });
  }

  const saved = stash.get(stashKey);
  stash.delete(stashKey);
  const restored = !!(saved && Date.now() - saved.at < STASH_MS);
  if (restored) {
    ({ page, total, done, fetched, hidden, seed, limit } = saved); // its own page size: density may have changed since
    masonry.add(saved.items);
    if (done) sentinel.replaceChildren(h('span', { class: 'muted' }, 'You’ve reached the end'));
    queueMicrotask(() => {
      if (destroyed) return;
      if (onTotal) onTotal(total);
      if (done && onDone) onDone(masonry.items.length); // fixed-id feeds reconcile missing items here
    });
  }

  const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting && !errored) load(); }, { rootMargin: '1100px 0px' });
  io.observe(sentinel);
  if (restored) keepFilled(); else setTimeout(load, 0); // first page does not depend on the observer's initial callback
  const offDensity = bus.on('density', (d) => { if (!destroyed) masonry.setDensity(d); });

  return {
    el: root,
    get items() { return masonry.items; },
    get total() { return total; },
    load,
    destroy() {
      if (!destroyed && masonry.items.length && !errored) {
        stash.set(stashKey, { at: Date.now(), items: masonry.items, page, total, done, fetched, hidden, seed, limit });
        while (stash.size > STASH_MAX) stash.delete(stash.keys().next().value);
      }
      destroyed = true; io.disconnect(); offDensity(); masonry.destroy();
    },
  };
}
