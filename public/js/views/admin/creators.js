import { h, icon, fmt, toast, confirmDialog, openModal, avatar, debounce } from '../../dom.js';
import { adminGet, adminPost, adminPatch } from '../../api.js';
import { parse, navigate, href } from '../../router.js';
import { adminSession } from '../../store.js';
import { deepPullControl } from '../../components/deep-pull.js';
import { table, pager, platBadge, pageHead, act, undoToast, searchBox, loadingState, errorState } from './ui.js';

function addCreatorDialog(onDone) {
  const name = h('input', { class: 'input', placeholder: 'Display name (optional)', autofocus: true });
  const links = h('textarea', { class: 'textarea', rows: 7, 'aria-label': 'Public profile links', placeholder: 'Paste any of their public profile links — one per line:\nhttps://x.com/name\nhttps://bsky.app/profile/name.bsky.social\nu/name\nhttps://www.redgifs.com/users/name\nhttps://linktr.ee/name   ← hubs are crawled for more accounts\nhttps://onlyfans.com/name   ← kept on the profile as a paid page' });
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
        r.links.length ? h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } }, `${r.links.length} external link${r.links.length === 1 ? '' : 's'} saved to their profile.`) : null,
        r.conflicts.length ? h('p', { style: { color: 'var(--warn)', fontSize: '13px', marginTop: '6px' } }, `Skipped (belongs to another creator): ${r.conflicts.map((c) => `${c.input} — ${c.reason}`).join('; ')}. Use Merge if it is the same person.`) : null,
        r.skipped.length ? h('p', { style: { color: 'var(--warn)', fontSize: '13px', marginTop: '6px' } }, `Not recognised: ${r.skipped.map((s) => s.input).join(', ')}`) : null));
      toast('Creator saved — syncing now', 'ok');
    } }, 'Add creator')],
  });
}

