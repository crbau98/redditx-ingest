import { h, icon, proxied, fmt, avatar, toast } from '../dom.js';
import { lazyBackground } from '../lazy-bg.js';
import { platformLabel, platformColor, follows, bus } from '../store.js';
import { href } from '../router.js';
import { postedWords } from './creator-words.js';

/**
 * A creator card.
 *
 * Three variants share one markup: the default card (grids), `mini` (rails, 220px) and `spotlight` (Home's
 * "Top OnlyFans creators", larger samples and name). Every card says when he last posted, in words, and dims its
 * pictures when he has been quiet for a long time. Quiet creators stay visible.
 *
 * reason is one short line of why he is on this rail (for example "Most posts here"). It is only shown when the
 * caller has a true reason to give; the card never invents one.
 */
export function creatorCard(c, { mini = false, badge = null, spotlight = false, reason = null } = {}) {
  const thumbs = (c.previews || []).slice(0, 3);
  while (thumbs.length < 3) thumbs.push(null);
  const isNew = follows.has(c.id) && c.last_media_at && follows.seen(c.id) && c.last_media_at > follows.seen(c.id);
  const when = postedWords(c.last_media_at);

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

  const totalPosts = c.media_count || 0;
  const videoCount = c.video_count || 0;
  const photoCount = Math.max(0, totalPosts - videoCount);
  const platformCap = spotlight ? 5 : mini ? 3 : 4;

  const whenEl = when
    ? h('span', { class: `creator-when${when.live ? ' live' : ''}${when.quiet ? ' quiet' : ''}`, title: `Last post ${fmt.ago(c.last_media_at)}` }, when.text)
    : null;

  return h('a', {
    class: `creator-card${mini ? ' mini' : ''}${spotlight ? ' spotlight' : ''}${when && when.quiet ? ' is-quiet' : ''}`,
    href: href(`/creator/${c.id}`),
    'aria-label': c.display_name || c.handle,
    style: badge ? { position: 'relative' } : null,
  },
  badge ? h('span', { class: 'rise' }, icon('trend', 'sm'), badge) : null,
  // Three sample pictures, decorative: the card's link already names him. Each loads only when near the screen (lazy-bg.js).
  h('div', { class: 'creator-thumbs', 'aria-hidden': 'true' },
    thumbs.map((t) => lazyBackground(h('div'), t ? proxied(t) : null))),
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
      whenEl),
    reason || (c.platforms && c.platforms.length)
      ? h('div', { class: 'creator-foot' },
        reason ? h('span', { class: 'reason-chip' }, reason) : null,
        c.platforms && c.platforms.length
          ? h('div', { class: 'creator-plats', 'aria-label': `Posts on ${c.platforms.map(platformLabel).join(', ')}` },
            c.platforms.slice(0, platformCap).map((p) => h('span', { class: 'badge plat', style: { '--c': platformColor(p) } }, platformLabel(p))))
          : null)
      : null));
}
