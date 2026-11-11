import { makeGuard } from '../guard.js';
import { h, icon, fmt, emptyState } from '../dom.js';
import { get, prefetch } from '../api.js';
import { href } from '../router.js';
import { follows, tastes, history as viewHistory, prefs, playback, GENERIC, searches, smartFeedQuery } from '../store.js';
import { mediaCard } from '../components/card.js';
import { creatorCard } from '../components/creator-card.js';
import { createFeed } from '../components/feed.js';
import { openLightbox, surpriseMe } from '../components/ondemand.js';
import { smartSearch } from '../smart.js';
import { attachSuggest } from '../components/suggest.js';
import { creatorRing } from '../components/creator-ring.js';
import { initPullToRefresh } from '../components/pull-to-refresh.js';

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
      h('div', { class: 'rail' }, people.map((c, i) => creatorCard(c, { mini: true, badge: c.reason, eager: i < 2 })))) : null);
}

/**
 * First visit: "What are you into?" Real tags from the library (never invented), 10 at most. Two picks
 * tune For you; each pick refreshes that rail in place. "Skip for now" hides the card for good.
 */
function interestPicker(tags, { onChange, onSkip }) {
  if (tastes.ready() || prefs.introDone) return null;
  const niche = tags.filter((t) => t && t.name && !GENERIC.has(t.name)).slice(0, 10);
  if (!niche.length) return null;
  const picked = new Set(tastes.seededTags());
  const count = h('span', { class: 'muted', style: { fontSize: '13px' }, 'aria-live': 'polite' }, '');
  const paintCount = () => {
    count.textContent = picked.size >= 2 ? `${picked.size} picked · For you is updating` : picked.size ? 'Pick one more' : 'Pick two or more';
  };
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { if (picked.size >= 2) onChange(); }, 300); };
  const chipEl = (t) => {
    const on = picked.has(t.name);
    const b = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), title: `${t.count} posts tagged #${t.name}` }, `#${t.name}`);
    b.addEventListener('click', () => {
      const now = !picked.has(t.name);
      if (now) picked.add(t.name); else picked.delete(t.name);
      tastes.seedTags([t.name], now ? 3 : -3);
      b.classList.toggle('on', now); b.setAttribute('aria-pressed', String(now));
      paintCount(); schedule();
    });
    return b;
  };
  const chips = niche.map(chipEl);
  paintCount();
  const card = h('section', { class: 'section intro-card taste-picker' },
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' } },
      h('div', null, h('h2', null, icon('sparkle'), 'What are you into?'), h('p', { class: 'muted', style: { margin: '6px 0 0' } }, 'Pick two or more and For you and the creator picks follow them. Stored on this device only.'))),
    h('div', { class: 'taste-wrap', role: 'group', 'aria-label': 'Interests' }, chips.slice(0, 4)),
    chips.length > 4 ? h('div', { class: 'taste-swipe', role: 'group', 'aria-label': 'More interests' }, chips.slice(4)) : null,
    h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginTop: '12px' } },
      count,
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { prefs.introDone = true; clearTimeout(timer); card.remove(); onSkip(); } }, 'Skip for now')));
  return card;
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

/** Niche chips that stay on the page: each one opens Explore filtered to that tag. Nothing here is dismissible. */
function nicheRow(tags) {
  const list = (tags || []).filter((t) => t && t.name).slice(0, 12);
  if (!list.length) return null;
  return h('nav', { class: 'niche-row', 'aria-label': 'Browse by niche' },
    h('span', { class: 'niche-label' }, 'Niches'),
    h('div', { class: 'niche-chips' },
      list.map((t) => h('a', { class: 'chip sm', href: href('/explore', { tags: t.name }) }, `#${t.name}`))));
}

