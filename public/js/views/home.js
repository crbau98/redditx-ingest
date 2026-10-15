import { h, icon, fmt, emptyState } from '../dom.js';
import { get } from '../api.js';
import { href } from '../router.js';
import { platformLabel, platformColor, follows, searches, tastes, history as viewHistory, prefs, visits } from '../store.js';
import { mediaCard } from '../components/card.js';
import { creatorCard } from '../components/creator-card.js';
import { createFeed } from '../components/feed.js';
import { openLightbox } from '../components/lightbox.js';
import { surpriseMe } from '../components/palette.js';
import { mountPrismBackground } from '../components/prism-bg.js';
import { createOrbit } from '../components/orbit.js';
import { countUp } from '../components/fx.js';
import { smartSearch } from '../smart.js';
import { attachSuggest } from '../components/suggest.js';
import { topicCards, becauseRails } from '../components/topics.js';

/** "For you": a rail ranked from this device's taste, with the taste shown (and editable) right there. */
async function forYouSection(open) {
  if (!tastes.ready()) return null;
  let res; let people = [];
  const q = tastes.query({ exclude: viewHistory.list().slice(0, 60) });
  try {
    [res, people] = await Promise.all([
      get('/api/recommend', { ...q, limit: 18, seed: Math.floor(Math.random() * 1e6) }),
      // Creators like the ones you engage with, minus the ones you already follow.
      get('/api/recommend/creators', { tags: q.tags, creators: q.creators, avoid_creators: q.avoid_creators, exclude: follows.list().map((c) => c.id).slice(0, 150).join(',') || undefined, limit: 12 }).catch(() => []),
    ]);
  } catch { return null; }
  if (!res.items.length) return null;
  const chips = h('div', { class: 'row wrap taste-chips' });
  const paintChips = () => chips.replaceChildren(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Tuned to'),
    tastes.topTags(6).map((t) => h('button', { class: 'chip sm x', title: `Show less #${t}`, 'aria-label': `Stop tuning to ${t}`, onclick: () => { tastes.forgetTag(t); paintChips(); } }, `#${t}`)),
    h('button', { class: 'chip sm', onclick: () => { tastes.reset(); chips.closest('section').remove(); } }, 'Reset'));
  paintChips();
  return h('section', { class: 'section' },
    sectionHead('sparkle', 'For you', 'Picked from what you watch, save and follow — learned on this device only', { href: href('/explore', { sort: 'foryou' }), label: 'See all' }),
    chips,
    h('div', { class: 'rail' }, res.items.map((it) => mediaCard(it, { open: open(res.items), compact: false, why: tastes.why(it) }))),
    h('a', { class: 'btn sm', href: href('/reels', { sort: 'foryou', type: 'all' }), style: { marginTop: '6px' } }, icon('film', 'sm'), 'Play For you as Reels'),
    people.length >= 3 ? h('div', { class: 'stack', style: { marginTop: '18px' } },
      h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' } }, 'Creators you might like'),
      h('div', { class: 'rail' }, people.map((c) => creatorCard(c, { mini: true, badge: c.reason })))) : null);
}

/**
 * "Since your last visit": what is new since this device was last here — from creators you follow,
 * across the library, and newly discovered creators — each one tap away. Hidden on a first visit
 * or when the last visit was under an hour ago (nothing meaningful to say).
 */
async function sinceSection() {
  const since = visits.since;
  if (!since || Date.now() - Date.parse(since) < 3600000) return null;
  const ids = follows.list().map((c) => c.id).slice(0, 100);
  const [all, mine, fresh] = await Promise.all([
    get('/api/media', { after: since, limit: 1 }).catch(() => null),
    ids.length ? get('/api/media', { after: since, creators: ids.join(','), limit: 1 }).catch(() => null) : null,
    get('/api/creators', { sort: 'new', limit: 48 }).catch(() => null),
  ]);
  const newCreators = fresh ? fresh.items.filter((c) => c.added_at && c.added_at > since).length : 0;
  const tiles = [];
  if (mine && mine.total) tiles.push(h('a', { class: 'since-tile hot', href: href('/following') }, h('b', { class: 'num' }, fmt.num(mine.total)), h('span', null, 'new from creators you follow')));
  if (all && all.total) tiles.push(h('a', { class: 'since-tile', href: href('/explore', { after: since, sort: 'trending' }) }, h('b', { class: 'num' }, fmt.num(all.total)), h('span', null, `new post${all.total === 1 ? '' : 's'} in the library`)));
  if (newCreators) tiles.push(h('a', { class: 'since-tile', href: href('/creators', { sort: 'new' }) }, h('b', { class: 'num' }, `${newCreators}${newCreators === 48 ? '+' : ''}`), h('span', null, `new creator${newCreators === 1 ? '' : 's'} discovered`)));
  if (!tiles.length) return null;
  return h('section', { class: 'section since' },
    sectionHead('clock', 'Since your last visit', `${fmt.ago(since)} — here is what is new`),
    h('div', { class: 'since-row' }, tiles));
}

