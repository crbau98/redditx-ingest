import { h, icon, fmt, proxied, avatar, toast, copyText, emptyState } from '../dom.js';
import { get } from '../api.js';
import { navigate, href } from '../router.js';
import { follows, platformColor, platformLabel, bus } from '../store.js';
import { createFeed } from '../components/feed.js';
import { creatorCard } from '../components/creator-card.js';
import { dominantColor, countUp } from '../components/fx.js';
import { landAvatar } from '../components/transitions.js';
import { openReport } from '../components/report.js';
import { platformSwitcher } from '../components/platform-switcher.js';

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

const counted = new Set(); // creators whose stats already counted up this visit

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
  const platform = /^[a-z]{2,20}$/.test(query.get('platform') || '') ? query.get('platform') : '';
  const setQ = (patch) => navigate(`/creator/${c.id}`, { type, sort, platform, ...patch }, { replace: true });

  // The stage: his best picture (previews come highest-scored first), full-bleed behind the header,
  // washed into the page with a colour taken from it. A banner is the fallback, then a plain wash.
  const art = (c.previews && c.previews[0]) || c.banner_url;

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

  // "Free on": every account where his posts cost nothing, his free OnlyFans included, as lit pills.
  const freeOn = (c.accounts || []).map((a) => h('a', { class: 'free-pill', href: a.url, target: '_blank', rel: 'noopener noreferrer nofollow', style: { '--c': platformColor(a.platform) } }, h('span', { class: 'dot' }), h('b', null, platformLabel(a.platform)), h('span', { class: 'h' }, String(a.label).replace(/^[@/]?(?:u\/)?/, ''))));
  if (c.onlyfans && c.onlyfans.free) freeOn.unshift(h('a', { class: 'free-pill of', href: c.onlyfans.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), h('b', null, 'OnlyFans'), h('span', { class: 'h' }, 'free')));
  // The OnlyFans page gets its own button in the header; the other external links stay chips.
  const ext = (c.links || []).filter((l) => l.url && !(c.onlyfans && /onlyfans\.com/i.test(l.url))).map((l) => h('a', { class: 'linkchip ext', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('link', 'sm'), l.label || l.service));

  // names and handles he uses elsewhere (creator identity), shown once each
  const aka = [...new Set((c.aliases || []).map((a) => (typeof a === 'string' ? a : a && a.alias)).filter(Boolean))].slice(0, 4);
  // A glowing ring (like a "story") when they posted in the last two days.
  const fresh = c.last_media_at && Date.now() - new Date(c.last_media_at).getTime() < 2 * 86400000;
  const headAvatar = avatar(c, 112);
  const head = h('div', { class: 'profile-head' },
    h('div', { class: `avatar-ring${fresh ? ' live' : ''}`, title: fresh ? `Posted ${fmt.ago(c.last_media_at)}` : null }, headAvatar),
    h('div', { class: 'profile-info' }, h('h1', null, c.display_name || c.handle, c.verified ? icon('verified', 'fill') : null), h('div', { class: 'creator-handle' }, `@${c.handle}`),
      aka.length ? h('div', { class: 'aka' }, 'Also goes by ', aka.join(', ')) : null),
    h('div', { class: 'profile-actions' }, followBtn,
      c.onlyfans ? h('a', { class: `btn of-cta${c.onlyfans.free ? ' free' : ''}`, href: c.onlyfans.url, target: '_blank', rel: 'noopener noreferrer nofollow', title: `onlyfans.com/${c.onlyfans.handle}` },
        h('span', { class: 'of-mark', 'aria-hidden': 'true' }), c.onlyfans.free ? 'Free OnlyFans' : 'OnlyFans', icon('external', 'sm')) : null,
      c.media_count ? h('a', { class: 'btn', href: href('/reels', { creator: c.id, sort: 'recent', type: 'all' }), title: 'Watch everything full screen' }, icon('film', 'sm'), 'Reels') : null,
      h('button', { class: 'btn icon', 'aria-label': 'Copy profile link', title: 'Copy link', onclick: async () => toast((await copyText(location.href)) ? 'Link copied' : 'Could not copy') }, icon('share')),
      h('button', { class: 'btn icon', 'aria-label': 'Report', title: 'Report', onclick: () => openReport({ creatorId: c.id, title: 'Report this creator' }) }, icon('flag'))));

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, [['', `All`, c.media_count], ['image', 'Photos', c.media_count - c.video_count], ['video', 'Videos', c.video_count]].map(([v, l, n]) =>
    h('button', { class: type === v ? 'on' : '', role: 'tab', 'aria-selected': String(type === v), onclick: () => setQ({ type: v }) }, `${l} `, h('span', { class: 'muted num' }, fmt.num(n)))));
  const sortSel = h('select', { class: 'select sm', style: { width: 'auto', marginLeft: 'auto', marginBottom: '8px' }, 'aria-label': 'Sort', onchange: (e) => setQ({ sort: e.target.value }) }, [['recent', 'Newest'], ['top', 'Top rated'], ['trending', 'Trending'], ['oldest', 'Oldest']].map(([v, l]) => h('option', { value: v, selected: sort === v }, l)));

  const feed = createFeed({ endpoint: `/api/creators/${c.id}/media`, query: { type, sort, platform: platform || undefined }, empty: emptyState({ icon: 'image', title: 'Nothing here yet', text: 'No published posts match this tab.' }) });

  const stage = h('section', { class: `stage${art ? '' : ' bare'}` },
    art ? h('div', { class: 'stage-media', 'aria-hidden': 'true' }, h('img', { class: 'stage-img', src: proxied(art), alt: '', decoding: 'async', fetchpriority: 'high' })) : null,
    h('div', { class: 'stage-tint', 'aria-hidden': 'true' }), h('div', { class: 'stage-wash', 'aria-hidden': 'true' }), // the wash sits on top so the page edge is always plain background
    head);
  // Stats count up the first time you open a creator in a visit; coming back shows them settled.
  const stat = (n, f = fmt.int) => { const b = h('b', { class: 'num' }, f(n)); if (!counted.has(c.id)) countUp(b, n, f); return b; };
  const stats = h('div', { class: 'profile-stats' }, h('span', null, stat(c.media_count), 'posts'), h('span', null, stat(c.video_count), 'videos'), c.total_score ? h('span', null, stat(c.total_score, fmt.num), 'total score') : null, c.last_media_at ? h('span', null, `Active ${fmt.ago(c.last_media_at)}`) : null);
  counted.add(c.id);

  root.replaceChildren(stage,
    c.bio ? h('p', { class: 'profile-bio' }, c.bio) : null,
    stats,
    freeOn.length ? h('div', { class: 'free-on' }, h('span', { class: 'free-on-label' }, 'Free on'), h('div', { class: 'free-on-row' }, freeOn)) : null,
    ext.length ? h('div', { class: 'linkrow' }, ext) : null,
    c.topTags && c.topTags.length ? h('div', { class: 'row wrap', style: { marginTop: '14px', gap: '6px' } }, c.topTags.slice(0, 10).map((t) => h('a', { class: 'tag', href: href('/explore', { tag: t.name }) }, `#${t.name}`))) : null,
    h('div', { style: { height: '22px' } }),
    platformSwitcher(c, { value: platform, onChange: (p) => setQ({ platform: p }) }), // pills per platform, plus his paid-page cards
    h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('div', { class: 'grow' }, tabs), sortSel),
    feed.el);
  landAvatar(headAvatar, c.id); // the avatar tapped on the way here flies into place
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
  // OnlyFans creators: more men with a page who post in the same style.
  if (c.onlyfans) get(`/api/creators/${c.id}/similar`, { limit: 12, onlyfans: 1 }).then((list) => {
    if (!list.length || !root.isConnected) return;
    const anchor = root.querySelector('.tabs');
    if (!anchor) return;
    anchor.closest('.row').before(h('section', { class: 'section', style: { marginTop: '28px' } },
      h('div', { class: 'section-head' }, h('div', null, h('h2', null, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), 'More OnlyFans creators like him'), h('div', { class: 'sub' }, 'Similar style, each with his own page'))),
      h('div', { class: 'rail' }, list.map((x) => creatorCard(x, { mini: true })))), h('div', { style: { height: '8px' } }));
  }).catch(() => {});
  // Chameleon: the profile takes its accent colours from the creator's own artwork.
  const TINT_VARS = ['--accent', '--accent-2', '--accent-3', '--grad', '--grad-soft'];
  const tintFrom = art || c.avatar_url; // the same picture the stage shows, so the wash matches it
  dominantColor(tintFrom ? proxied(tintFrom) : null).then((col) => {
    if (!col || !root.isConnected || !root.contains(head)) return;
    const hsl = (dh, ds = 0, dl = 0) => `hsl(${(col.h + dh + 360) % 360} ${Math.min(95, col.s + ds)}% ${Math.min(72, col.l + dl)}%)`;
    root.style.setProperty('--accent', hsl(0));
    root.style.setProperty('--accent-2', hsl(-38, 0, -6));
    root.style.setProperty('--accent-3', hsl(32, 0, 6));
    root.style.setProperty('--grad', `linear-gradient(120deg, ${hsl(-38, 0, -6)} 0%, ${hsl(0)} 55%, ${hsl(32, 0, 6)} 100%)`);
    root.style.setProperty('--grad-soft', `linear-gradient(120deg, hsl(${(col.h + 322) % 360} ${col.s}% ${col.l}% / .22), hsl(${col.h} ${col.s}% ${col.l}% / .2) 55%, hsl(${(col.h + 32) % 360} ${col.s}% ${col.l}% / .16))`);
    root.classList.add('tinted');
  });
  return () => { feed.destroy(); off(); TINT_VARS.forEach((v) => root.style.removeProperty(v)); root.classList.remove('tinted'); };
}
