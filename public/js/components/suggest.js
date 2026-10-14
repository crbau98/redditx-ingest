import { h, icon, fmt, avatar, debounce, proxied } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { platformLabel, recentSearches } from '../store.js';
import { understand, understoodChips, smartSearch } from '../smart.js';

/**
 * Autocomplete for search boxes: a live "Understood as" preview of what Enter will search
 * (tags, creator, type, time, source read from plain words), then creators, tags and communities.
 * Arrow keys move, Enter opens the highlighted row (or runs the smart search),
 * Esc closes. Stale responses are discarded so fast typing never flickers.
 */
export function attachSuggest(input, { id = 'suggest-box' } = {}) {
  const box = h('div', { class: 'suggest', role: 'listbox', id, hidden: true });
  input.setAttribute('aria-controls', id);
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

  // Live preview: the first results Enter would show, fetched for what was understood (or the raw words).
  const preview = h('div', { class: 'suggest-preview', hidden: true });
  function paintPreview(res, params) {
    const items = (res && res.items) || [];
    if (!items.length) {
      preview.replaceChildren(h('span', { class: 'muted' }, res && res.total === 0 ? 'No exact matches — Enter relaxes the search for you' : ''));
      preview.hidden = !(res && res.total === 0);
      return;
    }
    preview.replaceChildren(
      h('div', { class: 'sp-strip' }, items.slice(0, 6).map((it) => {
        const src = it.preview_url || it.thumbnail_url || (it.media_type === 'image' ? it.media_url : null);
        const a = h('a', { class: 'sp-thumb', href: '#', title: it.title || '', 'aria-label': it.title || 'Open' }, src ? h('img', { src: proxied(src), alt: '', loading: 'eager', decoding: 'async' }) : null, it.media_type === 'video' ? h('span', { class: 'sp-play' }, icon('play', 'sm')) : null);
        a.addEventListener('mousedown', (e) => { e.preventDefault(); hide(); input.blur(); navigate('/explore', { ...params, m: it.id }); });
        return a;
      })),
      h('span', { class: 'sp-count' }, `${fmt.num(res.total)} ${res.total === 1 ? 'result' : 'results'}`));
    preview.hidden = false;
    if (box.hidden && document.activeElement === input) {
      if (!box.parentElement && input.parentElement) input.parentElement.appendChild(box);
      box.hidden = false; input.setAttribute('aria-expanded', 'true');
    }
  }

  function render(d, u) {
    rows = [];
    const parts = [];
    // Only worth showing when the words were read as more than a single plain match.
    if (u && u.understood && (u.chips.length > 1 || u.text || u.corrections.length || !['tag', 'creator', 'community'].includes(u.chips[0].key))) {
      const raw = input.value;
      parts.push(label('Search for'), row([h('span', { class: 'u-spark' }, icon('sparkle', 'sm')), h('span', { class: 'u-preview' }, understoodChips(u)), h('kbd', { class: 'u-enter' }, '↵')], () => smartSearch(raw)));
      rows[rows.length - 1].el.classList.add('understood-row');
    }
    const hasRows = parts.length > 0;
    if (d.creators.length) {
      parts.push(label('Creators'), ...d.creators.map((c) => row([avatar(c, 28), h('span', { class: 'truncate' }, c.display_name || c.handle), h('span', { class: 'muted' }, `@${c.handle}`), h('span', { class: 'n' }, `${fmt.num(c.media_count)} posts`)], () => navigate(`/creator/${c.id}`))));
    }
    if (d.tags.length) parts.push(label('Tags'), ...d.tags.map((t) => row([icon('tag', 'sm'), h('span', null, `#${t.name}`), h('span', { class: 'n' }, fmt.num(t.count))], () => navigate('/explore', { tag: t.name }))));
    if (d.communities.length) parts.push(label('Communities'), ...d.communities.map((c) => row([icon('compass', 'sm'), h('span', { class: 'truncate' }, c.name), h('span', { class: 'muted' }, platformLabel(c.platform)), h('span', { class: 'n' }, fmt.num(c.count))], () => navigate('/explore', { community: c.name }))));
    if (input.value.trim().length >= 3) parts.push(preview);
    if (!hasRows) { hide(); box.replaceChildren(...parts); return; } // the preview opens it if results arrive
    box.replaceChildren(...parts);
    // The input may not be in the DOM yet when attachSuggest() runs, so mount the box on first use.
    if (!box.parentElement && input.parentElement) input.parentElement.appendChild(box);
    box.hidden = false; input.setAttribute('aria-expanded', 'true');
    idx = -1;
  }

  // Empty box: what you searched for before, one tap (or ↓ ↵) to run again.
  function renderRecent() {
    rows = [];
    const list = recentSearches.list();
    if (!list.length) { hide(); return; }
    const clearBtn = h('button', { class: 'suggest-clear', type: 'button' }, 'Clear');
    clearBtn.addEventListener('mousedown', (e) => { e.preventDefault(); recentSearches.clear(); hide(); });
    box.replaceChildren(h('div', { class: 'suggest-label suggest-recent-head' }, 'Recent searches', clearBtn), ...list.map((q) => {
      const x = h('button', { class: 'suggest-x', type: 'button', 'aria-label': `Remove “${q}” from recent searches`, tabindex: '-1' }, icon('x', 'sm'));
      const el = row([icon('history', 'sm'), h('span', { class: 'truncate grow' }, q), x], () => { input.value = q; smartSearch(q); });
      // the remove button sits inside the row: claim its press before the row's handler sees it
      x.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); recentSearches.remove(q); renderRecent(); }, true);
      return el;
    }));
    if (!box.parentElement && input.parentElement) input.parentElement.appendChild(box);
    box.hidden = false; input.setAttribute('aria-expanded', 'true');
    idx = -1;
  }

  const query = debounce(async () => {
    const q = input.value.trim();
    if (!q) { token++; renderRecent(); return; }
    const mine = ++token;
    try {
      const [d, u] = await Promise.all([get('/api/suggest', { q }), q.includes(' ') || q.length >= 4 ? understand(q) : null]);
      if (mine !== token || document.activeElement !== input) return;
      preview.hidden = true;
      render(d, u);
      if (q.length >= 3) {
        const params = u && u.understood ? { ...u.query, smart: '1', raw: q } : { q };
        const { smart, raw, ...api } = params; // eslint-disable-line no-unused-vars
        const res = await get('/api/media', { ...api, limit: 6 }).catch(() => null);
        if (mine === token && document.activeElement === input) paintPreview(res, params);
      }
    } catch { /* suggestions are a nicety */ }
  }, 150);

  input.addEventListener('input', query);
  input.addEventListener('focus', () => { if (!input.value.trim()) renderRecent(); else if (rows.length) box.hidden = false; });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (box.hidden || !rows.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mark((idx + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark((idx - 1 + rows.length) % rows.length); }
    else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); e.stopImmediatePropagation(); rows[idx].go(); hide(); input.blur(); }
    else if (e.key === 'Escape') hide();
  });
}
