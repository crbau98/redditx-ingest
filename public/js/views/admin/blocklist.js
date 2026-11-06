import { h, icon, fmt } from '../../dom.js';
import { adminGet, adminPost, adminDelete } from '../../api.js';
import { pageHead, table, pager, act, undoToast, openModal, loadingState, errorState } from './ui.js';

const TYPES = { creator: 'Creator (platform:handle)', hash: 'Media hash', source_key: 'Source key', post: 'Post' };

export async function render(root) {
  const host = h('div', { class: 'stack' });
  let page = 0;
  root.append(pageHead('Blocklist', 'Anything here is never imported again: removed media, blocked creators and takedowns.',
    h('button', { class: 'btn primary', type: 'button', onclick: addDialog }, icon('plus', 'sm'), 'Add entry')),
  h('p', { class: 'a-note' }, 'Creator entries look like ', h('code', null, 'reddit:username'), ' or ', h('code', null, 'x:handle'), '. Removing an entry does not bring old media back; it only allows future imports.'), host);

  function addDialog() {
    const type = h('select', { class: 'select', 'aria-label': 'Type' }, Object.entries(TYPES).map(([v, l]) => h('option', { value: v }, l)));
    const value = h('input', { class: 'input', placeholder: 'reddit:someuser', 'aria-label': 'Value' });
    const reason = h('input', { class: 'input', placeholder: 'Reason (optional)', 'aria-label': 'Reason' });
    const m = openModal({ title: 'Add to blocklist', body: h('div', null, h('div', { class: 'field' }, h('label', null, 'Type'), type), h('div', { class: 'field' }, h('label', null, 'Value'), value), h('div', { class: 'field' }, h('label', null, 'Reason'), reason)),
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: async (e) => { if (await act(e.currentTarget, () => adminPost('/blocklist', { type: type.value, value: value.value, reason: reason.value }), 'Added')) { m.close(); load(); } } }, 'Add')] });
  }

  async function load() {
    host.replaceChildren(loadingState('Loading the blocklist'));
    let r;
    try { r = await adminGet('/blocklist', { page, limit: 50 }); } catch (e) { host.replaceChildren(errorState(e.message, load)); return; }
    host.replaceChildren(table([
      { label: 'Type', render: (b) => h('span', { class: 'badge' }, b.type) },
      { label: 'Value', cell: 'title', render: (b) => h('span', { class: 'mono', style: { overflowWrap: 'anywhere' } }, b.value) },
      { label: 'Reason', cell: 'wide', render: (b) => h('span', { class: 'a-sub' }, b.reason || '') },
      { label: 'Added', render: (b) => fmt.ago(b.created_at) },
      { label: '', srLabel: 'Actions', cell: 'actions', render: (b) => h('div', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', 'aria-label': `Remove ${b.value} from the blocklist`, onclick: async (e) => {
        if (await act(e.currentTarget, () => adminDelete(`/blocklist/${b.id}`)) === undefined) return;
        undoToast('Removed from the blocklist', async () => { await adminPost('/blocklist', { type: b.type, value: b.value, reason: b.reason || '' }); load(); });
        load();
      } }, 'Remove')) },
    ], r.items, { label: 'Blocklist', empty: 'Nothing blocked.' }), pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => { page = p; load(); } }));
  }
  await load();
}
