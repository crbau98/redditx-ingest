import { h, icon, fmt, emptyState } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { prefs, platforms, platformLabel } from '../store.js';
import { createFeed } from '../components/feed.js';

const SORTS = [['trending', 'Trending'], ['recent', 'Newest'], ['top', 'Top rated'], ['random', 'Shuffle'], ['oldest', 'Oldest']];
const SINCE = [['', 'All time'], ['day', 'Past day'], ['week', 'Past week'], ['month', 'Past month'], ['year', 'Past year']];

export async function explore(root, { query }) {
  const f = {
    type: query.get('type') || '', sort: query.get('sort') || (query.get('q') ? 'relevance' : 'recent'), platform: query.get('platform') || '',
    community: query.get('community') || '', tag: query.get('tag') || '', q: query.get('q') || '', since: query.get('since') || '',
  };
  const set = (patch) => { const next = { ...f, ...patch }; if (next.sort === 'relevance' && !next.q) next.sort = 'recent'; navigate('/explore', next, { replace: true }); window.scrollTo({ top: 0 }); };

  const title = f.q ? `Results for “${f.q}”` : f.tag ? `#${f.tag}` : f.community ? f.community : 'Explore';
  document.title = `${title} — PRISM`;
  const count = h('div', { class: 'sub' }, ' ');

  const sortOptions = f.q ? [['relevance', 'Best match'], ...SORTS] : SORTS;
  const typeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Media type' }, [['', 'All', 'grid'], ['image', 'Photos', 'image'], ['video', 'Videos', 'video']].map(([v, l, ic]) =>
    h('button', { class: f.type === v ? 'on' : '', onclick: () => set({ type: v }), 'aria-pressed': String(f.type === v) }, icon(ic, 'sm'), l)));
  const sortSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Sort', onchange: (e) => set({ sort: e.target.value }) }, sortOptions.map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));
  const sinceSel = ['top', 'trending'].includes(f.sort) ? h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Time range', onchange: (e) => set({ since: e.target.value }) }, SINCE.map(([v, l]) => h('option', { value: v, selected: f.since === v }, l))) : null;
  const platSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Source', onchange: (e) => set({ platform: e.target.value }) }, h('option', { value: '' }, 'All sources'));
  const density = h('div', { class: 'seg hide-mobile', role: 'group', 'aria-label': 'Density' }, [['s', 'Dense'], ['m', 'Cozy'], ['l', 'Large']].map(([v, l]) =>
    h('button', { class: prefs.density === v ? 'on' : '', onclick: (e) => { prefs.density = v; density.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, l)));

  const active = [];
  const chip = (label, key) => active.push(h('button', { class: 'chip on x', onclick: () => set({ [key]: '' }), 'aria-label': `Remove filter ${label}` }, label));
  if (f.q) chip(`“${f.q}”`, 'q'); if (f.tag) chip(`#${f.tag}`, 'tag'); if (f.community) chip(f.community, 'community'); if (f.platform) chip(platformLabel(f.platform), 'platform'); if (f.since) chip(SINCE.find((s) => s[0] === f.since)[1], 'since');

  const bar = h('div', { class: 'filterbar' }, typeSeg, sortSel, sinceSel, platSel, h('span', { class: 'spacer' }), density, active.length ? h('div', { class: 'active-filters' }, active) : null);
  const tagRail = h('div', { class: 'row', style: { gap: '8px', overflowX: 'auto', padding: '14px 0 2px', scrollbarWidth: 'none' } });

  const feed = createFeed({
    query: { ...f, sort: f.sort === 'relevance' ? undefined : f.sort },
    onTotal: (t) => { count.textContent = `${fmt.int(t)} ${t === 1 ? 'result' : 'results'}`; },
    empty: emptyState({ icon: 'search', title: 'No matches', text: f.q ? 'Try a shorter search, or remove a filter.' : 'Nothing has been ingested for these filters yet.', actions: [h('a', { class: 'btn', href: href('/explore') }, 'Clear filters')] }),
  });

  root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), count)), bar, tagRail, h('div', { style: { height: '14px' } }), feed.el);

  // Fill the dynamic option lists without blocking the feed.
  get('/api/platforms').then((list) => { for (const p of list) platSel.appendChild(h('option', { value: p.platform, selected: f.platform === p.platform }, `${platformLabel(p.platform)} (${fmt.num(p.count)})`)); }).catch(() => {});
  get('/api/tags', { limit: 30 }).then((tags) => {
    tagRail.replaceChildren(...tags.map((t) => h('button', { class: `chip${f.tag === t.name ? ' on' : ''}`, onclick: () => set({ tag: f.tag === t.name ? '' : t.name }) }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count)))));
  }).catch(() => {});

  return () => feed.destroy();
}
