import { h, icon, fmt, toast, confirmDialog, promptDialog, emptyState, proxied } from '../dom.js';
import { get, query as postQuery } from '../api.js';
import { navigate, href } from '../router.js';
import { favorites, follows, collections, searches, history, prefs, platformLabel, recentSearches } from '../store.js';
import { createFeed } from '../components/feed.js';
import { creatorCard } from '../components/creator-card.js';
import { openLightbox } from '../components/lightbox.js';

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

const TABS = [['saved', 'Saved', 'heart'], ['collections', 'Collections', 'folder'], ['following', 'Following', 'users'], ['feeds', 'Smart feeds', 'bookmark'], ['history', 'History', 'history']];
const counts = { saved: () => favorites.count(), collections: () => collections.count(), following: () => follows.count(), feeds: () => searches.count(), history: () => history.count() };

/** Plain-language summary of a saved search ("Videos · #muscle · Bluesky"). */
function describeQuery(q) {
  return [q.q && `“${q.q}”`, q.type === 'video' ? 'Videos' : q.type === 'image' ? 'Photos' : null, q.tag && `#${q.tag}`, q.community, q.platform && platformLabel(q.platform), q.following && 'Following', q.since && `past ${q.since}`, q.sort && q.sort !== 'recent' && q.sort !== 'relevance' && q.sort]
    .filter(Boolean).join(' · ') || 'Everything';
}

/** A feed over a fixed list of ids that tells the user when some have disappeared. */
function idFeed(ids, { empty, onLoaded } = {}) {
  const note = h('p', { class: 'muted', style: { margin: '-6px 0 14px', fontSize: '13px' } });
  const feed = createFeed({
    ids, query: {}, endpoint: '/api/media', empty,
    // Items removed at the source (or by a takedown) quietly drop out; say so once we know.
    onDone: (loaded) => { const missing = ids.length - loaded; if (missing > 0) note.textContent = `${missing} item${missing === 1 ? ' is' : 's are'} no longer available.`; if (onLoaded) onLoaded(feed.items.map((x) => x.id)); },
  });
  return { el: h('div', null, note, feed.el), destroy: () => feed.destroy(), feed };
}

