import { h, icon, fmt, proxied, emptyState, promptDialog, confirmDialog } from '../../dom.js';
import { adminGet, adminPost } from '../../api.js';
import { parse, navigate } from '../../router.js';
import { pageHead, act, chips, loadingState, errorState } from './ui.js';

const KIND = { takedown: 'Takedown', copyright: 'Copyright', underage: 'Possible minor', nonconsensual: 'No consent', other: 'Other' };
// What each resolution does, for the confirmation. Remove and Block cannot be undone from here.
const CONFIRM = {
  remove: { title: 'Remove and blocklist this item?', text: 'It is taken down and added to the blocklist, so the source cannot bring it back. This cannot be undone here.', label: 'Remove' },
  block_creator: { title: 'Block this creator?', text: 'His media is taken down, his feeds stop and his accounts are blocklisted. This cannot be undone here.', label: 'Block creator' },
};

export async function render(root) {
  const status = parse().query.get('status') || 'open';
  const host = h('div', { class: 'stack' });
  root.append(pageHead('Reports', 'Takedown requests and safety reports from viewers. Reports about minors or consent hide the item immediately.'),
    h('div', { class: 'a-toolbar' }, h('div', { class: 'a-toolbar-row' }, chips([['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['all', 'All']], status, (v) => navigate('/admin/reports', { status: v }, { replace: true }), 'Report status'))), host);

  async function load() {
    host.replaceChildren(loadingState('Loading reports'));
    let r;
    try { r = await adminGet('/reports', { status, limit: 50 }); } catch (e) { host.replaceChildren(errorState(e.message, load)); return; }
    if (!r.items.length) { host.replaceChildren(emptyState({ icon: 'check', title: 'No reports here', text: status === 'open' ? 'You’re all caught up.' : 'Nothing in this view.' })); return; }
    host.replaceChildren(...r.items.map((x) => {
      const urgent = ['underage', 'nonconsensual'].includes(x.kind) && x.status === 'open';
      const resolve = (action, label, tone = '') => h('button', { class: `btn sm ${tone}`, type: 'button', onclick: async (e) => {
        let note = '';
        if (CONFIRM[action]) { const c = CONFIRM[action]; if (!(await confirmDialog(c.text, { title: c.title, confirmLabel: c.label, danger: true }))) return; }
        else if (action === 'dismiss' || action === 'restore') { note = await promptDialog({ title: label, label: 'Note (optional)', confirmLabel: label }); if (note === null) return; }
        await act(e.currentTarget, () => adminPost(`/reports/${x.id}/resolve`, { action, note }), 'Done'); load();
      } }, label);
      return h('article', { class: `report${urgent ? ' urgent' : ''}`, 'aria-label': `${KIND[x.kind] || x.kind} report` },
        h('div', { class: 'thumb', role: 'img', 'aria-label': x.media_title || 'Reported item', style: x.media_thumb ? { backgroundImage: `url("${proxied(x.media_thumb)}")` } : {} }),
        h('div', { class: 'stack', style: { gap: '6px', minWidth: 0 } },
          h('div', { class: 'row wrap' }, h('span', { class: `badge ${urgent ? 'bad' : 'warn'}` }, KIND[x.kind] || x.kind), x.status !== 'open' ? h('span', { class: 'badge' }, x.status) : null, h('span', { class: 'a-sub' }, fmt.ago(x.created_at))),
          h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, x.media_title || x.creator_handle || '(item removed)'),
          x.reason ? h('p', { class: 'a-note', style: { whiteSpace: 'pre-line', fontSize: '14px', color: 'var(--text-2)' } }, x.reason) : null,
          h('div', { class: 'a-sub' }, [x.creator_handle && `@${x.creator_handle}`, x.media_state && `item: ${x.media_state}`, x.contact && `contact: ${x.contact}`].filter(Boolean).join(' · ')),
          x.resolution ? h('div', { class: 'a-sub' }, `Resolution: ${x.resolution}`) : null),
        x.status === 'open' ? h('div', { class: 'acts' },
          x.media_id ? resolve('restore', 'Restore (false alarm)', 'good') : null,
          resolve('dismiss', 'Dismiss'),
          x.media_id ? resolve('remove', 'Remove and blocklist', 'danger') : null,
          x.creator_id ? resolve('block_creator', 'Block creator', 'danger') : null) : null);
    }));
  }
  await load();
}
