import { h, icon, fmt, toast, debounce, emptyState } from '../../dom.js';
import { adminGet, adminPost } from '../../api.js';
import { parse, navigate } from '../../router.js';
import { platformLabel } from '../../store.js';
import { pageHead, pager, act } from './ui.js';
import { selectableGrid } from './moderation.js';

export async function render(root) {
  const q = parse().query;
  const f = { state: q.get('state') || 'published', platform: q.get('platform') || '', type: q.get('type') || '', q: q.get('q') || '', page: parseInt(q.get('page') || '0', 10) };
  const set = (patch) => navigate('/admin/media', { ...f, ...patch }, { replace: true });
  const search = h('input', { class: 'input sm', type: 'search', placeholder: 'Search title, creator, tag…', value: f.q, style: { maxWidth: '260px' } });
  search.addEventListener('input', debounce(() => set({ q: search.value.trim(), page: 0 }), 350));
  const sel = (key, opts) => h('select', { class: 'select sm', style: { width: 'auto' }, onchange: (e) => set({ [key]: e.target.value, page: 0 }) }, opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
  const host = h('div', { class: 'stack' });
  root.append(pageHead('Media', 'Browse everything in the library and moderate in bulk.'),
    h('div', { class: 'toolbar' }, search, sel('state', [['published', 'Published'], ['review', 'In review'], ['hidden', 'Hidden'], ['removed', 'Removed']]), sel('type', [['', 'Photos & videos'], ['image', 'Photos'], ['video', 'Videos']]), sel('platform', [['', 'All sources'], ...['reddit', 'redgifs', 'bluesky', 'mastodon', 'misskey', 'lemmy', 'x', 'telegram', 'rss', 'web'].map((p) => [p, platformLabel(p) || p])])), host);

  async function load() {
    const r = await adminGet('/media', { state: f.state, platform: f.platform, type: f.type, q: f.q, page: f.page, limit: 48 });
    if (!r.items.length) { host.replaceChildren(emptyState({ icon: 'image', title: 'No media', text: 'Nothing matches these filters.' })); return; }
    const bar = h('div', { class: 'bulkbar', hidden: true });
    const count = h('b', null);
    const run = (action, msg) => async (e) => { const ids = [...grid.selected]; await act(e.currentTarget, () => adminPost('/media/bulk', { ids, action, reason: 'admin bulk' }), `${ids.length} ${msg}`); load(); };
    const grid = selectableGrid(r.items, { onChange: (s) => { bar.hidden = !s.size; count.textContent = `${s.size} selected`; } });
    bar.append(count, h('span', { class: 'grow' }),
      f.state !== 'published' ? h('button', { class: 'btn good', onclick: run('approve', 'published') }, 'Publish') : null,
      f.state !== 'hidden' ? h('button', { class: 'btn', onclick: run('hide', 'hidden') }, 'Hide') : null,
      f.state !== 'removed' ? h('button', { class: 'btn', onclick: run('reject', 'removed') }, 'Remove') : null,
      h('button', { class: 'btn danger', onclick: run('block', 'blocked') }, 'Block forever'));
    host.replaceChildren(grid.el, pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }), bar);
  }
  await load();
}