export function home(root) {
  eagerRail = 4;
  const holder = h('div', { class: 'stack home-pending' }, h('div', { class: 'skeleton', style: { height: '168px', borderRadius: '16px' } }));
  const latestHead = h('div', { class: 'section-head' },
    h('div', null, h('h2', null, icon('layers'), 'Latest uploads'), h('div', { class: 'sub' }, 'Filter by creator, or open Explore for everything')),
    h('a', { class: 'link-more', href: href('/explore') }, 'Explore', icon('chev-r', 'sm')));
  const creatorFilterBar = h('div', { class: 'row', hidden: true, style: { gap: '8px', overflowX: 'auto', padding: '0 0 14px', scrollbarWidth: 'none' }, role: 'group', 'aria-label': 'Filter feed by creator' });
  let feed = createFeed({
    query: { sort: 'recent' },
    pageSize: 36,
    failText: 'Latest uploads didn’t load. The rest of Home is still here.',
    empty: emptyState({ icon: 'layers', title: 'No uploads yet', text: 'Discover still loaded. New posts show up here as soon as they are ingested.' }),
  });
  const feedSection = h('section', { class: 'section' }, latestHead, creatorFilterBar, feed.el);
  root.replaceChildren(holder, feedSection);
  let data;
  // Everything that does not need /api/discover starts now, with it, instead of one round trip
  // (150 ms+ on a phone) after another. Each one is only awaited where the page uses it.
  const open = (list) => (item) => openLightbox(list, Math.max(0, list.findIndex((x) => x.id === item.id)));
  const followIds = follows.list().map((c) => c.id).slice(0, 100);
  const followedP = followIds.length ? get('/api/media', { creators: followIds.join(','), sort: 'recent', limit: 14 }).then((r) => r.items, () => []) : Promise.resolve([]);
  const resumeSaved = playback.list().slice(0, 12);
  const resumeP = resumeSaved.length
    ? get('/api/media', { ids: resumeSaved.map((p) => p.id).join(','), limit: resumeSaved.length }).then((r) => r.items || [], () => [])
    : Promise.resolve([]);
  const forYouP = forYouSection(open).catch(() => null);
  prefetch('/api/media', { sort: 'recent', page: 0, limit: 36 }); // the first feed page, reused by the feed already on screen
  // The grid is already on screen. Hand back the way out before Discover returns, so leaving destroys
  // that grid while the snapshot is still in flight and a late snapshot cannot replace the next page.
  let extra = () => {};
  const life = makeGuard(() => {
    extra();
    extra = () => {};
    if (feed) feed.destroy();
    feed = null;
  });
  const stop = life.cleanup;
  void fill();
  return stop;

  async function fill() {
  try { data = await get('/api/discover'); } catch (e) {
    if (life.isLeft()) return;
    // The early grid is independent. A failed snapshot must not throw away uploads that already painted.
    const failedFeeds = homeFeeds();
    holder.replaceWith(...[emptyState({
      icon: 'alert',
      title: 'Discover didn’t load',
      text: `${e.message || 'The snapshot failed.'} Latest uploads are still on this page.`,
      actions: [h('button', { class: 'btn primary', onclick: () => {
        const dying = feed; feed = null;
        const next = home(root);
        extra = () => { next(); };
        if (dying) dying.destroy();
      } }, 'Try again')],
    }), failedFeeds.section].filter(Boolean));
    failedFeeds.paint();
    return;
  }
  if (life.isLeft()) return;

  const s = data.stats;
  const input = h('input', { class: 'input', type: 'search', placeholder: window.matchMedia('(max-width: 560px)').matches ? 'Search creators or tags' : 'Try “muscle guys at the gym, videos this week”', 'aria-label': 'Search', enterkeyhint: 'search', autocomplete: 'off' });
  const go = () => smartSearch(input.value);
  attachSuggest(input, { id: 'hero-suggest' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  // One calm hero: the promise, one search box, three actions. Counts live in the kicker once, and nothing here animates.
  const hero = h('section', { class: 'hero' }, h('div', { class: 'hero-copy' },
    h('div', { class: 'hero-kicker' }, h('span', { class: 'live-dot' }), `${fmt.num(s.total)} posts from ${fmt.num(s.creators)} creators across ${data.platforms.length} sources`),
    h('h1', null, 'The Master Index for ', h('em', null, 'Gay OnlyFans & Male Creators')),
    h('p', { class: 'lead' }, 'Follow gay male creators across OnlyFans, GayForFans, Bluesky, Reddit and X in one place. Public posts only; paid pages link out.'),
    h('div', { class: 'hero-search' }, icon('search', 'lg'), input, h('button', { class: 'btn primary', onclick: go }, 'Search')),
    h('div', { class: 'hero-actions' },
      h('a', { class: 'btn glass', href: href('/creators') }, icon('users', 'sm'), 'Popular creators'),
      h('a', { class: 'btn glass', href: href('/reels') }, icon('film', 'sm'), 'Watch Reels'),
      h('button', { class: 'btn glass', onclick: surpriseMe }, icon('shuffle', 'sm'), 'Surprise me')),
    h('p', { class: 'hero-note' }, 'Adults 18+ only. Male creators only. Report anything that doesn’t belong.')));

  function homeFeeds() {
    const savedFeeds = searches.list().slice(0, 2);
    const rows = [];
    if (!savedFeeds.length) return { section: null, paint() {} };
    const section = h('section', { class: 'section home-feeds' },
      sectionHead('bookmark', 'Smart feeds', 'New since you last opened them', { href: href('/saved', { tab: 'feeds' }), label: 'See all' }),
      h('div', { class: 'search-list' }, savedFeeds.map((s) => {
        const hold = h('span', { class: 'home-feed-count' });
        rows.push({ s, hold });
        return h('div', { class: 'search-item' },
          icon('bookmark'),
          h('div', { class: 'grow', style: { minWidth: 0 } }, h('a', { href: href('/explore', s.query), onclick: () => searches.markSeen(s.id), style: { fontWeight: 650 } }, s.name)),
          hold);
      })));
    const paint = () => {
      for (const { s, hold } of rows) {
        const fresh = searches.list().find((x) => x.id === s.id) || s;
        get('/api/media', smartFeedQuery(fresh)).then((r) => {
          if (!hold.isConnected) return;
          hold.replaceChildren(r.total ? h('span', { class: 'badge good' }, `${fmt.num(r.total)} new`) : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'up to date'));
        }).catch(() => { if (hold.isConnected) hold.replaceChildren(); });
      }
    };
    return { section, paint };
  }

  if (!s.total) {
    if (life.isLeft()) return;
    feed.destroy();
    feed = null;
    const emptyFeeds = homeFeeds();
    root.replaceChildren(...[hero, emptyState({
      icon: 'sparkle', title: 'Your library is empty',
      text: 'Open the admin console to add creators and communities, then run a first sync. Content appears here as soon as it’s ingested.',
      actions: [h('a', { class: 'btn primary', href: href('/admin/sources') }, 'Open admin'), h('a', { class: 'btn', href: href('/creators') }, 'Browse creators')],
    }), emptyFeeds.section].filter(Boolean));
    emptyFeeds.paint();
    const stopEmpty = initPullToRefresh(root, async () => { emptyFeeds.paint(); });
    extra = () => { stopEmpty(); };
    return;
  }

  // The page, in the order a visitor wants it: the most popular creators first, then what is new from people they follow,
  // what is trending, a personal feed once there is taste to learn from, and the latest uploads at the bottom.
  const top = data.topCreators || [];
  const parts = [hero];
  // Niche chips persist under the hero: they are a way in, not a first-visit prompt, so they never go away.
  const niches = nicheRow(data.tags);
  if (niches) parts.push(niches);
  // Order matters for the first screen: the creators come right after the hero and the niche row. The follow ring and the
  // first-visit picker come after them, so neither pushes the first creator card below the fold at 390x844.
  if (top.length) {
    parts.push(h('section', { class: 'section suggested-spotlight' },
      sectionHead('users', 'Popular creators', 'Ranked from engagement, platform breadth, archive size and freshness. Quiet for 90 days: left out.', { href: href('/creators'), label: 'See all' }),
      h('div', { class: 'rail' }, top.map((c, i) => creatorCard(c, { spotlight: true, reason: 'Popular here', eager: i < 2 })))));
  }
  // "Popular now" is only what the server computes: posts in the last 7 days against each creator's usual pace.
  // It is hidden, not faked, when fewer than three creators qualify.
  const popular = (data.rising || []).filter((c) => c.week_count > 0);
  if (popular.length >= 3) {
    parts.push(h('section', { class: 'section popular-now' },
      sectionHead('trend', 'Popular now', 'Most posts this week against each creator’s usual pace. A sign of momentum, not a quality rank.', { href: href('/creators', { sort: 'popular', fresh: '7' }), label: 'See all' }),
      h('div', { class: 'rail' }, popular.map((c, i) => creatorCard(c, { mini: true, eager: i < 2, reason: `${fmt.num(c.week_count)} ${c.week_count === 1 ? 'post' : 'posts'} this week` })))));
  }
  const ring = creatorRing([...top, ...(data.rising || []), ...(data.newCreators || [])], { label: 'More creators' });
  if (ring) parts.push(ring);
  const feeds = homeFeeds();
  if (feeds.section) parts.push(feeds.section);
  // The For you rail has a fixed slot; a pick refreshes what is in it, in place.
  const refreshForYou = async () => { const sec = await forYouSection(open).catch(() => null); forYouSlot.replaceChildren(...(sec ? [sec] : [])); };
  const picker = interestPicker(data.tags, { onChange: refreshForYou, onSkip: () => {} });
  if (picker) parts.push(picker);

  const forYouSlot = h('div', { class: 'for-you-slot' });
  const fromFollowed = await followedP; // optional: a failed request leaves it empty
  if (life.isLeft()) return;
  if (fromFollowed.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('heart', 'From creators you follow', 'Latest from the people you follow on this device', { href: href('/following'), label: 'See all' }), rail(fromFollowed, { open: open(fromFollowed) })));
  }
  const resumeItems = await resumeP;
  if (life.isLeft()) return;
  const resumeById = new Map(resumeItems.map((it) => [it.id, it]));
  const continueItems = resumeSaved.map((p) => resumeById.get(p.id)).filter(Boolean);
  if (continueItems.length) {
    const frac = new Map(resumeSaved.map((p) => [p.id, p.d ? Math.min(0.96, p.t / p.d) : 0]));
    const resumeHead = sectionHead('history', 'Continue watching', 'Picked up where you left off on this device');
    const resumeSec = h('section', { class: 'section continue-watching' }, resumeHead,
      h('div', { class: 'rail' }, continueItems.map((it) => h('div', { class: 'resume-card' },
        mediaCard(it, { open: open(continueItems), eager: false }),
        h('span', { class: 'resume-bar', style: { '--p': String(frac.get(it.id) || 0) }, 'aria-hidden': 'true' })))),
      h('button', { class: 'btn sm ghost', style: { marginTop: '8px' }, onclick: () => { playback.clear(); resumeSec.remove(); } }, 'Clear'));
    parts.push(resumeSec);
  }
  if (data.trending.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('flame', 'Trending now', 'Top posts, OnlyFans creators first', { href: href('/explore', { sort: 'trending', paid: 'onlyfans' }), label: 'See all' }), rail(data.trending, { open: open(data.trending) })));
  }
  const forYou = await forYouP;
  if (life.isLeft()) return;
  if (forYou) forYouSlot.replaceChildren(forYou);
  parts.push(forYouSlot);

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
  const pillCreators = top.slice(0, 12);
  if (pillCreators.length) {
    creatorFilterBar.hidden = false;
    creatorFilterBar.replaceChildren(
      h('button', { type: 'button', class: 'chip on', dataset: { cid: '' }, 'aria-pressed': 'true', onclick: () => setFeedCreator('') }, 'All creators'),
      ...pillCreators.map((c) => h('button', { type: 'button', class: 'chip', dataset: { cid: c.id }, 'aria-pressed': 'false', onclick: () => setFeedCreator(c.id), title: `${c.display_name || c.handle} (${c.media_count} posts)` },
        c.display_name || c.handle, h('span', { class: 'n' }, fmt.num(c.media_count)))),
      h('a', { class: 'chip', href: href('/find') }, icon('plus', 'sm'), 'Find a creator'));
  }

  if (life.isLeft()) return;
  root.replaceChildren(...parts, feedSection);
  feeds.paint();
  const stopPtr = initPullToRefresh(root, async () => {
    if (feed) await feed.refresh();
    await refreshForYou();
    feeds.paint();
  });
  extra = () => { stopPtr(); };
  }
}
