import { h, icon, fmt, emptyState } from '../dom.js';
import { get, prefetch } from '../api.js';
import { href } from '../router.js';
import { platformLabel, platformColor, follows, searches, tastes, history as viewHistory, prefs, visits } from '../store.js';
import { mediaCard } from '../components/card.js';
import { creatorCard } from '../components/creator-card.js';
import { createFeed } from '../components/feed.js';
import { openLightbox, surpriseMe } from '../components/ondemand.js';
import { smartSearch } from '../smart.js';
import { attachSuggest } from '../components/suggest.js';
import { topicCards, becauseRails } from '../components/topics.js';
import { creatorRing } from '../components/creator-ring.js';

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
    h('div', { class: 'rail' }, res.items.map((it, i) => mediaCard(it, { open: open(res.items), compact: false, why: tastes.why(it), eager: i < 4 }))),
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

let eagerRail = 4;
function rail(items, { open }) {
  const n = eagerRail;
  eagerRail = 0;
  return h('div', { class: 'rail' }, items.map((it, i) => mediaCard(it, { open, compact: false, eager: i < n })));
}

function sectionHead(iconName, title, sub, more) {
  return h('div', { class: 'section-head' },
    h('div', null, h('h2', null, icon(iconName), title), sub ? h('div', { class: 'sub' }, sub) : null),
    more ? h('a', { class: 'link-more', href: more.href }, more.label, icon('chev-r', 'sm')) : null);
}

