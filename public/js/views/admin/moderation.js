import { h, icon, fmt, toast, proxied, emptyState } from '../../dom.js';
import { adminGet, adminPost } from '../../api.js';
import { pageHead, act, platBadge, thumbOf } from './ui.js';

const REASONS = { 'scope:unclear': 'Male focus unclear', 'scope': 'Male focus unclear' };
const reasonLabel = (r) => (r && r.startsWith('safety:') ? `Safety: ${r.slice(7)}` : REASONS[r] || r || 'Flagged');

/** A selectable grid of media with bulk actions — shared by the review queue and the media browser. */
export function selectableGrid(items, { onChange }) {
  const selected = new Set();
  const cards = items.map((m) => {
    const card = h('div', { class: 'mod-card', tabindex: '0', role: 'checkbox', 'aria-checked': 'false', 'aria-label': m.title || 'media' },
      h('div', { class: 'img', style: thumbOf(m) ? { backgroundImage: `url("${proxied(thumbOf(m))}")` } : {} }, h('div', { class: 'check' }, icon('check')),
        m.media_type === 'video' ? h('span', { class: 'pill', style: { position: 'absolute', right: '8px', top: '8px' } }, icon('play', 'fill'), 'Video') : null),
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

export async function render(root) {
  const host = h('div', { class: 'stack' });
  root.append(pageHead('Review queue', 'Items held back because their male focus is unclear or the safety gate flagged a keyword. Nothing here is public until you approve it.  Shortcuts: ← → move · Space select · A approve · H hide · R remove.'), host);

  // Keyboard triage: with 700+ items waiting, clicking each one is the slowest part of the job.
  // "Block forever" deliberately has no shortcut — the one irreversible action stays a click.
  let grid = null;
  let shortcuts = null; // the bulk actions of the page currently showing (NOT named `act`: that shadows the import)
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

  async function load() {
    const r = await adminGet('/moderation/queue', { limit: 60 });
    if (!r.items.length) { host.replaceChildren(emptyState({ icon: 'check', title: 'Queue is clear', text: 'Nothing needs a decision right now.' })); return; }
    const bar = h('div', { class: 'bulkbar', hidden: true });
    const count = h('b', null, '0 selected');
    const run = (action) => async (e) => {
      const ids = [...grid.selected];
      await act(e && e.currentTarget, () => adminPost('/media/bulk', { ids, action, reason: 'review queue' }), `${ids.length} ${action === 'approve' ? 'approved' : action === 'block' ? 'blocked' : action === 'hide' ? 'hidden' : 'removed'}`);
      load();
    };
    grid = selectableGrid(r.items, { onChange: (sel) => { bar.hidden = !sel.size; count.textContent = `${sel.size} selected`; } });
    bar.append(count, h('span', { class: 'grow' }),
      h('button', { class: 'btn good', onclick: run('approve') }, icon('check', 'sm'), 'Approve'),
      h('button', { class: 'btn', onclick: run('hide') }, 'Hide'),
      h('button', { class: 'btn', onclick: run('reject') }, 'Remove'),
      h('button', { class: 'btn danger', onclick: run('block') }, 'Block forever'));
    host.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'muted' }, `${fmt.int(r.total)} waiting`), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: () => grid.selectAll() }, 'Select all on page')), grid.el, bar);
    // The keyboard layer runs the same actions as the buttons (act() takes any element, or none).
    shortcuts = { a: run('approve'), h: run('hide'), r: run('reject') };
  }
  await load();
  return () => document.removeEventListener('keydown', onKey);
}
