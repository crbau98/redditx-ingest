import { h, icon, fmt, emptyState } from '../dom.js';
import { get } from '../api.js';
import { href } from '../router.js';
import { platformLabel, platformColor } from '../store.js';

export async function browse(root) {
  document.title = 'Browse — PRISM';
  root.replaceChildren(h('div', { class: 'skeleton', style: { height: '320px' } }));
  let tags; let communities; let platforms;
  try { [tags, communities, platforms] = await Promise.all([get('/api/tags', { limit: 200 }), get('/api/communities'), get('/api/platforms')]); }
  catch (e) { root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t load', text: e.message })); return () => {}; }

  if (!platforms.length) { root.replaceChildren(emptyState({ icon: 'compass', title: 'Nothing to browse yet', text: 'Once content is ingested, its sources, tags and communities show up here.' })); return () => {}; }

  const max = Math.max(1, ...tags.map((t) => t.count));
  const min = Math.min(...tags.map((t) => t.count));
  // log scale keeps one huge tag from dwarfing the rest
  const size = (n) => 13 + 15 * ((Math.log(n) - Math.log(min || 1)) / ((Math.log(max) - Math.log(min || 1)) || 1));
  const byPlatform = new Map();
  for (const c of communities) { if (!byPlatform.has(c.platform)) byPlatform.set(c.platform, []); byPlatform.get(c.platform).push(c); }

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Browse'), h('div', { class: 'sub' }, 'Every source, community and tag in the library'))),
    h('section', { class: 'section', style: { marginTop: '8px' } }, h('div', { class: 'section-head' }, h('h2', null, icon('layers'), 'Sources')),
      h('div', { class: 'browse-grid' }, platforms.map((p) => h('a', { class: 'browse-tile', href: href('/explore', { platform: p.platform }), style: { '--c': platformColor(p.platform) } },
        h('div', { class: 'name' }, platformLabel(p.platform)), h('div', { class: 'count num' }, fmt.int(p.count)), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'items'))))),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, icon('tag'), 'Tags'), h('div', { class: 'sub' }, `${tags.length} most used`)),
      h('div', { class: 'tagcloud' }, [...tags].sort((a, b) => a.name.localeCompare(b.name)).map((t) => h('a', { href: href('/explore', { tag: t.name }), style: { fontSize: `${size(t.count).toFixed(1)}px` }, title: `${t.count} items` }, `#${t.name}`)))),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, icon('compass'), 'Communities')),
      h('div', { class: 'stack', style: { gap: '22px' } }, [...byPlatform.entries()].map(([plat, list]) => h('div', null,
        h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', { class: 'badge plat', style: { '--c': platformColor(plat) } }, platformLabel(plat)), h('span', { class: 'muted', style: { fontSize: '13px' } }, `${list.length} communities`)),
        h('div', { class: 'row wrap' }, list.slice(0, 60).map((c) => h('a', { class: 'chip', href: href('/explore', { community: c.name }) }, c.name, h('span', { class: 'n' }, fmt.num(c.count))))))))));
  return () => {};
}
