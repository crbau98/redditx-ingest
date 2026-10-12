import { h, icon, fmt, proxied, avatar, toast, copyText, emptyState } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { follows, platformColor, platformLabel, bus } from '../store.js';
import { createFeed } from '../components/feed.js';
import { creatorCard } from '../components/creator-card.js';
import { openReport } from '../components/report.js';

/** Year-long posting heatmap, source split and usual posting hours (UTC → local). */
function activityPanel(a) {
  const total = a.platforms.reduce((n, p) => n + p.n, 0);
  if (!total) return null;
  const counts = new Map(a.days.map((d) => [d.day, d.n]));
  const max = Math.max(1, ...a.days.map((d) => d.n));
  const level = (n) => (!n ? 0 : n >= max * 0.75 ? 4 : n >= max * 0.5 ? 3 : n >= max * 0.25 ? 2 : 1);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - 52 * 7 * 86400000);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // align columns to weeks starting Sunday
  const cells = [];
  for (let t = start.getTime(); t <= today.getTime(); t += 86400000) {
    const key = new Date(t).toISOString().slice(0, 10);
    const n = counts.get(key) || 0;
    cells.push(h('i', { dataset: { l: String(level(n)) }, title: `${new Date(t).toLocaleDateString([], { dateStyle: 'medium', timeZone: 'UTC' })}: ${n} post${n === 1 ? '' : 's'}` }));
  }
  const yearTotal = a.days.reduce((n, d) => n + d.n, 0);
  const activeDays = a.days.length;

  // hours are stored in UTC; shift to the viewer's local clock
  const offset = -new Date().getTimezoneOffset() / 60;
  const hours = Array(24).fill(0);
  for (const r of a.hours) hours[(((r.hour + offset) % 24) + 24) % 24 | 0] += r.n;
  const hMax = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  const fmtHour = (x) => new Date(2000, 0, 1, x).toLocaleTimeString([], { hour: 'numeric' });

  const heat = h('div', { class: 'heatmap', role: 'img', 'aria-label': `${yearTotal} posts on ${activeDays} days in the last year` }, cells);
  requestAnimationFrame(() => { heat.scrollLeft = heat.scrollWidth; }); // newest weeks visible on small screens
  return h('div', { class: 'activity' },
    h('div', { class: 'panel-lite' }, h('h4', null, 'Posting activity'), heat,
      h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px' } }, `${fmt.int(yearTotal)} posts on ${activeDays} day${activeDays === 1 ? '' : 's'} in the last year${a.range && a.range.first ? ` · first seen ${fmt.ago(a.range.first)}` : ''}`)),
    h('div', { class: 'panel-lite' },
      h('h4', null, 'Where they post'),
      h('div', { class: 'split' }, a.platforms.map((p) => h('i', { style: { width: `${(p.n / total) * 100}%`, background: platformColor(p.platform) }, title: `${platformLabel(p.platform)}: ${p.n}` }))),
      h('div', { class: 'row wrap', style: { gap: '4px 12px', fontSize: '12.5px', marginBottom: '14px' } }, a.platforms.map((p) => h('span', { class: 'row', style: { gap: '5px' } }, h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: platformColor(p.platform), display: 'inline-block' } }), `${platformLabel(p.platform)} ${Math.round((p.n / total) * 100)}%`))),
      h('h4', null, 'Usually posts around'),
      h('div', { class: 'hours', role: 'img', 'aria-label': `Most posts around ${fmtHour(peak)}` }, hours.map((n, i) => h('i', { style: { height: `${Math.max(3, (n / hMax) * 100)}%` }, title: `${fmtHour(i)}: ${n}` }))),
      h('div', { class: 'chart-axis', style: { display: 'flex', justifyContent: 'space-between', color: 'var(--muted)', fontSize: '11.5px', marginTop: '6px' } }, h('span', null, fmtHour(0)), h('b', { style: { color: 'var(--text)' } }, `peak ${fmtHour(peak)}`), h('span', null, fmtHour(23)))));
}

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
      c.media_count ? h('a', { class: 'btn', href: href('/reels', { creator: c.id, sort: 'recent', type: 'all' }), title: 'Watch everything full screen' }, icon('film', 'sm'), 'Reels') : null,
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
  // Activity and "Similar creators" load after the page is usable; a failure just means they are missing.
  get(`/api/creators/${c.id}/activity`).then((a) => {
    const panel = root.isConnected && activityPanel(a);
    const anchor = root.querySelector('.tabs');
    if (panel && anchor) anchor.closest('.row').before(panel, h('div', { style: { height: '22px' } }));
  }).catch(() => {});
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