/** First visit: let people pick a few interests so "For you" works from minute one. */
function interestPicker(tags, onDone) {
  if (tastes.ready() || prefs.introDone || !tags.length) return null;
  const picked = new Set();
  const go = h('button', { class: 'btn primary', disabled: true }, icon('sparkle', 'sm'), 'Build my feed');
  const count = h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Pick 3 or more');
  const chipEls = tags.slice(0, 24).map((t) => {
    const b = h('button', { class: 'chip', 'aria-pressed': 'false' }, `#${t.name}`);
    b.addEventListener('click', () => {
      if (picked.has(t.name)) picked.delete(t.name); else picked.add(t.name);
      b.classList.toggle('on', picked.has(t.name)); b.setAttribute('aria-pressed', String(picked.has(t.name)));
      go.disabled = picked.size < 3; count.textContent = picked.size < 3 ? `Pick ${3 - picked.size} more` : `${picked.size} picked`;
    });
    return b;
  });
  const card = h('section', { class: 'section intro-card' },
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' } },
      h('div', null, h('h2', null, icon('sparkle'), 'What are you into?'), h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Pick a few and PRISM tunes a “For you” feed around them. It keeps learning from what you watch and save — on this device only.')),
      h('button', { class: 'btn icon ghost', 'aria-label': 'Dismiss', onclick: () => { prefs.introDone = true; card.remove(); } }, icon('x'))),
    h('div', { class: 'row wrap', style: { gap: '8px', margin: '14px 0' } }, chipEls),
    h('div', { class: 'row', style: { gap: '12px' } }, go, count));
  go.addEventListener('click', () => {
    for (const t of picked) tastes.record({ tags: [t] }, 3);
    prefs.introDone = true;
    onDone();
  });
  return card;
}

/** Map a saved Explore search onto /api/media parameters. */
function mediaQuery(q) {
  const out = { ...q };
  delete out.following;
  if (out.sort === 'relevance') delete out.sort;
  if (q.following) {
    const ids = follows.list().map((c) => c.id).slice(0, 100);
    out.creators = ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000';
  }
  return out;
}

