'use strict';
/**
 * Tumblr adapter, built on Tumblr's stable public RSS feeds (no API key).
 *
 *   user  target "blogname" (or a custom domain)   one blog
 *   tag   target "tag@blog"     one blog's tag feed    (https://<blog>.tumblr.com/tagged/<tag>/rss)
 *         (site-wide tag feeds no longer exist: Tumblr returns 404 for https://www.tumblr.com/tagged/<tag>/rss)
 *
 * A blog is creator-owned (trusted); tag feeds are open searches (untrusted: every item has to read
 * male-focused). Reblogs carry somebody else's media: they are kept (setting "reposts", on by default) and credited to
 * the blog they were reblogged from, so a reblogging fan blog becomes a way in to the original creator.
 * Image URLs are upgraded to Tumblr's largest rendition.
 */
const config = require('../config');
const rss = require('./rss');
const { originOf, repostsOn } = require('./util');

const DEFAULT_BASE = 'https://www.tumblr.com';

/** Origin of a blog: `name` -> https://name.tumblr.com, a custom domain -> https://domain. */
function blogOrigin(blog) {
  const b = String(blog || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!b) throw new Error('Tumblr blog name is missing');
  if (config.baseUrls.tumblr !== DEFAULT_BASE) return originOf(b); // tests point blogs at a loopback mock ("127.0.0.1:port")
  return b.includes('.') ? `https://${b}` : `https://${b}.tumblr.com`;
}

const tagPath = (tag) => `/tagged/${encodeURIComponent(String(tag).trim().replace(/^#/, '')).replace(/%20/g, '+')}/rss`;

/** Feed URL for a feed row. */
function feedUrl(feed) {
  if (feed.kind === 'user') return `${blogOrigin(feed.target)}/rss`;
  const [tag, blog] = String(feed.target).split('@');
  if (!tag) throw new Error('Tumblr tag feed needs a tag');
  // Verified live: https://www.tumblr.com/tagged/<tag>/rss is gone (404); per-blog feeds and per-blog tag feeds still work.
  if (!blog) throw Object.assign(new Error('Tumblr no longer publishes site-wide tag feeds: follow blogs, or use tag@blogname (e.g. gay@someblog)'), { skip: true });
  return `${blogOrigin(blog)}${tagPath(tag)}`;
}

/**
 * Tumblr serves the same image at several sizes:
 *   .../<hash>_500.jpg                       -> _1280
 *   64.media.tumblr.com/.../s500x750/<h>.jpg -> s1280x1920 (Tumblr clamps to the original size)
 */
function upgradeImage(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)tumblr\.com$/i.test(u.hostname)) return url;
    u.pathname = u.pathname
      .replace(/_(?:75sq|100|250|400|500|540|640)(\.(?:jpe?g|png|gif))$/i, '_1280$1')
      .replace(/\/s\d{2,4}x\d{2,4}(?:_c1)?\//, '/s1280x1920/');
    return u.toString();
  } catch { return url; }
}

/** The blog an entry's link points at: https://<blog>.tumblr.com/post/<id>/<slug> -> blog. */
const blogOfLink = (link) => { try { const h = new URL(link).hostname.toLowerCase(); return h.replace(/\.tumblr\.com$/, ''); } catch { return null; } };

/**
 * A reblog's text starts with "<original-blog>:" and links to that blog (Tumblr quotes the source).
 * @param {string} blog the blog whose feed this is (null in global tag feeds, where it is the entry's own blog)
 * @returns {string|null} the blog it was reblogged from
 */
function rebloggedFrom(entry, blog) {
  const own = blog || blogOfLink(entry.link);
  const m = /^([a-z0-9][a-z0-9-]*):/i.exec(String(entry.text || '').trim());
  if (!m || !own || m[1].toLowerCase() === own.toLowerCase()) return null;
  return (entry.links || []).some((l) => blogOfLink(l) === m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}
const isReblog = (entry, blog) => !!rebloggedFrom(entry, blog);

/** RSS entry -> ingest items (shared by user and tag feeds). */
function toItems(entry, parsed, feed) {
  const own = feed.kind === 'user' ? String(feed.target).toLowerCase().replace(/\.tumblr\.com$/, '') : blogOfLink(entry.link);
  const original = rebloggedFrom(entry, own);
  if (original && !(config.tumblrIncludeReblogs || repostsOn())) return [];
  const author = original || (feed.kind === 'user' ? feed.target : (entry.author || own));
  const items = rss.entryToItems({ ...entry, author, media: entry.media.map((m) => (m.type === 'image' ? { ...m, url: upgradeImage(m.url), preview: m.preview || m.url } : m)) }, parsed);
  return items.map((it) => ({
    ...it,
    author: String(author || '').replace(/\.tumblr\.com$/, ''),
    community: feed.kind === 'tag' ? String(feed.target).split('@')[0] : null,
    tags: [...(it.tags || []), ...(feed.kind === 'tag' ? [String(feed.target).split('@')[0]] : [])],
    query: feed.kind === 'tag' ? String(feed.target).split('@')[0] : null,
    nsfw: 'explicit',
    probe: true,
    ...(original ? { repostOf: { platform: 'tumblr', handle: original, via: own } } : {}),
  }));
}

module.exports = {
  platform: 'tumblr',
  label: 'Tumblr',
  color: '#36465d',
  kinds: ['user', 'tag'],
  intervalMin: { user: 240, tag: 180 },
  feedUrl, upgradeImage, isReblog, rebloggedFrom, toItems,
  isConfigured: () => ({ ok: true, note: config.tumblrIncludeReblogs || repostsOn() ? 'reblogs included, credited to the original blog' : 'reblogs skipped (Settings: reposts)' }),

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    const got = await rss.load(feedUrl(feed), ctx.force ? {} : { etag: cursor.etag, lastModified: cursor.lastModified });
    if (got.notModified) return { items: [], via: 'tumblr-304' };
    let parsed;
    try { parsed = rss.parseFeed(got.text, got.url); } catch (e) { throw Object.assign(new Error(`Not a valid Tumblr feed: ${e.message}`), { status: 422 }); }
    if (!parsed.entries.length && /<html/i.test(got.text.slice(0, 2000))) throw Object.assign(new Error('Tumblr returned a web page instead of a feed (blog private, deleted or adult-gated)'), { status: 404 });

    const items = [];
    let newest = cursor.newestAt || null;
    for (const entry of parsed.entries.slice(0, ctx.limit || 40)) {
      if (entry.published && cursor.newestAt && entry.published <= cursor.newestAt && !ctx.force) continue;
      if (entry.published && (!newest || entry.published > newest)) newest = entry.published;
      items.push(...toItems(entry, parsed, feed));
    }
    const h = got.headers || {};
    const next = { ...(newest ? { newestAt: newest } : {}), ...(h.etag ? { etag: h.etag } : {}), ...(h['last-modified'] ? { lastModified: h['last-modified'] } : {}) };
    return {
      items,
      cursor: Object.keys(next).length ? next : undefined,
      profile: feed.kind === 'user' ? { displayName: parsed.title, avatarUrl: parsed.image, bio: parsed.description } : undefined,
      via: 'rss',
    };
  },
};
