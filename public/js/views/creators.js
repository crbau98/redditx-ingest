import { h, icon, fmt, debounce, emptyState } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { platformLabel, follows } from '../store.js';
import { find } from './find.js';
import { creatorCard } from '../components/creator-card.js';

const SORTS = [['media', 'Most posts'], ['score', 'Top rated'], ['recent', 'Recently active'], ['new', 'Newest'], ['name', 'A–Z']];
/** "Posted in the last …": who is publishing right now. */
const FRESH = [['', 'Any time'], ['7', 'This week'], ['30', 'This month'], ['90', 'Last 3 months'], ['365', 'This year']];

export async function creators(root, { query }) {
  document.title = 'Creators — PRISM';
  const PAID_OPTS = [['', 'All creators'], ['onlyfans', 'OnlyFans'], ['fansly', 'Fansly'], ['justforfans', 'JustFor.Fans'], ['manyvids', 'ManyVids'], ['loyalfans', 'LoyalFans'], ['fancentro', 'FanCentro'], ['fanvue', 'Fanvue'], ['clips4sale', 'Clips4Sale']];
  const f = {
    q: query.get('q') || '', sort: query.get('sort') || 'media', platform: query.get('platform') || '',
    paid: query.get('paid') || (query.get('onlyfans') === '1' ? 'onlyfans' : ''),
    fresh: query.get('fresh') || '',
    following: query.get('following') || '',
    lookup: query.get('lookup') || '',
  };
  const set = (patch) => {
    const next = { ...f, ...patch };
    delete next.onlyfans;
    navigate('/creators', next, { replace: true });
  };

  const count = h('div', { class: 'sub' }, ' ');
  const search = h('input', {
    class: 'input sm',
    type: 'search',
    placeholder: 'Search creators (Enter for web lookup)…',
    value: f.q,
    style: { maxWidth: '240px' },
    'aria-label': 'Search creators',
  });
  const lookupHost = h('section', { class: 'creators-lookup-host', hidden: !f.lookup });
  const runInlineLookup = (qText) => {
    const qVal = (qText !== undefined ? qText : search.value).trim();
    lookupHost.hidden = false;
    const subQuery = new URLSearchParams(qVal ? { q: qVal } : {});
    find(lookupHost, { query: subQuery });
  };
  search.addEventListener('input', debounce(() => set({ q: search.value.trim(), lookup: '' }), 350));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && search.value.trim()) {
      e.preventDefault();
      runInlineLookup(search.value.trim());
    }
  });

  const isAll = !f.q && !f.paid && f.sort === 'media' && !f.platform && !f.fresh && !f.following;
  const allChip = h('button', {
    type: 'button',
    class: `chip${isAll ? ' on' : ''}`,
    'aria-pressed': String(isAll),
    title: 'Top creators: OnlyFans pages first, then everyone else by posts',
    onclick: () => { search.value = ''; navigate('/creators', {}, { replace: true }); },
  }, icon('flame', 'sm'), 'Top');

  const followingChip = h('button', {
    type: 'button',
    class: `chip${f.following ? ' on' : ''}`,
    'aria-pressed': String(!!f.following),
    title: 'Creators you follow on this device',
    onclick: () => set({ following: f.following ? '' : '1' }),
  }, icon('heart', 'sm'), 'Following');

  const ofChip = h('button', {
    type: 'button',
    class: `chip of-pill${f.paid === 'onlyfans' ? ' on' : ''}`,
    'aria-pressed': String(f.paid === 'onlyfans'),
    title: 'Only creators with an OnlyFans linkout',
    onclick: () => set({ paid: f.paid === 'onlyfans' ? '' : 'onlyfans' }),
  }, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), 'OnlyFans only');

  const newChip = h('button', {
    type: 'button',
    class: `chip${f.sort === 'new' ? ' on' : ''}`,
    'aria-pressed': String(f.sort === 'new'),
    title: 'Sort by newly discovered creators',
    onclick: () => set({ sort: f.sort === 'new' ? 'media' : 'new' }),
  }, icon('sparkle', 'sm'), 'New');

  // The other sorts live in the Filters panel as one menu instead of three more chips.
  const sortSel = h('select', {
    class: 'select sm',
    style: { width: 'auto' },
    'aria-label': 'Sort creators',
    onchange: (e) => set({ sort: e.target.value }),
  }, SORTS.map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));

  const platSel = h('select', {
    class: 'select sm',
    style: { width: 'auto' },
    'aria-label': 'Filter by free source',
    onchange: (e) => set({ platform: e.target.value }),
  }, h('option', { value: '' }, 'All sources'));

  const freshSel = h('select', {
    class: 'select sm',
    style: { width: 'auto' },
    'aria-label': 'Posted recently',
    onchange: (e) => set({ fresh: e.target.value }),
  }, FRESH.map(([v, l]) => h('option', { value: v, selected: f.fresh === v }, l)));

  const field = (label, el) => h('label', { class: 'filter-field' }, h('span', { class: 'filter-label' }, label), el);

  const filtersActive = Boolean(f.q || f.sort !== 'media' || f.platform || f.paid || f.fresh || f.following);
  const clearBtn = filtersActive ? h('button', {
    class: 'chip clear-all',
    onclick: () => { search.value = ''; navigate('/creators', {}, { replace: true }); },
    'aria-label': 'Clear all creator filters',
  }, 'Clear all') : null;

  // Secondary disclosure for Source and Activity
  const moreFilters = [field('Sort', sortSel), field('Source', platSel), field('Activity', freshSel)].filter(Boolean);
  const activeExtraCount = (f.platform ? 1 : 0) + (f.fresh ? 1 : 0) + (f.sort !== 'media' && f.sort !== 'new' ? 1 : 0);
  const filtersDisclosure = (() => {
    let open = window.matchMedia('(min-width: 900px)').matches && activeExtraCount > 0;
    const panel = h('div', { class: 'filter-more', hidden: !open }, moreFilters);
    const btn = h('button', {
      class: `chip filter-more-btn${activeExtraCount ? ' on' : ''}`,
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': 'creators-filter-more',
    }, icon('sliders', 'sm'), activeExtraCount ? `Filters · ${activeExtraCount}` : 'Filters');
    panel.id = 'creators-filter-more';
    btn.addEventListener('click', () => {
      open = !open;
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
    return [btn, panel];
  })();

  const grid = h('div', { class: 'creator-grid' });
  const more = h('div', { class: 'loadmore' });

  root.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', null, 'Creators'),
        count,
        h('div', { class: 'sub' },
          'Explore verified creators and direct OnlyFans linkouts in the library, or look up any creator across the open web.'
        )
      ),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'btn primary sm', onclick: () => runInlineLookup(search.value.trim()) }, icon('search', 'sm'), 'Look up on web')
      )
    ),
    h('div', { class: 'filterbar creator-filters', role: 'toolbar', 'aria-label': 'Creator filters' },
      h('div', { class: 'filter-scroll' },
        search,
        allChip,
        ofChip,
        followingChip,
        newChip,
        ...filtersDisclosure,
        clearBtn
      )
    ),
    lookupHost,
    grid,
    more
  );
  if (f.lookup) runInlineLookup(f.q);

  get('/api/platforms').then((list) => {
    for (const p of list) platSel.appendChild(h('option', { value: p.platform, selected: f.platform === p.platform }, platformLabel(p.platform)));
  }).catch(() => {});

  let page = 0; let total = 0; let loading = false; let destroyed = false; let done = false;
  async function load() {
    if (loading || done || destroyed) return;
    loading = true;
    more.replaceChildren(h('div', { class: 'spinner' }));
    try {
      const params = { ...f, fresh: f.fresh || undefined, page, limit: 36 };
      delete params.following; delete params.lookup;
      if (f.following) {
        const ids = follows.list().map((c) => c.id);
        if (!ids.length) {
          total = 0; count.textContent = '0 creators'; done = true;
          more.replaceChildren(emptyState({ icon: 'heart', title: 'Not following anyone yet', text: 'Follow creators across PRISM and filter to them here.', actions: [h('button', { class: 'btn primary', onclick: () => set({ following: '' }) }, 'Show all creators')] }));
          return;
        }
        params.ids = ids.slice(0, 150).join(',');
      }
      if (params.paid) params.onlyfans = params.paid === 'onlyfans' ? '1' : undefined;
      const r = await get('/api/creators', params);
      if (destroyed) return;
      total = r.total; count.textContent = `${fmt.int(total)} ${total === 1 ? 'creator' : 'creators'}`;
      grid.append(...r.items.map((c) => creatorCard(c)));
      page++;
      done = grid.children.length >= total;
      if (!grid.children.length) more.replaceChildren(emptyState({ icon: 'users', title: 'No creators found', text: f.q ? `No creators matched “${f.q}” with current filters. Try searching across the web or resetting filters.` : f.paid ? 'No creators found with that linkout yet. As new accounts are scanned, linkouts update automatically.' : 'Creators appear here once content has been indexed into the library.', actions: [h('button', { type: 'button', class: 'btn primary', onclick: () => runInlineLookup(f.q) }, icon('search', 'sm'), f.q ? `Find “${f.q}” across the web` : 'Find a creator'), filtersActive ? h('button', { class: 'btn', onclick: () => navigate('/creators', {}, { replace: true }) }, 'Clear filters') : null].filter(Boolean) }));
      else more.replaceChildren(done ? h('span', { class: 'muted' }, 'That’s everyone') : h('button', { class: 'btn', onclick: load }, 'Load more'));
    } catch (e) { more.replaceChildren(h('span', { class: 'muted' }, e.message), h('button', { class: 'btn sm', onclick: load }, 'Retry')); }
    finally { loading = false; }
  }
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && page > 0) load(); }, { rootMargin: '800px' });
  io.observe(more);
  await load();
  return () => { destroyed = true; io.disconnect(); };
}
