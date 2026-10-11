import { h, icon, fmt, emptyState } from '../dom.js';
import { get } from '../api.js';
import { href, navigate } from '../router.js';
import { platformLabel, platformColor } from '../store.js';
import { mediaCard } from '../components/card.js';
import { creatorCard } from '../components/creator-card.js';
import { createFeed } from '../components/feed.js';
import { openLightbox } from '../components/lightbox.js';

function rail(items, { open }) {
  return h('div', { class: 'rail' }, items.map((it) => mediaCard(it, { open, compact: false })));
}

function sectionHead(iconName, title, sub, more) {
  return h('div', { class: 'section-head' },
    h('div', null, h('h2', null, icon(iconName), title), sub ? h('div', { class: 'sub' }, sub) : null),
    more ? h('a', { class: 'link-more', href: more.href }, more.label, icon('chev-r', 'sm')) : null);
}

export async function home(root) {
  const holder = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '320px' } }), h('div', { class: 'skeleton', style: { height: '260px' } }));
  root.replaceChildren(holder);
  let feed;
  let data;
  try { data = await get('/api/discover'); } catch (e) {
    root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t load', text: e.message, actions: [h('button', { class: 'btn primary', onclick: () => home(root) }, 'Try again')] }));
    return () => {};
  }

  const s = data.stats;
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search creators, tags, communities…', 'aria-label': 'Search', enterkeyhint: 'search' });
  const go = () => navigate('/explore', { q: input.value.trim() });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  const hero = h('section', { class: 'hero' },
    h('h1', null, 'Discover male creators ', h('em', null, 'across the web')),
    h('p', { class: 'lead' }, 'One feed for photos and videos from creators on Reddit, RedGIFs, Bluesky, Mastodon, X and more — fresh, searchable, and organised around the people who make it.'),
    h('div', { class: 'hero-search' }, icon('search', 'lg'), input, h('button', { class: 'btn primary', onclick: go }, 'Search')),
    h('div', { class: 'hero-stats' },
      h('div', null, h('b', { class: 'num' }, fmt.num(s.total)), h('span', null, 'items')),
      h('div', null, h('b', { class: 'num' }, fmt.num(s.creators)), h('span', null, 'creators')),
      h('div', null, h('b', { class: 'num' }, fmt.num(s.videos)), h('span', null, 'videos')),
      h('div', null, h('b', { class: 'num' }, data.platforms.length), h('span', null, 'sources'))),
    data.tags.length ? h('div', { class: 'hero-chips' }, data.tags.slice(0, 10).map((t) => h('a', { class: 'chip', href: href('/explore', { tag: t.name }) }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count))))) : null);

  if (!s.total) {
    root.replaceChildren(hero, emptyState({
      icon: 'sparkle', title: 'Your library is empty',
      text: 'Open the admin console to add creators and communities, then run a first sync. Content appears here as soon as it’s ingested.',
      actions: [h('a', { class: 'btn primary', href: href('/admin/sources') }, 'Open admin'), h('a', { class: 'btn', href: href('/creators') }, 'Browse creators')],
    }));
    return () => {};
  }

  const open = (list) => (item) => openLightbox(list, Math.max(0, list.findIndex((x) => x.id === item.id)));
  const parts = [hero];

  if (data.trending.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('flame', 'Trending now', 'What people are watching and saving', { href: href('/explore', { sort: 'trending' }), label: 'See all' }), rail(data.trending, { open: open(data.trending) })));
  }
  if (data.freshVideos.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('video', 'Fresh videos', 'Newest clips from across all sources', { href: href('/explore', { type: 'video', sort: 'recent' }), label: 'More videos' }), rail(data.freshVideos, { open: open(data.freshVideos) })));
  }
  if (data.topCreators.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('users', 'Top creators', 'Most-loved creators right now', { href: href('/creators'), label: 'All creators' }),
      h('div', { class: 'rail' }, data.topCreators.map((c) => creatorCard(c, { mini: true })))));
  }
  if (data.communities.length || data.platforms.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('compass', 'Browse by source'),
      h('div', { class: 'row wrap' },
        data.platforms.map((p) => h('a', { class: 'chip', href: href('/explore', { platform: p.platform }) }, h('span', { class: 'dot', style: { background: platformColor(p.platform) } }), platformLabel(p.platform), h('span', { class: 'n' }, fmt.num(p.count)))),
        data.communities.slice(0, 14).map((c) => h('a', { class: 'chip', href: href('/explore', { community: c.name }) }, c.name, h('span', { class: 'n' }, fmt.num(c.count)))))));
  }
  if (data.newCreators.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('sparkle', 'New on PRISM', 'Recently discovered creators', { href: href('/creators', { sort: 'new' }), label: 'See more' }),
      h('div', { class: 'rail' }, data.newCreators.map((c) => creatorCard(c, { mini: true })))));
  }

  feed = createFeed({ query: { sort: 'recent' }, pageSize: 36 });
  parts.push(h('section', { class: 'section' }, sectionHead('layers', 'Latest uploads', null, { href: href('/explore'), label: 'Explore everything' }), feed.el));

  root.replaceChildren(...parts);
  return () => feed && feed.destroy();
}
