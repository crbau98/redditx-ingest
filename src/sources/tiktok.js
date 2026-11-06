'use strict';
/**
 * TikTok adapter (public embed, no login, no key).
 *
 *   user   @handle, handle, or https://www.tiktok.com/@handle
 *
 * TikTok's profile page is behind a captcha/login wall, but the profile's public EMBED is not: the page TikTok serves to
 * third-party sites renders the creator's latest videos server-side, including the direct play address of each one.
 *
 *   https://www.tiktok.com/embed/@<handle>   ->  <script id="__FRONTITY_CONNECT_STATE__" type="application/json">…
 *
 * That state holds `videoList` (10 newest videos, newest first) with `id`, `desc`, `playAddr` (a real mp4 on
 * tiktokcdn), `coverUrl`, `playCount`, plus the creator's `nickname`, `signature`, avatar and follower count. Measured on
 * 2026-11-06: a 4.5 MB video/mp4 answered a range request from playAddr, no cookie, no referer.
 *
 * Ten videos is the whole embed (the `page` parameter is ignored), which is plenty for a feed that keeps polling: new
 * posts appear at the top, and older ones are already in the library.
 */
const http = require('./http').forPlatform('tiktok', 3500, { penalty: { ms: 120000, repeatMs: 600000, repeatWindowMs: 3600000 } });
const { clip } = require('./util');
const { BROWSER_UA } = require('../lib/challenge');

const EMBED = (handle) => `https://www.tiktok.com/embed/@${encodeURIComponent(handle)}`;
const HANDLE = /^[A-Za-z0-9._]{2,40}$/;

function handleOf(target) {
  const t = String(target || '').trim();
  const m = t.match(/tiktok\.com\/@([A-Za-z0-9._]{2,40})/i) || t.match(/^@?([A-Za-z0-9._]{2,40})$/);
  if (!m) throw Object.assign(new Error('TikTok: paste @handle or https://www.tiktok.com/@handle'), { status: 422 });
  if (!HANDLE.test(m[1])) throw Object.assign(new Error(`TikTok: "${m[1]}" is not a handle`), { status: 422 });
  return m[1];
}

/** The connect state the embed ships, or null when TikTok answered something else. */
function connectState(html) {
  const m = String(html).match(/<script id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** -> { user, videos } from the embed state (empty when the account has no public videos). */
function parseEmbed(state) {
  const data = (state && state.source && state.source.data) || {};
  for (const key of Object.keys(data)) {
    const entry = data[key];
    if (entry && typeof entry === 'object' && Array.isArray(entry.videoList)) {
      return { user: entry.userInfo || null, videos: entry.videoList.filter((v) => v && v.id && !v.privateItem) };
    }
  }
  return { user: null, videos: [] };
}

function videoToItem(v, handle, user) {
  const play = String(v.playAddr || '').trim();
  const cover = String(v.originCoverUrl || v.coverUrl || v.dynamicCoverUrl || '').trim() || null;
  if (!play && !cover) return null;
  return {
    sourceId: `tiktok-${v.id}`,
    position: 0,
    title: clip(v.desc || `TikTok video by @${handle}`, 200),
    text: v.desc || '',
    author: (user && user.nickname) || handle,
    community: null,
    score: Number(v.playCount) || 0,
    postedAt: null, // the embed carries no timestamp; newest-first order and sourceId dedupe cover it
    permalink: `https://www.tiktok.com/@${handle}/video/${v.id}`,
    mediaType: play ? 'video' : 'image',
    mediaUrl: play || cover,
    previewUrl: cover,
    thumbnailUrl: cover,
    width: Number(v.width) || null,
    height: Number(v.height) || null,
    nsfw: 'explicit',
    trusted: true, // TikTok's own CDN address from TikTok's own page
  };
}

module.exports = {
  platform: 'tiktok',
  label: 'TikTok',
  color: '#25f4ee',
  kinds: ['user'],
  intervalMin: { user: 240 },
  isConfigured: () => ({ ok: true }),
  handleOf,
  connectState,
  parseEmbed,
  videoToItem,
  async fetch(feed, ctx) {
    const handle = handleOf(feed.target);
    const res = await http.raw(EMBED(handle), {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      maxBytes: 2_000_000, retries: 1, timeout: 25000,
    });
    const html = String(res.body || '');
    const state = connectState(html);
    if (!state) {
      const why = /rate limit|ratelimit/i.test(html) ? 'rate limited' : /captcha|verify/i.test(html) ? 'captcha' : 'no embed state';
      throw Object.assign(new Error(`TikTok embed for @${handle} answered ${res.status} with ${why}`), { status: res.status === 200 ? 502 : res.status });
    }
    const { user, videos } = parseEmbed(state);
    const limit = Math.max(1, Number(ctx.limit) || 30);
    const items = videos.slice(0, limit).map((v) => videoToItem(v, handle, user)).filter(Boolean);
    return {
      items,
      cursor: items.length ? { newestId: items[0].sourceId } : undefined,
      profile: user ? {
        displayName: user.nickname || handle,
        handle: user.uniqueId || handle,
        bio: user.signature || null,
        avatarUrl: user.avatarThumbUrl || null,
        verified: !!user.verified,
        followers: Number(user.followerCount) || 0,
      } : { displayName: handle, handle },
      via: 'tiktok-embed',
    };
  },
};
