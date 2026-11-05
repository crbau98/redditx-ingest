import { h, icon, fmt, proxied, toast, openModal, emptyState } from '../../dom.js';
import { platformLabel, platformColor } from '../../store.js';

export const platBadge = (p) => h('span', { class: 'badge plat', style: { '--c': platformColor(p) } }, platformLabel(p));

export function statusDot(status, failures = 0) {
  const map = { ok: 'good', empty: 'good', error: 'bad', skipped: 'warn' };
  const cls = status ? map[status] || '' : 'info';
  return h('span', { class: `dot ${cls}`, title: status || 'never run', role: 'img', 'aria-label': status || 'never run' });
}

export const thumbOf = (m) => m.preview_url || m.thumbnail_url || (m.media_type === 'image' ? m.media_url : '');
export const thumb = (m) => h('div', { class: 'thumb', style: thumbOf(m) ? { backgroundImage: `url("${proxied(thumbOf(m))}")` } : {} });

/**
 * A list that is a table on a wide screen and a stack of cards on a phone (CSS only: the same cells, laid out by `.tbl.a-cards`).
 * Column: { label, render, class, width, cell } where cell is 'check' | 'title' | 'wide' | 'actions' to say where it sits in a card.
 * Table roles are written out because a table laid out as blocks loses them in some browsers.
 */
export function table(columns, rows, { empty = 'Nothing here.', label = 'List' } = {}) {
  const head = h('tr', { role: 'row' }, columns.map((c) => h('th', { role: 'columnheader', scope: 'col', style: c.width ? { width: c.width } : null, class: c.class }, c.label || h('span', { class: 'sr-only' }, c.srLabel || ''))));
  const body = rows.length
    ? rows.map((r) => h('tr', { role: 'row' }, columns.map((c) => h('td', { role: 'cell', class: c.class, 'data-label': c.label || null, 'data-cell': c.cell || null }, c.render(r)))))
    : [h('tr', { role: 'row' }, h('td', { role: 'cell', colspan: columns.length, class: 'tbl-empty' }, empty))];
  return h('div', { class: 'tbl-wrap a-cards' }, h('table', { class: 'tbl a-cards', role: 'table', 'aria-label': label }, h('thead', { role: 'rowgroup' }, head), h('tbody', { role: 'rowgroup' }, body)));
}

