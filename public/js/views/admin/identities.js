import { h, icon, fmt, toast, confirmDialog, avatar, debounce } from '../../dom.js';
import { adminGet, adminPost, adminDelete } from '../../api.js';
import { pager, pageHead, act, openModal } from './ui.js';

// Same person? — pairs of creators whose own profiles point at each other (engine/identity), plus each creator's aliases.
const EVIDENCE = {
  'bio-link': (e) => `bio links to ${e.detail}`,
  'bio-alias': (e) => `bio names ${e.detail} as his other account`,
  'same-onlyfans': (e) => `both promote onlyfans.com/${e.detail}`,
  'same-linkpage': (e) => `both use ${e.detail}`,
  admin: () => 'linked by admin',
};
const describe = (e) => (EVIDENCE[e.type] ? EVIDENCE[e.type](e) : e.type);

export async function render(root) {
  const host = h('div', { class: 'stack' });
  const counts = h('span');
  let page = 0; let status = 'pending';
  const tabs = h('div', { class: 'row wrap' }, ['pending', 'merged', 'rejected'].map((s) => h('button', { class: `btn sm${s === status ? ' primary' : ''}`, 'data-s': s, onclick: () => { status = s; page = 0; for (const b of tabs.children) b.classList.toggle('primary', b.dataset.s === s); load(); } }, s === 'pending' ? 'Waiting' : s === 'merged' ? 'Merged' : 'Different people')));

  root.append(pageHead('Same person?', 'Creators whose own profiles link to each other, name each other as a backup account, or promote the same OnlyFans or link page. A strong match with the same name merges on its own; everything else waits here.',
    h('button', { class: 'btn', onclick: async (e) => { const r = await act(e.currentTarget, () => adminPost('/identities/scan')); if (r) { toast(`${r.links} links checked, ${r.merged} merged, ${r.aliases} new aliases`, 'ok'); load(); } } }, icon('refresh', 'sm'), 'Scan now'),
    h('button', { class: 'btn', onclick: aliasDialog }, icon('users', 'sm'), 'Aliases')),
  h('div', { class: 'row wrap', style: { justifyContent: 'space-between' } }, tabs, counts), host);

  const card = (c, other, link) => h('div', { class: 'panel grow', style: { minWidth: '220px' } },
    h('div', { class: 'row' }, avatar(c, 40), h('div', { class: 'grow' }, h('b', null, c.display_name || c.handle), h('div', { class: 'muted', style: { fontSize: '13px' } }, `@${c.handle} · ${fmt.int(c.media_count || 0)} posts`))),
    c.aliases && c.aliases.length ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, 'Goes by: ', c.aliases.join(', ')) : null,
    link.status === 'pending' ? h('button', { class: 'btn sm primary', style: { marginTop: '10px' }, onclick: async (e) => {
      if (!(await confirmDialog(`Merge ${other.handle} into ${c.handle}? Media, accounts and names move across. This cannot be undone.`, { confirmLabel: 'Merge', danger: true }))) return;
      if (await act(e.currentTarget, () => adminPost(`/identities/${link.id}`, { action: 'merge', keepId: c.id }), 'Merged')) load();
    } }, 'Keep this one') : null);

  async function load() {
    const r = await adminGet('/identities', { status, page, limit: 30 });
    counts.replaceChildren(h('span', { class: 'muted', style: { fontSize: '13px' } }, `${fmt.int(r.counts.pending)} waiting · ${fmt.int(r.counts.merged)} merged · ${fmt.int(r.counts.aliases)} aliases known`));
    const rows = r.items.filter((l) => l.a && l.b).map((l) => h('div', { class: 'panel' },
      h('div', { class: 'row wrap', style: { gap: '12px', alignItems: 'stretch' } }, card(l.a, l.b, l), card(l.b, l.a, l)),
      h('ul', { class: 'muted', style: { fontSize: '13px', margin: '10px 0 0 18px' } }, l.evidence.map((e) => h('li', null, describe(e))),
        h('li', null, l.sameName ? 'same name on both' : 'different names: check before merging')),
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '10px' } },
        h('span', { class: `badge ${l.strength >= 6 ? 'good' : l.strength >= 4 ? 'warn' : ''}` }, `evidence ${l.strength}`),
        l.status === 'pending' ? h('button', { class: 'btn sm ghost', onclick: async (e) => { if (await act(e.currentTarget, () => adminPost(`/identities/${l.id}`, { action: 'reject' }), 'Kept apart')) load(); } }, 'Different people') : h('span', { class: 'muted' }, `${l.status} ${fmt.ago(l.updated_at)}`))));
    host.replaceChildren(...(rows.length ? rows : [h('p', { class: 'muted' }, status === 'pending' ? 'Nothing waiting. Run a scan, or let discovery find more.' : 'None yet.')]),
      pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => { page = p; load(); } }));
  }

  function aliasDialog() {
    const search = h('input', { class: 'input', placeholder: 'Find a creator by any name or handle…', autofocus: true });
    const list = h('div', { class: 'stack', style: { gap: '6px', marginTop: '10px', maxHeight: '260px', overflow: 'auto' } });
    const detail = h('div', { style: { marginTop: '12px' } });
    const modal = openModal({ title: 'Aliases', sub: 'Every name and handle a creator goes by. Search uses all of them.', wide: true, body: h('div', null, search, list, detail), actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Close')] });
    const show = async (c) => {
      const aliases = await adminGet(`/creators/${c.id}/aliases`);
      const input = h('input', { class: 'input', placeholder: 'Add a name or handle he uses' });
      const add = async (e) => { if (!input.value.trim()) return; if (await act(e.currentTarget, () => adminPost(`/creators/${c.id}/aliases`, { alias: input.value.trim(), kind: /\s/.test(input.value.trim()) ? 'name' : 'handle' }), 'Added')) show(c); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(e); });
      detail.replaceChildren(h('div', { class: 'panel' }, h('b', null, c.display_name || c.handle),
        h('div', { class: 'row wrap', style: { gap: '6px', margin: '10px 0' } }, aliases.map((a) => h('span', { class: 'badge', title: `${a.kind} · from ${a.source}${a.platform ? ` · ${a.platform}` : ''}` }, a.alias,
          h('button', { class: 'btn sm ghost', 'aria-label': `Remove ${a.alias}`, style: { padding: '0 4px', marginLeft: '4px' }, onclick: async () => { await adminDelete(`/creators/${c.id}/aliases/${encodeURIComponent(a.alias)}`); show(c); } }, '×')))),
        h('div', { class: 'row' }, input, h('button', { class: 'btn primary', onclick: add }, 'Add'))));
    };
    search.addEventListener('input', debounce(async () => {
      if (!search.value.trim()) { list.replaceChildren(); return; }
      const r = await adminGet('/creators', { q: search.value.trim(), limit: 8 });
      list.replaceChildren(...r.items.map((c) => h('button', { class: 'run-live', style: { border: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit' }, onclick: () => show(c) },
        avatar(c, 28), h('span', { class: 'grow' }, `${c.display_name || c.handle} · @${c.handle}`), h('span', { class: 'muted' }, `${c.media_count} posts`))));
    }, 250));
  }

  await load();
}