export async function saved(root, { query }) {
  document.title = 'Your library — PRISM';
  const tab = TABS.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'saved';
  const go = (t, extra = {}) => navigate('/saved', { tab: t, ...extra }, { replace: true });
  let cleanup = () => {};

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([key, label, ic]) => h('button', { class: tab === key ? 'on' : '', role: 'tab', 'aria-selected': String(tab === key), onclick: () => go(key) }, icon(ic, 'sm'), ` ${label} `, h('span', { class: 'muted num' }, counts[key]()))));

  const fileInput = h('input', { type: 'file', accept: 'application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; if (!file) return;
    try { const n = favorites.import(await file.text()); toast(`Imported ${n} saved item${n === 1 ? '' : 's'} plus collections, follows and smart feeds`, 'ok'); go(tab); }
    catch (e) { toast(e.message || 'Could not import that file', 'err'); }
  });
  const tools = h('div', { class: 'row wrap' },
    h('button', { class: 'btn sm', title: 'Saved items, collections, follows and smart feeds as one file', onclick: () => download(`prism-library-${new Date().toISOString().slice(0, 10)}.json`, favorites.export()) }, icon('download', 'sm'), 'Export'),
    h('button', { class: 'btn sm', onclick: () => fileInput.click() }, icon('upload', 'sm'), 'Import'), fileInput);

  const body = h('div');
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Your library'), h('div', { class: 'sub' }, 'Saved, collected, followed and watched on this device only — no account, nothing uploaded.')), tools),
    tabs, body);

  /* ------------------------------------------------------------- saved */
  if (tab === 'saved') {
    const ids = favorites.list();
    if (!ids.length) {
      body.replaceChildren(emptyState({ icon: 'heart', title: 'Nothing saved yet', text: 'Tap the heart on anything you like (or press F in the viewer) and it lands here.', actions: [h('a', { class: 'btn primary', href: href('/explore') }, 'Explore')] }));
    } else {
      const f = idFeed(ids);
      body.replaceChildren(h('div', { class: 'row wrap', style: { marginBottom: '14px' } },
        h('button', { class: 'btn sm primary', onclick: () => f.feed.items.length && openLightbox(f.feed.items, 0) }, icon('play', 'sm fill'), 'Play all'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('This only affects this device.', { title: 'Clear all saved items?', confirmLabel: 'Clear', danger: true })) { favorites.clear(); go('saved'); } } }, icon('trash', 'sm'), 'Clear')), f.el);
      cleanup = f.destroy;
    }
  }

  /* ------------------------------------------------------- collections */
  if (tab === 'collections') {
    const cid = query.get('c');
    const coll = cid ? collections.get(cid) : null;
    if (coll) {
      document.title = `${coll.name} — PRISM`;
      const head = h('div', { class: 'row wrap', style: { marginBottom: '14px', gap: '10px' } },
        h('a', { class: 'btn sm ghost', href: href('/saved', { tab: 'collections' }) }, icon('chev-l', 'sm'), 'All collections'),
        h('h2', { style: { fontSize: '22px', margin: '0 8px 0 0' } }, coll.name), h('span', { class: 'muted' }, `${coll.items.length} item${coll.items.length === 1 ? '' : 's'}`),
        h('span', { class: 'grow' }),
        coll.items.length ? h('button', { class: 'btn sm primary', onclick: () => f && f.feed.items.length && openLightbox(f.feed.items, 0) }, icon('play', 'sm fill'), 'Play all') : null,
        h('button', { class: 'btn sm', onclick: async () => { const n = await promptDialog({ title: 'Rename collection', label: 'Name', value: coll.name }); if (n) { collections.rename(coll.id, n); go('collections', { c: coll.id }); } } }, 'Rename'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('The items themselves stay in PRISM (and in Saved, if saved).', { title: `Delete “${coll.name}”?`, confirmLabel: 'Delete', danger: true })) { collections.remove(coll.id); go('collections'); } } }, icon('trash', 'sm'), 'Delete'));
      let f = null;
      if (!coll.items.length) body.replaceChildren(head, emptyState({ icon: 'folder', title: 'This collection is empty', text: 'Open anything and press C (or the bookmark button) to add it here.', actions: [h('a', { class: 'btn primary', href: href('/explore') }, 'Explore')] }));
      else { f = idFeed(coll.items, { onLoaded: (keep) => collections.prune(coll.id, keep) }); body.replaceChildren(head, f.el); cleanup = f.destroy; }
    } else {
      const list = collections.list();
      const newCard = h('button', { class: 'coll-card new', onclick: async () => { const n = await promptDialog({ title: 'New collection', label: 'Name', placeholder: 'e.g. Gym, Beach, Favourites…', confirmLabel: 'Create' }); if (n) { const c = collections.create(n); go('collections', { c: c.id }); } } }, icon('plus', 'lg'), 'New collection');
      const cards = list.map((c) => {
        const cover = h('div', { class: 'coll-cover' }, h('div'), h('div'), h('div'));
        return { c, cover, el: h('a', { class: 'coll-card', href: href('/saved', { tab: 'collections', c: c.id }) }, cover, h('div', { class: 'body' }, h('div', { class: 'name truncate' }, c.name), h('div', { class: 'muted', style: { fontSize: '13px' } }, `${c.items.length} item${c.items.length === 1 ? '' : 's'}`))) };
      });
      body.replaceChildren(list.length ? null : h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Group things you love into named collections — Gym, Outdoors, Cosplay, anything. Press C in the viewer to add to one.'), h('div', { class: 'coll-grid' }, newCard, cards.map((x) => x.el)));
      // One request fills every cover (first three items of each collection).
      const want = [...new Set(cards.flatMap((x) => x.c.items.slice(0, 3)))].slice(0, 100);
      if (want.length) {
        get('/api/media', { ids: want.join(','), limit: 100 }).then((r) => {
          const byId = new Map(r.items.map((m) => [m.id, m]));
          for (const x of cards) {
            x.c.items.filter((id) => byId.has(id)).slice(0, 3).forEach((id, i) => {
              const m = byId.get(id); const src = m.preview_url || m.thumbnail_url || (m.media_type === 'image' ? m.media_url : null);
              if (src) x.cover.children[i].style.backgroundImage = `url("${proxied(src)}")`;
            });
          }
        }).catch(() => {});
      }
    }
  }

  /* --------------------------------------------------------- following */
  if (tab === 'following') {
    const list = follows.list();
    if (!list.length) {
      body.replaceChildren(emptyState({ icon: 'users', title: 'Not following anyone', text: 'Follow creators from their profile, the viewer or Reels — the people land here, their newest posts under Following.', actions: [h('a', { class: 'btn primary', href: href('/creators') }, 'Browse creators')] }));
    } else {
      const grid = h('div', { class: 'creator-grid' }, list.map(() => h('div', { class: 'skeleton', style: { height: '260px' } })));
      body.replaceChildren(
        h('p', { class: 'muted', style: { margin: '-4px 0 14px', fontSize: '13.5px' } }, 'The people you follow on this device — their newest posts collect under ', h('a', { href: href('/following') }, 'Following'), '.'),
        h('div', { class: 'row wrap', style: { marginBottom: '14px' } },
        h('a', { class: 'btn sm primary', href: href('/reels', { following: '1', sort: 'recent', type: 'all' }) }, icon('film', 'sm'), 'Watch as Reels'),
        h('a', { class: 'btn sm', href: href('/following') }, icon('rss', 'sm'), 'Latest posts')), grid);
      // one request for every followed creator; ones the server no longer shows are dropped
      try {
        const d = await postQuery('/api/follow/summary', { follows: list.map((c) => ({ id: c.id, seen: c.seen })), cards: true });
        if (d.gone.length) follows.prune(d.gone);
        d.creators.sort((a, b) => String(b.last_media_at || '').localeCompare(String(a.last_media_at || '')));
        grid.replaceChildren(...d.creators.map((c) => creatorCard(c)));
      } catch (e) { grid.replaceChildren(h('p', { class: 'muted' }, e.message)); }
    }
  }

  /* ------------------------------------------------------- smart feeds */
  if (tab === 'feeds') {
    const list = searches.list();
    if (!list.length) {
      body.replaceChildren(emptyState({ icon: 'bookmark', title: 'No smart feeds yet', text: 'In Explore, set up any search or filter combination and press “Save as feed”. Home will then tell you how many new items have arrived since you last looked.', actions: [h('a', { class: 'btn primary', href: href('/explore') }, 'Open Explore')] }));
    } else {
      body.replaceChildren(h('div', { class: 'search-list' }, list.map((s) => {
        const badge = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '…');
        const q = { ...s.query }; delete q.following;
        if (s.query.following) { const ids = follows.list().map((c) => c.id).slice(0, 100); q.creators = ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000'; }
        if (q.sort === 'relevance') delete q.sort;
        get('/api/media', { ...q, after: s.seen, limit: 1 }).then((r) => { badge.replaceWith(r.total ? h('span', { class: 'badge good' }, `${fmt.int(r.total)} new`) : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'up to date')); }).catch(() => { badge.textContent = ''; });
        return h('div', { class: 'search-item' },
          icon('bookmark'),
          h('div', { class: 'grow', style: { minWidth: 0 } }, h('a', { href: href('/explore', s.query), onclick: () => searches.markSeen(s.id), style: { fontWeight: 650 } }, s.name), h('div', { class: 'q truncate' }, `${describeQuery(s.query)} · last checked ${fmt.ago(s.seen)}`)),
          badge,
          h('a', { class: 'btn sm', href: href('/reels', { ...s.query, type: s.query.type || 'all', sort: ['relevance', 'oldest'].includes(s.query.sort) ? 'recent' : s.query.sort }), title: 'Play as Reels' }, icon('film', 'sm')),
          h('button', { class: 'btn sm', onclick: async () => { const n = await promptDialog({ title: 'Rename smart feed', label: 'Name', value: s.name }); if (n) { searches.rename(s.id, n); go('feeds'); } } }, 'Rename'),
          h('button', { class: 'btn sm icon ghost', 'aria-label': `Delete ${s.name}`, title: 'Delete', onclick: () => { searches.remove(s.id); toast('Smart feed removed'); go('feeds'); } }, icon('trash', 'sm')));
      })));
    }
  }

  /* ----------------------------------------------------------- history */
  if (tab === 'history') {
    const ids = history.list();
    const pause = h('label', { class: 'row', style: { gap: '8px', fontSize: '13.5px' } }, h('input', { type: 'checkbox', checked: prefs.historyOff, onchange: (e) => { prefs.historyOff = e.target.checked; toast(e.target.checked ? 'History paused on this device' : 'History is on'); } }), 'Pause history');
    const hide = h('label', { class: 'row', style: { gap: '8px', fontSize: '13.5px' } }, h('input', { type: 'checkbox', checked: prefs.hideSeen, onchange: (e) => { prefs.hideSeen = e.target.checked; } }), 'Hide seen items in Explore');
    const bar = h('div', { class: 'row wrap', style: { marginBottom: '14px', gap: '16px' } }, pause, hide, h('span', { class: 'grow' }),
      ids.length ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Forget everything this device has opened, and its recent searches.', { title: 'Clear history?', confirmLabel: 'Clear', danger: true })) { history.clear(); recentSearches.clear(); go('history'); } } }, icon('trash', 'sm'), 'Clear history') : null);
    if (!ids.length) body.replaceChildren(bar, emptyState({ icon: 'history', title: prefs.historyOff ? 'History is paused' : 'Nothing watched yet', text: 'Everything you open in the viewer or Reels shows up here, newest first. It never leaves this device.' }));
    else { const f = idFeed(ids); body.replaceChildren(bar, f.el); cleanup = f.destroy; }
  }
  return () => cleanup();
}
