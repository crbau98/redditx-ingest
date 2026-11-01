import { h, icon, proxied, fmt, avatar, toast } from '../dom.js';
import { platformLabel, platformColor, follows, bus } from '../store.js';
import { href } from '../router.js';

export function creatorCard(c, { mini = false, badge = null } = {}) {
  const thumbs = (c.previews || []).slice(0, 3);
  while (thumbs.length < 3) thumbs.push(null);
  const isNew = follows.has(c.id) && c.last_media_at && follows.seen(c.id) && c.last_media_at > follows.seen(c.id);
  // Cards name the paid page when there is no OnlyFans badge to carry it.
  const fansly = !c.onlyfans && Array.isArray(c.paid) ? c.paid.find((l) => l && (l.service === 'Fansly' || /fansly\.com/i.test(l.url || ''))) : null;
  const jff = !c.onlyfans && !fansly && Array.isArray(c.paid) ? c.paid.find((l) => l && (l.service === 'JustFor.Fans' || /justfor\.fans/i.test(l.url || ''))) : null;
  const paidBadge = fansly
    ? [fansly.free ? 'Fansly · Free' : 'Fansly', fansly.free ? 'Has a free Fansly page' : 'Has a Fansly page', `fansly${fansly.free ? ' free' : ''}`]
    : jff
      ? [jff.free ? 'JFF · Free' : 'JFF', jff.free ? 'Has a free JustFor.Fans page' : 'Has a JustFor.Fans page', `jff${jff.free ? ' free' : ''}`]
      : null;
  const followBtn = h('button', {
    type: 'button',
    class: `btn sm${follows.has(c.id) ? ' on' : ''}`,
    style: { marginLeft: 'auto', flexShrink: '0' },
    'aria-pressed': String(follows.has(c.id)),
    onclick: (e) => {
      e.preventDefault(); e.stopPropagation();
      const on = follows.toggle(c);
      followBtn.className = `btn sm${on ? ' on' : ''}`;
      followBtn.setAttribute('aria-pressed', String(on));
      followBtn.textContent = on ? 'Following' : 'Follow';
      toast(on ? `Following ${c.display_name || c.handle}` : 'Unfollowed');
    },
  }, follows.has(c.id) ? 'Following' : 'Follow');
  return h('a', { class: `creator-card${mini ? ' mini' : ''}`, href: href(`/creator/${c.id}`), 'aria-label': c.display_name || c.handle, style: badge ? { position: 'relative' } : null },
    badge ? h('span', { class: 'rise' }, icon('trend', 'sm'), badge) : null,
    h('div', { class: 'creator-thumbs' }, thumbs.map((t) => h('div', { style: t ? { backgroundImage: `url("${proxied(t)}")` } : {} }))),
    h('div', { class: 'creator-body' },
      avatar(c, 56),
      h('div', { style: { minWidth: '0', flex: '1' } },
        h('div', { class: 'creator-name' }, c.display_name || c.handle, c.verified ? icon('verified', 'fill') : null, isNew ? h('span', { class: 'badge good' }, 'New') : null,
          c.onlyfans ? h('span', { class: `badge of${c.onlyfans.free ? ' free' : ''}`, title: c.onlyfans.free ? 'Has a free OnlyFans page' : 'Has an OnlyFans page' }, c.onlyfans.free ? 'OF · Free' : 'OF') : null,
          paidBadge ? h('span', { class: `badge ${paidBadge[2]}`, title: paidBadge[1] }, paidBadge[0]) : null),
        h('div', { class: 'creator-handle' }, `@${c.handle}`)),
      followBtn,
      h('div', { class: 'creator-stats' },
        h('span', null, h('b', null, fmt.num(c.media_count)), ' posts'),
        c.video_count ? h('span', null, h('b', null, fmt.num(c.video_count)), ' videos') : null,
        c.last_media_at ? h('span', null, fmt.ago(c.last_media_at)) : null),
      !mini && c.platforms && c.platforms.length ? h('div', { class: 'row wrap', style: { gap: '6px' } }, c.platforms.slice(0, 4).map((p) => h('span', { class: 'badge plat', style: { '--c': platformColor(p) } }, platformLabel(p)))) : null));
}
