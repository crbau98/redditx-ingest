import { h, icon, fmt, emptyState, toast, promptDialog } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { prefs, platformLabel, follows, searches, tastes, history as viewHistory, bus } from '../store.js';
import { createFeed } from '../components/feed.js';
import { understand, findRelaxation, relatedRail } from '../smart.js';

const SORTS = [['trending', 'Trending'], ['recent', 'Newest'], ['top', 'Top rated'], ['random', 'Shuffle'], ['oldest', 'Oldest']];
const SINCE = [['', 'All time'], ['day', 'Past day'], ['week', 'Past week'], ['month', 'Past month'], ['year', 'Past year']];
// URL-only state that is not part of the filter itself (never saved, never sent to the API).
const UI_KEYS = ['smart', 'raw', 'relaxed', 'from', 'norelax', 'label'];

export async function explore(root, { query }) {
  const f = {
    type: query.get('type') || '', sort: query.get('sort') || (query.get('q') ? 'relevance' : 'recent'), platform: query.get('platform') || '',
    community: query.get('community') || '', tag: query.get('tag') || '', q: query.get('q') || '', since: query.get('since') || '', following: query.get('following') || '',
    tags: query.get('tags') || '', anytags: query.get('anytags') || '', creator: query.get('creator') || '',
    smart: query.get('smart') || '', raw: query.get('raw') || '', relaxed: query.get('relaxed') || '', from: query.get('from') || '', norelax: query.get('norelax') || '', label: query.get('label') || '',
  };
  const filterOnly = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !UI_KEYS.includes(k)));
  // Changing a filter by hand ends the "relaxed" notice (the new filters are the user's own now).
  const set = (patch) => {
    const next = { ...f, relaxed: '', from: '', norelax: '', ...patch };
    if (next.sort === 'relevance' && !next.q) next.sort = 'recent';
    if (!next.tags && !next.creator && !next.q && !next.anytags) { next.smart = ''; next.raw = ''; }
    navigate('/explore', next, { replace: true }); window.scrollTo({ top: 0 });
  };
  const tagList = f.tags ? f.tags.split(',').filter(Boolean) : [];
  const anyList = f.anytags ? f.anytags.split(',').filter(Boolean) : [];

  const followIds = f.following ? follows.list().map((c) => c.id).slice(0, 100) : null;
  const toApi = (x) => ({
    type: x.type, sort: x.sort === 'relevance' ? undefined : x.sort, platform: x.platform, community: x.community, tag: x.tag, q: x.q, since: x.since,
    tags: x.tags || undefined, anytags: x.anytags || undefined, creator: x.creator || undefined,
    creators: followIds ? (followIds.length ? followIds.join(',') : '00000000-0000-0000-0000-000000000000') : undefined,
  });
  const anyFilter = f.q || f.tag || f.tags || f.anytags || f.creator || f.community || f.following;
  const titleText = f.sort === 'foryou' && !anyFilter ? 'For you' : f.smart && f.raw ? `“${f.raw}”` : f.following ? 'Following' : f.anytags && f.label ? f.label
    : f.q && !f.tags ? `Results for “${f.q}”` : tagList.length ? tagList.map((t) => `#${t}`).join(' + ') : f.tag ? `#${f.tag}` : f.community ? f.community : 'Explore';
  const titleEl = h('h1', null, titleText);
  document.title = `${titleText} — PRISM`;
  const count = h('div', { class: 'sub' }, ' ');

  const sortOptions = [...(f.q ? [['relevance', 'Best match']] : []), ...(tastes.ready() || f.sort === 'foryou' ? [['foryou', 'For you']] : []), ...SORTS];
  const forYou = f.sort === 'foryou';
  const typeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Media type' }, [['', 'All', 'grid'], ['image', 'Photos', 'image'], ['video', 'Videos', 'video']].map(([v, l, ic]) =>
    h('button', { class: f.type === v ? 'on' : '', onclick: () => set({ type: v }), 'aria-pressed': String(f.type === v) }, icon(ic, 'sm'), l)));
  const sortSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Sort', onchange: (e) => set({ sort: e.target.value }) }, sortOptions.map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));
  const sinceSel = ['top', 'trending'].includes(f.sort) || f.since ? h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Time range', onchange: (e) => set({ since: e.target.value }) }, SINCE.map(([v, l]) => h('option', { value: v, selected: f.since === v }, l))) : null;
  const platSel = h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Source', onchange: (e) => set({ platform: e.target.value }) }, h('option', { value: '' }, 'All sources'));
  const density = h('div', { class: 'seg hide-mobile', role: 'group', 'aria-label': 'Density' }, [['s', 'Dense'], ['m', 'Cozy'], ['l', 'Large']].map(([v, l]) =>
    h('button', { class: prefs.density === v ? 'on' : '', onclick: (e) => { prefs.density = v; density.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, l)));

  // Every active filter is a removable chip. For a smart search they sit in the "Understood as" banner instead.
  const active = [];
  const chip = (label, patch, cls = '') => active.push(h('button', { class: `chip on x ${cls}`.trim(), onclick: () => set(patch), 'aria-label': `Remove filter ${label}` }, label));
  if (f.q) chip(`“${f.q}”`, { q: '' }, 'u-text');
  for (const t of tagList) chip(`#${t}`, { tags: tagList.filter((x) => x !== t).join(',') }, 'u-tag');
  if (f.tag) chip(`#${f.tag}`, { tag: '' }, 'u-tag');
  if (f.anytags) chip(f.label ? `Topic: ${f.label}` : `Any of ${anyList.map((t) => `#${t}`).join(' ')}`, { anytags: '', label: '' }, 'u-topic');
  const creatorChip = f.creator ? h('button', { class: 'chip on x u-creator', onclick: () => set({ creator: '' }), 'aria-label': 'Remove creator filter' }, 'by creator') : null;
  if (creatorChip) active.push(creatorChip);
  if (f.community) chip(f.community, { community: '' }, 'u-community');
  if (f.platform) chip(platformLabel(f.platform), { platform: '' }, 'u-platform');
  if (f.since) chip(SINCE.find((s) => s[0] === f.since)[1], { since: '' }, 'u-since');
  if (f.smart && f.type) chip(f.type === 'video' ? 'Videos' : 'Photos', { type: '' }, 'u-type');
  let creatorName = null;
  if (f.creator) {
    get(`/api/creators/${f.creator}`).then((c) => {
      creatorName = c.display_name || c.handle;
      creatorChip.textContent = `by ${creatorName}`;
      if (titleText === 'Explore') { titleEl.textContent = creatorName; document.title = `${creatorName} — PRISM`; }
    }).catch(() => {});
  }

  // Smart search banner: shows how the typed words were read, with an escape hatch to plain words.
  let banner = null;
  if (f.smart && f.raw) {
    const fixes = h('div', { class: 'u-fixes' });
    banner = h('div', { class: 'understood', role: 'status' },
      h('div', { class: 'u-head' }, h('span', { class: 'u-spark' }, icon('sparkle', 'sm')), h('span', null, 'Understood as'), h('div', { class: 'u-chips' }, active.splice(0)),
        h('a', { class: 'u-raw', href: href('/explore', { q: f.raw }), title: 'Run a plain full-text search instead' }, 'Search the exact words')),
      fixes);
    understand(f.raw).then((u) => {
      if (u && u.corrections && u.corrections.length) fixes.replaceChildren(icon('check', 'sm'), 'Spelling fixed: ', ...u.corrections.map((c, i) => h('span', null, i ? ', ' : '', h('s', null, c.from), ' → ', h('b', null, `#${c.to}`))));
    });
  }
  // When nothing matched everything, a smart search drops the least important filter(s) and says so.
  const relaxedNote = f.relaxed ? h('div', { class: 'relaxed-note', role: 'status' }, icon('info', 'sm'),
    h('span', null, 'Nothing matched everything, so this shows results without ', h('b', null, f.relaxed), '.'),
    f.from ? h('a', { class: 'btn sm ghost', href: `#/explore?${f.from}&norelax=1` }, 'Show exact matches') : null) : null;

  // Smart feeds: save this exact filter set; Home then shows how many new items arrived since you last looked.
  const saveBtn = h('button', { class: 'btn sm' });
  const saveKey = filterOnly(f);
  const paintSave = () => { const s = searches.find(saveKey); saveBtn.className = `btn sm${s ? ' on' : ''}`; saveBtn.replaceChildren(icon('bookmark', `sm${s ? ' fill' : ''}`), s ? 'Saved feed' : 'Save as feed'); saveBtn.title = s ? 'Remove this smart feed' : 'Save these filters as a smart feed'; };
  saveBtn.addEventListener('click', async () => {
    const existing = searches.find(saveKey);
    if (existing) { searches.remove(existing.id); toast('Smart feed removed'); paintSave(); return; }
    const name = await promptDialog({ title: 'Save as smart feed', sub: 'It appears on Home with a count of what’s new since your last visit.', label: 'Name', value: titleEl.textContent === 'Explore' ? 'My feed' : titleEl.textContent.replace(/^Results for /, '').replace(/^“|”$/g, ''), confirmLabel: 'Save feed' });
    if (!name) return;
    const s = searches.add(name, saveKey); searches.markSeen(s.id);
    toast(`Saved “${s.name}”`, 'ok'); paintSave();
  });
  paintSave();
  const existingFeed = searches.find(saveKey);
  if (existingFeed) searches.markSeen(existingFeed.id);

  const seenChip = h('button', { class: `chip${prefs.hideSeen ? ' on' : ''}`, 'aria-pressed': String(prefs.hideSeen), title: 'Hide items you have already opened', onclick: () => { prefs.hideSeen = !prefs.hideSeen; } }, icon('eye', 'sm'), 'Hide seen');
  const reelsBtn = h('a', { class: 'btn sm', href: href('/reels', { type: f.type || 'all', sort: f.sort === 'relevance' || f.sort === 'oldest' ? 'recent' : f.sort, platform: f.platform, community: f.community, tag: f.tag, tags: f.tags, anytags: f.anytags, creator: f.creator, since: f.since, q: f.q, following: f.following }), title: 'Play these results full screen' }, icon('film', 'sm'), 'Play as Reels');

  const followChip = h('button', { class: `chip${f.following ? ' on' : ''}`, 'aria-pressed': String(!!f.following), onclick: () => set({ following: f.following ? '' : '1' }) }, icon('heart', 'sm'), 'Following');
  const bar = h('div', { class: 'filterbar' }, typeSeg, followChip, seenChip, sortSel, sinceSel, platSel, h('span', { class: 'spacer' }), density, active.length ? h('div', { class: 'active-filters' }, active) : null);

  // Tag rail: with tags in play, show tags that go with them (click narrows); otherwise the most used tags.
  const focusTags = [...tagList, ...(f.tag ? [f.tag] : []), ...anyList].slice(0, 4);
  const addTag = (name) => set({ tag: '', tags: [...new Set([...tagList, ...(f.tag ? [f.tag] : []), name])].slice(0, 6).join(',') });
  const tagRail = focusTags.length ? relatedRail(focusTags, { onPick: addTag, title: 'Narrow with' }) : h('div', { class: 'row', style: { gap: '8px', overflowX: 'auto', padding: '14px 0 2px', scrollbarWidth: 'none' } });

  const emptyHost = h('div', { class: 'stack', style: { justifyItems: 'center' } },
    f.following && !followIds.length ? emptyState({ icon: 'heart', title: 'You’re not following anyone yet', text: 'Follow creators from their profile and their newest posts will collect here.', actions: [h('a', { class: 'btn primary', href: href('/creators') }, 'Browse creators')] })
      : emptyState({ icon: 'search', title: 'No matches', text: f.q || f.tags ? 'Try fewer words, or remove a filter.' : 'Nothing has been ingested for these filters yet.', actions: [h('a', { class: 'btn', href: href('/explore') }, 'Clear filters')] }));

  async function onEmpty() {
    if (f.norelax || forYou) return;
    const r = await findRelaxation(f, toApi, { creatorName });
    if (!r || !root.isConnected) return;
    if (f.smart) {
      const from = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && !['relaxed', 'from', 'norelax'].includes(k))).toString();
      navigate('/explore', { ...f, ...r.patch, relaxed: r.label, from }, { replace: true });
      return;
    }
    emptyHost.append(h('button', { class: 'btn primary', onclick: () => set(r.patch) }, icon('sparkle', 'sm'), `Try without ${r.label} — ${fmt.int(r.total)} ${r.total === 1 ? 'result' : 'results'}`));
  }

  const makeFeed = () => createFeed(forYou ? {
    // Personal ranking from this device's taste; other filters narrow by type only.
    endpoint: '/api/recommend', hideSeen: prefs.hideSeen,
    query: { ...tastes.query({ exclude: viewHistory.list().slice(0, 100) }), type: f.type, seed: Math.floor(Math.random() * 1e6) },
    onTotal: (t) => { count.textContent = tastes.ready() ? `Picked for you from ${fmt.int(t)} matches` : 'Trending — save or watch a few things and this becomes yours'; },
  } : {
    hideSeen: prefs.hideSeen,
    query: toApi(f),
    onTotal: (t) => { count.textContent = `${fmt.int(t)} ${t === 1 ? 'result' : 'results'}`; if (t === 0) onEmpty(); },
    empty: emptyHost,
  });
  let feed = makeFeed();

  root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, titleEl, count), h('div', { class: 'row wrap' }, reelsBtn, saveBtn)), banner, relaxedNote, bar, tagRail, h('div', { style: { height: '14px' } }), feed.el);
  const offSearches = bus.on('searches', paintSave);
  // Toggling "Hide seen" (here or from the palette) rebuilds the feed in place.
  const offSeen = bus.on('hideSeen', (on) => {
    seenChip.classList.toggle('on', on); seenChip.setAttribute('aria-pressed', String(on));
    const old = feed; feed = makeFeed(); old.el.replaceWith(feed.el); old.destroy();
  });

  // Fill the dynamic option lists without blocking the feed.
  get('/api/platforms').then((list) => { for (const p of list) platSel.appendChild(h('option', { value: p.platform, selected: f.platform === p.platform }, `${platformLabel(p.platform)} (${fmt.num(p.count)})`)); }).catch(() => {});
  if (!focusTags.length) {
    get('/api/tags', { limit: 30 }).then((tags) => {
      tagRail.replaceChildren(...tags.map((t) => h('button', { class: 'chip', onclick: () => set({ tag: t.name }) }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count)))));
    }).catch(() => {});
  }

  return () => { feed.destroy(); offSearches(); offSeen(); };
}

