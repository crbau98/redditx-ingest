import { h, icon, fmt, emptyState, toast, paintCover } from '../../dom.js';
import { adminGet, adminPost } from '../../api.js';
import { href } from '../../router.js';
import { pageHead, act, platBadge, openModal, undoToast, bulkBar, loadingState, errorState, pager } from './ui.js';
import { holdOf, undoPlan, selectionSummary, sendBackBody, reasonClearBody, reasonActions, reasonClearCopy, reasonUndoChunks, REASON_ROUNDS } from './logic.js';
import { stillChain } from '../../images.js';

export { holdOf };

/*
 * The review queue: media the gate held back. Nothing here is public until approved.
 *
 * Hold kinds, in the order a reviewer should meet them:
 *   safety  a safety rule matched (the rule name is in review_reason). Approving publishes it,
 *           so approval of these asks for confirmation and names the rule.
 *   scope   the male focus could not be confirmed. Check the creator and the post.
 *   other   anything else the gate wrote. Shown as the gate wrote it.
 *
 * Actions, and what each one does to the item:
 *   Approve   publish (asks first; undo puts it back in the queue)
 *   Hide      keep it out of the library (undo puts it back in the queue)
 *   Remove    take it down (asks first; undo puts it back in the queue)
 *   Block     block the item forever so the source cannot return it (asks first; cannot be undone here)
 *
 * A hold with more rows than this page shows also has Publish all, Hide all and Remove all.
 * One confirm applies to every item still waiting under that exact reason. Block stays per item.
 */

// Used by the media browser's grid (selectableGrid below), which still shows the raw reason.
const REASONS = { 'scope:unclear': 'Male focus unclear', 'scope': 'Male focus unclear' };
const reasonLabel = (r) => (r && r.startsWith('safety:') ? `Safety: ${r.slice(7)}` : REASONS[r] || r || 'Flagged');

const KIND_ORDER = ['safety', 'scope', 'other'];
const ACTION_WORD = { approve: 'published', hide: 'hidden', reject: 'removed', block: 'blocked' };

/** One card. Evidence shown is what the queue returns: the hold, the creator, the source, the tags and the level. */
function queueCard(m, { onFlip }) {
  const hold = holdOf(m.review_reason);
  const creator = m.creator_name || m.creator_handle || m.author || 'Unknown creator';
  const tags = String(m.tags_text || '').split(/\s+/).filter(Boolean).slice(0, 4);
  const aria = `${m.title || 'Untitled'}. ${hold.label}. ${creator}.`;
  const img = h('div', { class: 'img', 'aria-hidden': 'true' },
    h('div', { class: 'check' }, icon('check')),
    m.media_type === 'video' ? h('span', { class: 'pill', style: { position: 'absolute', right: '8px', top: '8px' } }, icon('play', 'fill'), 'Video') : null);
  paintCover(img, stillChain(m));
  const card = h('div', { class: `mod-card kind-${hold.kind}`, tabindex: '0', role: 'checkbox', 'aria-checked': 'false', 'aria-label': aria },
    img,
    h('div', { class: 'body' },
      h('div', { class: 't' }, m.title || '(untitled)'),
      h('div', { class: 'row wrap', style: { gap: '6px' } }, platBadge(m.platform),
        h('span', { class: `badge ${hold.kind === 'safety' ? 'bad' : 'warn'}` }, hold.label)),
      h('div', { class: 'review-why' }, hold.why),
      h('div', { class: 'review-ev muted' },
        h('span', null, `${creator}${m.creator_handle ? ` · @${m.creator_handle}` : ''}`),
        h('span', null, `Posted ${m.posted_at ? fmt.ago(m.posted_at) : 'unknown'}`),
        m.nsfw_level ? h('span', null, `Level: ${m.nsfw_level}`) : null),
      tags.length ? h('div', { class: 'review-tags muted' }, tags.map((t) => `#${t.replace(/^#/, '')}`).join(' ')) : null,
      m.source_url ? h('a', { href: m.source_url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'muted review-src', onclick: (e) => e.stopPropagation() }, 'View original ↗') : null));
  const flip = () => onFlip(m, card);
  card.addEventListener('click', (e) => { if (!e.target.closest('a')) flip(); });
  card.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
  return { card, hold };
}