/** Find a person by name, performer name, handle or link across every platform, then follow the right accounts as one creator. */
function findCreatorDialog(onDone, { query = '', creatorId = null } = {}) {
  const q = h('input', { class: 'input', placeholder: 'A name, performer name, @handle or profile link', autofocus: true, value: query });
  const out = h('div', { style: { marginTop: '12px' } });
  let last = null; const picked = new Set();
  const keyOf = (c) => `${c.platform}|${c.kind}|${c.target}`;
  const tierBadge = (c) => h('span', { class: `badge ${c.tier === 'strong' ? 'good' : c.tier === 'likely' ? 'warn' : ''}` }, `${c.tier} · ${Math.round(c.confidence * 100)}%`);

  function render(r) {
    last = r; picked.clear();
    if (r.error) { out.replaceChildren(h('p', { style: { color: 'var(--bad, #f87171)' } }, r.error)); return; }
    for (const c of r.candidates) if (c.status === 'new' && c.tier === 'strong') picked.add(keyOf(c));
    const count = h('b', null);
    const followBtn = h('button', { class: 'btn primary', onclick: async (e) => {
      const selections = r.candidates.filter((c) => picked.has(keyOf(c))).map((c) => ({ platform: c.platform, kind: c.kind, target: c.target, label: c.label }));
      if (!selections.length) { toast('Pick at least one account', 'warn'); return; }
      const res = await act(e.currentTarget, () => adminPost('/lookup/follow', { creatorId, name: r.name && /\s/.test(r.query) ? r.query : (r.candidates.find((c) => picked.has(keyOf(c))) || {}).displayName || r.query, selections, externalLinks: r.externalLinks }));
      if (!res) return;
      onDone();
      out.replaceChildren(h('div', { class: 'panel' }, h('b', null, `${res.creator.display_name || res.creator.handle}`), ` — following ${res.feeds.length} account${res.feeds.length === 1 ? '' : 's'}; pulling their material in now (a deep first read, up to 300 posts each).`,
        res.rejected && res.rejected.length ? h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } }, `Skipped: ${res.rejected.map((x) => `${x.target} (${x.reason})`).join(', ')}`) : null));
      toast('Creator added — syncing now', 'ok');
    } }, 'Follow selected');
    const update = () => { count.textContent = `${picked.size} selected`; followBtn.disabled = !picked.size; };
    const rows = r.candidates.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: picked.has(keyOf(c)), disabled: c.status !== 'new', onchange: (e) => { if (e.target.checked) picked.add(keyOf(c)); else picked.delete(keyOf(c)); update(); } });
      return h('div', { class: 'panel', style: { padding: '10px 12px' } }, h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } }, cb,
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, platBadge(c.platform), h('b', null, c.displayName || c.label), h('a', { href: c.url || '#', target: '_blank', rel: 'noopener noreferrer', class: 'muted' }, c.label), tierBadge(c),
            c.status === 'following' ? h('span', { class: 'badge' }, 'already following') : c.status === 'blocked' ? h('span', { class: 'badge bad' }, 'blocked') : null,
            c.sampleCount ? h('span', { class: 'muted', style: { fontSize: '12px' } }, `${c.sampleCount}${c.sampleCount >= 8 ? '+' : ''} recent posts`) : null),
          c.bio ? h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } }, c.bio) : null,
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, c.evidence.join(' · ')))));
    });
    const hiddenN = r.hidden.safety + r.hidden.notMale;
    out.replaceChildren(
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '8px' } }, h('span', { class: 'muted', style: { fontSize: '13px' } }, `${r.candidates.length} account${r.candidates.length === 1 ? '' : 's'} found in ${(r.ms / 1000).toFixed(1)} s${r.webSearch ? ` · web search: ${r.webSearch}` : ' · web search not configured (BRAVE_API_KEY or SEARXNG_URL)'}${hiddenN ? ` · ${hiddenN} hidden (not male-focused or failed the safety gate)` : ''}`), count),
      r.candidates.length ? h('div', { class: 'stack', style: { gap: '8px' } }, rows) : h('p', { class: 'muted' }, 'No public accounts found. Try another spelling, a handle, or paste one of their profile links.'),
      r.externalLinks.length ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Paid / external links (saved to the profile): '), ...r.externalLinks.map((l) => h('a', { class: 'badge', href: l.url, target: '_blank', rel: 'noopener noreferrer', style: { marginRight: '6px' } }, l.service || l.label))) : null,
      r.candidates.length ? h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, followBtn) : null);
    update();
  }

  const search = async (e) => {
    if (!q.value.trim()) return;
    out.replaceChildren(h('p', { class: 'muted' }, 'Searching every platform, bios and link-in-bio pages… this can take up to a minute.'));
    const r = await act(e && e.currentTarget, () => adminPost('/lookup', { query: q.value.trim() })).catch((err) => ({ error: err.message }));
    if (r) render(r);
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  const m = openModal({
    title: 'Find a creator', sub: 'Search by name, performer name or handle. PRISM looks for the person on Reddit, RedGIFs, Bluesky, Mastodon, Misskey, X, Telegram, Tumblr and the web, reads their bios and link-in-bio pages, and shows what it found with the evidence. Only male-focused public accounts are offered.', wide: true,
    body: h('div', null, h('div', { class: 'row', style: { gap: '8px' } }, q, h('button', { class: 'btn primary', onclick: search }, 'Search')), out),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Close'),
      h('button', { class: 'btn', title: 'Search, then follow every strong, new match in one step', onclick: async (e) => {
        if (!q.value.trim()) return;
        out.replaceChildren(h('p', { class: 'muted' }, 'Searching and following the strong matches…'));
        const r = await act(e.currentTarget, () => adminPost('/lookup/auto', { query: q.value.trim() })).catch((err) => ({ error: err.message }));
        if (!r) return;
        if (r.followed && r.followed.ok) { onDone(); toast(`Following ${r.followed.feeds.length} accounts — syncing now`, 'ok'); }
        render(r);
        if (r.note) out.prepend(h('p', { style: { color: 'var(--warn)', fontSize: '13px' } }, r.note));
      } }, 'Find & follow strong matches')],
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

async function duplicatesDialog(onDone) {
  const groups = await adminGet('/creators-duplicates');
  const body = groups.length ? h('div', { class: 'stack' }, groups.map((g) => {
    const keep = g[0];
    return h('div', { class: 'panel' },
      h('div', { class: 'stack', style: { gap: '8px' } }, g.map((c, i) => h('div', { class: 'row' }, avatar(c, 30), h('span', { class: 'grow' }, `${c.display_name || c.handle} · @${c.handle}`, c.match && c.match.length ? h('span', { class: 'muted', style: { display: 'block', fontSize: '12px' } }, c.match.join(' · ')) : null), h('span', { class: 'muted' }, `${c.media_count} posts`), i === 0 ? h('span', { class: 'badge good' }, 'keep') : null))),
      h('div', { class: 'row', style: { marginTop: '12px', justifyContent: 'flex-end' } }, h('button', { class: 'btn sm primary', onclick: async (e) => {
        if (!(await confirmDialog(`Merge ${g.length - 1} into “${keep.display_name || keep.handle}”? Their media and accounts move across.`, { confirmLabel: 'Merge', danger: true }))) return;
        await act(e.currentTarget, async () => { for (const c of g.slice(1)) await adminPost('/creators/merge', { keepId: keep.id, mergeId: c.id }); }, 'Merged');
        m.close(); onDone();
      } }, 'Merge into the first')));
  })) : h('p', { class: 'muted' }, 'No probable duplicates found.');
  const m = openModal({ title: 'Possible duplicate creators', sub: 'Grouped by a shared link or profile picture, matching or nearly matching handles, or the same name with similar posts. Each row says why. Only merge if it is really the same person.', wide: true, body, actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Close')] });
}

/** Block takes his media down and blocklists his accounts, so it asks first. Restore only lets him back in. */
async function blockCreator(c, onDone) {
  const name = c.display_name || c.handle;
  if (!(await confirmDialog(`${name}'s media is taken down, his feeds stop and his accounts are blocklisted so nothing is re-imported. Restore later only lets him back in: media that was removed does not come back. To keep everything, hide him instead.`, { title: `Block ${name}?`, confirmLabel: 'Block', danger: true }))) return false;
  const r = await act(null, () => adminPost(`/creators/${c.id}/block`, { reason: 'admin' }), `${name} blocked`);
  if (r) onDone();
  return !!r;
}

/** Hide keeps everything but takes him off the site; undo (or Restore) puts him back. */
async function hideCreator(c, onDone) {
  const name = c.display_name || c.handle;
  const r = await act(null, () => adminPatch(`/creators/${c.id}`, { status: 'hidden' }));
  if (r === undefined) return;
  undoToast(`${name} is hidden from the site`, async () => { await adminPatch(`/creators/${c.id}`, { status: 'active' }); onDone(); });
  onDone();
}

async function restoreCreator(c, onDone) {
  const r = await act(null, () => adminPost(`/creators/${c.id}/restore`), `${c.display_name || c.handle} restored`);
  if (r) onDone();
}

async function detailDialog(id, onDone) {
  const c = await adminGet(`/creators/${id}`);
  const away = c.status === 'blocked' || c.status === 'hidden';
  const m = openModal({
    title: c.display_name || c.handle, sub: `@${c.handle} · ${c.media_count} published · ${c.status}`, wide: true,
    body: h('div', { class: 'stack' },
      c.bio ? h('p', { class: 'a-note' }, c.bio) : null,
      h('div', null, h('h4', { class: 'a-note', style: { fontWeight: 700, textTransform: 'uppercase', marginBottom: '8px' } }, 'Accounts and feeds'),
        c.feeds.length ? h('div', { class: 'stack', style: { gap: '6px' } }, c.feeds.map((f) => h('div', { class: 'a-run' }, platBadge(f.platform), h('span', { class: 'grow truncate' }, `${f.kind}: ${f.label || f.target}`), h('span', { class: 'muted' }, f.enabled ? (f.last_status || 'pending') : 'off')))) : h('p', { class: 'a-note' }, 'No feeds.')),
      (c.links || []).length ? h('div', { class: 'linkrow' }, c.links.map((l) => h('a', { class: 'linkchip ext', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('link', 'sm'), l.label || l.service))) : null,
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn', href: href(`/creator/${c.id}`), onclick: () => m.close() }, 'Public page'),
        h('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, () => adminPost('/engine/run', { feedIds: c.feeds.map((f) => f.id), force: true }), 'Sync queued') }, icon('refresh', 'sm'), 'Sync accounts'),
        h('button', { class: 'btn', type: 'button', title: 'Search the web and every platform for more accounts of this person', onclick: () => { m.close(); findCreatorDialog(onDone, { query: c.display_name || c.handle, creatorId: c.id }); } }, icon('search', 'sm'), 'Find more accounts'),
        deepPullControl({ creatorId: c.id, adminKey: adminSession.key, h, adminGet, adminPost }),
        h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); mergeDialog(c, onDone); } }, 'Merge into another…'))),
    actions: [
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Close'),
      away ? h('button', { class: 'btn good', type: 'button', onclick: async () => { m.close(); await restoreCreator(c, onDone); } }, 'Restore')
        : h('button', { class: 'btn', type: 'button', onclick: async () => { m.close(); await hideCreator(c, onDone); } }, 'Hide from the site'),
      c.status === 'blocked' ? null : h('button', { class: 'btn danger', type: 'button', onclick: async () => { m.close(); await blockCreator(c, onDone); } }, 'Block…'),
    ],
  });
}

export async function render(root) {
  const q = parse().query;
  const f = { q: q.get('q') || '', page: parseInt(q.get('page') || '0', 10), sort: q.get('sort') || 'recent' };
  const set = (patch) => navigate('/admin/creators', { ...f, ...patch }, { replace: true });
  const sort = h('select', { class: 'select sm', 'aria-label': 'Sort creators', onchange: (e) => set({ sort: e.target.value, page: 0 }) }, [['recent', 'Recently active'], ['media', 'Most posts'], ['new', 'Newest'], ['name', 'A–Z']].map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l)));
  const host = h('div', { class: 'stack' });
  const dupBtn = h('button', { class: 'btn sm', type: 'button', hidden: true, onclick: () => duplicatesDialog(load) }, icon('users', 'sm'), 'Possible duplicates');
  root.append(pageHead('Creators', 'People, not just feeds. Add a creator once and PRISM follows all of their public accounts.',
    h('button', { class: 'btn', type: 'button', onclick: () => findCreatorDialog(load) }, icon('search', 'sm'), 'Find a creator'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => addCreatorDialog(load) }, icon('plus', 'sm'), 'Add creator')),
  h('div', { class: 'a-toolbar' }, h('div', { class: 'a-toolbar-row' }, searchBox({ value: f.q, placeholder: 'Search creators…', label: 'Search creators', onInput: (v) => set({ q: v, page: 0 }) }), sort, dupBtn)), host);
  adminGet('/creators-duplicates').then((g) => { if (g.length) { dupBtn.hidden = false; dupBtn.replaceChildren(icon('users', 'sm'), `${g.length} possible duplicate${g.length === 1 ? '' : 's'}`); } }).catch(() => {});

  async function load() {
    host.replaceChildren(loadingState('Loading creators'));
    let r;
    try { r = await adminGet('/creators', { q: f.q, page: f.page, sort: f.sort, limit: 40 }); } catch (e) { host.replaceChildren(errorState(e.message, load)); return; }
    host.replaceChildren(table([
      { label: 'Creator', cell: 'title', render: (c) => h('div', { class: 'row' }, avatar(c, 40), h('div', { style: { minWidth: 0 } }, h('div', { class: 'a-title' }, h('span', { class: 'name' }, c.display_name || c.handle), h('span', { class: `badge ${c.status === 'active' ? 'good' : c.status === 'blocked' ? 'bad' : 'warn'}` }, c.status)), h('div', { class: 'a-sub' }, `@${c.handle}`))) },
      { label: 'Posts', class: 'num', render: (c) => fmt.int(c.media_count) },
      { label: 'Origin', render: (c) => h('span', { class: 'a-sub' }, c.origin) },
      { label: 'Active', render: (c) => (c.last_media_at ? fmt.ago(c.last_media_at) : '—') },
      { label: '', srLabel: 'Actions', cell: 'actions', render: (c) => h('div', { class: 'actions' },
        h('button', { class: 'btn sm', type: 'button', 'aria-label': `Details for ${c.display_name || c.handle}`, onclick: () => detailDialog(c.id, load) }, 'Details'),
        c.status === 'blocked' || c.status === 'hidden'
          ? h('button', { class: 'btn sm good', type: 'button', onclick: () => restoreCreator(c, load) }, 'Restore')
          : h('button', { class: 'btn sm', type: 'button', title: 'Take him off the site; keeps everything, one tap to undo', onclick: () => hideCreator(c, load) }, 'Hide')) },
    ], r.items, { label: 'Creators', empty: f.q ? 'No creators match.' : 'No creators yet. Add one above.' }), pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }));
  }
  await load();
}