export async function home(root) {
  eagerRail = 4;
  const holder = h('div', { class: 'stack' }, h('div', { class: 'skeleton', style: { height: '320px' } }), h('div', { class: 'skeleton', style: { height: '260px' } }));
  root.replaceChildren(holder);
  let feed;
  let data;
  // Everything that does not need /api/discover starts now, with it, instead of one round trip
  // (150 ms+ on a phone) after another. Each one is only awaited where the page uses it.
  const open = (list) => (item) => openLightbox(list, Math.max(0, list.findIndex((x) => x.id === item.id)));
  const followIds = follows.list().map((c) => c.id).slice(0, 100);
  const followedP = followIds.length ? get('/api/media', { creators: followIds.join(','), sort: 'recent', limit: 14 }).then((r) => r.items, () => []) : Promise.resolve([]);
  const sinceP = sinceSection();
  const forYouP = forYouSection(open).catch(() => null);
  const becauseP = becauseRails(open).catch(() => []);
  const topicsP = topicCards({ limit: 8 }).catch(() => null);
  prefetch('/api/media', { sort: 'recent', page: 0, limit: 36 }); // the first feed page, reused by createFeed below
  try { data = await get('/api/discover'); } catch (e) {
    root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t load', text: e.message, actions: [h('button', { class: 'btn primary', onclick: () => home(root) }, 'Try again')] }));
    return () => {};
  }

  const s = data.stats;
  const input = h('input', { class: 'input', type: 'search', placeholder: window.matchMedia('(max-width: 560px)').matches ? 'Search creators or tags' : 'Try “muscle guys at the gym, videos this week”', 'aria-label': 'Search', enterkeyhint: 'search', autocomplete: 'off' });
  const go = () => smartSearch(input.value);
  attachSuggest(input, { id: 'hero-suggest' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  // One calm hero: the promise, one search box, three actions. Counts live in the kicker once (no second stats row),
  // the featured creators have their own section below, and nothing here animates or loads WebGL.
  const copy = h('div', { class: 'hero-copy' },
    h('div', { class: 'hero-kicker' }, h('span', { class: 'live-dot' }), `${fmt.num(s.total)} posts from ${fmt.num(s.creators)} creators across ${data.platforms.length} sources`),
    h('h1', null, 'The Master Index for ', h('em', null, 'Gay OnlyFans & Male Creators')),
    h('p', { class: 'lead' }, 'Follow gay male creators across OnlyFans, GayForFans, Bluesky, Reddit and X in one place. Public posts only; paid pages link out.'),
    h('div', { class: 'hero-search' }, icon('search', 'lg'), input, h('button', { class: 'btn primary', onclick: go }, 'Search')),
    h('div', { class: 'hero-actions' },
      h('a', { class: 'btn glass', href: href('/creators') }, icon('users', 'sm'), 'Find a creator'),
      h('a', { class: 'btn glass', href: href('/reels') }, icon('film', 'sm'), 'Watch Reels'),
      h('button', { class: 'btn glass', onclick: surpriseMe }, icon('shuffle', 'sm'), 'Surprise me')),
    h('p', { class: 'hero-note' }, 'Adults 18+ only. Male creators only. Report anything that doesn’t belong.'));
  const hero = h('section', { class: 'hero' },
    copy,
    data.tags.length && !(!tastes.ready() && !prefs.introDone) ? h('div', { class: 'hero-chips' }, data.tags.slice(0, 8).map((t) => h('a', { class: 'chip', href: href('/explore', { tag: t.name }) }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count))))) : null);
  const teardownHero = () => {};

  if (!s.total) {
    root.replaceChildren(hero, emptyState({
      icon: 'sparkle', title: 'Your library is empty',
      text: 'Open the admin console to add creators and communities, then run a first sync. Content appears here as soon as it’s ingested.',
      actions: [h('a', { class: 'btn primary', href: href('/admin/sources') }, 'Open admin'), h('a', { class: 'btn', href: href('/creators') }, 'Browse creators')],
    }));
    return teardownHero;
  }

  // Newest posts from creators this device follows (the server never learns who you follow beyond this request).
  const fromFollowed = await followedP; // the rail is optional: a failed request leaves it empty

  const parts = [hero];
  // Content in the first screen: creators as rings, people you follow first, a spectrum ring if he posted this week.
  const ring = creatorRing([...(data.topCreators || []), ...(data.rising || []), ...(data.newCreators || [])], { label: 'Creators' });
  if (ring) parts.push(ring);
  // Fetched in parallel with the rest of the page; slotted in when ready.
  const picker = interestPicker(data.tags, async () => { const sec = await forYouSection(open); if (picker.isConnected) { if (sec) picker.replaceWith(sec); else picker.remove(); } });
  const since = await sinceP;
  if (since) parts.push(since);
  if (picker) parts.push(picker);
  if (data.topCreators && data.topCreators.length) {
    parts.push(h('section', { class: 'section suggested-spotlight' }, sectionHead('users', 'Featured OnlyFans Creators', 'Top creators with verified OnlyFans pages and media in the library — tap to open or follow', { href: href('/creators', { paid: 'onlyfans' }), label: 'All OnlyFans creators' }),
      h('div', { class: 'rail' }, data.topCreators.map((c) => creatorCard(c, { spotlight: true })))));
  }
  const forYou = await forYouP;
  if (forYou) parts.push(forYou);
  const smart = smartFeeds();
  if (smart) parts.push(smart);

  if (fromFollowed.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('heart', 'From creators you follow', 'Latest from the people you follow on this device', { href: href('/following'), label: 'See all' }), rail(fromFollowed, { open: open(fromFollowed) })));
  }
  parts.push(...await becauseP);
  const latestHead = h('div', { class: 'section-head' },
    h('div', null, h('h2', null, icon('layers'), 'Latest uploads'), h('div', { class: 'sub' }, 'Filter by creator or browse everything across sources')),
    h('a', { class: 'link-more', href: href('/explore') }, 'Explore everything', icon('chev-r', 'sm')));
  let activeCreatorId = '';
  const setFeedCreator = (cid) => {
    if (activeCreatorId === cid) return;
    activeCreatorId = cid;
    for (const b of creatorFilterBar.querySelectorAll('.chip')) {
      const on = (b.dataset.cid || '') === cid;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const next = createFeed({ query: cid ? { creator: cid, sort: 'recent' } : { sort: 'recent' }, pageSize: 36 });
    feed.el.replaceWith(next.el);
    feed.destroy();
    feed = next;
  };
  const pillCreators = [...(data.topCreators || []).slice(0, 12)];
  const creatorFilterBar = pillCreators.length ? h('div', { class: 'row', style: { gap: '8px', overflowX: 'auto', padding: '0 0 14px', scrollbarWidth: 'none' }, role: 'group', 'aria-label': 'Filter feed by creator' },
    h('button', { type: 'button', class: 'chip on', dataset: { cid: '' }, 'aria-pressed': 'true', onclick: () => setFeedCreator('') }, 'All creators'),
    ...pillCreators.map((c) => h('button', { type: 'button', class: 'chip', dataset: { cid: c.id }, 'aria-pressed': 'false', onclick: () => setFeedCreator(c.id), title: `${c.display_name || c.handle} (${c.media_count} posts)` },
      c.display_name || c.handle, h('span', { class: 'n' }, fmt.num(c.media_count)))),
    h('a', { class: 'chip', href: href('/find') }, icon('plus', 'sm'), 'Find a creator')) : null;


  if (data.trending.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('flame', 'Trending OnlyFans & Creators', 'Top posts from verified OnlyFans and independent creators', { href: href('/explore', { sort: 'trending', paid: 'onlyfans' }), label: 'See all' }), rail(data.trending, { open: open(data.trending) })));
  }
  const topics = await topicsP;
  if (topics) parts.push(h('section', { class: 'section' }, sectionHead('layers', 'Topics', 'Themes the library keeps coming back to — found from tags that travel together', { href: href('/browse'), label: 'Browse all' }), topics));
  if (data.rising && data.rising.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('trend', 'Rising this week', 'Creators posting more — and getting more love — than usual', { href: href('/creators', { sort: 'recent' }), label: 'All creators' }),
      h('div', { class: 'rail' }, data.rising.map((c) => creatorCard(c, { mini: true, badge: `+${c.week_count} this week` })))));
  }
  if (data.freshVideos.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('video', 'Fresh OnlyFans & Creator Clips', 'Newest creator video clips in the library', { href: href('/explore', { type: 'video', sort: 'recent', paid: 'onlyfans' }), label: 'More videos' }), rail(data.freshVideos, { open: open(data.freshVideos) })));
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
  parts.push(h('section', { class: 'section' }, latestHead, creatorFilterBar, feed.el));

  root.replaceChildren(...parts);
  return () => { teardownHero(); if (feed) feed.destroy(); };
}
