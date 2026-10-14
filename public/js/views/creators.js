import { h, icon, fmt, debounce, emptyState } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { platformLabel } from '../store.js';
import { creatorCard } from '../components/creator-card.js';

const SORTS = [['media', 'Most posts'], ['score', 'Top rated'], ['recent', 'Recently active'], ['new', 'Newest'], ['name', 'A–Z']];

export async function creators(root, { query }) {
  document.title = 'Creators — PRISM';
  const PAID_OPTS = [['', 'All creators'], ['onlyfans', 'OnlyFans'], ['fansly', 'Fansly'], ['justforfans', 'JustFor.Fans'], ['manyvids', 'ManyVids'], ['loyalfans', 'LoyalFans']];
  const f = { q: query.get('q') || '', sort: query.get('sort') || 'media', platform: query.get('platform') || '', paid: query.get('paid') || (query.get('onlyfans') === '1' ? 'onlyfans' : '') };
  const set = (patch) => {
    const next = { ...f, ...patch };
    delete next.onlyfans;
    navigate('/creators', next, { replace: true });
  };

  const count = h('div', { class: 'sub' }, ' ');
  const search = h('input', { class: 'input sm', type: 'search', placeholder: 'Search creators…', value: f.q, style: { maxWidth: '260px' }, 'aria-label': 'Search creators' });
  search.addEventListener('input', debounce(() => set({ q: search.value.trim() }), 350));
  const sortSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Sort creators', onchange: (e) => set({ sort: e.target.value }) }, SORTS.map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));
  const platSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Filter by free source', onchange: (e) => set({ platform: e.target.value }) }, h('option', { value: '' }, 'All sources'));
  const paidSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Filter by paid page (link-outs, never fetched)', title: 'Creators with a paid page (link-outs, never fetched)', onchange: (e) => set({ paid: e.target.value }) },
    PAID_OPTS.map(([v, l]) => h('option', { value: v, selected: (f.paid || '') === v }, l)));
  const field = (label, el) => h('label', { class: 'filter-field' }, h('span', { class: 'filter-label' }, label), el);
  const filtersActive = Boolean(f.q || f.sort !== 'media' || f.platform || f.paid);
  const clearBtn = filtersActive ? h('button', { class: 'chip clear-all', onclick: () => { search.value = ''; navigate('/creators', {}, { replace: true }); }, 'aria-label': 'Clear all creator filters' }, 'Clear all') : null;
  const grid = h('div', { class: 'creator-grid' });
  const more = h('div', { class: 'loadmore' });
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Creators'), count, h('div', { class: 'sub' }, 'Everyone with posts in the library — or pull someone new in below.')),
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn primary sm', href: href('/find') }, icon('search', 'sm'), 'Find a creator'),
        h('a', { class: 'btn galaxy-cta sm', href: href('/galaxy') }, icon('sparkle', 'sm'), 'Explore as a 3D galaxy'))),
    h('div', { class: 'row wrap creator-filters', style: { marginBottom: '18px' } }, search, field('Sort', sortSel), field('Source', platSel), field('Paid page', paidSel), clearBtn),
    grid, more);

  get('/api/platforms').then((list) => { for (const p of list) platSel.appendChild(h('option', { value: p.platform, selected: f.platform === p.platform }, platformLabel(p.platform))); }).catch(() => {});

  let page = 0; let total = 0; let loading = false; let destroyed = false; let done = false;
  async function load() {
    if (loading || done || destroyed) return;
    loading = true;
    more.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const params = { ...f, page, limit: 36 };
      if (params.paid) params.onlyfans = params.paid === 'onlyfans' ? '1' : undefined;
      const r = await get('/api/creators', params);
      if (destroyed) return;
      total = r.total; count.textContent = `${fmt.int(total)} ${total === 1 ? 'creator' : 'creators'}`;
      grid.append(...r.items.map((c) => creatorCard(c)));
      page++;
      done = grid.children.length >= total;
      if (!grid.children.length) more.replaceChildren(emptyState({ icon: 'users', title: 'No creators found', text: f.q ? `Nothing matches “${f.q}” with these filters. Try fewer filters — or pull him in directly.` : f.paid ? 'No creators with that paid page yet. Discovery adds them as it traces the pages creators promote.' : 'Creators appear here once their content has been ingested.', actions: [h('a', { class: 'btn primary', href: href('/find') }, icon('search', 'sm'), 'Find a creator'), filtersActive ? h('button', { class: 'btn', onclick: () => navigate('/creators', {}, { replace: true }) }, 'Clear filters') : null].filter(Boolean) }));
      else more.replaceChildren(done ? h('span', { class: 'muted' }, 'That’s everyone') : h('button', { class: 'btn', onclick: load }, 'Load more'));
    } catch (e) { more.replaceChildren(h('span', { class: 'muted' }, e.message), h('button', { class: 'btn sm', onclick: load }, 'Retry')); }
    finally { loading = false; }
  }
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && page > 0) load(); }, { rootMargin: '800px' });
  io.observe(more);
  await load();
  return () => { destroyed = true; io.disconnect(); };
}
