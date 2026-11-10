/**
 * Jump-back rows for the command palette, built only from posts this device already opened.
 * History is newest-first ids; the caller passes the matching media rows in that same order.
 */

import { stillChain } from './images.js';

export const RECENT_JUMPS = 6;
/** Reopening the palette inside this window reuses the last history fetch. */
export const JUMP_CACHE_MS = 60 * 1000;

/** True when the cached jump-back rows are for this history key and still fresh. */
export function jumpCacheFresh(cache, key, now = Date.now()) {
  return !!(cache && cache.key && cache.key === key && now - cache.at < JUMP_CACHE_MS);
}

/** Put API rows back into the order of the ids that were asked for. */
export function orderByIds(items, ids) {
  const rank = new Map((ids || []).map((id, i) => [id, i]));
  return [...(items || [])].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}

/**
 * Up to six videos and six creators, walking history once.
 * `plays` is the resume list (`{id, t}`); a video that has one gets that second count as `leftOff`.
 */
export function recentJumps(items, plays = []) {
  const left = new Map((plays || []).filter((p) => p && p.id).map((p) => [p.id, p.t]));
  const videos = [];
  const creators = [];
  const seen = new Set();
  for (const m of items || []) {
    if (!m || !m.id) continue;
    if (m.media_type === 'video' && videos.length < RECENT_JUMPS) {
      const stills = stillChain(m);
      videos.push({
        id: m.id,
        title: m.title || 'Video',
        leftOff: left.has(m.id) ? left.get(m.id) : null,
        creator: m.creator_name || m.creator_handle || '',
        still: stills[0] || null,
        stillFall: stills[1] || null,
      });
    }
    if (m.creator_id && !seen.has(m.creator_id) && creators.length < RECENT_JUMPS) {
      seen.add(m.creator_id);
      creators.push({
        id: m.creator_id,
        display_name: m.creator_name || m.creator_handle || 'Creator',
        handle: m.creator_handle || '',
        avatar_url: m.creator_avatar || null,
      });
    }
  }
  return { videos, creators };
}
