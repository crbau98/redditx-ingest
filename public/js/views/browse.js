import { makeGuard } from '../guard.js';
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

export function browse(root) {
  document.title = 'Browse — PRISM';
  root.replaceChildren(h('div', { class: 'skeleton', style: { height: '320px' } }));
  const total = (p) => p.then((r) => (r && Number.isFinite(r.total) ? r.total : null), () => null);
  // Topics and the three paid counts are slow. Start them now, but paint sources, communities, and tags without them.
  const tagsP = get('/api/tags', { limit: 200 });
  const communitiesP = get('/api/communities');
  const platformsP = get('/api/platforms');
  const topicsP = topicCards({ limit: 12 }).catch(() => null);
  const ofCreatorsP = total(get('/api/creators', { onlyfans: '1', limit: 1 }));
  const ofPostsP = total(get('/api/media', { paid: 'onlyfans', limit: 1 }));
  const fanslyP = total(get('/api/creators', { paid: 'fansly', limit: 1 }));
  // The skeleton is already up. Hand back the way out before the catalog returns, so a late
  // catalog cannot replace a page you have left.
  const life = makeGuard();
  const stop = life.cleanup;
  void fill();
  return stop;

  async function fill() {
  let tags; let communities; let platforms;
  try {
    [tags, communities, platforms] = await Promise.all([tagsP, communitiesP, platformsP]);
  }
  catch (e) {
    if (life.isLeft()) return;
    root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t load', text: e.message }));
    return;
  }
  if (life.isLeft()) return;

  if (!platforms.length) {
    if (life.isLeft()) return;
    root.replaceChildren(emptyState({ icon: 'compass', title: 'Nothing ingested yet', text: 'Sources, topics and tags appear here after the first ingest.', actions: [h('a', { class: 'btn primary', href: href('/admin/sources') }, 'Add a source')] }));
    return;
  }

  const byPlatform = new Map();
  for (const c of communities) { if (!byPlatform.has(c.platform)) byPlatform.set(c.platform, []); byPlatform.get(c.platform).push(c); }

  // Only tiles with a real number: a count that is missing or zero is left out, never invented.
  const tile = (cls, to, name, count, caption, style) => h('a', { class: `browse-tile ${cls}`.trim(), href: to, style },
    h('div', { class: 'name' }, name), h('div', { class: 'count num' }, fmt.num(count)), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, caption));
  const paidHold = h('div', { class: 'browse-hold' });
  const topicHold = h('div', { class: 'browse-hold' });
  const paintPaid = (ofCreators, ofPosts, fanslyCreators) => {
    if (!paidHold.isConnected) return;
    const paidTiles = [
      ofCreators ? tile('of-tile', href('/creators', { paid: 'onlyfans' }), [h('span', { class: 'of-mark', 'aria-hidden': 'true' }), 'OnlyFans creators'], ofCreators, 'With a linked page') : null,
      ofPosts ? tile('of-tile', href('/explore', { paid: 'onlyfans' }), [icon('sparkle', 'sm'), 'OnlyFans posts'], ofPosts, 'Photos and videos') : null,
      fanslyCreators ? tile('', href('/creators', { paid: 'fansly' }), 'Fansly creators', fanslyCreators, 'With a linked page', { '--c': '#0c85d0' }) : null,
    ].filter(Boolean);
    if (!paidTiles.length) { paidHold.remove(); return; }
    paidHold.replaceWith(h('section', { class: 'section', style: { marginTop: '8px' } },
      h('div', { class: 'section-head' },
        h('div', null,
          h('h2', null, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), 'OnlyFans & paid pages'),
          h('div', { class: 'sub' }, 'Creators with a linked OnlyFans or Fansly page')),
        h('a', { class: 'link-more', href: href('/creators'), 'aria-label': 'See top creators' }, 'See all', icon('chev-r', 'sm'))),
      h('div', { class: 'browse-grid' }, paidTiles)));
  };

  if (life.isLeft()) return;
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Browse'), h('div', { class: 'sub' }, 'Every source, community and tag in the library.'))),
    paidHold,
    h('section', { class: 'section', style: { marginTop: '8px' } }, h('div', { class: 'section-head' }, h('h2', null, icon('layers'), 'Sources'), h('div', { class: 'sub' }, 'Free platforms PRISM ingests — each tile opens Explore')),
      h('div', { class: 'browse-grid' }, platforms.map((p) => h('a', { class: 'browse-tile', href: href('/explore', { platform: p.platform }), style: { '--c': platformColor(p.platform) } },
        h('div', { class: 'name' }, platformLabel(p.platform)), h('div', { class: 'count num' }, fmt.int(p.count)), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'items'))))),
    topicHold,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, icon('compass'), 'Communities'), h('div', { class: 'sub' }, 'Where creators post — each chip opens Explore')),
      h('div', { class: 'stack', style: { gap: '22px' } }, [...byPlatform.entries()].map(([plat, list]) => communityList(plat, list)))),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, icon('tag'), 'Tags'), h('div', { class: 'sub' }, `${tags.length} most used`)),
      tagRow([...tags].sort((a, b) => b.count - a.count))));

  Promise.all([ofCreatorsP, ofPostsP, fanslyP]).then(([ofCreators, ofPosts, fanslyCreators]) => { if (life.isLeft()) return; paintPaid(ofCreators, ofPosts, fanslyCreators); });
  topicsP.then((topics) => {
    if (life.isLeft()) return;
    if (!topicHold.isConnected) return;
    if (!topics) { topicHold.remove(); return; }
    topicHold.replaceWith(h('section', { class: 'section', style: { marginTop: '8px' } }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, icon('sparkle'), 'Topics'), h('div', { class: 'sub' }, 'Tags that travel together, grouped automatically'))), topics));
  });
  }
}
