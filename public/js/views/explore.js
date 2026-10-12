import { h, icon, fmt, emptyState, toast, promptDialog } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { prefs, platforms, platformLabel, follows, searches, bus } from '../store.js';
import { createFeed } from '../components/feed.js';

const SORTS = [['trending', 'Trending'], ['recent', 'Newest'], ['top', 'Top rated'], ['random', 'Shuffle'], ['oldest', 'Oldest']];
const SINCE = [['', 'All time'], ['day', 'Past day'], ['week', 'Past week'], ['month', 'Past month'], ['year', 'Past year']];

export async function explore(root, { query }) {
  const f = {
    type: query.get('type') || '', sort: query.get('sort') || (query.get('q') ? 'relevance' : 'recent'), platform: query.get('platform') || '',
    community: query.get('community') || '', tag: query.get('tag') || '', q: query.get('q') || '', since: query.get('since') || '', following: query.get('following') || '',
  };
  const set = (patch) => { const next = { ...f, ...patch }; if (next.sort === 'relevance' && !next.q) next.sort = 'recent'; navigate('/explore', next, { replace: true }); window.scrollTo({ top: 0 }); };

  const followIds = f.following ? follows.list().map((c) => c.id).slice(0, 100) : null;
  const title = f.following ? 'Following' : f.q ? `Results for “${f.q}”` : f.tag ? `#${f.tag}` : f.community ? f.community : 'Explore';
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

  // Smart feeds: save this exact filter set; Home then shows how many new items arrived since you last looked.
  const saveBtn = h('button', { class: 'btn sm' });
  const paintSave = () => { const s = searches.find(f); saveBtn.className = `btn sm${s ? ' on' : ''}`; saveBtn.replaceChildren(icon('bookmark', `sm${s ? ' fill' : ''}`), s ? 'Saved feed' : 'Save as feed'); saveBtn.title = s ? 'Remove this smart feed' : 'Save these filters as a smart feed'; };
  saveBtn.addEventListener('click', async () => {
    const existing = searches.find(f);
    if (existing) { searches.remove(existing.id); toast('Smart feed removed'); paintSave(); return; }
    const name = await promptDialog({ title: 'Save as smart feed', sub: 'It appears on Home with a count of what’s new since your last visit.', label: 'Name', value: title === 'Explore' ? 'My feed' : title.replace(/^Results for /, ''), confirmLabel: 'Save feed' });
    if (!name) return;
    const s = searches.add(name, f); searches.markSeen(s.id);
    toast(`Saved “${s.name}”`, 'ok'); paintSave();
  });
  paintSave();
  const existingFeed = searches.find(f);
  if (existingFeed) searches.markSeen(existingFeed.id);

  const seenChip = h('button', { class: `chip${prefs.hideSeen ? ' on' : ''}`, 'aria-pressed': String(prefs.hideSeen), title: 'Hide items you have already opened', onclick: () => { prefs.hideSeen = !prefs.hideSeen; } }, icon('eye', 'sm'), 'Hide seen');
  const reelsBtn = h('a', { class: 'btn sm', href: href('/reels', { type: f.type || 'all', sort: f.sort === 'relevance' || f.sort === 'oldest' ? 'recent' : f.sort, platform: f.platform, community: f.community, tag: f.tag, q: f.q, following: f.following }), title: 'Play these results full screen' }, icon('film', 'sm'), 'Play as Reels');

  const followChip = h('button', { class: `chip${f.following ? ' on' : ''}`, 'aria-pressed': String(!!f.following), onclick: () => set({ following: f.following ? '' : '1' }) }, icon('heart', 'sm'), 'Following');
  const bar = h('div', { class: 'filterbar' }, typeSeg, followChip, seenChip, sortSel, sinceSel, platSel, h('span', { class: 'spacer' }), density, active.length ? h('div', { class: 'active-filters' }, active) : null);
  const tagRail = h('div', { class: 'row', style: { gap: '8px', overflowX: 'auto', padding: '14px 0 2px', scrollbarWidth: 'none' } });

  const makeFeed = () => createFeed({
    hideSeen: prefs.hideSeen,
    query: { ...f, following: undefined, creators: followIds ? (followIds.length ? followIds.join(',') : '00000000-0000-0000-0000-000000000000') : undefined, sort: f.sort === 'relevance' ? undefined : f.sort },
    onTotal: (t) => { count.textContent = `${fmt.int(t)} ${t === 1 ? 'result' : 'results'}`; },
    empty: f.following && !followIds.length ? emptyState({ icon: 'heart', title: 'You’re not following anyone yet', text: 'Follow creators from their profile and their newest posts will collect here.', actions: [h('a', { class: 'btn primary', href: href('/creators') }, 'Browse creators')] }) : emptyState({ icon: 'search', title: 'No matches', text: f.q ? 'Try a shorter search, or remove a filter.' : 'Nothing has been ingested for these filters yet.', actions: [h('a', { class: 'btn', href: href('/explore') }, 'Clear filters')] }),
  });
  let feed = makeFeed();

  root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), count), h('div', { class: 'row wrap' }, reelsBtn, saveBtn)), bar, tagRail, h('div', { style: { height: '14px' } }), feed.el);
  const offSearches = bus.on('searches', paintSave);
  // Toggling "Hide seen" (here or from the palette) rebuilds the feed in place.
  const offSeen = bus.on('hideSeen', (on) => {
    seenChip.classList.toggle('on', on); seenChip.setAttribute('aria-pressed', String(on));
    const old = feed; feed = makeFeed(); old.el.replaceWith(feed.el); old.destroy();
  });

  // Fill the dynamic option lists without blocking the feed.
  get('/api/platforms').then((list) => { for (const p of list) platSel.appendChild(h('option', { value: p.platform, selected: f.platform === p.platform }, `${platformLabel(p.platform)} (${fmt.num(p.count)})`)); }).catch(() => {});
  get('/api/tags', { limit: 30 }).then((tags) => {
    tagRail.replaceChildren(...tags.map((t) => h('button', { class: `chip${f.tag === t.name ? ' on' : ''}`, onclick: () => set({ tag: f.tag === t.name ? '' : t.name }) }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count)))));
  }).catch(() => {});

  return () => { feed.destroy(); offSearches(); offSeen(); };
}