/** The queue as sections by hold kind, with one shared selection. Keeps the `el` / `selected` shape the key handler uses. */
export function reviewGroups(items, { onChange }) {
  const selected = new Map(); // id -> item
  const cards = new Map();    // id -> card element
  const el = h('div', { class: 'stack review-groups' });
  const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, []]));
  for (const m of items) byKind[holdOf(m.review_reason).kind].push(m);
  const setCard = (id, on) => { const c = cards.get(id); if (!c) return; c.classList.toggle('sel', on); c.setAttribute('aria-checked', String(on)); };
  const flip = (m, card) => { cards.set(m.id, card); if (selected.has(m.id)) selected.delete(m.id); else selected.set(m.id, m); setCard(m.id, selected.has(m.id)); onChange(selected); };
  const groupsEls = KIND_ORDER.filter((k) => byKind[k].length).map((k) => {
    const list = byKind[k];
    const headId = `rq-${k}`;
    const grid = h('div', { class: 'mod-grid' });
    const built = list.map((m) => { const { card, hold } = queueCard(m, { onFlip: flip }); cards.set(m.id, card); grid.append(card); return hold; });
    const pick = (on) => list.forEach((m) => { if (on) selected.set(m.id, m); else selected.delete(m.id); setCard(m.id, on); });
    const allOn = () => list.every((m) => selected.has(m.id));
    const selBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => { pick(!allOn()); onChange(selected); selBtn.textContent = allOn() ? 'Clear this group' : `Select all ${list.length}`; } }, `Select all ${list.length}`);
    return h('section', { class: `review-group kind-${k}`, 'aria-labelledby': headId },
      h('div', { class: 'review-group-head' },
        h('h2', { id: headId, class: 'group-label' }, `${built[0].group} · ${list.length} on this page`),
        h('span', { class: 'grow' }), selBtn),
      k === 'safety' ? h('p', { class: 'review-group-note muted' }, 'Approving publishes these. You confirm once before anything goes live.') : null,
      grid);
  });
  el.append(...groupsEls);
  return { el, selected, items, cards, selectAll() { items.forEach((m) => { selected.set(m.id, m); setCard(m.id, true); }); onChange(selected); } };
}

/** Confirmation for the actions that change what the public sees. Cancel has the focus, so Enter does nothing by accident. */
export function confirmBatch(action, items) {
  const n = items.length;
  const safety = items.filter((m) => holdOf(m.review_reason).kind === 'safety');
  const rules = [...new Set(safety.map((m) => holdOf(m.review_reason).rule))];
  const copy = {
    approve: { title: `Publish ${n} ${n === 1 ? 'item' : 'items'}?`, go: `Publish ${n}`, cls: 'good',
      sub: `They go live in the library and in Explore.${safety.length ? ` ${safety.length} matched a safety rule (${rules.join(', ')}). Publishing overrides that rule for these items.` : ''}` },
    reject: { title: `Remove ${n} ${n === 1 ? 'item' : 'items'}?`, go: `Remove ${n}`, cls: 'danger',
      sub: 'They are taken down and are not shown on the site.' },
    block: { title: `Block ${n} ${n === 1 ? 'item' : 'items'} forever?`, go: `Block ${n}`, cls: 'danger',
      sub: 'The source cannot return these items. Only an admin can undo a block, from the blocklist.' },
  }[action];
  if (!copy) return Promise.resolve(true);
  return new Promise((resolve) => {
    let m;
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close(false) }, 'Cancel');
    const go = h('button', { class: `btn ${copy.cls}`, type: 'button', onclick: () => m.close(true) }, copy.go);
    m = openModal({ title: copy.title, sub: copy.sub, body: null, onClose: (ok) => resolve(!!ok), actions: [cancel, go] });
    setTimeout(() => cancel.focus(), 60);
  });
}

/**
 * Put items back where they came from: approve, hide and remove all return to the review queue, each with the hold reason it was
 * waiting under (the queue groups by it, and an approval names the safety rule it overrides), in ONE atomic request. Takes the items
 * (or their ids, which come back as an unclassified hold).
 */
export async function sendBackToReview(items) { return adminPost('/media/bulk', sendBackBody(items)); }

/** One confirm for a whole hold. Cancel has the focus, so Enter does nothing by accident. */
function confirmReason(action, row) {
  const copy = reasonClearCopy(row.reason, action, row.n);
  if (!copy) return Promise.resolve(false);
  return new Promise((resolve) => {
    let m;
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => m.close(false) }, 'Cancel');
    const go = h('button', { class: copy.cls ? `btn ${copy.cls}` : 'btn', type: 'button', onclick: () => m.close(true) }, copy.go);
    m = openModal({ title: copy.title, sub: copy.sub, body: null, onClose: (ok) => resolve(!!ok), actions: [cancel, go] });
    setTimeout(() => cancel.focus(), 60);
  });
}

