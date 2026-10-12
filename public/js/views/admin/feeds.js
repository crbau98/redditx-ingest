import { h, icon, fmt, toast, confirmDialog, openModal, debounce } from '../../dom.js';
import { adminGet, adminPost, adminPatch, adminDelete } from '../../api.js';
import { parse, navigate, href } from '../../router.js';
import { platforms, platformLabel } from '../../store.js';
import { table, pager, toggle, platBadge, statusDot, pageHead, act } from './ui.js';

const KINDS = { reddit: ['community', 'user'], redgifs: ['search', 'user', 'niche'], bluesky: ['user', 'search', 'feedgen', 'list'], mastodon: ['user', 'tag'], misskey: ['user', 'tag'], tumblr: ['user', 'tag'], peertube: ['user', 'channel', 'tag', 'search'], lemmy: ['community', 'user'], x: ['user', 'search'], telegram: ['user'], rss: ['feed'], web: ['page'], linkinbio: ['page'] };
const HINT = {
  reddit: 'r/gaybros or u/someone', redgifs: 'a search term, or a username', bluesky: 'handle.bsky.social  /  bsky.app/profile/…/feed/…  /  …/lists/…', mastodon: 'name@instance.social  /  hashtag', misskey: 'name@misskey.io  /  hashtag', tumblr: 'blogname  /  tag  /  tag@blogname', peertube: 'account@instance.tld  /  channel@instance.tld  /  tag  /  search words',
  lemmy: 'community@instance.tld', x: '@handle  /  search query (needs token)', telegram: 't.me/channelname (public preview)', rss: 'https://site.com/feed.xml', web: 'https://site.com/gallery', linkinbio: 'https://linktr.ee/name',
};
const INTERVALS = [[30, '30 min'], [60, '1 hour'], [90, '90 min'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '1 day'], [4320, '3 days']];

function addDialog(onDone, preset = {}) {
  const smart = h('input', { class: 'input', placeholder: 'Paste a link or handle — we’ll work out the rest (r/sub, u/name, x.com/…, bsky.app/…, RSS…)', autofocus: true });
  const plat = h('select', { class: 'select' }, Object.keys(KINDS).map((p) => h('option', { value: p, selected: p === preset.platform }, platformLabel(p) || p)));
  const kind = h('select', { class: 'select' });
  const target = h('input', { class: 'input', placeholder: '' });
  const syncKinds = () => { kind.replaceChildren(...KINDS[plat.value].map((k) => h('option', { value: k }, k))); target.placeholder = HINT[plat.value]; };
  plat.addEventListener('change', syncKinds); syncKinds();
  const trusted = h('input', { type: 'checkbox' });
  const m = openModal({
    title: 'Add a feed', sub: 'A feed is anything PRISM should keep checking: a community, a hashtag, a search, an RSS feed — or a single creator’s account.',
    body: h('div', null,
      h('div', { class: 'field' }, h('label', null, 'Quick add'), smart),
      h('p', { class: 'muted', style: { textAlign: 'center', margin: '4px 0 12px', fontSize: '13px' } }, '— or choose manually —'),
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } }, h('div', { class: 'field grow' }, h('label', null, 'Source'), plat), h('div', { class: 'field grow' }, h('label', null, 'Type'), kind)),
      h('div', { class: 'field' }, h('label', null, 'Target'), target),
      h('label', { class: 'row', style: { gap: '8px', fontSize: '13.5px' } }, trusted, 'This is male-focused content (skip the strict check)'),
    ),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => {
      const body = smart.value.trim() ? { input: smart.value.trim() } : { platform: plat.value, kind: kind.value, target: target.value.trim(), trusted: trusted.checked ? true : undefined };
      const r = await act(e.currentTarget, () => adminPost('/feeds', body));
      if (r) { toast(r.status === 'exists' ? 'Already following that' : 'Feed added — syncing now', 'ok'); m.close(); onDone(); }
    } }, 'Add feed')],
  });
}

function importDialog(onDone) {
  const text = h('textarea', { class: 'textarea', rows: 10, placeholder: 'One per line, or comma separated:\nr/gaybrosgonewild\nu/somecreator\nhttps://bsky.app/profile/someone.bsky.social\nhttps://bsky.app/profile/someone.bsky.social/feed/hot\nhttps://example.com/feed.xml\n@name@mastodon.social\n@name@misskey.io' });
  const file = h('input', { type: 'file', accept: '.opml,.xml,.txt,text/xml,application/xml,text/plain', hidden: true });
  file.addEventListener('change', async () => { const f = file.files[0]; if (f) { text.value = await f.text(); toast(`Loaded ${f.name}`); } file.value = ''; });
  const m = openModal({
    title: 'Bulk import', sub: 'Paste communities, creators, feeds and links in any mix — or load an OPML file exported from any feed reader. Unrecognised lines are reported, never guessed.', wide: true,
    body: h('div', null, h('div', { class: 'field' }, text), h('button', { class: 'btn sm', onclick: () => file.click() }, icon('upload', 'sm'), 'Load OPML / text file'), file),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => {
      const r = await act(e.currentTarget, () => adminPost('/feeds/import', { text: text.value }));
      if (!r) return;
      toast(`${r.created} added · ${r.exists} already followed${r.external ? ` · ${r.external} external links ignored` : ''}${r.invalid.length ? ` · ${r.invalid.length} not recognised` : ''}`, r.invalid.length ? '' : 'ok');
      if (r.invalid.length) console.warn('Not recognised:', r.invalid);
      m.close(); onDone();
    } }, 'Import')],
  });
}

