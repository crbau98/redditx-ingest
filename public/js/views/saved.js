import { h, icon, fmt, toast, confirmDialog, emptyState, openModal } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { favorites, follows, bus } from '../store.js';
import { createFeed } from '../components/feed.js';
import { creatorCard } from '../components/creator-card.js';

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

export async function saved(root, { query }) {
  document.title = 'Saved — PRISM';
  const tab = query.get('tab') === 'following' ? 'following' : 'saved';
  let cleanup = () => {};

  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    h('button', { class: tab === 'saved' ? 'on' : '', role: 'tab', onclick: () => navigate('/saved', { tab: 'saved' }, { replace: true }) }, 'Saved ', h('span', { class: 'muted num' }, favorites.count())),
    h('button', { class: tab === 'following' ? 'on' : '', role: 'tab', onclick: () => navigate('/saved', { tab: 'following' }, { replace: true }) }, 'Following ', h('span', { class: 'muted num' }, follows.count())));

  const fileInput = h('input', { type: 'file', accept: 'application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; if (!file) return;
    try { const n = favorites.import(await file.text()); toast(`Imported ${n} saved item${n === 1 ? '' : 's'}`, 'ok'); navigate('/saved', { tab }, { replace: true }); }
    catch (e) { toast(e.message || 'Could not import that file', 'err'); }
  });
  const tools = h('div', { class: 'row wrap' },
    h('button', { class: 'btn sm', onclick: () => download('prism-saved.json', favorites.export()) }, icon('download', 'sm'), 'Export'),
    h('button', { class: 'btn sm', onclick: () => fileInput.click() }, icon('upload', 'sm'), 'Import'), fileInput,
    tab === 'saved' && favorites.count() ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('This only affects this device.', { title: 'Clear all saved items?', confirmLabel: 'Clear', danger: true })) { favorites.clear(); navigate('/saved', { tab }, { replace: true }); } } }, icon('trash', 'sm'), 'Clear') : null);

  const body = h('div');
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Your collection'), h('div', { class: 'sub' }, 'Saved and followed on this device only — no account, nothing uploaded.')), tools),
    tabs, body);

  if (tab === 'saved') {
    const ids = favorites.list();
    if (!ids.length) {
      body.replaceChildren(emptyState({ icon: 'heart', title: 'Nothing saved yet', text: 'Tap the heart on anything you like (or press F in the viewer) and it lands here.', actions: [h('a', { class: 'btn primary', href: href('/explore') }, 'Explore')] }));
    } else {
      const note = h('p', { class: 'muted', style: { margin: '-6px 0 14px', fontSize: '13px' } });
      const feed = createFeed({
        ids, query: {}, endpoint: '/api/media',
        // Items removed at the source (or by a takedown) quietly drop out; say so once we know.
        onDone: (loaded) => { const missing = ids.length - loaded; if (missing > 0) note.textContent = `${missing} saved item${missing === 1 ? ' is' : 's are'} no longer available.`; },
      });
      body.replaceChildren(note, feed.el);
      cleanup = () => feed.destroy();
    }
  } else {
    const list = follows.list();
    if (!list.length) {
      body.replaceChildren(emptyState({ icon: 'users', title: 'Not following anyone', text: 'Follow creators to find them here, with a “New” badge when they post.', actions: [h('a', { class: 'btn primary', href: href('/creators') }, 'Browse creators')] }));
    } else {
      const grid = h('div', { class: 'creator-grid' }, list.map(() => h('div', { class: 'skeleton', style: { height: '260px' } })));
      body.replaceChildren(grid);
      const results = await Promise.all(list.map((f) => get(`/api/creators/${f.id}`).then((c) => c).catch((e) => (e.status === 404 ? null : undefined))));
      const cards = [];
      results.forEach((c, i) => { if (c === null) follows.toggle({ id: list[i].id }); else if (c) cards.push(c); });
      cards.sort((a, b) => String(b.last_media_at || '').localeCompare(String(a.last_media_at || '')));
      grid.replaceChildren(...cards.map((c) => creatorCard(c)));
    }
  }
  return cleanup;
}
