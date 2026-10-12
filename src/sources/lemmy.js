'use strict';
/**
 * Lemmy adapter (public API; tries /api/v3 then /api/v4 so it survives the
 * 1.0 API bump).
 *
 *   community  target "name@instance.tld"
 *   user       target "name@instance.tld"
 */
const http = require('./http').forPlatform('lemmy', 700);
const { toIso, clip } = require('./util');
const { looksLikeDirectMedia, looksLikeVideo } = require('../lib/mediaurl');

function hostFromActor(id) { try { return new URL(id).hostname; } catch { return null; } }

function parsePostView(pv) {
  const post = pv && pv.post;
  if (!post || post.removed || post.deleted) return [];
  const url = post.url || '';
  const mime = String(post.url_content_type || '');
  let type = null;
  if (/^image\//i.test(mime) || (looksLikeDirectMedia(url) && !looksLikeVideo(url))) type = 'image';
  if (/^video\//i.test(mime) || looksLikeVideo(url)) type = 'video';
  if (!type && post.embed_video_url) type = 'video';
  const mediaUrl = type === 'video' && post.embed_video_url && !looksLikeVideo(url) ? post.embed_video_url : url;
  if (!type || !/^https?:/i.test(mediaUrl || '')) return [];
  const author = pv.creator && `${pv.creator.name}@${hostFromActor(pv.creator.actor_id) || ''}`.replace(/@$/, '');
  return [{
    sourceId: String(post.ap_id || post.id),
    position: 0,
    title: clip(post.name || '', 300),
    text: clip(post.body || '', 400),
    author,
    authorName: pv.creator && pv.creator.display_name,
    authorAvatar: pv.creator && pv.creator.avatar,
    community: pv.community && `${pv.community.name}@${hostFromActor(pv.community.actor_id) || ''}`.replace(/@$/, ''),
    score: (pv.counts && pv.counts.score) || 0,
    postedAt: toIso(post.published),
    permalink: post.ap_id,
    mediaType: type,
    mediaUrl,
    previewUrl: post.thumbnail_url || (type === 'image' ? mediaUrl : null),
    nsfw: post.nsfw || (pv.community && pv.community.nsfw) ? 'explicit' : 'suggestive',
    trusted: true,
  }];
}

async function call(host, path) {
  try {
    return await http.json(`https://${host}/api/v3${path}`);
  } catch (e) {
    if (e.status === 404 || e.status === 400) return http.json(`https://${host}/api/v4${path}`);
    throw e;
  }
}

module.exports = {
  platform: 'lemmy',
  label: 'Lemmy',
  color: '#00bc8c',
  kinds: ['community', 'user'],
  intervalMin: { community: 120, user: 240 },
  parsePostView,
  isConfigured: () => ({ ok: true }),

  async fetch(feed, ctx) {
    const [name, host] = String(feed.target).split('@');
    if (!name || !host) throw new Error('Lemmy target must look like name@instance.tld');
    const cursor = ctx.cursor || {};
    const items = [];
    let newest = cursor.newestAt || null;
    const maxPages = cursor.newestAt ? 1 : 3;
    for (let page = 1; page <= maxPages; page++) {
      if (ctx.aborted()) break;
      const path = feed.kind === 'user'
        ? `/user?username=${encodeURIComponent(`${name}@${host}`)}&sort=New&limit=50&page=${page}`
        : `/post/list?community_name=${encodeURIComponent(name)}&sort=New&limit=50&page=${page}&type_=All&show_nsfw=true`;
      const json = await call(host, path);
      const posts = json.posts || [];
      if (!posts.length) break;
      let reachedKnown = false;
      for (const pv of posts) {
        for (const it of parsePostView(pv)) {
          if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
          if (cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
          items.push(it);
        }
      }
      if (reachedKnown) break;
    }
    return { items, cursor: newest ? { newestAt: newest } : undefined, via: 'api' };
  },
};