/** Saved searches with a live "N new since your last visit" count each. */
function smartFeeds() {
  const list = searches.list();
  if (!list.length) return null;
  const row = h('div', { class: 'smart-row' }, list.map((s) => {
    const n = h('span', { class: 'zero' }, '…');
    const chip = h('a', { class: 'smart-chip', href: href('/explore', s.query), onclick: () => searches.markSeen(s.id) }, icon('bookmark', 'sm'), s.name, n);
    get('/api/media', { ...mediaQuery(s.query), after: s.seen, limit: 1 })
      .then((r) => { if (r.total) n.replaceWith(h('span', { class: 'new' }, `${fmt.num(r.total)} new`)); else n.textContent = 'up to date'; })
      .catch(() => { n.textContent = ''; });
    return chip;
  }));
  return h('section', { class: 'section' }, sectionHead('bookmark', 'Your smart feeds', 'Saved searches, with what’s new since you last looked', { href: href('/saved', { tab: 'feeds' }), label: 'Manage' }), row);
}

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
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Try “muscle guys at the gym, videos this week”', 'aria-label': 'Search', enterkeyhint: 'search', autocomplete: 'off' });
  const go = () => smartSearch(input.value);
  attachSuggest(input, { id: 'hero-suggest' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  // Stats count up once on arrival; the hero's backdrop is a live WebGL prism shader and
  // trending media turn on a 3D orbit beside the copy. Both mount after first paint so the
  // largest paint is not held back by WebGL setup on phones (static wash first, motion after).
  const stat = (n, label, format = fmt.num) => { const b = h('b', { class: 'num' }, format(n)); requestAnimationFrame(() => countUp(b, n, (v) => format(Math.round(v)))); return h('div', null, b, h('span', null, label)); };
  const openFromOrbit = (it, list) => openLightbox(list, Math.max(0, list.findIndex((x) => x.id === it.id)));
  const orbitHolder = h('div', { class: 'hero-visual' });
  const copy = h('div', { class: 'hero-copy' },
    h('div', { class: 'hero-kicker' }, h('span', { class: 'live-dot' }), `${fmt.num(s.total)} photos & videos · ${fmt.num(s.creators)} creators · updated continuously`),
    h('h1', null, 'Discover male creators ', h('em', null, 'across the web')),
    h('p', { class: 'lead' }, 'One feed for photos and videos from creators on Reddit, RedGIFs, Bluesky, Mastodon, X, YouTube and more — fresh, searchable, and organised around the people who make it.'),
    h('div', { class: 'hero-search' }, icon('search', 'lg'), input, h('button', { class: 'btn primary', onclick: go }, 'Search')),
    h('div', { class: 'hero-actions' },
      h('a', { class: 'btn glass', href: href('/find') }, icon('search', 'sm'), 'Find a creator'),
      h('a', { class: 'btn glass', href: href('/reels') }, icon('film', 'sm'), 'Watch Reels'),
      h('button', { class: 'btn glass', onclick: surpriseMe }, icon('shuffle', 'sm'), 'Surprise me'),
      h('a', { class: 'btn ghost hide-mobile', href: href('/browse') }, icon('layers', 'sm'), 'Browse everything')),
    h('div', { class: 'hero-stats' }, stat(s.total, 'items'), stat(s.creators, 'creators'), stat(s.videos, 'videos'), stat(data.platforms.length, 'sources', (v) => String(v))));
  const hero = h('section', { class: 'hero' },
    copy,
    data.trending.length >= 5 ? orbitHolder : null,
    data.tags.length && !(!tastes.ready() && !prefs.introDone) ? h('div', { class: 'hero-chips' }, data.tags.slice(0, 10).map((t) => h('a', { class: 'chip', href: href('/explore', { tag: t.name }) }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count))))) : null);
  let stopPrism = () => {};
  let orbit = null;
  const teardownHero = () => { stopPrism(); if (orbit) orbit.destroy(); };
  const mountMotion = () => {
    if (!hero.isConnected) return;
    if (data.trending.length >= 5) {
      hero.classList.add('hero-split');
      orbit = createOrbit(data.trending, { onOpen: openFromOrbit, compact: window.matchMedia('(max-width: 899px)').matches });
      orbitHolder.replaceChildren(orbit.el, h('div', { class: 'orbit-hint' }, icon('chev-l', 'sm'), 'Drag to spin · tap to open', icon('chev-r', 'sm')));
    }
    stopPrism = mountPrismBackground(hero);
  };
  if ('requestIdleCallback' in window) requestIdleCallback(mountMotion, { timeout: 1500 });
  else setTimeout(mountMotion, 300);

  if (!s.total) {
    root.replaceChildren(hero, emptyState({
      icon: 'sparkle', title: 'Your library is empty',
      text: 'Open the admin console to add creators and communities, then run a first sync. Content appears here as soon as it’s ingested.',
      actions: [h('a', { class: 'btn primary', href: href('/admin/sources') }, 'Open admin'), h('a', { class: 'btn', href: href('/creators') }, 'Browse creators')],
    }));
    return teardownHero;
  }

  // Newest posts from creators this device follows (the server never learns who you follow beyond this request).
  let fromFollowed = [];
  const followIds = follows.list().map((c) => c.id).slice(0, 100);
  if (followIds.length) {
    try { fromFollowed = (await get('/api/media', { creators: followIds.join(','), sort: 'recent', limit: 14 })).items; } catch { /* rail is optional */ }
  }

  const parts = [hero];
  const open = (list) => (item) => openLightbox(list, Math.max(0, list.findIndex((x) => x.id === item.id)));
  // Fetched in parallel with the rest of the page; slotted in when ready.
  const topicsP = topicCards({ limit: 8 });
  const sinceP = sinceSection();
  const becauseP = becauseRails(open);
  const picker = interestPicker(data.tags, async () => { const sec = await forYouSection(open); if (picker.isConnected) { if (sec) picker.replaceWith(sec); else picker.remove(); } });
  const since = await sinceP;
  if (since) parts.push(since);
  if (picker) parts.push(picker);
  const forYou = await forYouSection(open);
  if (forYou) parts.push(forYou);
  const smart = smartFeeds();
  if (smart) parts.push(smart);

  if (fromFollowed.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('heart', 'From creators you follow', 'Latest from the people you follow on this device', { href: href('/following'), label: 'See all' }), rail(fromFollowed, { open: open(fromFollowed) })));
  }
  parts.push(...await becauseP);
  if (data.trending.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('flame', 'Trending now', 'What people are watching and saving', { href: href('/explore', { sort: 'trending' }), label: 'See all' }), rail(data.trending, { open: open(data.trending) })));
  }
  const topics = await topicsP;
  if (topics) parts.push(h('section', { class: 'section' }, sectionHead('layers', 'Topics', 'Themes the library keeps coming back to — found from tags that travel together', { href: href('/browse'), label: 'Browse all' }), topics));
  if (data.rising && data.rising.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('trend', 'Rising this week', 'Creators posting more — and getting more love — than usual', { href: href('/creators', { sort: 'recent' }), label: 'All creators' }),
      h('div', { class: 'rail' }, data.rising.map((c) => creatorCard(c, { mini: true, badge: `+${c.week_count} this week` })))));
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
  return () => { teardownHero(); if (feed) feed.destroy(); };
}
