import { h, fmt } from '../../dom.js';
import { adminGet } from '../../api.js';
import { parse, navigate } from '../../router.js';
import { pageHead, table, pager, chips, loadingState, errorState } from './ui.js';

const TONE = { block: 'bad', hide: 'warn', flag: 'warn', reject: 'warn', remove: 'warn', approve: 'good', publish: 'good', 'auto-hide': 'bad', 'auto-retire': 'info' };

export async function render(root) {
  const q = parse().query;
  const f = { type: q.get('type') || '', page: parseInt(q.get('page') || '0', 10) };
  const set = (patch) => navigate('/admin/audit', { ...f, ...patch }, { replace: true });
  const host = h('div', { class: 'stack' });
  root.append(pageHead('Audit log', 'Every moderation decision, manual and automatic, with who made it and why.'),
    h('div', { class: 'a-toolbar' }, h('div', { class: 'a-toolbar-row' }, chips([['', 'Everything'], ['media', 'Media'], ['creator', 'Creators'], ['report', 'Reports']], f.type, (v) => set({ type: v, page: 0 }), 'What was acted on'))), host);
  host.replaceChildren(loadingState('Loading the log'));
  let r;
  try { r = await adminGet('/audit', { type: f.type, page: f.page, limit: 50 }); } catch (e) { host.replaceChildren(errorState(e.message, () => render(root))); return; }
  host.replaceChildren(table([
    { label: 'When', render: (a) => h('span', { title: fmt.date(a.created_at) }, fmt.ago(a.created_at)) },
    { label: 'Actor', render: (a) => h('span', { class: `badge ${a.actor === 'system' ? 'info' : ''}` }, a.actor) },
    { label: 'Action', render: (a) => h('span', { class: `badge ${TONE[a.action] || ''}` }, a.action) },
    { label: 'Target', cell: 'title', render: (a) => h('div', null, h('div', { class: 'a-title' }, h('span', { class: 'name' }, a.target_label || '(removed)')), h('div', { class: 'a-sub mono' }, `${a.target_type}:${String(a.target_id).slice(0, 8)}`)) },
    { label: 'Reason', cell: 'wide', render: (a) => h('span', { class: 'a-sub' }, a.reason || '') },
  ], r.items, { label: 'Audit log', empty: 'No moderation actions recorded yet.' }), pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }));
}
