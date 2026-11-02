import { h, icon, fmt, emptyState } from '../dom.js';
import { get } from '../api.js';
import { href } from '../router.js';
import { platformLabel, platformColor } from '../store.js';
import { topicCards } from '../components/topics.js';

/** Equal-size chips with counts (no font-size decoration: sizes hurt scanning). */
function tagRow(tags) {
  const wrap = h('div', { class: 'tagcloud eq' });
  const chip = (t) => h('a', { href: href('/explore', { tag: t.name }), title: `${t.count} items` }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count)));
  let extra = [];
  for (const t of tags.slice(0, 40)) wrap.append(chip(t));
  const rest = tags.slice(40);
  if (rest.length) {
    let open = false;
    const more = h('button', { class: 'chip more', type: 'button', 'aria-expanded': 'false' }, `All ${tags.length} tags`);
    more.addEventListener('click', () => {
      open = !open;
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Fewer tags' : `All ${tags.length} tags`;
      if (open) { extra = rest.map(chip); wrap.append(more, ...extra); }
      else { for (const el of extra) el.remove(); extra = []; }
    });
    wrap.append(more);
  }
  return wrap;
}

/** Communities per platform: top 8, then a disclosure for the rest. */
function communityList(plat, list) {
  const wrap = h('div', { class: 'stack', style: { gap: '10px' } });
  const chips = (n) => list.slice(0, n).map((c) => h('a', { class: 'chip', href: href('/explore', { community: c.name }) }, c.name, h('span', { class: 'n' }, fmt.num(c.count))));
  const row = h('div', { class: 'row wrap' }, chips(8));
  let open = false;
  const head = h('div', { class: 'row', style: { marginBottom: '10px' } },
    h('span', { class: 'badge plat', style: { '--c': platformColor(plat) } }, platformLabel(plat)),
    h('span', { class: 'muted', style: { fontSize: '13px' } }, `${list.length} communities`));
  if (list.length > 8) {
    const btn = h('button', { class: 'chip more', type: 'button', 'aria-expanded': 'false' }, `Show all ${list.length}`);
    btn.addEventListener('click', () => {
      open = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'Show top 8' : `Show all ${list.length}`;
      row.replaceChildren(...chips(open ? list.length : 8));
    });
    head.append(h('span', { style: { flex: '1' } }), btn);
  }
  wrap.append(head, row);
  return wrap;
}

export async function browse(root) {
  document.title = 'Browse — PRISM';
  root.replaceChildren(h('div', { class: 'skeleton', style: { height: '320px' } }));
  let tags; let communities; let platforms;
  let topics;
  try { [tags, communities, platforms, topics] = await Promise.all([get('/api/tags', { limit: 200 }), get('/api/communities'), get('/api/platforms'), topicCards({ limit: 12 })]); }
  catch (e) { root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t load', text: e.message })); return () => {}; }

  if (!platforms.length) {
    root.replaceChildren(emptyState({ icon: 'compass', title: 'Nothing ingested yet', text: 'Sources, topics and tags appear here after the first ingest.', actions: [h('a', { class: 'btn primary', href: href('/admin/sources') }, 'Add a source')] }));
    return () => {};
  }

  const byPlatform = new Map();
  for (const c of communities) { if (!byPlatform.has(c.platform)) byPlatform.set(c.platform, []); byPlatform.get(c.platform).push(c); }

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Browse'), h('div', { class: 'sub' }, 'Every source, community and tag in the library. Discover for finding a creator; Explore for content.'))),
    h('section', { class: 'section', style: { marginTop: '8px' } },
      h('div', { class: 'section-head' },
        h('div', null,
          h('h2', null, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), 'OnlyFans & Creator Networks'),
          h('div', { class: 'sub' }, 'Verified male creators with independent subscription pages')),
        h('a', { class: 'link-more', href: href('/creators', { paid: 'onlyfans' }) }, 'All OnlyFans creators', icon('chev-r', 'sm'))),
      h('div', { class: 'browse-grid' },
        h('a', { class: 'browse-tile of-tile', href: href('/creators', { paid: 'onlyfans' }) },
          h('div', { class: 'name' }, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), 'OnlyFans Stars'),
          h('div', { class: 'count num' }, '285+'),
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Verified creators')),
        h('a', { class: 'browse-tile of-tile', href: href('/explore', { paid: 'onlyfans' }) },
          h('div', { class: 'name' }, icon('sparkle', 'sm'), 'OnlyFans Media'),
          h('div', { class: 'count num' }, '25.9K+'),
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Photos & videos')),
        h('a', { class: 'browse-tile of-tile', href: href('/reels', { paid: 'onlyfans' }) },
          h('div', { class: 'name' }, icon('film', 'sm'), 'OnlyFans Reels'),
          h('div', { class: 'count num' }, 'Full-Screen'),
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Vertical video feed')),
        h('a', { class: 'browse-tile', href: href('/creators', { paid: 'fansly' }), style: { '--c': '#0c85d0' } },
          h('div', { class: 'name' }, 'Fansly Creators'),
          h('div', { class: 'count num' }, 'Active'),
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Independent feeds')),
        h('a', { class: 'browse-tile', href: href('/creators', { paid: 'gff' }), style: { '--c': '#ff4757' } },
          h('div', { class: 'name' }, 'GayForFans'),
          h('div', { class: 'count num' }, '1,300+'),
          h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Creators & feeds')))),
    h('section', { class: 'section', style: { marginTop: '8px' } }, h('div', { class: 'section-head' }, h('h2', null, icon('layers'), 'Sources'), h('div', { class: 'sub' }, 'Free platforms PRISM ingests — each tile opens Explore')),
      h('div', { class: 'browse-grid' }, platforms.map((p) => h('a', { class: 'browse-tile', href: href('/explore', { platform: p.platform }), style: { '--c': platformColor(p.platform) } },
        h('div', { class: 'name' }, platformLabel(p.platform)), h('div', { class: 'count num' }, fmt.int(p.count)), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'items'))))),
    topics ? h('section', { class: 'section', style: { marginTop: '8px' } }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, icon('sparkle'), 'Topics'), h('div', { class: 'sub' }, 'Tags that travel together, grouped automatically'))), topics) : null,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, icon('compass'), 'Communities'), h('div', { class: 'sub' }, 'Where creators post — each chip opens Explore')),
      h('div', { class: 'stack', style: { gap: '22px' } }, [...byPlatform.entries()].map(([plat, list]) => communityList(plat, list)))),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, icon('tag'), 'Tags'), h('div', { class: 'sub' }, `${tags.length} most used`)),
      tagRow([...tags].sort((a, b) => b.count - a.count))));
  return () => {};
}
