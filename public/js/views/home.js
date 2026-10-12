import { h, icon, fmt, emptyState } from '../dom.js';
import { get } from '../api.js';
import { href, navigate } from '../router.js';
import { platformLabel, platformColor, follows, searches, tastes, history as viewHistory, prefs } from '../store.js';
import { mediaCard } from '../components/card.js';
import { creatorCard } from '../components/creator-card.js';
import { createFeed } from '../components/feed.js';
import { openLightbox } from '../components/lightbox.js';
import { surpriseMe } from '../components/palette.js';

/** "For you": a rail ranked from this device's taste, with the taste shown (and editable) right there. */
async function forYouSection(open) {
  if (!tastes.ready()) return null;
  let res;
  try { res = await get('/api/recommend', { ...tastes.query({ exclude: viewHistory.list().slice(0, 60) }), limit: 18, seed: Math.floor(Math.random() * 1e6) }); } catch { return null; }
  if (!res.items.length) return null;
  const chips = h('div', { class: 'row wrap taste-chips' });
  const paintChips = () => chips.replaceChildren(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Tuned to'),
    tastes.topTags(6).map((t) => h('button', { class: 'chip sm x', title: `Show less #${t}`, 'aria-label': `Stop tuning to ${t}`, onclick: () => { tastes.forgetTag(t); paintChips(); } }, `#${t}`)),
    h('button', { class: 'chip sm', onclick: () => { tastes.reset(); chips.closest('section').remove(); } }, 'Reset'));
  paintChips();
  return h('section', { class: 'section' },
    sectionHead('sparkle', 'For you', 'Picked from what you watch, save and follow — learned on this device only', { href: href('/explore', { sort: 'foryou' }), label: 'See all' }),
    chips,
    h('div', { class: 'rail' }, res.items.map((it) => mediaCard(it, { open: open(res.items), compact: false }))),
    h('a', { class: 'btn sm', href: href('/reels', { sort: 'foryou', type: 'all' }), style: { marginTop: '6px' } }, icon('film', 'sm'), 'Play For you as Reels'));
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
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search creators, tags, communities…', 'aria-label': 'Search', enterkeyhint: 'search' });
  const go = () => navigate('/explore', { q: input.value.trim() });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  const hero = h('section', { class: 'hero' },
    h('h1', null, 'Discover male creators ', h('em', null, 'across the web')),
    h('p', { class: 'lead' }, 'One feed for photos and videos from creators on Reddit, RedGIFs, Bluesky, Mastodon, X and more — fresh, searchable, and organised around the people who make it.'),
    h('div', { class: 'hero-search' }, icon('search', 'lg'), input, h('button', { class: 'btn primary', onclick: go }, 'Search')),
    h('div', { class: 'hero-actions' },
      h('a', { class: 'btn', href: href('/reels') }, icon('film', 'sm'), 'Watch Reels'),
      h('button', { class: 'btn', onclick: surpriseMe }, icon('shuffle', 'sm'), 'Surprise me'),
      h('a', { class: 'btn ghost hide-mobile', href: href('/browse') }, icon('layers', 'sm'), 'Browse everything')),
    h('div', { class: 'hero-stats' },
      h('div', null, h('b', { class: 'num' }, fmt.num(s.total)), h('span', null, 'items')),
      h('div', null, h('b', { class: 'num' }, fmt.num(s.creators)), h('span', null, 'creators')),
      h('div', null, h('b', { class: 'num' }, fmt.num(s.videos)), h('span', null, 'videos')),
      h('div', null, h('b', { class: 'num' }, data.platforms.length), h('span', null, 'sources'))),
    data.tags.length && !(!tastes.ready() && !prefs.introDone) ? h('div', { class: 'hero-chips' }, data.tags.slice(0, 10).map((t) => h('a', { class: 'chip', href: href('/explore', { tag: t.name }) }, `#${t.name}`, h('span', { class: 'n' }, fmt.num(t.count))))) : null);

  if (!s.total) {
    root.replaceChildren(hero, emptyState({
      icon: 'sparkle', title: 'Your library is empty',
      text: 'Open the admin console to add creators and communities, then run a first sync. Content appears here as soon as it’s ingested.',
      actions: [h('a', { class: 'btn primary', href: href('/admin/sources') }, 'Open admin'), h('a', { class: 'btn', href: href('/creators') }, 'Browse creators')],
    }));
    return () => {};
  }

  // Newest posts from creators this device follows (the server never learns who you follow beyond this request).
  let fromFollowed = [];
  const followIds = follows.list().map((c) => c.id).slice(0, 100);
  if (followIds.length) {
    try { fromFollowed = (await get('/api/media', { creators: followIds.join(','), sort: 'recent', limit: 14 })).items; } catch { /* rail is optional */ }
  }

  const parts = [hero];
  const open = (list) => (item) => openLightbox(list, Math.max(0, list.findIndex((x) => x.id === item.id)));
  const picker = interestPicker(data.tags, async () => { const sec = await forYouSection(open); if (picker.isConnected) { if (sec) picker.replaceWith(sec); else picker.remove(); } });
  if (picker) parts.push(picker);
  const forYou = await forYouSection(open);
  if (forYou) parts.push(forYou);
  const smart = smartFeeds();
  if (smart) parts.push(smart);

  if (fromFollowed.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('heart', 'From creators you follow', 'Latest from the people you follow on this device', { href: href('/explore', { following: '1' }), label: 'See all' }), rail(fromFollowed, { open: open(fromFollowed) })));
  }
  if (data.trending.length) {
    parts.push(h('section', { class: 'section' }, sectionHead('flame', 'Trending now', 'What people are watching and saving', { href: href('/explore', { sort: 'trending' }), label: 'See all' }), rail(data.trending, { open: open(data.trending) })));
  }
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
  return () => feed && feed.destroy();
}