export async function render(root) {
  const host = h('div', { class: 'stack' });
  const sub = h('div', null,
    h('div', null, 'Held back, not public. The gate kept these out because a safety rule matched or the male focus is unclear.'),
    h('div', { class: 'a-keys' }, 'Keys: ← → move · Space select · A approve (asks first) · H hide · R remove (asks first). Block has no key.'));
  root.append(pageHead('Review queue', sub), host);

  // Keyboard triage: with hundreds waiting, clicking each one is the slowest part. Approve, Remove and Block ask first; Hide does not.
  let grid = null;
  let shortcuts = null;
  let lastKey = null; let lastAt = 0;
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable], button, a')) return;
    const modal = document.getElementById('modal-root');
    if (modal && modal.children.length) return;
    const now = Date.now();
    const prevG = (lastKey === 'g' || lastKey === 'G') && now - lastAt < 1200;
    lastKey = e.key; lastAt = now;
    if (prevG || !grid || !grid.el.isConnected) return;
    const cards = [...grid.el.querySelectorAll('.mod-card')];
    if (!cards.length) return;
    if (e.key.startsWith('Arrow')) {
      const i = cards.indexOf(document.activeElement);
      const next = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? Math.min(cards.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      e.preventDefault();
      cards[next].focus();
      cards[next].scrollIntoView({ block: 'nearest' });
      return;
    }
    const k = e.key.toLowerCase();
    if (!shortcuts || !shortcuts[k] || !grid.selected.size) return;
    e.preventDefault();
    shortcuts[k]();
  };
  document.addEventListener('keydown', onKey);

  let alive = true;
  const showState = (node) => { if (alive) host.replaceChildren(node); };
  let bulk = null;
  let clearing = false;
  // Mixed holds used to stop at the newest 60. Page through the rest with the same pager as Media.
  let page = 0;
  const PAGE = 60;

  async function load() {
    if (!alive) return;
    showState(loadingState('Loading the queue'));
    if (bulk) bulk.clear();
    let r;
    try { r = await adminGet('/moderation/queue', { limit: PAGE, page }); }
    catch (e) { if (alive) showState(errorState(e.message, () => load())); return; }
    if (!alive) return;
    // After a clear, this page can be empty while older holds remain — step back once.
    if (!r.items.length && page > 0 && (r.total || 0) > 0) {
      page = Math.max(0, Math.min(page - 1, Math.ceil(r.total / (r.limit || PAGE)) - 1));
      return load();
    }
    if (!r.items.length) {
      grid = null; shortcuts = null;
      showState(emptyState({ icon: 'check', title: 'Nothing is waiting',
        text: 'The queue holds media the gate kept back: a safety rule matched, or the male focus could not be confirmed. Nothing held here is public. New holds appear after the next ingest.',
        actions: [h('a', { class: 'btn', href: href('/admin/overview') }, 'Back to overview')] }));
      return;
    }
    const run = (action) => async (e) => {
      const items = [...grid.selected.values()];
      if (!items.length) return;
      // Everything that changes what the public sees asks first (Approve names any safety rule it overrides); Hide does not.
      if (action !== 'hide' && !(await confirmBatch(action, items))) return;
      const ids = items.map((m) => m.id);
      const ok = await act(e && e.currentTarget, () => adminPost('/media/bulk', { ids, action, reason: 'review queue' }));
      if (!ok) return;
      const plan = undoPlan(action);
      if (plan) undoToast(`${plan.verb} ${ids.length} item${ids.length === 1 ? '' : 's'}`, async () => { await sendBackToReview(items); load(); });
      else toast(`${ids.length} ${ACTION_WORD[action]}`);
      load();
    };
    bulk = bulkBar([
      h('button', { class: 'btn good', type: 'button', onclick: run('approve') }, icon('check', 'sm'), 'Approve'),
      h('button', { class: 'btn', type: 'button', onclick: run('hide') }, 'Hide'),
      h('button', { class: 'btn', type: 'button', onclick: run('reject') }, 'Remove'),
      h('button', { class: 'btn danger', type: 'button', 'aria-label': 'Block forever', title: 'Block forever', onclick: run('block') }, 'Block'),
    ], { label: 'Selected items' });
    grid = reviewGroups(r.items, { onChange: (sel) => { const items = [...sel.values()]; if (items.length) bulk.set(selectionSummary(items)); else bulk.clear(); } });
    const holds = reasonActions(r.reasons, r.items);
    const status = h('div', { class: 'a-meta', role: 'status' });
    const clearReason = (action, row) => async (e) => {
      if (clearing) return;
      clearing = true;
      try {
        if (!(await confirmReason(action, row))) return;
        const label = holdOf(row.reason).label;
        await act(e && e.currentTarget, async () => {
          const ids = [];
          let remaining = row.n;
          let guard = 0;
          let stopped = null;
          try {
            while (alive && remaining > 0 && guard++ < REASON_ROUNDS) {
              const body = reasonClearBody(row.reason, action);
              if (!body) break;
              const out = await adminPost('/moderation/by-reason', body);
              if (!out || !out.updated) { remaining = out ? Number(out.remaining) || 0 : remaining; break; }
              if (Array.isArray(out.ids)) ids.push(...out.ids);
              remaining = Number(out.remaining) || 0;
              if (status.isConnected) status.textContent = `${label}: ${fmt.int(ids.length)} done${remaining ? ` · ${fmt.int(remaining)} still waiting` : ''}`;
            }
          } catch (err) { stopped = err; }
          const plan = undoPlan(action);
          if (plan && ids.length) {
            undoToast(`${plan.verb} ${fmt.int(ids.length)} “${label}”`, async () => {
              for (const body of reasonUndoChunks(ids, row.reason)) await adminPost('/media/bulk', body);
              if (alive) load();
            });
          }
          if (alive) await load();
          if (stopped) throw stopped;
          if (remaining > 0) toast(`${fmt.int(remaining)} still waiting under this hold`);
        });
      } finally { clearing = false; }
    };
    const holdSection = holds.length ? h('section', { class: 'review-reasons', 'aria-label': 'Clear a whole hold' },
      h('h2', { class: 'group-label' }, 'Clear a whole hold'),
      h('p', { class: 'review-group-note muted' }, 'One action applies to every item still waiting under that hold, not only this page.'),
      status,
      ...holds.map((row) => h('div', { class: 'review-reason' },
        h('div', { class: 'grow' }, h('strong', null, row.label), h('div', { class: 'muted' }, `${fmt.int(row.n)} waiting`)),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm good', type: 'button', onclick: clearReason('approve', row) }, 'Publish all'),
          h('button', { class: 'btn sm', type: 'button', onclick: clearReason('hide', row) }, 'Hide all'),
          h('button', { class: 'btn sm', type: 'button', onclick: clearReason('reject', row) }, 'Remove all'))))) : null;
    const from = page * (r.limit || PAGE) + 1;
    const to = from + r.items.length - 1;
    showState(h('div', { class: 'stack' },
      holdSection,
      h('div', { class: 'row' }, h('span', { class: 'a-meta', role: 'status' }, `${fmt.int(r.total)} waiting · showing ${from}–${to}`), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => grid.selectAll() }, 'Select all on this page')),
      grid.el,
      pager({ page: r.page, limit: r.limit || PAGE, total: r.total, onPage: (p) => { page = p; load(); } }),
      bulk.el));
    shortcuts = { a: run('approve'), h: run('hide'), r: run('reject') };
  }
  await load();
  return () => { alive = false; document.removeEventListener('keydown', onKey); };
}