export async function render(root) {
  const q = parse().query;
  const f = { platform: q.get('platform') || '', kind: q.get('kind') || '', status: q.get('status') || '', q: q.get('q') || '', page: parseInt(q.get('page') || '0', 10) };
  const set = (patch) => navigate('/admin/feeds', { ...f, ...patch }, { replace: true });

  const search = h('input', { class: 'input sm', type: 'search', placeholder: 'Search feeds…', value: f.q, style: { maxWidth: '220px' } });
  search.addEventListener('input', debounce(() => set({ q: search.value.trim(), page: 0 }), 350));
  const sel = (key, options, label) => h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': label, onchange: (e) => set({ [key]: e.target.value, page: 0 }) }, options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));

  const tableHost = h('div');
  const bar = h('div', { class: 'toolbar' }, search,
    sel('platform', [['', 'All sources'], ...Object.keys(KINDS).map((p) => [p, platformLabel(p) || p])], 'Source'),
    sel('status', [['', 'Any status'], ['ok', 'Healthy'], ['error', 'Failing'], ['never', 'Never run']], 'Status'),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn sm', onclick: () => importDialog(load) }, icon('upload', 'sm'), 'Bulk import'),
    h('button', { class: 'btn sm primary', onclick: () => addDialog(load, { platform: f.platform || 'reddit' }) }, icon('plus', 'sm'), 'Add feed'));
  root.append(pageHead('Feeds', 'Everything PRISM keeps in sync. Each feed has its own schedule, health and backoff.'), bar, tableHost);

  async function load() {
    const r = await adminGet('/feeds', { platform: f.platform, kind: f.kind, status: f.status, q: f.q, page: f.page, limit: 50 });
    tableHost.replaceChildren(
      table([
        { label: '', width: '14px', render: (x) => statusDot(x.last_status) },
        { label: 'Source', render: (x) => h('div', { class: 'row' }, platBadge(x.platform), h('span', { class: 'sub' }, x.kind)) },
        { label: 'Target', render: (x) => h('div', null, h('div', { class: 'truncate', style: { maxWidth: '280px', fontWeight: 550 } }, x.label || x.target), x.creator_handle ? h('a', { class: 'sub', href: href(`/admin/creators`) }, `↳ ${x.creator_name || x.creator_handle}`) : h('span', { class: 'sub' }, x.origin)) },
        { label: 'Last run', render: (x) => h('div', null, x.last_run_at ? fmt.ago(x.last_run_at) : 'never', x.last_error ? h('div', { class: 'sub', style: { color: x.last_status === 'error' ? 'var(--bad)' : 'var(--muted)', maxWidth: '240px' }, title: x.last_error }, h('span', { class: 'truncate', style: { display: 'block' } }, x.last_error)) : null) },
        { label: 'Next', render: (x) => (x.enabled ? fmt.until(x.next_run_at) : '—') },
        { label: 'Items', class: 'num', render: (x) => fmt.int(x.items_total) },
        { label: 'Every', render: (x) => h('select', { class: 'select sm', style: { width: '104px' }, onchange: (e) => adminPatch(`/feeds/${x.id}`, { intervalMin: Number(e.target.value) }).then(() => toast('Interval saved', 'ok')).catch((er) => toast(er.message, 'err')) }, [...new Set([...INTERVALS.map((i) => i[0]), x.interval_min])].sort((a, b) => a - b).map((v) => h('option', { value: v, selected: v === x.interval_min }, (INTERVALS.find((i) => i[0] === v) || [0, `${v} min`])[1]))) },
        { label: 'On', render: (x) => toggle(x.enabled, (on) => adminPatch(`/feeds/${x.id}`, { enabled: on, resetErrors: on }).catch((er) => toast(er.message, 'err'))) },
        { label: '', render: (x) => h('div', { class: 'actions' },
          h('button', { class: 'btn icon sm ghost', title: 'Sync now', 'aria-label': 'Sync now', onclick: (e) => act(e.currentTarget, () => adminPost(`/feeds/${x.id}/run`, { force: false }), 'Queued') }, icon('refresh', 'sm')),
          h('button', { class: 'btn icon sm ghost', title: 'Delete', 'aria-label': 'Delete feed', onclick: async () => { if (await confirmDialog(`Stop following ${x.label || x.target}? Existing media stays.`, { confirmLabel: 'Delete', danger: true })) { await adminDelete(`/feeds/${x.id}`); load(); } } }, icon('trash', 'sm'))) },
      ], r.items, { empty: 'No feeds match. Add one above, or clear the filters.' }),
      pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }));
  }
  await load();
  const timer = setInterval(() => { if (root.isConnected) load().catch(() => {}); }, 15000);
  return () => clearInterval(timer);
}
