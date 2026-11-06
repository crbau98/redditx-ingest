import { h, icon, fmt, toast, confirmDialog, openModal } from '../../dom.js';
import { adminGet, adminPost, adminPatch, adminDelete } from '../../api.js';
import { parse, navigate, href } from '../../router.js';
import { platformLabel } from '../../store.js';
import { table, pager, platBadge, statusDot, pageHead, act, undoToast, searchBox, chips, bulkBar, checkbox, loadingState } from './ui.js';
import { explainFeedError, feedQuery, feedStatusLabel } from './logic.js';

const KINDS = { reddit: ['community', 'user'], redgifs: ['search', 'user', 'niche'], bluesky: ['user', 'search', 'feedgen', 'list'], mastodon: ['user', 'tag'], misskey: ['user', 'tag'], tumblr: ['user', 'tag'], peertube: ['user', 'channel', 'tag', 'search'], x: ['user', 'search'], telegram: ['user'], rss: ['feed'], web: ['page'], linkinbio: ['page'] };
const HINT = {
  reddit: 'r/gaybros or u/someone', redgifs: 'a search term, or a username', bluesky: 'handle.bsky.social  /  bsky.app/profile/…/feed/…  /  …/lists/…', mastodon: 'name@instance.social  /  hashtag', misskey: 'name@misskey.io  /  hashtag', tumblr: 'blogname  /  tag  /  tag@blogname', peertube: 'account@instance.tld  /  channel@instance.tld  /  tag  /  search words',
  x: '@handle  /  search query (needs token)', telegram: 't.me/channelname (public preview)', rss: 'https://site.com/feed.xml', web: 'https://site.com/gallery', linkinbio: 'https://linktr.ee/name',
};
const INTERVALS = [[30, '30 min'], [60, '1 hour'], [90, '90 min'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '1 day'], [4320, '3 days']];
// a phone shows cards (about 190px each), so a page is half as long there
const PAGE = window.matchMedia('(max-width: 899px)').matches ? 25 : 50;
const STATUS_CHIPS = [['', 'All'], ['error', 'Failing'], ['paused', 'Paused'], ['never', 'Never run']];

/** Add a feed. A sheet on a phone. One field is enough: paste a link or a handle. */
export function addFeedDialog(onDone, preset = {}) {
  const smart = h('input', { class: 'input', placeholder: 'Paste a link or handle (r/sub, u/name, x.com/…, bsky.app/…, RSS…)', 'aria-label': 'Link or handle', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const plat = h('select', { class: 'select', 'aria-label': 'Source' }, Object.keys(KINDS).map((p) => h('option', { value: p, selected: p === preset.platform }, platformLabel(p) || p)));
  const kind = h('select', { class: 'select', 'aria-label': 'Type' });
  const target = h('input', { class: 'input', placeholder: '', 'aria-label': 'Target' });
  const syncKinds = () => { kind.replaceChildren(...KINDS[plat.value].map((k) => h('option', { value: k }, k))); target.placeholder = HINT[plat.value]; };
  plat.addEventListener('change', syncKinds); syncKinds();
  const trusted = h('input', { type: 'checkbox' });
  const submit = async (e) => {
    const body = smart.value.trim() ? { input: smart.value.trim() } : { platform: plat.value, kind: kind.value, target: target.value.trim(), trusted: trusted.checked ? true : undefined };
    const r = await act(e.currentTarget, () => adminPost('/feeds', body));
    if (!r) return;
    m.close();
    if (r.status === 'exists') toast('Already following that');
    else {
      const f = r.feed;
      undoToast(`Added ${f ? (f.label || f.target) : 'feed'}; syncing now`, async () => { if (f) await adminDelete(`/feeds/${f.id}`); onDone(); });
    }
    onDone();
  };
  const go = h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Add feed');
  smart.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
  const m = openModal({
    title: 'Add a source', sub: 'Anything PRISM should keep checking: a community, a hashtag, a search, an RSS feed, or one creator’s account.',
    body: h('div', null,
      h('div', { class: 'field' }, h('label', null, 'Quick add'), smart),
      h('details', { class: 'a-fold', style: { margin: '4px 0 12px' } }, h('summary', null, 'Or choose the source yourself'),
        h('div', { class: 'a-fold-body' },
          h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' } }, h('div', { class: 'field grow' }, h('label', null, 'Source'), plat), h('div', { class: 'field grow' }, h('label', null, 'Type'), kind)),
          h('div', { class: 'field' }, h('label', null, 'Target'), target),
          h('label', { class: 'row', style: { gap: '8px', fontSize: '13.5px' } }, trusted, 'This is male-focused content (skip the strict check)')))),
    actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), go],
  });
}

