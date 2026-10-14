'use strict';
/**
 * YouTube adapter (official RSS only, no API key, no scraping for media).
 *
 *   user     target "channel_id" (UC...) or "@handle" or full channel URL
 *   channel  target "channel_id" (same as user: a channel's uploads)
 *
 * YouTube has a documented public feed per channel:
 *   https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>
 * When the target is an @handle or channel URL, the channel_id is resolved
 * once from the public channel page (og:url / channelId) and then RSS is used.
 * Media files themselves are never proxied or downloaded: each video becomes
 * an item whose thumbnail is the media and whose permalink is the watch page,
 * opened via the official embed / watch URL. No YouTube search feeds: search
 * results are too mixed for an untrusted auto-follow source.
 */
const rss = require('./rss');
const http = require('./http').forPlatform('youtube', 600);
const { toIso, clip } = require('./util');

const FEED = (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{10,40}$/;
const HANDLE = /^@[A-Za-z0-9._-]{2,60}$/;

function videoIdFromLink(link) {
  try {
    const u = new URL(link);
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/);
    if (m) return m[1];
  } catch { /* ignore */ }
  return null;
}

function thumbFor(id, entry) {
  const m = (entry.media || []).find((x) => x.url && /ytimg\.com/i.test(x.url));
  if (m) return m.url;
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/** Resolve "@handle" or channel URL to a UC channel_id via the public page (once per fetch, best-effort). */
async function resolveChannelId(target) {
  const t = String(target || '').trim();
  if (CHANNEL_ID.test(t)) return t;
  const m = t.match(/(UC[A-Za-z0-9_-]{10,40})/);
  if (m) return m[1];
  let pageUrl = null;
  if (HANDLE.test(t)) pageUrl = `https://www.youtube.com/${t}`;
  else if (/^https?:\/\//i.test(t)) pageUrl = t;
  else if (/^[A-Za-z0-9._-]{2,60}$/.test(t)) pageUrl = `https://www.youtube.com/@${t.replace(/^@/, '')}`;
  if (!pageUrl) throw Object.assign(new Error(`YouTube: paste the channel_id (UC...), @handle, or channel URL`), { status: 422 });
  const res = await http.raw(pageUrl, { headers: { accept: 'text/html' }, maxBytes: 1_500_000 });
  const html = String(res.body || res.text || '');
  const found = html.match(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{10,40})"/) || html.match(/channel_id=(UC[A-Za-z0-9_-]{10,40})/) || html.match(/<link[^>]+rel=["']canonical["'][^>]+youtube\.com\/channel\/(UC[A-Za-z0-9_-]{10,40})/i);
  if (!found) throw Object.assign(new Error(`YouTube: could not resolve ${t} to a channel (paste the UC... channel_id or the channel RSS URL instead)`), { status: 422 });
  return found[1];
}

function entryToItem(entry, feedTitle) {
  const link = entry.link || null;
  const vid = link ? videoIdFromLink(link) : null;
  const thumb = thumbFor(vid, entry);
  if (!vid || !thumb) return null;
  return {
    sourceId: vid,
    position: 0,
    title: clip(entry.title || entry.text || feedTitle || 'YouTube video', 200),
    text: entry.text || '',
    author: entry.author || feedTitle || null,
    community: null,
    score: 0,
    postedAt: entry.published || null,
    permalink: link,
    mediaType: 'image',
    mediaUrl: thumb,
    previewUrl: thumb,
    width: 480,
    height: 360,
    altText: null,
    tags: entry.categories || [],
    links: entry.links || [],
    probe: false,
    trusted: false,
  };
}

module.exports = {
  platform: 'youtube',
  label: 'YouTube',
  color: '#ff0033',
  kinds: ['user', 'channel'],
  intervalMin: { user: 240, channel: 240 },
  isConfigured: () => ({ ok: true }),
  resolveChannelId,
  videoIdFromLink,
  async fetch(feed, ctx) {
    const channelId = await resolveChannelId(feed.target);
    const got = await rss.load(FEED(channelId));
    const parsed = rss.parseFeed(got.text, got.url);
    const items = [];
    let newest = (ctx.cursor || {}).newestAt || null;
    for (const entry of parsed.entries.slice(0, ctx.limit || 30)) {
      if (entry.published && newest && entry.published <= (ctx.cursor || {}).newestAt && !ctx.force) continue;
      if (entry.published && (!newest || entry.published > newest)) newest = entry.published;
      const it = entryToItem(entry, parsed.title);
      if (it) items.push(it);
    }
    return {
      items,
      cursor: newest ? { newestAt: newest, channelId } : undefined,
      profile: { displayName: parsed.title, avatarUrl: parsed.image || null, bio: parsed.description || null, handle: channelId },
      via: 'youtube-rss',
    };
  },
};
