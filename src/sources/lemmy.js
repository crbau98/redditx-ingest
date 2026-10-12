'use strict';
/**
 * Lemmy adapter (public API; tries /api/v3 then /api/v4 so it survives the
 * 1.0 API bump).
 *
 *   community  target "name@instance.tld"
 *   user       target "name@instance.tld"
 */
const http = require('./http').forPlatform('lemmy', 700);
const { toIso, clip, absUrl, originOf, errorDetail } = require('./util');
const { looksLikeDirectMedia, looksLikeVideo } = require('../lib/mediaurl');

// A link post to a RedGIFs page: the pipeline resolves it to the real mp4 (see pipeline.js step 1).
const REDGIFS_PAGE = /^https?:\/\/(?:www\.)?redgifs\.com\/(?:watch|ifr)\//i;

function hostFromActor(id) { try { return new URL(id).hostname; } catch { return null; } }

/**
 * One Lemmy PostView -> items. Handles both API shapes: v3 (counts.score, published) and v4/1.0
 * (score and published_at live on the post itself). `host` (optional) absolutises relative pict-rs URLs.
 */
function parsePostView(pv, host) {
  const post = pv && pv.post;
  if (!post || post.removed || post.deleted) return [];
  const base = host ? originOf(host) : undefined;
  const url = (base ? absUrl(post.url, base) : post.url) || '';
  const mime = String(post.url_content_type || '');
  let type = null;
  if (/^image\//i.test(mime) || (looksLikeDirectMedia(url) && !looksLikeVideo(url))) type = 'image';
  if (/^video\//i.test(mime) || looksLikeVideo(url)) type = 'video';
  const redgifs = REDGIFS_PAGE.test(url);
  if (redgifs) type = 'video';
  if (!type && post.embed_video_url) type = 'video';
  // Prefer the RedGIFs page itself (the pipeline resolves it); otherwise a direct file; otherwise the page's og:video.
  const mediaUrl = redgifs ? url : type === 'video' && post.embed_video_url && !looksLikeVideo(url) ? post.embed_video_url : url;
  if (!type || !/^https?:/i.test(mediaUrl || '')) return [];
  const thumb = base ? absUrl(post.thumbnail_url, base) : post.thumbnail_url;
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
    score: (pv.counts && pv.counts.score) || post.score || 0,
    postedAt: toIso(post.published || post.published_at),
    permalink: post.ap_id,
    mediaType: type,
    mediaUrl,
    previewUrl: thumb || (type === 'image' ? mediaUrl : null),
    nsfw: post.nsfw || (pv.community && pv.community.nsfw) ? 'explicit' : 'suggestive',
    trusted: true,
  }];
}

/** Which API generation each host answered last time ('v3' | 'v4'), so a v4-only server isn't probed with v3 every page. */
const apiVersion = new Map();

/** HttpError -> Error whose message names Lemmy's own error code (e.g. couldnt_find_community) instead of just a URL. */
function lemmyError(e, host) {
  if (!e || !e.status) return e;
  const detail = errorDetail(e);
  const err = new Error(`Lemmy ${host}: HTTP ${e.status}${detail ? ` ${detail}` : ''}`);
  // Lemmy 0.19 answers an unknown/removed community or user with HTTP 400 couldnt_find_*; report it as gone so the engine can disable the feed.
  err.status = /couldnt_find_(community|person)|not_found/i.test(detail) ? 404 : e.status; err.retryAfter = e.retryAfter; err.body = e.body;
  return err;
}

/** GET an API path on a host: v3 first (all 0.x servers), v4 when v3 is gone (Lemmy 1.0 dropped it). */
async function call(host, path, path4 = path) {
  const order = apiVersion.get(host) === 'v4' ? ['v4', 'v3'] : ['v3', 'v4'];
  let first = null;
  for (const v of order) {
    try {
      const json = await http.json(`${originOf(host)}/api/${v}${v === 'v4' ? path4 : path}`);
      apiVersion.set(host, v);
      return { json, ver: v };
    } catch (e) {
      if (!first) first = e;
      // 404/400/405: this generation isn't served here (or the target isn't on it): try the other one.
      if (![400, 404, 405, 410].includes(e.status)) throw lemmyError(e, host);
    }
  }
  throw lemmyError(first, host);
}

/** The busiest NSFW communities on an instance (discovery). */
async function listCommunities(host, limit = 50) {
  const { json } = await call(host, `/community/list?type_=All&sort=TopMonth&show_nsfw=true&limit=${limit}`);
  return (json.communities || []).map((x) => {
    const c = x.community || {}; let h = host;
    try { h = new URL(c.actor_id).hostname; } catch { /* keep the instance */ }
    return { name: c.name, host: h, title: c.title || null, description: c.description ? String(c.description).slice(0, 400) : null, nsfw: !!c.nsfw, subscribers: (x.counts && x.counts.subscribers) || c.subscribers || 0 };
  }).filter((c) => c.name);
}

module.exports = {
  listCommunities,
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
    let next = null; // v4 paging token (page_cursor)
    let userId = null; // v4 person id
    for (let page = 1; page <= maxPages; page++) {
      if (ctx.aborted()) break;
      const cur = (ver) => (ver === 'v4' ? (next ? `&page_cursor=${encodeURIComponent(next)}` : '') : `&page=${page}`);
      let res;
      if (feed.kind === 'user') {
        const qn = encodeURIComponent(`${name}@${host}`);
        // v3: GET /user?username=; v4 renamed it (GET /person/content, keyed by person id when the username form is refused).
        const v3 = `/user?username=${qn}&sort=New&limit=50`;
        const v4 = (id) => `/person/content?${id ? `person_id=${id}` : `username=${qn}`}&type_=Posts&limit=50`;
        const ver = apiVersion.get(host) === 'v4' ? 'v4' : 'v3';
        res = await call(host, `${v3}${cur('v3')}`, `${v4(userId)}${cur('v4')}`).catch(async (e) => {
          if (ver === 'v3' && !userId && (e.status === 400 || e.status === 404)) {
            const who = await http.json(`${originOf(host)}/api/v4/person?username=${qn}`).catch(() => null);
            userId = who && ((who.person_view && who.person_view.person && who.person_view.person.id) || (who.person && who.person.id)) || null;
            if (userId) { apiVersion.set(host, 'v4'); return call(host, `${v3}${cur('v3')}`, `${v4(userId)}${cur('v4')}`); }
          }
          throw e;
        });
      } else {
        // v3 pages with ?page=N; v4 with ?page_cursor= taken from the previous response's next_page.
        res = await call(host, `/post/list?community_name=${encodeURIComponent(name)}&sort=New&limit=50&type_=All&show_nsfw=true${cur('v3')}`,
          `/post/list?community_name=${encodeURIComponent(name)}&sort=New&limit=50&type_=All&show_nsfw=true${cur('v4')}`);
      }
      const json = res.json;
      // v3: {posts: [PostView]}; v4: {posts: [...], next_page} or, for a person, {content: [{type_:'Post', ...}]}.
      const posts = (json.posts || json.content || json.items || []).filter((x) => x && (x.post || x.post_view)).map((x) => x.post_view || x);
      next = json.next_page || null;
      if (!posts.length) break;
      let reachedKnown = false;
      for (const pv of posts) {
        for (const it of parsePostView(pv, host)) {
          if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
          if (cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
          items.push(it);
        }
      }
      if (reachedKnown) break;
      if (res.ver === 'v4' && !next) break; // no further page
    }
    return { items, cursor: newest ? { newestAt: newest } : undefined, via: 'api' };
  },
};
