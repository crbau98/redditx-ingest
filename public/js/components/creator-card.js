import { h, icon, proxied, fmt, avatar } from '../dom.js';
import { platformLabel, platformColor, follows } from '../store.js';
import { href } from '../router.js';

export function creatorCard(c, { mini = false, badge = null } = {}) {
  const thumbs = (c.previews || []).slice(0, 3);
  while (thumbs.length < 3) thumbs.push(null);
  const isNew = follows.has(c.id) && c.last_media_at && follows.seen(c.id) && c.last_media_at > follows.seen(c.id);
  return h('a', { class: `creator-card${mini ? ' mini' : ''}`, href: href(`/creator/${c.id}`), 'aria-label': c.display_name || c.handle, style: badge ? { position: 'relative' } : null },
    badge ? h('span', { class: 'rise' }, icon('trend', 'sm'), badge) : null,
    h('div', { class: 'creator-thumbs' }, thumbs.map((t) => h('div', { style: t ? { backgroundImage: `url("${proxied(t)}")` } : {} }))),
    h('div', { class: 'creator-body' },
      avatar(c, 56),
      h('div', null,
        h('div', { class: 'creator-name' }, c.display_name || c.handle, c.verified ? icon('verified', 'fill') : null, isNew ? h('span', { class: 'badge good' }, 'New') : null,
          c.onlyfans ? h('span', { class: `badge of${c.onlyfans.free ? ' free' : ''}`, title: c.onlyfans.free ? 'Has a free OnlyFans page' : 'Has an OnlyFans page' }, c.onlyfans.free ? 'OF · Free' : 'OF') : null),
        h('div', { class: 'creator-handle' }, `@${c.handle}`)),
      h('div', { class: 'creator-stats' },
        h('span', null, h('b', null, fmt.num(c.media_count)), ' posts'),
        c.video_count ? h('span', null, h('b', null, fmt.num(c.video_count)), ' videos') : null,
        c.last_media_at ? h('span', null, fmt.ago(c.last_media_at)) : null),
      !mini && c.platforms && c.platforms.length ? h('div', { class: 'row wrap', style: { gap: '6px' } }, c.platforms.slice(0, 4).map((p) => h('span', { class: 'badge plat', style: { '--c': platformColor(p) } }, platformLabel(p)))) : null));
}
