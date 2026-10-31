'use strict';
/**
 * Coomer adapter (the public onlyfans/fansly/patreon mirror index at coomer.st).
 *
 *   user    target "onlyfans/<handle>" (or bare handle, default service onlyfans)
 *           everything one creator has on coomer.
 *   search  target "free text"        keyword feed, ordered by newest (untrusted:
 *                                     every item must read male-focused to publish, see lib/scope).
 *
 * Everything coomer shows is public web content served by coomer's own pages and CDN; the engine
 * still runs its safety / takedown / male-scope gates on every item. Media URLs go through coomer's
 * /data/ endpoint, which 302s to the file CDN (nX.coomer.st) — the same link a logged-in browser tab
 * follows — so the item's permalink (the coomer post page) is stored too.
 */
const http = require('./http').forPlatform('coomer', 2500);
const { toIso, clip } = require('./util');

const BASE = 'https://coomer.st';
const SERVICES = new Set(['onlyfans', 'fansly', 'patreon', 'subscribestar', 'gd', 'justforfans']);
const PAGE = 50;
const MAX_PAGES = 4; // 200 posts per feed run, newest first; coomer rate-limits hard (429)

// Coomer's API asks scrapers to identify with a stylesheet Accept header.
const HEADERS = { accept: 'text/css' };

function splitTarget(target) {
  const t = String(target || '').trim().toLowerCase().replace(/^@/, '');
  const i = t.indexOf('/');
  if (i > 0 && SERVICES.has(t.slice(0, i))) return { service: t.slice(0, i), handle: t.slice(i + 1) };
  return { service: 'onlyfans', handle: t };
}

function fileUrl(pathOrUrl) {
  const p = String(pathOrUrl || '');
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return `${BASE}/data${p.startsWith('/') ? p : `/${p}`}`;
}

function mediaTypeOf(name) {
  return /\.(mp4|webm|mov|m4v|avi)$/i.test(String(name || '')) ? 'video' : 'image';
}

/** One coomer post -> up to N media items (file + attachments), newest page order preserved. */
function itemsFromPost(post, feed) {
  const out = [];
  const files = [];
  if (post.file && post.file.path) files.push(post.file);
  for (const a of Array.isArray(post.attachments) ? post.attachments : []) if (a && a.path) files.push(a);
  const svc = post.service || splitTarget(feed.target).service;
  const author = String(post.user || '');
  const text = `${post.title || ''} ${(post.content || post.substring || '').replace(/<[^>]*>/g, ' ')}`.trim();
  const permalink = post.id ? `${BASE}/${svc}/user/${author}/${post.id}` : `${BASE}/${svc}/user/${author}`;
  files.forEach((f, i) => {
    const url = fileUrl(f.path);
    if (!url) return;
    const type = mediaTypeOf(f.name || f.path);
    out.push({
      sourceId: `coomer-${svc}-${post.id || author}-${i}`.slice(0, 220),
      position: i,
      title: clip(post.title || text || f.name || author, 200),
      body: clip(text, 2000),
      author,
      service: svc,
      score: 0,
      postedAt: toIso(post.published),
      permalink,
      mediaType: type,
      mediaUrl: url,
      previewUrl: type === 'image' ? url : null,
      tags: [],
      nsfw: 'explicit',
      trusted: true, // API-provided media URL on coomer's own host; scope trust is decided per feed
    });
  });
  return out;
}

async function api(path) {
  const res = await http.json(`${BASE}${path}`, { headers: HEADERS, retries: 2, maxBytes: 8_000_000 });
  if (res && res.error) throw new Error(`coomer: ${res.error}`);
  return res || { posts: [] };
}

module.exports = {
  platform: 'coomer',
  label: 'Coomer',
  color: '#f59e0b',
  kinds: ['user', 'search'],
  intervalMin: { user: 240, search: 360 },
  isConfigured: () => ({ ok: true }),

  /** Turn a pasted coomer URL into a feed spec. */
  parse(input) {
    const m = String(input || '').match(/coomer\.st\/(onlyfans|fansly|patreon|subscribestar|gd|justforfans)\/user\/([A-Za-z0-9_-]+)/i);
    if (!m) return null;
    return { platform: 'coomer', kind: 'user', target: `${m[1].toLowerCase()}/${m[2]}`, ingestable: true, label: `${m[2]} (${m[1].toLowerCase()} on Coomer)`, url: `https://coomer.st/${m[1]}/user/${m[2]}` };
  },

  async fetch(feed, ctx = {}) {
    const notes = [];
    const items = [];
    const seen = new Set();
    // The cursor is the *previous* run's newest post: posts at or below it are already stored. New
    // content found this run only moves the returned cursor forward (it must never gate this run's
    // own pages, which are all older than the newest post on page 1).
    const prevNewest = (ctx.cursor || {}).newestAt || null;
    let runNewest = prevNewest;
    const { service: svc0, handle: handle0 } = splitTarget(feed.target);
    const opt = feed.kind === 'user'
      ? `service=${encodeURIComponent(svc0)}&q=${encodeURIComponent(handle0)}` // `user=` is ignored by the API; handle query + filter below
      : `q=${encodeURIComponent(feed.target)}`;
    const mine = feed.kind === 'user' ? handle0 : null;

    for (let page = 0; page < MAX_PAGES; page++) {
      let json;
      try {
        json = await api(`/api/v1/posts?${opt}&sort=new&o=${page * PAGE}`);
      } catch (e) {
        notes.push(page === 0 ? `coomer: ${e.message}` : `coomer: stopped at page ${page + 1} (${e.message})`);
        break;
      }
      const posts = Array.isArray(json.posts) ? json.posts : [];
      if (!posts.length) break;
      let fresh = 0;
      for (const p of posts) {
        if (!p || !p.id) continue;
        // A creator feed only keeps his own posts (the query returns anyone who names the handle too).
        if (mine && String(p.user || '').toLowerCase() !== mine) continue;
        if (p.published && prevNewest && p.published <= prevNewest && !ctx.force) continue;
        if (p.published && (!runNewest || p.published > runNewest)) runNewest = p.published;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        fresh++;
        // Coomer mirrors what a logged-in viewer sees; the engine's safety / takedown / male-scope
        // gates re-check every item (tombstones and creator takedowns are recorded there, not fetched
        // per post — a request per post would blow the site's rate limit immediately).
        const itemSet = itemsFromPost(p, feed);
        items.push(...itemSet.slice(0, ctx.limit ? Math.max(1, ctx.limit - items.length) : 20));
        if (ctx.limit && items.length >= ctx.limit) break;
      }
      if (ctx.limit && items.length >= ctx.limit) break;
      if (posts.length < PAGE) break;
      // A creator feed's query only names him in some posts: keep paging until the mirror runs dry.
      if (!fresh && !mine) break; // fully behind the cursor: no newer content
    }
    return {
      items,
      cursor: runNewest ? { newestAt: runNewest } : undefined,
      profile: feed.kind === 'user' ? { displayName: splitTarget(feed.target).handle, bio: null, avatarUrl: null, links: [] } : null,
      notes,
      via: 'coomer-api',
    };
  },
};
