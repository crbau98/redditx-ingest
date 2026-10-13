import { h, icon, fmt, debounce, emptyState } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { platformLabel } from '../store.js';
import { creatorCard } from '../components/creator-card.js';

const SORTS = [['media', 'Most posts'], ['score', 'Top rated'], ['recent', 'Recently active'], ['new', 'Newest'], ['name', 'A–Z']];

export async function creators(root, { query }) {
  document.title = 'Creators — PRISM';
  const f = { q: query.get('q') || '', sort: query.get('sort') || 'media', platform: query.get('platform') || '', onlyfans: query.get('onlyfans') === '1' ? '1' : '' };
  const set = (patch) => navigate('/creators', { ...f, ...patch }, { replace: true });

  const count = h('div', { class: 'sub' }, ' ');
  const search = h('input', { class: 'input sm', type: 'search', placeholder: 'Search creators…', value: f.q, style: { maxWidth: '260px' }, 'aria-label': 'Search creators' });
  search.addEventListener('input', debounce(() => set({ q: search.value.trim() }), 350));
  const sortSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Sort', onchange: (e) => set({ sort: e.target.value }) }, SORTS.map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));
  const platSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Platform', onchange: (e) => set({ platform: e.target.value }) }, h('option', { value: '' }, 'All sources'));
  const ofChip = h('button', { class: `chip of-chip${f.onlyfans ? ' on' : ''}`, 'aria-pressed': String(!!f.onlyfans), title: 'Only creators with an OnlyFans page', onclick: () => set({ onlyfans: f.onlyfans ? '' : '1' }) },
    h('span', { class: 'of-mark', 'aria-hidden': 'true' }), 'OnlyFans');
  const grid = h('div', { class: 'creator-grid' });
  const more = h('div', { class: 'loadmore' });
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Creators'), count),
      h('a', { class: 'btn galaxy-cta', href: href('/galaxy') }, icon('sparkle', 'sm'), 'Explore as a 3D galaxy')),
    h('div', { class: 'row wrap', style: { marginBottom: '18px' } }, search, sortSel, platSel, ofChip),
    grid, more);

  get('/api/platforms').then((list) => { for (const p of list) platSel.appendChild(h('option', { value: p.platform, selected: f.platform === p.platform }, platformLabel(p.platform))); }).catch(() => {});

  let page = 0; let total = 0; let loading = false; let destroyed = false; let done = false;
  async function load() {
    if (loading || done || destroyed) return;
    loading = true;
    more.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const r = await get('/api/creators', { ...f, page, limit: 36 });
      if (destroyed) return;
      total = r.total; count.textContent = `${fmt.int(total)} ${total === 1 ? 'creator' : 'creators'}`;
      grid.append(...r.items.map((c) => creatorCard(c)));
      page++;
      done = grid.children.length >= total;
      if (!grid.children.length) more.replaceChildren(emptyState({ icon: 'users', title: 'No creators found', text: f.q ? 'Try a different name.' : f.onlyfans ? 'No OnlyFans creators yet. Discovery adds them as it traces the pages creators promote.' : 'Creators appear here once their content has been ingested.' }));
      else more.replaceChildren(done ? h('span', { class: 'muted' }, 'That’s everyone') : h('button', { class: 'btn', onclick: load }, 'Load more'));
    } catch (e) { more.replaceChildren(h('span', { class: 'muted' }, e.message), h('button', { class: 'btn sm', onclick: load }, 'Retry')); }
    finally { loading = false; }
  }
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && page > 0) load(); }, { rootMargin: '800px' });
  io.observe(more);
  await load();
  return () => { destroyed = true; io.disconnect(); };
}