/** A selectable grid of media with bulk actions — shared by the review queue and the media browser. */
export function selectableGrid(items, { onChange }) {
  const selected = new Set();
  const cards = items.map((m) => {
    const img = h('div', { class: 'img' }, h('div', { class: 'check' }, icon('check')),
      m.media_type === 'video' ? h('span', { class: 'pill', style: { position: 'absolute', right: '8px', top: '8px' } }, icon('play', 'fill'), 'Video') : null);
    paintCover(img, stillChain(m));
    const card = h('div', { class: 'mod-card', tabindex: '0', role: 'checkbox', 'aria-checked': 'false', 'aria-label': m.title || 'media' },
      img,
      h('div', { class: 'body' }, h('div', { class: 't' }, m.title || '(untitled)'),
        h('div', { class: 'row wrap', style: { gap: '6px' } }, platBadge(m.platform), m.review_reason ? h('span', { class: `badge ${m.review_reason.startsWith('safety') ? 'bad' : 'warn'}` }, reasonLabel(m.review_reason)) : null),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, `${m.creator_name || m.author || '—'} · ${fmt.ago(m.ingested_at)}`),
        m.source_url ? h('a', { href: m.source_url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'muted', style: { fontSize: '12px' }, onclick: (e) => e.stopPropagation() }, 'View original ↗') : null));
    const flip = () => { if (selected.has(m.id)) selected.delete(m.id); else selected.add(m.id); card.classList.toggle('sel', selected.has(m.id)); card.setAttribute('aria-checked', String(selected.has(m.id))); onChange(selected); };
    card.addEventListener('click', flip);
    card.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
    return card;
  });
  return { el: h('div', { class: 'mod-grid' }, cards), selected, selectAll() { items.forEach((m, i) => { selected.add(m.id); cards[i].classList.add('sel'); cards[i].setAttribute('aria-checked', 'true'); }); onChange(selected); } };
}