export function pager({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return h('nav', { class: 'pager', 'aria-label': 'Pages' },
    h('span', { role: 'status' }, `${fmt.int(total)} total · page ${page + 1} of ${pages}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', type: 'button', disabled: page <= 0, onclick: () => onPage(page - 1) }, icon('chev-l', 'sm'), 'Prev'),
      h('button', { class: 'btn sm', type: 'button', disabled: page >= pages - 1, onclick: () => onPage(page + 1) }, 'Next', icon('chev-r', 'sm'))));
}

export function toggle(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', checked: !!checked, role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label || null });
  input.addEventListener('change', () => { input.setAttribute('aria-checked', String(input.checked)); onChange(input.checked, input); });
  return h('label', { class: 'switch' }, input, h('span'));
}

export function kpi({ value, label, detail, href, tone }) {
  const el = h(href ? 'a' : 'div', { class: `kpi${href ? ' link' : ''}${tone ? ` alert ${tone === 'bad' ? 'bad' : ''}` : ''}`, href }, h('div', { class: 'v num' }, value), h('div', { class: 'l' }, label), detail ? h('div', { class: 'd' }, detail) : null);
  return el;
}

/** Wrap an async action: disables the button, toasts errors. */
export async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; }
  catch (e) { toast(e.message || 'Failed', 'err'); return undefined; }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
}

export function pageHead(title, sub, ...actions) {
  return h('div', { class: 'adm-head' }, h('div', null, h('h1', { tabindex: '-1' }, title), sub ? h('div', { class: 'sub' }, sub) : null), actions.length ? h('div', { class: 'row wrap' }, actions) : null);
}

/**
 * A toast with an Undo button. It stays 8 seconds (long enough to reach on a phone), one at a time per `key`.
 * `onUndo` may be async; a failure is reported and the toast closes either way.
 */
let undoEl = null;
export function undoToast(message, onUndo, { ms = 8000 } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return { dismiss() {} };
  if (undoEl) undoEl.remove();
  let timer = null;
  const dismiss = () => { clearTimeout(timer); if (el.isConnected) el.remove(); if (undoEl === el) undoEl = null; };
  const btn = h('button', { type: 'button', onclick: async () => {
    btn.disabled = true;
    try { await onUndo(); toast('Undone', 'ok'); } catch (e) { toast(e.message || 'Could not undo', 'err'); }
    dismiss();
  } }, 'Undo');
  const el = h('div', { class: 'toast a-undo', role: 'status' }, h('span', null, message), btn);
  root.appendChild(el);
  undoEl = el;
  timer = setTimeout(dismiss, ms);
  return { dismiss };
}

/** Sticky-friendly search box with a visible label for screen readers. */
let refocusSearch = false; // a search that re-renders its view (the filter lives in the URL) gets its caret back
export function searchBox({ value = '', placeholder = 'Search…', label = 'Search', onInput }) {
  const input = h('input', { class: 'input', type: 'search', value, placeholder, 'aria-label': label, autocomplete: 'off', enterkeyhint: 'search' });
  let t = null;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { refocusSearch = true; onInput(input.value.trim()); setTimeout(() => { refocusSearch = false; }, 400); }, 350); });
  if (refocusSearch) { refocusSearch = false; setTimeout(() => { if (input.isConnected) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }, 80); }
  return h('div', { class: 'a-search' }, icon('search', 'sm'), input);
}

/** Filter chips: one is pressed. Real buttons with aria-pressed, 44px on touch. */
export function chips(options, current, onPick, label) {
  return h('div', { class: 'a-chips', role: 'group', 'aria-label': label }, options.map(([v, l]) => h('button', { class: 'a-chip', type: 'button', 'aria-pressed': String(current === v), onclick: () => onPick(v) }, l)));
}

/**
 * The bulk action bar, fixed to the bottom of the screen (above the tab bar on a phone) and shown only while something is selected.
 * `buttons` are real <button>s; `set(summary)` shows the bar with a count line, `clear()` hides it.
 */
export function bulkBar(buttons, { label = 'Selected items' } = {}) {
  const count = h('div', { class: 'a-bulk-count', role: 'status', 'aria-live': 'polite' });
  const el = h('div', { class: 'a-bulk', hidden: true, role: 'region', 'aria-label': label }, count, h('div', { class: 'a-bulk-acts' }, buttons));
  return {
    el,
    set(summary) { count.textContent = summary; el.hidden = false; },
    clear() { el.hidden = true; count.textContent = ''; },
  };
}

/** A checkbox with a 44px hit area; `cell` pulls it into the card's left edge. */
export function checkbox({ checked = false, label, onChange, cell = false, id = null }) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label, 'data-id': id });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: `a-check${cell ? ' cell' : ''}` }, input);
}

export const loadingState = (text = 'Loading…') => h('div', { class: 'a-skel', role: 'status', 'aria-label': text }, h('i'), h('i'), h('i'));

/** An error with a way out. Nothing was changed. */
export function errorState(message, retry) {
  return emptyState({ icon: 'alert', title: 'That did not load', text: `${message || 'The server did not answer.'} Nothing was changed.`, actions: retry ? [h('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again')] : [] });
}

/** Run `render()` into `host` with a loading state first and an error state (with retry) if it throws. */
export async function guarded(host, render) {
  const run = async () => {
    host.replaceChildren(loadingState());
    try { host.replaceChildren(await render()); } catch (e) { host.replaceChildren(errorState(e && e.message, run)); }
  };
  await run();
}

export { openModal, emptyState };
