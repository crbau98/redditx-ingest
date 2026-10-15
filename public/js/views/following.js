import { h, icon, fmt, avatar, emptyState } from '../dom.js';
import { get, query as postQuery } from '../api.js';
import { navigate, href } from '../router.js';
import { follows, followVisits } from '../store.js';
import { createFeed } from '../components/feed.js';
import { creatorCard } from '../components/creator-card.js';

/*
 * Following: everything the creators you follow posted, newest first, split at the point you
 * were last here. Up to 500 follows travel in POST bodies (/api/follow/*), so the list is never
 * cut short the way a URL would cut it.
 */

const hashOf = (s) => { let x = 0; for (const ch of s) x = (Math.imul(x, 31) + ch.charCodeAt(0)) | 0; return (x >>> 0).toString(36); };

/** One avatar per creator, most to catch up on first; a ring and a count mark who posted since. */
function creatorRail(list) {
  return h('div', { class: 'follow-rail', role: 'list', 'aria-label': 'Creators you follow' }, list.map((c) => {
    const name = c.display_name || c.handle;
    return h('a', { class: `follow-chip${c.new_count ? ' has-new' : ''}`, role: 'listitem', href: href(`/creator/${c.id}`), title: name,
      'aria-label': c.new_count ? `${name}, ${c.new_count > 99 ? '99+' : c.new_count} new` : name },
    h('span', { class: 'follow-ring' }, avatar(c, 58)),
    c.new_count ? h('span', { class: 'follow-new' }, c.new_count > 99 ? '99+' : String(c.new_count)) : null,
    h('span', { class: 'follow-name' }, name));
  }));
}

/** Not following anyone yet: say what this page does and offer creators to start with. */
async function emptyFollowing(root) {
  const people = h('div', { class: 'rail' });
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Following'), h('div', { class: 'sub' }, 'Follow creators and everything they post collects here'))),
    emptyState({ icon: 'users', title: 'You’re not following anyone yet', text: 'Tap Follow on a creator’s profile, in the viewer or in Reels. Their new posts land here, newest first, with a badge when there’s something you haven’t seen.', actions: [h('a', { class: 'btn primary', href: href('/creators') }, 'Browse creators')] }),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('div', null, h('h2', null, icon('flame'), 'Popular creators'))), people));
  try {
    const r = await get('/api/creators', { sort: 'score', limit: 12 });
    people.replaceChildren(...r.items.map((c) => creatorCard(c, { mini: true })));
  } catch { people.remove(); }
  return () => {};
}

export async function following(root, { query }) {
  document.title = 'Following — PRISM';
  if (!follows.count()) return emptyFollowing(root);
  const type = ['image', 'video'].includes(query.get('type')) ? query.get('type') : '';
  const list = follows.list();
  const since = followVisits.open(); // also clears the badges: you are looking now
  // each creator's own cut-off (a creator page visited since counts as caught up on him)
  const body = list.map((c) => ({ id: c.id, since: followVisits.sinceFor(c) }));
  const key = hashOf(JSON.stringify(body));

  const sub = h('div', { class: 'sub' }, `${fmt.int(list.length)} creator${list.length === 1 ? '' : 's'}`);
  const typeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Media type' }, [['', 'All', 'grid'], ['image', 'Photos', 'image'], ['video', 'Videos', 'video']].map(([v, l, ic]) =>
    h('button', { class: type === v ? 'on' : '', 'aria-pressed': String(type === v), onclick: () => navigate('/following', { type: v }, { replace: true }) }, icon(ic, 'sm'), l)));
  const railHost = h('div', { class: 'follow-rail-host' }, h('div', { class: 'follow-rail' }, list.slice(0, 12).map(() => h('div', { class: 'follow-chip' }, h('span', { class: 'follow-ring' }, h('div', { class: 'skeleton', style: { width: '58px', height: '58px', borderRadius: '50%' } }))))));

  const page = (part) => (params) => postQuery('/api/follow/feed', { follows: body, part, type: type || undefined, page: params.page, limit: params.limit, nocount: params.nocount === '1' });
  const feeds = [];
  const parts = [];

  // With a previous visit: what arrived since, then a divider, then the rest. First visit: one feed.
  if (since) {
    const newHead = h('div', { class: 'section-head follow-since', hidden: true },
      h('div', null, h('h2', null, icon('sparkle'), 'New since you were last here'), h('div', { class: 'sub' }, `Your last visit was ${fmt.ago(since)}`)));
    const caughtUp = h('div', { class: 'follow-caught-up', role: 'status', hidden: true }, icon('check', 'sm'), `You’re all caught up. Nothing new since ${fmt.ago(since)}.`);
    const divider = h('div', { class: 'follow-divider', role: 'separator', hidden: true }, h('span', null, 'Earlier'));
    const fresh = createFeed({
      fetchPage: page('new'), query: { part: 'new', type, key }, pageSize: 24, empty: h('span'), quietEnd: true,
      onTotal: (t) => {
        newHead.hidden = !t; divider.hidden = !t; caughtUp.hidden = !!t;
        if (t) newHead.querySelector('.sub').textContent = `${fmt.int(t)} new post${t === 1 ? '' : 's'} · your last visit was ${fmt.ago(since)}`;
      },
    });
    feeds.push(fresh);
    parts.push(newHead, caughtUp, fresh.el, divider);
  }
  const rest = createFeed({
    fetchPage: page(since ? 'earlier' : 'all'), query: { part: since ? 'earlier' : 'all', type, key },
    empty: emptyState({ icon: 'clock', title: 'Nothing here yet', text: type ? 'No posts of this type from the creators you follow. Try All.' : 'The creators you follow have no posts in the library yet. New ones appear here as they are found.' }),
  });
  feeds.push(rest);
  parts.push(rest.el);

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Following'), sub, h('div', { class: 'sub' }, 'Their newest posts, on this device only — manage the people in Saved › Following.')),
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn sm', href: href('/reels', { following: '1', sort: 'recent', type: type || 'all' }), title: 'Play the newest posts full screen' }, icon('film', 'sm'), 'Play as Reels'),
        h('a', { class: 'btn sm ghost', href: href('/saved', { tab: 'following' }) }, icon('users', 'sm'), 'Manage'))),
    railHost,
    h('div', { class: 'filterbar follow-bar' }, typeSeg),
    ...parts);

  // the rail counts what is new since this visit's cut-off, the same line the feed splits at
  postQuery('/api/follow/summary', { follows: list.map((c) => ({ id: c.id, seen: followVisits.sinceFor(c) })) }).then((d) => {
    if (!root.isConnected) return;
    railHost.replaceChildren(creatorRail(d.creators));
    const fresh = d.creators.filter((c) => c.new_count).length;
    sub.textContent = `${fmt.int(d.creators.length)} creator${d.creators.length === 1 ? '' : 's'}${fresh ? ` · ${fresh} posted since your last visit` : ''}`;
  }).catch(() => railHost.replaceChildren());

  return () => { for (const f of feeds) f.destroy(); };
}
