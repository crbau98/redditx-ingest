import { h, icon, fmt, toast, confirmDialog, openModal, avatar, debounce } from '../../dom.js';
import { adminGet, adminPost, adminPatch } from '../../api.js';
import { parse, navigate, href } from '../../router.js';
import { table, pager, platBadge, pageHead, act } from './ui.js';

function addCreatorDialog(onDone) {
  const name = h('input', { class: 'input', placeholder: 'Display name (optional)', autofocus: true });
  const links = h('textarea', { class: 'textarea', rows: 7, placeholder: 'Paste any of their public profile links — one per line:\nhttps://x.com/name\nhttps://bsky.app/profile/name.bsky.social\nu/name\nhttps://www.redgifs.com/users/name\nhttps://linktr.ee/name   ← hubs are crawled for more accounts\nhttps://onlyfans.com/name   ← shown on their profile, never scraped' });
  const result = h('div');
  const m = openModal({
    title: 'Add a creator', sub: 'One person, many accounts. PRISM follows every public account you give it and keeps their media together on one profile.', wide: true,
    body: h('div', null, h('div', { class: 'field' }, h('label', null, 'Name'), name), h('div', { class: 'field' }, h('label', null, 'Profile links'), links), result),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Close'), h('button', { class: 'btn primary', onclick: async (e) => {
      const r = await act(e.currentTarget, () => adminPost('/creators', { name: name.value.trim(), inputs: links.value }));
      if (!r) return;
      onDone();
      result.replaceChildren(h('div', { class: 'panel', style: { marginTop: '12px' } },
        h('b', null, `${r.creator.display_name || r.creator.handle}`), ` — following ${r.feeds.length} account${r.feeds.length === 1 ? '' : 's'}`,
        r.links.length ? h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } }, `${r.links.length} external link${r.links.length === 1 ? '' : 's'} saved to their profile (not scraped).`) : null,
        r.conflicts.length ? h('p', { style: { color: 'var(--warn)', fontSize: '13px', marginTop: '6px' } }, `Skipped (belongs to another creator): ${r.conflicts.map((c) => `${c.input} — ${c.reason}`).join('; ')}. Use Merge if it is the same person.`) : null,
        r.skipped.length ? h('p', { style: { color: 'var(--warn)', fontSize: '13px', marginTop: '6px' } }, `Not recognised: ${r.skipped.map((s) => s.input).join(', ')}`) : null));
      toast('Creator saved — syncing now', 'ok');
    } }, 'Add creator')],
  });
}

