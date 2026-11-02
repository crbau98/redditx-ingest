import { h, icon, proxied, fmt, avatar, toast } from '../dom.js';
import { platformLabel, platformColor, follows, bus } from '../store.js';
import { href } from '../router.js';

/** How fresh is he? "Today", "3d", "2mo" — and whether anything is from this year. */
function freshness(lastMediaAt) {
  if (!lastMediaAt) return null;
  const ms = Date.now() - new Date(lastMediaAt).getTime();
  if (!Number.isFinite(ms)) return null;
  const days = ms / 86400000;
  if (days < 1) return { label: 'Today', live: true };
  if (days < 7) return { label: `${Math.round(days)}d`, live: true };
  if (days < 35) return { label: `${Math.round(days / 7)}w`, live: false };
  if (days < 365) return { label: `${Math.round(days / 30)}mo`, live: false };
  return { label: fmt.ago(lastMediaAt), live: false };
}

/**
 * A creator card.
 *
 * mini is the small rail card, spotlight the large one on Home (bigger previews, a wider
 * name, the platforms he posts on, and how fresh his work is).
 */
export function creatorCard(c, { mini = false, badge = null, spotlight = false } = {}) {
  const thumbs = (c.previews || []).slice(0, 3);
  while (thumbs.length < 3) thumbs.push(null);
  const isNew = follows.has(c.id) && c.last_media_at && follows.seen(c.id) && c.last_media_at > follows.seen(c.id);
  const fresh = freshness(c.last_media_at);

  const fansly = Array.isArray(c.paid) ? c.paid.find((l) => l && (l.service === 'Fansly' || /fansly\.com/i.test(l.url || ''))) : null;
  const jff = Array.isArray(c.paid) ? c.paid.find((l) => l && (l.service === 'JustFor.Fans' || /justfor\.fans/i.test(l.url || ''))) : null;

  const paidBadge = (!c.onlyfans && fansly)
    ? [fansly.free ? 'Fansly · Free' : 'Fansly', fansly.free ? 'Has a free Fansly page' : 'Has a Fansly page', `fansly${fansly.free ? ' free' : ''}`]
    : (!c.onlyfans && jff)
      ? [jff.free ? 'JFF · Free' : 'JFF', jff.free ? 'Has a free JustFor.Fans page' : 'Has a JustFor.Fans page', `jff${jff.free ? ' free' : ''}`]
      : null;

  const ofLabel = c.onlyfans ? (c.onlyfans.trial ? 'Free Trial' : c.onlyfans.promo ? 'OF Promo' : c.onlyfans.free ? 'Free OF' : 'OnlyFans') : null;
  const ofCtaBtn = c.onlyfans && (spotlight || !mini)
    ? h('a', {
        class: `btn sm of-cta${c.onlyfans.free ? ' free' : c.onlyfans.trial ? ' trial' : c.onlyfans.promo ? ' promo' : ''}`,
        href: c.onlyfans.url,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        title: `Open onlyfans.com/${c.onlyfans.handle}`,
        onclick: (e) => e.stopPropagation(),
      }, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), ofLabel, icon('external', 'sm'))
    : null;

  const fanslyCtaBtn = !c.onlyfans && fansly && (spotlight || !mini)
    ? h('a', {
        class: `btn sm fansly-cta${fansly.free ? ' free' : ''}`,
        href: fansly.url,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        title: `Open Fansly (${fansly.handle || 'profile'})`,
        onclick: (e) => e.stopPropagation(),
      }, h('span', { class: 'paid-dot', 'aria-hidden': 'true' }), fansly.free ? 'Fansly Free' : 'Fansly', icon('external', 'sm'))
    : null;

  const jffCtaBtn = !c.onlyfans && !fansly && jff && (spotlight || !mini)
    ? h('a', {
        class: `btn sm jff-cta${jff.free ? ' free' : ''}`,
        href: jff.url,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        title: `Open JustFor.Fans (${jff.handle || 'profile'})`,
        onclick: (e) => e.stopPropagation(),
      }, h('span', { class: 'paid-dot', 'aria-hidden': 'true' }), jff.free ? 'JFF Free' : 'JFF', icon('external', 'sm'))
    : null;

  const followBtn = h('button', {
    type: 'button',
    class: `btn sm${follows.has(c.id) ? ' on' : ''}`,
    'aria-pressed': String(follows.has(c.id)),
    'aria-label': `${follows.has(c.id) ? 'Unfollow' : 'Follow'} ${c.display_name || c.handle}`,
    onclick: (e) => {
      e.preventDefault(); e.stopPropagation();
      const on = follows.toggle(c);
      followBtn.className = `btn sm${on ? ' on' : ''}`;
      followBtn.setAttribute('aria-pressed', String(on));
      followBtn.textContent = on ? 'Following' : 'Follow';
      toast(on ? `Following ${c.display_name || c.handle}` : 'Unfollowed');
    },
  }, follows.has(c.id) ? 'Following' : 'Follow');

  const freshMark = fresh && spotlight
    ? h('span', { class: `fresh-mark${fresh.live ? ' live' : ''}`, title: `Last post ${fmt.ago(c.last_media_at)}` },
      h('i', { 'aria-hidden': 'true' }), fresh.label)
    : null;

  const totalPosts = c.media_count || 0;
  const videoCount = c.video_count || 0;
  const photoCount = Math.max(0, totalPosts - videoCount);

  return h('a', {
    class: `creator-card${mini ? ' mini' : ''}${spotlight ? ' spotlight' : ''}`,
    href: href(`/creator/${c.id}`),
    'aria-label': c.display_name || c.handle,
    style: badge ? { position: 'relative' } : null,
  },
  badge ? h('span', { class: 'rise' }, icon('trend', 'sm'), badge) : null,
  h('div', { class: 'creator-thumbs' },
    thumbs.map((t) => h('div', { style: t ? { backgroundImage: `url("${proxied(t)}")` } : {} })),
    freshMark),
  h('div', { class: 'creator-body' },
    h('div', { class: 'creator-head' },
      avatar(c, spotlight ? 64 : 56),
      h('div', { class: 'creator-meta' },
        h('div', { class: 'creator-name' }, c.display_name || c.handle, c.verified ? icon('verified', 'fill') : null, isNew ? h('span', { class: 'badge good' }, 'New') : null,
          c.onlyfans ? h('span', { class: `badge of${c.onlyfans.free ? ' free' : c.onlyfans.trial ? ' trial' : c.onlyfans.promo ? ' promo' : ''}`, title: `OnlyFans · @${c.onlyfans.handle}` }, h('span', { class: 'of-mark', 'aria-hidden': 'true' }), c.onlyfans.trial ? 'OF · Trial' : c.onlyfans.promo ? 'OF · Promo' : c.onlyfans.free ? 'OF · Free' : 'OF') : null,
          paidBadge ? h('span', { class: `badge ${paidBadge[2]}`, title: paidBadge[1] }, paidBadge[0]) : null),
        h('div', { class: 'creator-handle' }, `@${c.handle}`)),
      h('div', { class: 'creator-actions' }, ofCtaBtn || fanslyCtaBtn || jffCtaBtn, followBtn)),
    h('div', { class: 'creator-stats' },
      h('span', { class: 'stat-item', title: `${fmt.int(totalPosts)} total posts` }, h('b', null, fmt.num(totalPosts)), ' posts'),
      videoCount > 0 ? h('span', { class: 'stat-item stat-videos', title: `${fmt.int(videoCount)} videos` }, icon('video', 'sm'), ' ', h('b', null, fmt.num(videoCount))) : null,
      photoCount > 0 ? h('span', { class: 'stat-item stat-photos', title: `${fmt.int(photoCount)} photos` }, icon('image', 'sm'), ' ', h('b', null, fmt.num(photoCount))) : null,
      fresh && !spotlight ? h('span', { class: `creator-fresh${fresh.live ? ' live' : ''}`, title: `Last post ${fmt.ago(c.last_media_at)}` }, fresh.label)
        : (c.last_media_at ? h('span', { class: 'creator-last-post' }, fmt.ago(c.last_media_at)) : null)),
    !mini && c.platforms && c.platforms.length ? h('div', { class: 'row wrap', style: { gap: '6px' } }, c.platforms.slice(0, spotlight ? 5 : 4).map((p) => h('span', { class: 'badge plat', style: { '--c': platformColor(p) } }, platformLabel(p)))) : null));
}
