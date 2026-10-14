import { h, icon, avatar, fmt, debounce, $ } from '../dom.js';
import { get } from '../api.js';
import { navigate, setParam } from '../router.js';
import { prefs, searches, collections, platformLabel } from '../store.js';
import { smartSearch } from '../smart.js';

let open = null;

/** Open a random item in the viewer, wherever you are. */
export async function surpriseMe() {
  try {
    const r = await get('/api/media', { sort: 'random', seed: Math.floor(Math.random() * 2147483647), limit: 1 });
    if (r.items[0]) setParam('m', r.items[0].id, { replace: false });
  } catch { /* nothing to show */ }
}

function staticCommands() {
  const go = (path, query) => () => navigate(path, query || {});
  return [
    { group: 'Go to', icon: 'home', label: 'Home', run: go('/') },
    { group: 'Go to', icon: 'rss', label: 'Following', hint: 'new from creators you follow', run: go('/following') },
    { group: 'Go to', icon: 'compass', label: 'Explore', run: go('/explore') },
    { group: 'Go to', icon: 'film', label: 'Reels', hint: 'full-screen, swipe through', run: go('/reels') },
    { group: 'Go to', icon: 'layers', label: 'Browse tags & sources', run: go('/browse') },
    { group: 'Go to', icon: 'users', label: 'Creators', run: go('/creators') },
    { group: 'Go to', icon: 'search', label: 'Find a creator', hint: 'name, handle or link → follow all accounts', run: go('/find') },
    { group: 'Go to', icon: 'sparkle', label: 'Creator galaxy', hint: '3D map of who posts alike', run: go('/galaxy') },
    { group: 'Go to', icon: 'heart', label: 'Saved', run: go('/saved') },
    { group: 'Go to', icon: 'folder', label: 'Collections', run: go('/saved', { tab: 'collections' }) },
    { group: 'Go to', icon: 'history', label: 'History', run: go('/saved', { tab: 'history' }) },
    { group: 'Go to', icon: 'sliders', label: 'Admin console', run: go('/admin') },
    { group: 'Actions', icon: 'shuffle', label: 'Surprise me', hint: 'open something random', run: surpriseMe },
    { group: 'Actions', icon: 'shuffle', label: 'Shuffle reels', run: go('/reels', { sort: 'random', type: 'all' }) },
    { group: 'Actions', icon: 'video', label: 'Newest videos', run: go('/explore', { type: 'video', sort: 'recent' }) },
    { group: 'Actions', icon: 'flame', label: 'Trending this week', run: go('/explore', { sort: 'trending', since: 'week' }) },
    { group: 'Actions', icon: 'heart', label: 'Latest from people I follow', run: go('/following') },
    { group: 'Actions', icon: document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun', label: 'Toggle light / dark theme', run: () => { prefs.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; } },
    { group: 'Actions', icon: 'palette', label: 'Display settings', hint: 'theme, accent colour, grid', run: () => import('./display.js').then((m) => m.openDisplaySettings()) },
    { group: 'Actions', icon: 'eye', label: prefs.hideSeen ? 'Show items I’ve already seen' : 'Hide items I’ve already seen', run: () => { prefs.hideSeen = !prefs.hideSeen; } },
    ...searches.list().map((s) => ({ group: 'Smart feeds', icon: 'bookmark', label: s.name, run: () => { searches.markSeen(s.id); navigate('/explore', s.query); } })),
    ...collections.list().map((c) => ({ group: 'Collections', icon: 'folder', label: c.name, hint: `${c.items.length} item${c.items.length === 1 ? '' : 's'}`, run: () => navigate('/saved', { tab: 'collections', c: c.id }) })),
  ];
}

const norm = (s) => String(s || '').toLowerCase();
/** Every typed word must appear somewhere in the label (in order-insensitive fashion). */
const matches = (cmd, q) => q.split(/\s+/).filter(Boolean).every((w) => norm(`${cmd.label} ${cmd.group} ${cmd.hint || ''}`).includes(w));

export function openPalette() {
  if (open) { open.input.focus(); return; }
  const root = $('#modal-root');
  const prevFocus = document.activeElement;
  const input = h('input', { type: 'text', placeholder: 'Type a command, creator, tag…', 'aria-label': 'Command palette', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const overlay = h('div', { class: 'overlay palette-overlay', role: 'presentation' },
    h('div', { class: 'modal palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      h('div', { class: 'palette-input' }, icon('command'), input, h('kbd', { class: 'kbd' }, 'Esc')),
      list,
      h('div', { class: 'palette-foot' }, h('span', null, h('kbd', { class: 'kbd' }, '↑'), ' ', h('kbd', { class: 'kbd' }, '↓'), ' move'), h('span', null, h('kbd', { class: 'kbd' }, '↵'), ' open'), h('span', null, h('kbd', { class: 'kbd' }, '/'), ' search'), h('span', null, h('kbd', { class: 'kbd' }, '?'), ' shortcuts'))));

  const commands = staticCommands();
  let rows = []; let idx = 0; let remote = { creators: [], tags: [], communities: [] }; let token = 0;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove(); open = null;
    document.body.classList.toggle('no-scroll', !!$('.lb') || !!$('#modal-root').children.length || document.body.classList.contains('reels-mode'));
    if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch { /* ignore */ }
  };
  const run = (r) => { close(); r.run(); };
  const mark = (i) => { idx = i; rows.forEach((r, k) => { r.el.classList.toggle('on', k === i); r.el.setAttribute('aria-selected', String(k === i)); }); if (rows[i]) rows[i].el.scrollIntoView({ block: 'nearest' }); };

  function paint() {
    const q = norm(input.value.trim());
    const local = q ? commands.filter((c) => matches(c, q)) : commands.filter((c) => c.group !== 'Collections' || commands.filter((x) => x.group === 'Collections').indexOf(c) < 4);
    const dyn = [
      ...remote.creators.map((c) => ({ group: 'Creators', avatar: c, label: c.display_name || c.handle, hint: `@${c.handle} · ${fmt.num(c.media_count)} posts`, run: () => navigate(`/creator/${c.id}`) })),
      ...remote.tags.map((t) => ({ group: 'Tags', icon: 'tag', label: `#${t.name}`, hint: `${fmt.num(t.count)} items`, run: () => navigate('/explore', { tag: t.name }) })),
      ...remote.communities.map((c) => ({ group: 'Communities', icon: 'compass', label: c.name, hint: `${platformLabel(c.platform)} · ${fmt.num(c.count)}`, run: () => navigate('/explore', { community: c.name }) })),
    ];
    // Commands you typed the name of come first, then live matches, then a plain search as the fallback.
    const all = [...local, ...dyn, ...(q ? [{ group: 'Search', icon: 'search', label: `Search for “${input.value.trim()}”`, run: () => smartSearch(input.value) }] : [])];
    rows = [];
    const parts = [];
    let group = null;
    for (const c of all) {
      if (c.group !== group) { group = c.group; parts.push(h('div', { class: 'suggest-label' }, group)); }
      const el = h('a', { class: 'suggest-row', role: 'option', href: '#', 'aria-selected': 'false' }, c.avatar ? avatar(c.avatar, 26) : icon(c.icon || 'chev-r', 'sm'), h('span', { class: 'truncate' }, c.label), c.hint ? h('span', { class: 'n' }, c.hint) : null);
      const row = { el, run: c.run };
      el.addEventListener('click', (e) => { e.preventDefault(); run(row); });
      el.addEventListener('mousemove', () => { const k = rows.indexOf(row); if (k !== idx) mark(k); });
      rows.push(row); parts.push(el);
    }
    list.replaceChildren(...(parts.length ? parts : [h('p', { class: 'muted', style: { padding: '18px', textAlign: 'center' } }, 'No matches')]));
    mark(0);
  }

  const fetchRemote = debounce(async () => {
    const q = input.value.trim();
    const mine = ++token;
    if (!q) { remote = { creators: [], tags: [], communities: [] }; paint(); return; }
    try { const r = await get('/api/suggest', { q }); if (mine === token && open) { remote = r; paint(); } } catch { /* local commands still work */ }
  }, 140);
  input.addEventListener('input', () => { paint(); fetchRemote(); });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) mark((idx + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) mark((idx - 1 + rows.length) % rows.length); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (rows[idx]) run(rows[idx]); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  root.appendChild(overlay);
  document.body.classList.add('no-scroll');
  open = { input, close };
  paint();
  input.focus();
}

export const paletteOpen = () => !!open;