function mergeDialog(from, onDone) {
  const search = h('input', { class: 'input', placeholder: 'Search the creator to keep…', autofocus: true });
  const list = h('div', { class: 'stack', style: { gap: '6px', marginTop: '10px', maxHeight: '300px', overflow: 'auto' } });
  const m = openModal({ title: `Merge “${from.display_name || from.handle}” into…`, sub: 'All media and accounts move to the creator you pick. This cannot be undone.', body: h('div', null, search, list), actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel')] });
  const run = debounce(async () => {
    if (!search.value.trim()) { list.replaceChildren(); return; }
    const r = await adminGet('/creators', { q: search.value.trim(), limit: 8 });
    list.replaceChildren(...r.items.filter((c) => c.id !== from.id).map((c) => h('button', { class: 'run-live', style: { border: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit' }, onclick: async () => {
      if (!(await confirmDialog(`Merge ${from.handle} into ${c.handle}?`, { confirmLabel: 'Merge', danger: true }))) return;
      await act(null, () => adminPost('/creators/merge', { keepId: c.id, mergeId: from.id }), 'Merged'); m.close(); onDone();
    } }, avatar(c, 32), h('span', { class: 'grow' }, `${c.display_name || c.handle} · @${c.handle}`), h('span', { class: 'muted' }, `${c.media_count} posts`))));
  }, 250);
  search.addEventListener('input', run);
}

async function detailDialog(id, onDone) {
  const c = await adminGet(`/creators/${id}`);
  const m = openModal({
    title: c.display_name || c.handle, sub: `@${c.handle} · ${c.media_count} published · ${c.status}`, wide: true,
    body: h('div', { class: 'stack' },
      c.bio ? h('p', { class: 'muted' }, c.bio) : null,
      h('div', null, h('div', { class: 'muted', style: { fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', marginBottom: '8px' } }, 'Accounts & feeds'),
        c.feeds.length ? h('div', { class: 'stack', style: { gap: '6px' } }, c.feeds.map((f) => h('div', { class: 'run-live' }, platBadge(f.platform), h('span', { class: 'grow truncate' }, `${f.kind}: ${f.label || f.target}`), h('span', { class: 'muted' }, f.enabled ? (f.last_status || 'pending') : 'off')))) : h('p', { class: 'muted' }, 'No feeds.')),
      (c.links || []).length ? h('div', { class: 'linkrow' }, c.links.map((l) => h('a', { class: 'linkchip ext', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('link', 'sm'), l.label || l.service))) : null),
    actions: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Close'),
      h('a', { class: 'btn', href: href(`/creator/${c.id}`), onclick: () => m.close() }, 'Public page'),
      h('button', { class: 'btn', onclick: (e) => act(e.currentTarget, () => adminPost('/engine/run', { feedIds: c.feeds.map((f) => f.id), force: true }), 'Sync queued') }, icon('refresh', 'sm'), 'Sync accounts'),
    ],
  });
}

export async function render(root) {
  const q = parse().query;
  const f = { q: q.get('q') || '', page: parseInt(q.get('page') || '0', 10), sort: q.get('sort') || 'recent' };
  const set = (patch) => navigate('/admin/creators', { ...f, ...patch }, { replace: true });
  const search = h('input', { class: 'input sm', type: 'search', placeholder: 'Search creators…', value: f.q, style: { maxWidth: '240px' } });
  search.addEventListener('input', debounce(() => set({ q: search.value.trim(), page: 0 }), 350));
  const sort = h('select', { class: 'select sm', style: { width: 'auto' }, onchange: (e) => set({ sort: e.target.value, page: 0 }) }, [['recent', 'Recently active'], ['media', 'Most posts'], ['new', 'Newest'], ['name', 'A–Z']].map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));
  const host = h('div');
  root.append(pageHead('Creators', 'People, not just feeds. Add a creator once and PRISM follows all of their public accounts.', h('button', { class: 'btn primary', onclick: () => addCreatorDialog(load) }, icon('plus', 'sm'), 'Add creator')), h('div', { class: 'toolbar' }, search, sort), host);

  async function load() {
    const r = await adminGet('/creators', { q: f.q, page: f.page, sort: f.sort, limit: 40 });
    host.replaceChildren(table([
      { label: 'Creator', render: (c) => h('div', { class: 'row' }, avatar(c, 36), h('div', null, h('div', { style: { fontWeight: 600 } }, c.display_name || c.handle), h('div', { class: 'sub' }, `@${c.handle}`))) },
      { label: 'Status', render: (c) => h('span', { class: `badge ${c.status === 'active' ? 'good' : c.status === 'blocked' ? 'bad' : 'warn'}` }, c.status) },
      { label: 'Posts', class: 'num', render: (c) => fmt.int(c.media_count) },
      { label: 'Origin', render: (c) => h('span', { class: 'sub' }, c.origin) },
      { label: 'Active', render: (c) => (c.last_media_at ? fmt.ago(c.last_media_at) : '—') },
      { label: '', render: (c) => h('div', { class: 'actions' },
        h('button', { class: 'btn sm', onclick: () => detailDialog(c.id, load) }, 'Details'),
        h('button', { class: 'btn sm ghost', onclick: () => mergeDialog(c, load) }, 'Merge'),
        c.status === 'blocked' || c.status === 'hidden'
          ? h('button', { class: 'btn sm good', onclick: (e) => act(e.currentTarget, async () => { await adminPost(`/creators/${c.id}/restore`); load(); }, 'Restored') }, 'Restore')
          : h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(`Hides all of ${c.display_name || c.handle}'s media, stops their feeds and blocklists the accounts so nothing is re-imported.`, { title: 'Block this creator?', confirmLabel: 'Block', danger: true })) { await adminPost(`/creators/${c.id}/block`, { reason: 'admin' }); load(); } } }, 'Block')) },
    ], r.items, { empty: 'No creators yet.' }), pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }));
  }
  await load();
}
