import { h, icon, fmt, toast, proxied, emptyState, promptDialog } from '../../dom.js';
import { adminGet, adminPost } from '../../api.js';
import { parse, navigate } from '../../router.js';
import { pageHead, act } from './ui.js';

const KIND = { takedown: 'Takedown', copyright: 'Copyright', underage: 'Possible minor', nonconsensual: 'No consent', other: 'Other' };

export async function render(root) {
  const status = parse().query.get('status') || 'open';
  const seg = h('div', { class: 'seg' }, [['open', 'Open'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['all', 'All']].map(([v, l]) => h('button', { class: status === v ? 'on' : '', onclick: () => navigate('/admin/reports', { status: v }, { replace: true }) }, l)));
  const host = h('div', { class: 'stack' });
  root.append(pageHead('Reports', 'Takedown requests and safety reports from viewers. Reports about minors or consent hide the item immediately.'), seg, host);

  async function load() {
    const r = await adminGet('/reports', { status, limit: 50 });
    if (!r.items.length) { host.replaceChildren(emptyState({ icon: 'check', title: 'No reports here', text: status === 'open' ? 'You’re all caught up.' : 'Nothing in this view.' })); return; }
    host.replaceChildren(...r.items.map((x) => {
      const urgent = ['underage', 'nonconsensual'].includes(x.kind) && x.status === 'open';
      const resolve = (action, label, tone = '') => h('button', { class: `btn sm ${tone}`, onclick: async (e) => {
        const note = action === 'dismiss' || action === 'restore' ? await promptDialog({ title: label, label: 'Note (optional)', confirmLabel: label }) : '';
        if (note === null) return;
        await act(e.currentTarget, () => adminPost(`/reports/${x.id}/resolve`, { action, note }), 'Done'); load();
      } }, label);
      return h('div', { class: `report${urgent ? ' urgent' : ''}` },
        h('div', { class: 'thumb', style: x.media_thumb ? { backgroundImage: `url("${proxied(x.media_thumb)}")` } : {} }),
        h('div', { class: 'stack', style: { gap: '6px', minWidth: 0 } },
          h('div', { class: 'row wrap' }, h('span', { class: `badge ${urgent ? 'bad' : 'warn'}` }, KIND[x.kind] || x.kind), x.status !== 'open' ? h('span', { class: 'badge' }, x.status) : null, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, fmt.ago(x.created_at))),
          h('div', { style: { fontWeight: 600 } }, x.media_title || x.creator_handle || '(item removed)'),
          x.reason ? h('p', { class: 'muted', style: { fontSize: '14px', whiteSpace: 'pre-line' } }, x.reason) : null,
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [x.creator_handle && `@${x.creator_handle}`, x.media_state && `item: ${x.media_state}`, x.contact && `contact: ${x.contact}`].filter(Boolean).join(' · ')),
          x.resolution ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `Resolution: ${x.resolution}`) : null),
        x.status === 'open' ? h('div', { class: 'acts' },
          x.media_id ? resolve('remove', 'Remove & blocklist', 'danger') : null,
          x.creator_id ? resolve('block_creator', 'Block creator', 'danger') : null,
          x.media_id ? resolve('restore', 'Restore (false alarm)', 'good') : null,
          resolve('dismiss', 'Dismiss')) : null);
    }));
  }
  await load();
}
