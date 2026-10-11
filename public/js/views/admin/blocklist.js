import { h, icon, fmt, toast, openModal } from '../../dom.js';
import { adminGet, adminPost, adminDelete } from '../../api.js';
import { pageHead, table, pager, act } from './ui.js';

const TYPES = { creator: 'Creator (platform:handle)', hash: 'Media hash', source_key: 'Source key', post: 'Post' };

export async function render(root) {
  const host = h('div');
  let page = 0;
  root.append(pageHead('Blocklist', 'Anything here is never imported again — removed media, blocked creators and takedowns.',
    h('button', { class: 'btn primary', onclick: addDialog }, icon('plus', 'sm'), 'Add entry')),
  h('div', { class: 'panel' }, h('p', { class: 'muted', style: { fontSize: '14px' } }, 'Creator entries look like ', h('code', null, 'reddit:username'), ' or ', h('code', null, 'x:handle'), '. Removing an entry does not bring old media back; it only allows future imports.')), host);

  function addDialog() {
    const type = h('select', { class: 'select' }, Object.entries(TYPES).map(([v, l]) => h('option', { value: v }, l)));
    const value = h('input', { class: 'input', placeholder: 'reddit:someuser' });
    const reason = h('input', { class: 'input', placeholder: 'Reason (optional)' });
    const m = openModal({ title: 'Add to blocklist', body: h('div', null, h('div', { class: 'field' }, h('label', null, 'Type'), type), h('div', { class: 'field' }, h('label', null, 'Value'), value), h('div', { class: 'field' }, h('label', null, 'Reason'), reason)),
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => { if (await act(e.currentTarget, () => adminPost('/blocklist', { type: type.value, value: value.value, reason: reason.value }), 'Added')) { m.close(); load(); } } }, 'Add')] });
  }

  async function load() {
    const r = await adminGet('/blocklist', { page, limit: 50 });
    host.replaceChildren(table([
      { label: 'Type', render: (b) => h('span', { class: 'badge' }, b.type) },
      { label: 'Value', render: (b) => h('span', { class: 'mono truncate', style: { display: 'block', maxWidth: '380px' } }, b.value) },
      { label: 'Reason', render: (b) => h('span', { class: 'sub' }, b.reason || '') },
      { label: 'Added', render: (b) => fmt.ago(b.created_at) },
      { label: '', render: (b) => h('div', { class: 'actions' }, h('button', { class: 'btn sm ghost', onclick: async () => { await adminDelete(`/blocklist/${b.id}`); load(); } }, 'Remove')) },
    ], r.items, { empty: 'Nothing blocked.' }), pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => { page = p; load(); } }));
  }
  await load();
}