function importDialog(onDone) {
  const text = h('textarea', { class: 'textarea', rows: 10, 'aria-label': 'Feeds to add', placeholder: 'One per line, or comma separated:\nr/gaybrosgonewild\nu/somecreator\nhttps://bsky.app/profile/someone.bsky.social\nhttps://example.com/feed.xml\n@name@mastodon.social' });
  const file = h('input', { type: 'file', accept: '.opml,.xml,.txt,text/xml,application/xml,text/plain', hidden: true });
  file.addEventListener('change', async () => { const f = file.files[0]; if (f) { text.value = await f.text(); toast(`Loaded ${f.name}`); } file.value = ''; });
  const m = openModal({
    title: 'Bulk import', sub: 'Paste communities, creators, feeds and links in any mix, or load an OPML file from a feed reader. Unrecognised lines are reported, never guessed.', wide: true,
    body: h('div', null, h('div', { class: 'field' }, text), h('button', { class: 'btn sm', type: 'button', onclick: () => file.click() }, icon('upload', 'sm'), 'Load OPML / text file'), file),
    actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
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
  const selected = new Map(); // id -> feed on this page

  const platSel = h('select', { class: 'select sm', 'aria-label': 'Source platform', onchange: (e) => set({ platform: e.target.value, page: 0 }) },
    [['', 'All sources'], ...Object.keys(KINDS).map((p) => [p, platformLabel(p) || p])].map(([v, l]) => h('option', { value: v, selected: f.platform === v }, l)));
  const count = h('span', { class: 'a-meta', role: 'status' }, '');
  const selectAll = h('button', { class: 'btn sm', type: 'button' }, 'Select all');
  const bar = h('div', { class: 'a-toolbar' },
    h('div', { class: 'a-toolbar-row' }, searchBox({ value: f.q, placeholder: 'Search feeds…', label: 'Search feeds', onInput: (v) => set({ q: v, page: 0 }) }), platSel),
    h('div', { class: 'a-toolbar-row' }, chips(STATUS_CHIPS, f.status, (v) => set({ status: v, page: 0 }), 'Status'), h('span', { class: 'grow' }), count, selectAll));
  const listHost = h('div', { class: 'stack' });

  const bulk = bulkBar([
    h('button', { class: 'btn', type: 'button', onclick: (e) => bulkRun(e, 'run') }, icon('refresh', 'sm'), 'Run now'),
    h('button', { class: 'btn', type: 'button', onclick: (e) => bulkRun(e, 'pause') }, icon('pause', 'sm'), 'Pause'),
    h('button', { class: 'btn', type: 'button', onclick: (e) => bulkRun(e, 'resume') }, icon('play', 'sm fill'), 'Turn on'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { selected.clear(); syncSelection(); } }, 'Clear'),
  ], { label: 'Selected feeds' });

  root.append(pageHead('Feeds', 'Everything PRISM keeps in sync. Each feed has its own schedule, health and backoff.',
    h('button', { class: 'btn', type: 'button', onclick: () => importDialog(load) }, icon('upload', 'sm'), 'Bulk import'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => addFeedDialog(load, { platform: f.platform || 'reddit' }) }, icon('plus', 'sm'), 'Add feed')), bar, listHost, bulk.el);

  let current = [];
  function syncSelection() {
    bulk.el.hidden = !selected.size;
    if (selected.size) bulk.set(`${selected.size} feed${selected.size === 1 ? '' : 's'} selected`); else bulk.clear();
    for (const cb of listHost.querySelectorAll('input[data-id]')) cb.checked = selected.has(cb.dataset.id);
    selectAll.textContent = current.length && selected.size === current.length ? 'Clear all' : 'Select all';
  }
  selectAll.addEventListener('click', () => {
    if (selected.size === current.length) selected.clear(); else current.forEach((x) => selected.set(x.id, x));
    syncSelection();
  });

  // turning a feed on clears its failure count (a fresh start); an undo changes only the switch, so a failing feed is still failing
  const patchEnabled = (feed, on, { fresh = on } = {}) => adminPatch(`/feeds/${feed.id}`, { enabled: on, resetErrors: fresh });
  async function bulkRun(e, what) {
    const items = [...selected.values()];
    if (!items.length) return;
    const btn = e.currentTarget;
    if (what === 'run') {
      const r = await act(btn, () => adminPost('/engine/run', { feedIds: items.map((x) => x.id), force: true }), `${items.length} queued`);
      if (r) { selected.clear(); syncSelection(); }
      return;
    }
    const on = what === 'resume';
    const affected = items.filter((x) => !!x.enabled !== on);
    const r = await act(btn, async () => { for (const x of affected) await patchEnabled(x, on); return true; });
    if (!r) return load();
    selected.clear(); syncSelection();
    if (affected.length) undoToast(`${on ? 'Turned on' : 'Paused'} ${affected.length} feed${affected.length === 1 ? '' : 's'}`, async () => { for (const x of affected) await patchEnabled(x, !on, { fresh: false }); load(); });
    load();
  }

  const rowActions = (x) => h('div', { class: 'actions' },
    h('button', { class: 'btn sm', type: 'button', onclick: (e) => act(e.currentTarget, () => adminPost(`/feeds/${x.id}/run`, { force: false }), 'Queued') }, icon('refresh', 'sm'), 'Run now'),
    x.enabled
      ? h('button', { class: 'btn sm', type: 'button', onclick: async (e) => { if (await act(e.currentTarget, () => patchEnabled(x, false)) === undefined) return; undoToast(`Paused ${x.label || x.target}`, async () => { await patchEnabled(x, true, { fresh: false }); load(); }); load(); } }, icon('pause', 'sm'), 'Pause')
      : h('button', { class: 'btn sm good', type: 'button', onclick: async (e) => { if (await act(e.currentTarget, () => patchEnabled(x, true)) === undefined) return; undoToast(`Turned on ${x.label || x.target}`, async () => { await patchEnabled(x, false); load(); }); load(); } }, icon('play', 'sm fill'), 'Turn on'),
    h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `Delete ${x.label || x.target}`, onclick: async () => {
      if (await confirmDialog(`Stop following ${x.label || x.target} and delete the feed? Its media stays in the library. This cannot be undone: pause it instead if you may want it back.`, { title: 'Delete this feed?', confirmLabel: 'Delete', danger: true })) { await adminDelete(`/feeds/${x.id}`); toast('Feed deleted', 'ok'); load(); }
    } }, icon('trash', 'sm'), 'Delete'));

  const statusCell = (x) => {
    const label = feedStatusLabel(x);
    const err = x.last_status === 'error' && x.last_error ? explainFeedError(x.last_error, x.consecutive_failures) : null;
    return h('div', { class: 'cell-stack' },
      h('span', { class: `badge ${label === 'Failing' ? 'bad' : label === 'Paused' ? 'warn' : label === 'Healthy' ? 'good' : ''}` }, label),
      err ? h('span', { class: 'a-err', title: x.last_error }, err.plain) : null);
  };

  async function load() {
    let r;
    try { r = await adminGet('/feeds', { ...feedQuery(f), limit: PAGE }); } catch (e) { listHost.replaceChildren(h('div', { class: 'a-alert bad', role: 'alert' }, icon('alert', 'sm'), h('div', null, `Couldn’t load feeds: ${e.message}. `, h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, 'Try again')))); return; }
    current = r.items;
    for (const id of [...selected.keys()]) if (!current.some((x) => x.id === id)) selected.delete(id);
    count.textContent = `${fmt.int(r.total)} feed${r.total === 1 ? '' : 's'}`;
    selectAll.hidden = !current.length;
    listHost.replaceChildren(
      table([
        { label: '', srLabel: 'Select', cell: 'check', width: '40px', render: (x) => checkbox({ cell: true, id: x.id, checked: selected.has(x.id), label: `Select ${x.label || x.target}`, onChange: (on) => { if (on) selected.set(x.id, x); else selected.delete(x.id); syncSelection(); } }) },
        { label: 'Feed', cell: 'title', render: (x) => h('div', { class: 'cell-stack' },
          h('div', { class: 'a-title' }, statusDot(x.last_status), h('span', { class: 'name' }, x.label || x.target), platBadge(x.platform), h('span', { class: 'a-sub' }, x.kind)),
          x.creator_handle ? h('a', { class: 'a-sub', href: href('/admin/creators', { q: x.creator_handle }) }, `↳ ${x.creator_name || x.creator_handle}`) : h('span', { class: 'a-sub' }, x.origin)) },
        { label: 'Status', noLabel: true, render: statusCell },
        { label: 'Last run', render: (x) => (x.last_run_at ? fmt.ago(x.last_run_at) : 'never') },
        { label: 'Next', render: (x) => (x.enabled ? fmt.until(x.next_run_at) : '—') },
        { label: 'Items', class: 'num', render: (x) => fmt.int(x.items_total) },
        { label: 'Every', render: (x) => h('select', { class: 'select sm', style: { width: '112px' }, 'aria-label': `How often ${x.label || x.target} is read`, onchange: (e) => adminPatch(`/feeds/${x.id}`, { intervalMin: Number(e.target.value) }).then(() => toast('Interval saved', 'ok')).catch((er) => toast(er.message, 'err')) }, [...new Set([...INTERVALS.map((i) => i[0]), x.interval_min])].sort((a, b) => a - b).map((v) => h('option', { value: v, selected: v === x.interval_min }, (INTERVALS.find((i) => i[0] === v) || [0, `${v} min`])[1]))) },
        { label: '', srLabel: 'Actions', cell: 'actions', render: rowActions },
      ], r.items, { label: 'Feeds', empty: f.q || f.status || f.platform ? 'No feeds match these filters.' : 'No feeds yet. Add one above.' }),
      pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }));
    syncSelection();
  }
  listHost.replaceChildren(loadingState('Loading feeds'));
  await load();
  const timer = setInterval(() => { if (root.isConnected && !selected.size && !listHost.contains(document.activeElement)) load().catch(() => {}); }, 15000);
  return () => clearInterval(timer);
}
