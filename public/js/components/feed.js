import { h, icon, emptyState } from '../dom.js';
import { get, clearApiCache, prefetch } from '../api.js';
import { prefs, history, playback, bus } from '../store.js';
import { createMasonry } from './masonry.js';
import { mediaCard } from './card.js';
import { openLightbox } from './ondemand.js';
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

function resumeFrac(id) {
  const p = playback.get(id);
  if (!p || !p.d || p.t <= 0) return 0;
  return Math.min(0.96, p.t / p.d);
}

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
export function createFeed({ query = {}, endpoint = '/api/media', fetchPage = null, pageSize, empty, failText = '', onTotal, onDone, onPage = null, ids, alsoIds = null, hideSeen = false, showProgress = false, why = null, quietEnd = false }) {
  const root = h('div', { class: 'feed' });
  const masonry = createMasonry({ density: prefs.density, render: (item, d, opts) => mediaCard(item, { open: openAt, compact: d === 's', why: why ? why(item) : null, eager: !!(opts && opts.eager), width: (opts && opts.width) || 0, progress: showProgress ? resumeFrac(item.id) : 0 }) });
  const sentinel = h('div', { class: 'loadmore' });
  const bones = h('div', { class: 'feed-skeletons', 'aria-hidden': 'true' });
  for (let i = 0; i < 8; i++) bones.append(h('div', { class: 'feed-bone' }));
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
  // Cursor mode is used where the server offers a stable key (media sorts). Fixed-id feeds and
  // custom fetchPage callers keep offset paging; an older server without nextCursor falls back too.
  const cursorSort = query.sort || 'recent';
  const canCursor = !ids && !fetchPage && endpoint === '/api/media' && ['recent', 'oldest', 'top', 'trending', 'ingested'].includes(cursorSort);
  let cursorMode = canCursor;
  let cursor = null;
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
      const pageIndex = page;
      const idSlice = ids ? ids.slice(pageIndex * limit, (pageIndex + 1) * limit) : undefined;
      // Resume points past the first page ride on that first request. They are not drawn in the grid.
      let asked = idSlice;
      if (idSlice && pageIndex === 0 && Array.isArray(alsoIds) && alsoIds.length) {
        const inSlice = new Set(idSlice);
        const extra = alsoIds.filter((id) => id && !inSlice.has(id));
        if (extra.length) asked = [...idSlice, ...extra];
      }
      const usingCursor = cursorMode && !!cursor;
      const params = { ...query, limit: asked ? asked.length : limit, seed: query.sort === 'random' ? seed : query.seed, ids: asked ? asked.join(',') : undefined,
        ...(ids
          ? { page: 0 }
          : usingCursor
            ? { cursor, nocount: '1' }
            : { page, ...(page > 0 ? { nocount: '1' } : {}) }) };
      // fetchPage: a feed whose request is not a plain GET (e.g. a follow list in a POST body)
      const res = await (fetchPage ? fetchPage(params) : get(endpoint, params));
      if (destroyed) return;
      let pageItems = res.items || [];
      let extraItems = [];
      if (idSlice && asked && asked.length !== idSlice.length) {
        const inSlice = new Set(idSlice);
        extraItems = pageItems.filter((it) => it && !inSlice.has(it.id));
        pageItems = pageItems.filter((it) => it && inSlice.has(it.id));
      }
      if (ids) pageItems.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); // keep "most recently saved first"
      if (ids) total = ids.length; else if (res.total !== null && res.total !== undefined) total = res.total;
      if (onTotal && (pageIndex === 0 || ids)) onTotal(total);
      // The first cursor-capable response decides the mode. A server without nextCursor keeps offset paging.
      if (!ids && cursorMode && !usingCursor && !('nextCursor' in res)) cursorMode = false;
      if (!ids && cursorMode) cursor = res.nextCursor || null;
      // "Hide seen": drop anything this device already opened. Paging still follows the server's pages.
      const fresh = hideSeen ? pageItems.filter((it) => !history.has(it.id)) : pageItems;
      hidden += pageItems.length - fresh.length;
      fetched += pageItems.length;
      if (fresh.length) masonry.add(fresh);
      if (onPage) onPage({ page: pageIndex, items: pageItems, extra: extraItems });
      page++;
      done = ids
        ? page * limit >= ids.length
        : cursorMode
          ? ((res.items || []).length < limit || !res.nextCursor)
          : ((res.items || []).length < limit || fetched >= total);
      if (bones.isConnected && (masonry.items.length || done)) bones.remove();
      if (!done && !ids && !fetchPage) {
        const next = cursorMode && cursor
          ? { ...query, limit, cursor, nocount: '1' }
          : { ...query, limit, page, nocount: '1', seed: query.sort === 'random' ? seed : query.seed };
        prefetch(endpoint, next);
      }
      if (!masonry.items.length && done && hidden) {
        sentinel.replaceChildren(emptyState({ icon: 'eye', title: 'You’ve seen everything here', text: `${hidden} item${hidden === 1 ? ' is' : 's are'} hidden because you already opened ${hidden === 1 ? 'it' : 'them'}. Turn off “Hide seen” to show them again.` }));
      } else if (!masonry.items.length && done) {
        sentinel.replaceChildren(empty || emptyState({ icon: 'search', title: 'Nothing here yet', text: 'Try changing the filters or search terms.' }));
      } else if (!masonry.items.length) {
        sentinel.replaceChildren(h('div', { class: 'spinner' }));
      } else if (done) {
        // quietEnd: a feed with more below it (Following's "new" part) ends without an end note
        sentinel.replaceChildren(quietEnd ? '' : h('span', { class: 'muted' }, hidden ? `You’ve reached the end · ${hidden} seen item${hidden === 1 ? '' : 's'} hidden` : 'You’ve reached the end'));
        if (onDone) onDone(masonry.items.length);
      } else sentinel.replaceChildren();
    } catch (e) {
      errored = true;
      if (bones.isConnected) bones.remove();
      sentinel.replaceChildren(h('div', { class: 'stack', style: { justifyItems: 'center' } }, h('span', { class: 'muted' }, failText || e.message || 'Could not load'), h('button', { class: 'btn sm', onclick: () => { load(); } }, icon('refresh', 'sm'), 'Retry')));
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
  // "Hide seen" means what you have opened since, too (e.g. the item you left the page through)
  const keep = saved ? (hideSeen ? saved.items.filter((it) => !history.has(it.id)) : saved.items) : [];
  const restored = !!(saved && keep.length && Date.now() - saved.at < STASH_MS);
  if (restored) {
    ({ page, total, done, fetched, hidden, seed, limit, cursor, cursorMode } = saved); // its own page size: density may have changed since
    hidden += saved.items.length - keep.length;
    masonry.add(keep);
    if (done && !quietEnd) sentinel.replaceChildren(h('span', { class: 'muted' }, 'You’ve reached the end'));
    queueMicrotask(() => {
      if (destroyed) return;
      if (onPage) onPage({ page: 0, items: keep, extra: [], restored: true });
      if (onTotal) onTotal(total);
      if (done && onDone) onDone(masonry.items.length); // fixed-id feeds reconcile missing items here
    });
  } else root.insertBefore(bones, masonry.el);

  const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting && !errored) load(); }, { rootMargin: '1100px 0px' });
  io.observe(sentinel);
  if (restored) keepFilled(); else setTimeout(load, 0); // first page does not depend on the observer's initial callback
  const offDensity = bus.on('density', (d) => { if (!destroyed) masonry.setDensity(d); });

  async function refresh() {
    // A pull can land while a page is still in flight. Let it finish first: otherwise loadPage()
    // below returns at once on `loading`, and the old page's items would be appended to the
    // cleared grid with the page counter already back at zero (duplicates on the next load).
    if (inflight) { try { await inflight; } catch { /* loadPage reports its own errors */ } }
    if (destroyed) return;
    page = 0;
    total = null;
    done = false;
    errored = false;
    hidden = 0;
    fetched = 0;
    seed = Math.floor(Math.random() * 1e6);
    cursor = null;
    cursorMode = canCursor;
    // A pull asks for what is new now: api.js keeps public GETs for 30 s, so without this the
    // "refresh" would re-render the response the page already had.
    clearApiCache();
    masonry.clear();
    if (!bones.isConnected) root.insertBefore(bones, masonry.el);
    dropFeedStash(routeKey());
    return loadPage();
  }

  return {
    el: root,
    get items() { return masonry.items; },
    get total() { return total; },
    load,
    refresh,
    destroy() {
      if (!destroyed && masonry.items.length && !errored) {
        stash.set(stashKey, { at: Date.now(), items: masonry.items, page, total, done, fetched, hidden, seed, limit, cursor, cursorMode });
        while (stash.size > STASH_MAX) stash.delete(stash.keys().next().value);
      }
      destroyed = true; io.disconnect(); offDensity(); masonry.destroy();
    },
  };
}
