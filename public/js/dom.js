// Tiny DOM toolkit. Content is only ever inserted as text nodes or attributes —
// there is no innerHTML anywhere, so scraped titles/bios cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

// The native replaceChildren/append turn `null`/`undefined`/`false` into the literal text
// "null"/"undefined"/"false". We routinely pass `cond ? node : null`, so make the native
// methods skip empty values (also flattening arrays) instead of rendering them.
for (const method of ['replaceChildren', 'append', 'prepend']) {
  const native = Element.prototype[method];
  Element.prototype[method] = function patched(...nodes) {
    return native.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  };
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `i ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...nodes) => { clear(el); append(el, nodes); return el; };

/* ------------------------------------------------------------- formatting */
const nf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  num: (n) => nf.format(n || 0),
  int: (n) => new Intl.NumberFormat('en').format(n || 0),
  ago(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
    return `${Math.floor(s / (86400 * 365))}y ago`;
  },
  until(iso) {
    if (!iso) return '—';
    const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
    if (s <= 0) return 'due';
    if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
    if (s < 86400) return `in ${Math.round(s / 3600)}h`;
    return `in ${Math.round(s / 86400)}d`;
  },
  date: (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'),
  duration(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60); const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  },
  ms: (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`),
};

/** Remote media always goes through the same-origin proxy. Local paths pass through. */
export function proxied(url) {
  if (!url) return '';
  if (url.startsWith('/') || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ } ta.remove(); return ok;
  }
}

/* --------------------------------------------------------------- avatars */
const GRADS = [['#8b5cf6', '#ec4899'], ['#06b6d4', '#8b5cf6'], ['#f97316', '#ef4444'], ['#10b981', '#06b6d4'], ['#f59e0b', '#ec4899'], ['#6366f1', '#14b8a6']];
export function avatar(entity, size = 40) {
  const name = (entity && (entity.display_name || entity.creator_name || entity.handle || entity.creator_handle)) || '?';
  const url = entity && (entity.avatar_url || entity.creator_avatar);
  const initial = name.replace(/^[^A-Za-z0-9]+/, '').charAt(0).toUpperCase() || '?';
  let hash = 0; for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = GRADS[hash % GRADS.length];
  const el = h('div', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: `linear-gradient(135deg, ${a}, ${b})` } }, initial);
  if (url) {
    const img = h('img', { src: proxied(url), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('load', () => { el.textContent = ''; el.appendChild(img); }, { once: true });
  }
  return el;
}

/* ---------------------------------------------------------------- toasts */
export function toast(message, type = '') {
  const root = $('#toast-root');
  const el = h('div', { class: `toast ${type}`, role: 'status' }, message);
  root.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .25s, transform .25s'; el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 260); }, type === 'err' ? 4500 : 2600);
}

/* ---------------------------------------------------------------- modals */
export function openModal({ title, sub, body, actions = [], wide = false, sheet = true, onClose } = {}) {
  const root = $('#modal-root');
  const prevFocus = document.activeElement;
  const overlay = h('div', { class: `overlay${sheet ? ' sheet' : ''}`, role: 'presentation' });
  const modal = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title ? h('h3', null, title) : null, sub ? h('p', { class: 'sub' }, sub) : null, body,
    actions.length ? h('div', { class: 'actions' }, actions) : null);
  overlay.appendChild(modal);
  const close = (result) => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.body.classList.toggle('no-scroll', !!$('.lb') || !!$('#modal-root').children.length);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch { /* ignore */ }
    if (onClose) onClose(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && root.lastElementChild === overlay) { e.stopPropagation(); close(); }
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  root.appendChild(overlay);
  document.body.classList.add('no-scroll');
  const first = modal.querySelector('input, textarea, select, button.primary');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: modal };
}

export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { resolve(v); m.close(); };
    m = openModal({
      title, sub: message, body: null, onClose: () => resolve(false),
      actions: [h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, confirmLabel)],
    });
  });
}

export function promptDialog({ title, sub, label, value = '', placeholder = '', multiline = false, confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea', { class: 'textarea', placeholder, rows: 5 }) : h('input', { class: 'input', placeholder, value });
    if (multiline) input.value = value;
    let m;
    const done = (v) => { resolve(v); m.close(); };
    // preventDefault: focus returns to the opener on close, and an unhandled Enter would then "click" it again
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); } });
    m = openModal({
      title, sub, body: h('div', { class: 'field' }, label ? h('label', null, label) : null, input), onClose: () => resolve(null),
      actions: [h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => done(input.value.trim()) }, confirmLabel)],
    });
  });
}

export function emptyState({ icon: ic = 'sparkle', title, text, actions = [] }) {
  return h('div', { class: 'empty' }, h('div', { class: 'ico' }, icon(ic)), h('h3', null, title), text ? h('p', null, text) : null, actions.length ? h('div', { class: 'row wrap', style: { justifyContent: 'center' } }, actions) : null);
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}
