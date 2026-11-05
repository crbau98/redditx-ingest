import { h, icon, avatar } from '../dom.js';
import { href } from '../router.js';
import { follows } from '../store.js';

const FRESH_MS = 7 * 86400000;

/**
 * Creators as avatar rings in a swipeable strip, like a stories bar.
 *
 * A spectrum ring means he posted in the last 7 days; a plain ring means he has been quiet.
 * Creators this device follows come first (the sort is stable, so the server's order holds
 * inside each group). Returns null when there are too few creators to be worth a strip.
 */
export function creatorRing(list, { max = 16, label = 'Creators' } = {}) {
  const seen = new Set();
  const items = [];
  for (const c of list || []) {
    if (!c || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    items.push(c);
  }
  if (items.length < 3) return null;
  items.sort((a, b) => Number(follows.has(b.id)) - Number(follows.has(a.id)));

  const rows = items.slice(0, max).map((c) => {
    const ms = c.last_media_at ? Date.now() - new Date(c.last_media_at).getTime() : Infinity;
    const fresh = Number.isFinite(ms) && ms < FRESH_MS;
    const name = c.display_name || c.handle;
    const mine = follows.has(c.id);
    return h('li', null,
      h('a', {
        class: `ring-item${mine ? ' following' : ''}`,
        href: href(`/creator/${c.id}`),
        'aria-label': `${name}${mine ? ', you follow' : ''}${fresh ? ', posted this week' : ''}`,
      }, h('span', { class: `ring${fresh ? ' fresh' : ''}` }, avatar(c, 66)), h('span', { class: 'ring-name' }, name)));
  });
  rows.push(h('li', null,
    h('a', { class: 'ring-item add', href: href('/find'), 'aria-label': 'Find a creator' },
      h('span', { class: 'ring' }, icon('plus')), h('span', { class: 'ring-name' }, 'Find'))));

  return h('section', { class: 'ring-section', 'aria-label': label }, h('ul', { class: 'ring-strip' }, rows));
}
