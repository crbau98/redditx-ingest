import { h, icon, fmt } from '../../dom.js';
import { adminGet } from '../../api.js';
import { parse, navigate } from '../../router.js';
import { pageHead, table, pager } from './ui.js';

const TONE = { block: 'bad', hide: 'warn', flag: 'warn', reject: 'warn', remove: 'warn', approve: 'good', publish: 'good', 'auto-hide': 'bad' };

export async function render(root) {
  const q = parse().query;
  const f = { type: q.get('type') || '', page: parseInt(q.get('page') || '0', 10) };
  const set = (patch) => navigate('/admin/audit', { ...f, ...patch }, { replace: true });
  const seg = h('div', { class: 'seg' }, [['', 'Everything'], ['media', 'Media'], ['creator', 'Creators'], ['report', 'Reports']].map(([v, l]) => h('button', { class: f.type === v ? 'on' : '', onclick: () => set({ type: v, page: 0 }) }, l)));
  const host = h('div');
  root.append(pageHead('Audit log', 'Every moderation decision — manual and automatic — with who made it and why.'), seg, host);
  const r = await adminGet('/audit', { type: f.type, page: f.page, limit: 50 });
  host.replaceChildren(table([
    { label: 'When', render: (a) => h('span', { title: fmt.date(a.created_at) }, fmt.ago(a.created_at)) },
    { label: 'Actor', render: (a) => h('span', { class: `badge ${a.actor === 'system' ? 'info' : ''}` }, a.actor) },
    { label: 'Action', render: (a) => h('span', { class: `badge ${TONE[a.action] || ''}` }, a.action) },
    { label: 'Target', render: (a) => h('div', null, h('div', { class: 'truncate', style: { maxWidth: '300px' } }, a.target_label || '(removed)'), h('div', { class: 'sub mono' }, `${a.target_type}:${String(a.target_id).slice(0, 8)}`)) },
    { label: 'Reason', render: (a) => h('span', { class: 'sub' }, a.reason || '') },
  ], r.items, { empty: 'No moderation actions recorded yet.' }), pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }));
}
