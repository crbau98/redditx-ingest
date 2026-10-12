import { h, icon, fmt, avatar, debounce } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { platformLabel } from '../store.js';

/**
 * Autocomplete for the header search: creators, tags and communities.
 * Arrow keys move, Enter opens the highlighted row (or searches the raw text),
 * Esc closes. Stale responses are discarded so fast typing never flickers.
 */
export function attachSuggest(input) {
  const box = h('div', { class: 'suggest', role: 'listbox', id: 'suggest-box', hidden: true });
  input.setAttribute('aria-controls', 'suggest-box');
  input.setAttribute('aria-autocomplete', 'list');
  let rows = []; let idx = -1; let token = 0;

  const hide = () => { box.hidden = true; idx = -1; input.setAttribute('aria-expanded', 'false'); };
  const mark = (i) => {
    idx = i;
    rows.forEach((r, k) => { r.el.classList.toggle('on', k === i); r.el.setAttribute('aria-selected', String(k === i)); });
    if (rows[i]) rows[i].el.scrollIntoView({ block: 'nearest' });
  };

  function row(content, go) {
    const el = h('a', { class: 'suggest-row', role: 'option', href: '#', 'aria-selected': 'false' }, content);
    // mousedown (not click) so it fires before the input's blur closes the box
    el.addEventListener('mousedown', (e) => { e.preventDefault(); go(); hide(); input.blur(); });
    rows.push({ el, go });
    return el;
  }
  const label = (t) => h('div', { class: 'suggest-label' }, t);

  function render(d) {
    rows = [];
    const parts = [];
    if (d.creators.length) {
      parts.push(label('Creators'), ...d.creators.map((c) => row([avatar(c, 28), h('span', { class: 'truncate' }, c.display_name || c.handle), h('span', { class: 'muted' }, `@${c.handle}`), h('span', { class: 'n' }, `${fmt.num(c.media_count)} posts`)], () => navigate(`/creator/${c.id}`))));
    }
    if (d.tags.length) parts.push(label('Tags'), ...d.tags.map((t) => row([icon('tag', 'sm'), h('span', null, `#${t.name}`), h('span', { class: 'n' }, fmt.num(t.count))], () => navigate('/explore', { tag: t.name }))));
    if (d.communities.length) parts.push(label('Communities'), ...d.communities.map((c) => row([icon('compass', 'sm'), h('span', { class: 'truncate' }, c.name), h('span', { class: 'muted' }, platformLabel(c.platform)), h('span', { class: 'n' }, fmt.num(c.count))], () => navigate('/explore', { community: c.name }))));
    if (!parts.length) { hide(); return; }
    box.replaceChildren(...parts);
    // The input may not be in the DOM yet when attachSuggest() runs, so mount the box on first use.
    if (!box.parentElement && input.parentElement) input.parentElement.appendChild(box);
    box.hidden = false; input.setAttribute('aria-expanded', 'true');
    idx = -1;
  }

  const query = debounce(async () => {
    const q = input.value.trim();
    if (!q) { hide(); return; }
    const mine = ++token;
    try { const d = await get('/api/suggest', { q }); if (mine === token && document.activeElement === input) render(d); } catch { /* suggestions are a nicety */ }
  }, 150);

  input.addEventListener('input', query);
  input.addEventListener('focus', () => { if (input.value.trim() && rows.length) box.hidden = false; });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (box.hidden || !rows.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mark((idx + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark((idx - 1 + rows.length) % rows.length); }
    else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); e.stopImmediatePropagation(); rows[idx].go(); hide(); input.blur(); }
    else if (e.key === 'Escape') hide();
  });
}
