import { h, toast, emptyState, confirmDialog } from '../../dom.js';
import { adminGet, adminPost } from '../../api.js';
import { parse, navigate } from '../../router.js';
import { platformLabel } from '../../store.js';
import { pageHead, pager, act, undoToast, searchBox, chips, bulkBar, loadingState, errorState } from './ui.js';
import { selectableGrid } from './moderation.js';
import { undoActionFor } from './logic.js';

const STATES = [['published', 'Published'], ['review', 'In review'], ['hidden', 'Hidden'], ['removed', 'Removed']];
const WORD = { approve: 'Published', hide: 'Hidden', reject: 'Removed', block: 'Blocked' };

export async function render(root) {
  const q = parse().query;
  const f = { state: q.get('state') || 'published', platform: q.get('platform') || '', type: q.get('type') || '', q: q.get('q') || '', page: parseInt(q.get('page') || '0', 10) };
  const set = (patch) => navigate('/admin/media', { ...f, ...patch }, { replace: true });
  const sel = (key, opts, label) => h('select', { class: 'select sm', 'aria-label': label, onchange: (e) => set({ [key]: e.target.value, page: 0 }) }, opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
  const host = h('div', { class: 'stack' });
  root.append(pageHead('Media', 'Browse everything in the library and moderate in bulk.'),
    h('div', { class: 'a-toolbar' },
      h('div', { class: 'a-toolbar-row' }, searchBox({ value: f.q, placeholder: 'Search title, creator, tag…', label: 'Search media', onInput: (v) => set({ q: v, page: 0 }) }),
        sel('type', [['', 'Photos and videos'], ['image', 'Photos'], ['video', 'Videos']], 'Type'),
        sel('platform', [['', 'All sources'], ...['reddit', 'redgifs', 'bluesky', 'mastodon', 'misskey', 'tumblr', 'peertube', 'lemmy', 'x', 'telegram', 'rss', 'web'].map((p) => [p, platformLabel(p) || p])], 'Source')),
      h('div', { class: 'a-toolbar-row' }, chips(STATES, f.state, (v) => set({ state: v, page: 0 }), 'Library state'))), host);

  async function load() {
    host.replaceChildren(loadingState('Loading media'));
    let r;
    try { r = await adminGet('/media', { state: f.state, platform: f.platform, type: f.type, q: f.q, page: f.page, limit: 48 }); } catch (e) { host.replaceChildren(errorState(e.message, load)); return; }
    if (!r.items.length) { host.replaceChildren(emptyState({ icon: 'image', title: 'No media', text: 'Nothing matches these filters.' })); return; }
    const run = (action) => async (e) => {
      const ids = [...grid.selected];
      const prior = f.state; // every selected item is in this state
      const ok = await act(e.currentTarget, () => adminPost('/media/bulk', { ids, action, reason: 'admin bulk' }));
      if (!ok) return;
      const back = undoActionFor(prior);
      if (action === 'block' || !back) toast(`${WORD[action]} ${ids.length}`, 'ok');
      else undoToast(`${WORD[action]} ${ids.length} item${ids.length === 1 ? '' : 's'}`, async () => { await adminPost('/media/bulk', { ids, action: back, reason: 'undo' }); load(); });
      load();
    };
    const bulk = bulkBar([
      f.state !== 'published' ? h('button', { class: 'btn good', type: 'button', onclick: run('approve') }, 'Publish') : null,
      f.state !== 'hidden' ? h('button', { class: 'btn', type: 'button', onclick: run('hide') }, 'Hide') : null,
      f.state !== 'removed' ? h('button', { class: 'btn', type: 'button', onclick: run('reject') }, 'Remove') : null,
      h('button', { class: 'btn danger', type: 'button', title: 'Block forever: the source cannot return it', onclick: async (e) => {
        const n = grid.selected.size;
        if (!(await confirmDialog(`The source cannot return ${n === 1 ? 'it' : 'them'}, and this cannot be undone here. Only the blocklist can lift a block.`, { title: `Block ${n} item${n === 1 ? '' : 's'} forever?`, confirmLabel: 'Block', danger: true }))) return;
        run('block')(e);
      } }, 'Block'),
    ]);
    const grid = selectableGrid(r.items, { onChange: (s) => { if (s.size) bulk.set(`${s.size} selected`); else bulk.clear(); } });
    host.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'a-meta', role: 'status' }, `${r.total} item${r.total === 1 ? '' : 's'}`)), grid.el, pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }), bulk.el);
  }
  await load();
}
