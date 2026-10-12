import { h, icon, fmt, proxied, avatar, toast, copyText, emptyState } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { follows, platformColor, platformLabel, bus } from '../store.js';
import { createFeed } from '../components/feed.js';
import { creatorCard } from '../components/creator-card.js';
import { openReport } from '../components/report.js';

export async function creator(root, { params, query }) {
  root.replaceChildren(h('div', { class: 'skeleton', style: { height: '260px' } }));
  let c;
  try { c = await get(`/api/creators/${params.id}`); } catch (e) {
    root.replaceChildren(emptyState({ icon: 'users', title: e.status === 404 ? 'Creator not found' : 'Couldn’t load', text: e.status === 404 ? 'This profile may have been removed.' : e.message, actions: [h('a', { class: 'btn', href: href('/creators') }, 'Browse creators')] }));
    return () => {};
  }
  document.title = `${c.display_name || c.handle} — PRISM`;
  const type = query.get('type') || '';
  const sort = query.get('sort') || 'recent';
  const setQ = (patch) => navigate(`/creator/${c.id}`, { type, sort, ...patch }, { replace: true });

  const banner = h('div', { class: 'profile-banner' }, c.banner_url ? h('div', { class: 'bg', style: { backgroundImage: `url("${proxied(c.banner_url)}")` } }) : (c.previews && c.previews[0] ? h('div', { class: 'bg', style: { backgroundImage: `url("${proxied(c.previews[0])}")` } }) : null));

  const followBtn = h('button', { class: 'btn' });
  const paintFollow = () => {
    const on = follows.has(c.id);
    followBtn.className = `btn${on ? ' on' : ' primary'}`;
    followBtn.replaceChildren(icon('heart', `sm${on ? ' fill' : ''}`), on ? 'Following' : 'Follow');
  };
  followBtn.addEventListener('click', () => { const on = follows.toggle(c); toast(on ? `Following ${c.display_name || c.handle}` : 'Unfollowed'); });
  paintFollow();
  const off = bus.on('follow', () => { if (followBtn.isConnected) paintFollow(); else off(); });
  if (follows.has(c.id)) follows.markSeen(c.id);

  const accounts = (c.accounts || []).map((a) => h('a', { class: 'linkchip', href: a.url, target: '_blank', rel: 'noopener noreferrer nofollow', style: { '--c': platformColor(a.platform) } }, h('span', { class: 'dot' }), `${platformLabel(a.platform)} · ${String(a.label).replace(/^[@/]?(?:u\/)?/, '')}`, icon('external', 'sm')));
  const ext = (c.links || []).filter((l) => l.url).map((l) => h('a', { class: 'linkchip ext', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('link', 'sm'), l.label || l.service));

  const head = h('div', { class: 'profile-head' },
    avatar(c, 112),
    h('div', { class: 'profile-info' }, h('h1', null, c.display_name || c.handle, c.verified ? icon('verified', 'fill') : null), h('div', { class: 'creator-handle' }, `@${c.handle}`)),
    h('div', { class: 'profile-actions' }, followBtn,
      h('button', { class: 'btn icon', 'aria-label': 'Copy profile link', title: 'Copy link', onclick: async () => toast((await copyText(location.href)) ? 'Link copied' : 'Could not copy') }, icon('share')),
      h('button', { class: 'btn icon', 'aria-label': 'Report', title: 'Report', onclick: () => openReport({ creatorId: c.id, title: 'Report this creator' }) }, icon('flag'))));

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['', `All`, c.media_count], ['image', 'Photos', c.media_count - c.video_count], ['video', 'Videos', c.video_count]].map(([v, l, n]) =>
    h('button', { class: type === v ? 'on' : '', role: 'tab', 'aria-selected': String(type === v), onclick: () => setQ({ type: v }) }, `${l} `, h('span', { class: 'muted num' }, fmt.num(n)))));
  const sortSel = h('select', { class: 'select sm', style: { width: 'auto', marginLeft: 'auto', marginBottom: '8px' }, 'aria-label': 'Sort', onchange: (e) => setQ({ sort: e.target.value }) }, [['recent', 'Newest'], ['top', 'Top rated'], ['trending', 'Trending'], ['oldest', 'Oldest']].map(([v, l]) => h('option', { value: v, selected: sort === v }, l)));

  const feed = createFeed({ endpoint: `/api/creators/${c.id}/media`, query: { type, sort }, empty: emptyState({ icon: 'image', title: 'Nothing here yet', text: 'No published posts match this tab.' }) });

  root.replaceChildren(banner, head,
    c.bio ? h('p', { class: 'profile-bio' }, c.bio) : null,
    h('div', { class: 'profile-stats' }, h('span', null, h('b', { class: 'num' }, fmt.int(c.media_count)), 'posts'), h('span', null, h('b', { class: 'num' }, fmt.int(c.video_count)), 'videos'), c.total_score ? h('span', null, h('b', { class: 'num' }, fmt.num(c.total_score)), 'total score') : null, c.last_media_at ? h('span', null, `Active ${fmt.ago(c.last_media_at)}`) : null),
    accounts.length || ext.length ? h('div', { class: 'linkrow' }, accounts, ext) : null,
    c.topTags && c.topTags.length ? h('div', { class: 'row wrap', style: { marginTop: '14px', gap: '6px' } }, c.topTags.slice(0, 10).map((t) => h('a', { class: 'tag', href: href('/explore', { tag: t.name }) }, `#${t.name}`))) : null,
    h('div', { style: { height: '22px' } }),
    h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { class: 'grow' }, tabs), sortSel),
    feed.el);
  // "Similar creators" loads after the page is usable; a failure just means no rail.
  get(`/api/creators/${c.id}/similar`, { limit: 12 }).then((list) => {
    if (!list.length || !root.isConnected) return;
    const anchor = root.querySelector('.tabs');
    if (!anchor) return;
    anchor.closest('.row').before(h('section', { class: 'section', style: { marginTop: '28px' } },
      h('div', { class: 'section-head' }, h('div', null, h('h2', null, icon('users'), 'Similar creators'), h('div', { class: 'sub' }, 'Based on what they post'))),
      h('div', { class: 'rail' }, list.map((x) => creatorCard(x, { mini: true })))), h('div', { style: { height: '8px' } }));
  }).catch(() => {});
  return () => { feed.destroy(); off(); };
}
