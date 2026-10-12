import { h, icon, fmt, proxied } from '../dom.js';
import { get } from '../api.js';
import { href } from '../router.js';
import { tastes, history as viewHistory } from '../store.js';
import { mediaCard } from './card.js';

/**
 * Topics: clusters of tags that keep showing up together in the library (e.g. "Gym & muscle"),
 * found by the server from co-occurrence. Each card is a preview mosaic that opens all of it.
 */
export async function topicCards({ limit = 10 } = {}) {
  let list;
  try { list = await get('/api/topics'); } catch { return null; }
  if (!list || list.length < 2) return null;
  return h('div', { class: 'topic-grid' }, list.slice(0, limit).map((t, i) => {
    const q = { anytags: t.tags.join(','), label: t.title };
    const tiles = t.previews.slice(0, 4);
    return h('a', { class: 'topic-card', href: href('/explore', q), style: { '--i': i }, 'aria-label': `${t.title}: ${t.count} items` },
      h('div', { class: `topic-mosaic n${tiles.length}` }, tiles.map((src) => h('span', { class: 'tile', style: { backgroundImage: `url("${proxied(src)}")` } }))),
      h('div', { class: 'topic-body' },
        h('div', { class: 'topic-title' }, t.title),
        h('div', { class: 'topic-tags' }, t.tags.slice(0, 4).map((x) => h('span', null, `#${x}`))),
        h('div', { class: 'topic-count' }, `${fmt.num(t.count)} items`, icon('chev-r', 'sm'))));
  }));
}

/** "Because you watch #tag": one rail per strongest taste tag, best of that tag first. */
export async function becauseRails(open, { max = 2 } = {}) {
  if (!tastes.ready()) return [];
  const seen = new Set(viewHistory.list().slice(0, 200));
  const out = [];
  for (const tag of tastes.topTags(5)) {
    if (out.length >= max) break;
    let res;
    try { res = await get('/api/media', { tag, sort: 'top', since: 'month', limit: 24, nocount: '1' }); } catch { continue; }
    let items = res.items.filter((it) => !seen.has(it.id));
    if (items.length < 6) {
      try { items = (await get('/api/media', { tag, sort: 'top', limit: 24 })).items.filter((it) => !seen.has(it.id)); } catch { /* keep what we have */ }
    }
    if (items.length < 4) continue;
    items = items.slice(0, 14);
    out.push(h('section', { class: 'section' },
      h('div', { class: 'section-head' },
        h('div', null, h('h2', null, icon('sparkle'), 'Because you watch ', h('span', { class: 'grad-text' }, `#${tag}`)), h('div', { class: 'sub' }, 'The best of it you haven’t opened yet')),
        h('a', { class: 'link-more', href: href('/explore', { tag, sort: 'top' }) }, 'See all', icon('chev-r', 'sm'))),
      h('div', { class: 'rail' }, items.map((it) => mediaCard(it, { open: open(items), compact: false })))));
  }
  return out;
}
