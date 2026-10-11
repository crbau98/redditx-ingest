import { h, icon, fmt, proxied, toast, openModal } from '../../dom.js';
import { platformLabel, platformColor } from '../../store.js';

export const platBadge = (p) => h('span', { class: 'badge plat', style: { '--c': platformColor(p) } }, platformLabel(p));

export function statusDot(status, failures = 0) {
  const map = { ok: 'good', empty: 'good', error: 'bad', skipped: 'warn' };
  const cls = status ? map[status] || '' : 'info';
  return h('span', { class: `dot ${cls}`, title: status || 'never run' });
}

export const thumbOf = (m) => m.preview_url || m.thumbnail_url || (m.media_type === 'image' ? m.media_url : '');
export const thumb = (m) => h('div', { class: 'thumb', style: thumbOf(m) ? { backgroundImage: `url("${proxied(thumbOf(m))}")` } : {} });

export function table(columns, rows, { empty = 'Nothing here.' } = {}) {
  const head = h('tr', null, columns.map((c) => h('th', { style: c.width ? { width: c.width } : null, class: c.class }, c.label || '')));
  const body = rows.length
    ? rows.map((r) => h('tr', null, columns.map((c) => h('td', { class: c.class }, c.render(r)))))
    : [h('tr', null, h('td', { colspan: columns.length, class: 'tbl-empty' }, empty))];
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, head), h('tbody', null, body)));
}

export function pager({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return h('div', { class: 'pager' },
    h('span', null, `${fmt.int(total)} total · page ${page + 1} of ${pages}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', disabled: page <= 0, onclick: () => onPage(page - 1) }, icon('chev-l', 'sm'), 'Prev'),
      h('button', { class: 'btn sm', disabled: page >= pages - 1, onclick: () => onPage(page + 1) }, 'Next', icon('chev-r', 'sm'))));
}

export function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!checked, role: 'switch', 'aria-checked': String(!!checked) });
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
  finally { if (btn) btn.disabled = false; }
}

export function pageHead(title, sub, ...actions) {
  return h('div', { class: 'adm-head' }, h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null), actions.length ? h('div', { class: 'row wrap' }, actions) : null);
}

export { openModal };
