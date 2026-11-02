'use strict';
/**
 * Coomer adapter (the public onlyfans/fansly/patreon mirror index at coomer.st).
 *
 *   user    target "onlyfans/<handle>" (or bare handle, default service onlyfans)
 *           everything one creator has on coomer, newest first, read through the mirror's own
 *           per-creator endpoint. The cursor remembers both the newest post seen and how deep into
 *           the list the backfill has walked, so a creator with thousands of posts is fetched
 *           across runs instead of only his first pageful.
 *   search  target "free text"        keyword feed, ordered by newest (untrusted:
 *                                     every item must read male-focused to publish, see lib/scope).
 *
 * Everything coomer shows is public web content served by coomer's own pages and CDN; the engine
 * still runs its safety / takedown / male-scope gates on every item. Media URLs go through coomer's
 * /data/ endpoint, which 302s to the file CDN (nX.coomer.st) — the same link a logged-in browser tab
 * follows — so the item's permalink (the coomer post page) is stored too.
 */
const config = require('../config');
const http = require('./http').forPlatform('coomer', 2500);
const { toIso, clip } = require('./util');

const BASE = config.baseUrls.coomer;
const IMG_BASE = config.baseUrls.coomerImg || 'https://img.coomer.st';
const SERVICES = new Set(['onlyfans', 'fansly', 'patreon', 'subscribestar', 'gd', 'justforfans']);
const PAGE = 50;
/** Pages read per run: creator pages go deep (a whole backlog), keyword feeds stay shallow. */
function maxPages(feed) {
  const settings = require('../settings').get();
  const cap = Number(settings.coomerPages) > 0 ? Number(settings.coomerPages) : 40;
  return feed.kind === 'user' ? cap : Math.min(cap, Math.max(4, Math.round(cap / 4)));
}

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

/** Coomer's image CDN (img.coomer.st) serves 800px JPEGs for image paths, plus creator icons and banners. */
function thumbUrl(pathOrUrl) {
  const p = String(pathOrUrl || '');
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return `${IMG_BASE}/thumbnail/data${p.startsWith('/') ? p : `/${p}`}`;
}

function bannerUrl(service, handle) {
  if (!service || !handle) return null;
  return `${IMG_BASE}/banners/${encodeURIComponent(service)}/${encodeURIComponent(handle)}`;
}

function iconUrl(service, handle) {
  if (!service || !handle) return null;
  return `${IMG_BASE}/icons/${encodeURIComponent(service)}/${encodeURIComponent(handle)}`;
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
  // If a post has both an image and a video, use the image's thumbnail as the video's poster; otherwise fall back to the creator's banner.
  const firstImg = files.find((f) => f && f.path && mediaTypeOf(f.name || f.path) === 'image');
  const videoPoster = firstImg ? thumbUrl(firstImg.path) : (author ? bannerUrl(svc, author) : null);
  files.forEach((f, i) => {
    const url = fileUrl(f.path);
    if (!url) return;
    const type = mediaTypeOf(f.name || f.path);
    const preview = type === 'image' ? thumbUrl(f.path) : videoPoster;
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
      previewUrl: preview,
      thumbnailUrl: preview,
      tags: [],
      nsfw: 'explicit',
      trusted: true, // API-provided media URL on coomer's own host; scope trust is decided per feed
    });
  });
  return out;
}

async function api(path, { retries = 2, timeout = 12000 } = {}) {
  const res = await http.json(`${BASE}${path}`, { headers: HEADERS, retries, timeout, maxBytes: 8_000_000 });
  if (res && res.error) throw new Error(`coomer: ${res.error}`);
  return Array.isArray(res) ? res : (res && Array.isArray(res.posts) ? res.posts : []);
}

/** Coomer answers "the offset is past the end of this creator's list" with a 400, not an empty page. */
const pastEnd = (e) => /bigger than total count/i.test(String(e && e.message || ''));

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
    return { platform: 'coomer', kind: 'user', target: `${m[1].toLowerCase()}/${m[2]}`, ingestable: true, label: `${m[2]} (${m[1].toLowerCase()} on Coomer)`, url: `${BASE}/${m[1].toLowerCase()}/user/${m[2]}` };
  },

  async fetch(feed, ctx = {}) {
    const notes = [];
    const items = [];
    const seen = new Set();
    // The cursor is three things: `newestAt` (the newest post seen, so a run knows whether anything
    // new arrived), `oldestId` (the oldest post stored — coomer's ids fall as posts get older, so
    // this marks the stored set exactly, with no date ties) and `walk` (how many posts, counted from
    // the newest, are stored without a gap: the backfill resumes right after them). The walk is what
    // makes a deep backfill finish: without it every run started again at page 1 and a creator with
    // thousands of posts only ever contributed his first 400.
    const prevNewest = (ctx.cursor || {}).newestAt || null;
    const prevOldestId = Number((ctx.cursor || {}).oldestId) || 0;
    let walk = Number((ctx.cursor || {}).walk) || 0;
    let runNewest = prevNewest;
    let runOldestId = prevOldestId;
    const { service: svc0, handle: handle0 } = splitTarget(feed.target);
    // A creator feed reads the mirror's own per-creator endpoint: every post on it is his, so no
    // page is spent on other people's posts that merely name him (which is all the search endpoint
    // returns — the old behaviour, and the reason a creator's page took 40 requests to fill).
    const pagePath = (o) => (feed.kind === 'user'
      ? `/api/v1/${svc0}/user/${handle0}/posts?o=${o}`
      : `/api/v1/posts?q=${encodeURIComponent(feed.target)}&sort=new&o=${o}`);
    const mine = feed.kind === 'user' ? handle0 : null;
    // A small explicit limit means "does this creator page exist?" — the lookup probe reads one page
    // (2.5 s) and stops. Scheduled runs pass 100–400 and get the deep backfill: paging 40 pages for a
    // probe burned the whole 18 s probe timeout on every guessed handle.
    const asked = Number(ctx.limit) || 0;
    const probe = asked > 0 && asked < 50;
    const pageCap = probe ? 1 : maxPages(feed);
    const itemCap = probe ? asked : feed.kind === 'user' ? Math.max(asked, 400) : asked || 100;
    // A probe must fail fast: one attempt, short timeout, no rate-limit waits — "not verified" is a
    // perfectly good answer for a guessed handle, and 15 s backoffs burned the whole probe budget.
    const apiOpts = probe ? { retries: 0, timeout: 8000 } : { retries: 2, timeout: 12000 };
    // The engine gives a feed run 150 s and the pipeline needs its share: stop paging in time rather
    // than being killed mid-request (a killed run stores no cursor, so the work is simply lost).
    const deadline = Date.now() + (probe ? 20000 : 95000);
    // Every request is sized to what is left of that budget: a page that starts at 90 s must not be
    // allowed 3 retries × 12 s, which is what pushed whole runs past the engine's 150 s and lost the
    // cursor. Late in the run, one attempt and a short timeout is the only honest request.
    const requestOpts = () => {
      const left = deadline - Date.now();
      return { ...apiOpts, timeout: Math.max(3_000, Math.min(apiOpts.timeout, left)), retries: left > 25_000 ? apiOpts.retries : 0 };
    };
    // The mirror only accepts offsets that are multiples of PAGE ("Offset is not a multiple of 50").
    const pageStart = (n) => Math.floor(n / PAGE) * PAGE;
    let offset = 0;        // query offset of the page being read (always a multiple of PAGE)
    let phase = 'front';   // 'front': only what is newer than the cursor · 'backfill': the stored backlog
    // Absolute positions, counted from the newest post: everything below `skipBelow` is already
    // stored; `consumed` is how far this run has read, which becomes the next walk.
    let skipBelow = 0;
    let consumed = 0;

    // A saved walk means the last run stopped inside the backlog. Look at the newest page first:
    // if anything was published since, every position behind it moved, so this run must start at the
    // front and re-find the boundary (one cheap request; the alternative is missing new posts).
    if (walk > 0 && prevNewest && !ctx.force && !probe) {
      try {
        const head = await api(pagePath(0), requestOpts());
        const hasNew = head.some((p) => p.published && p.published > prevNewest);
        if (!hasNew) { skipBelow = walk; consumed = walk; offset = pageStart(walk); phase = 'backfill'; }
      } catch { /* stay at the front: a full pass is always correct, only slower */ }
    }

    for (let page = 0; page < pageCap; page++) {
      if (Date.now() > deadline) { notes.push('coomer: stopped at the run time budget'); break; }
      let json = null;
      const maxAttempts = probe ? 1 : 3;
      for (let attempt = 0; attempt < maxAttempts && !json; attempt++) {
        try {
          json = await api(pagePath(offset), requestOpts());
        } catch (e) {
          // "Offset N is bigger than total count M" is the mirror's way of saying the list is over.
          if (pastEnd(e)) { json = []; break; }
          const rate = e && (e.status === 429 || /429|rate/i.test(String(e.message)));
          if (rate && !probe && attempt < 2 && Date.now() < deadline) { // coomer rate-limits hard: wait it out instead of ending the run
            notes.push(`coomer: rate limited, waiting`);
            await new Promise((r) => setTimeout(r, 12000 * (attempt + 1)));
            continue;
          }
          notes.push(offset === 0 ? `coomer: ${e.message}` : `coomer: stopped after ${offset} posts (${e.message})`);
        }
      }
      if (!json) break;
      const posts = Array.isArray(json) ? json : [];
      if (!posts.length) break; // the mirror ran dry
      let fresh = 0;
      let boundary = -1; // absolute position where the stored region begins (front phase only)
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        const abs = offset + i;
        if (!p || !p.id) continue;
        // A creator feed only keeps his own posts (the search endpoint returns anyone who names him too).
        if (mine && String(p.user || '').toLowerCase() !== mine) continue;
        if (phase === 'front' && prevNewest && p.published && p.published <= prevNewest) {
          // The stored region starts here. A creator feed crosses into his backfill and keeps
          // reading (everything after this point is content we do not have yet); a keyword feed
          // has nothing older worth re-reading, so it stops.
          if (!mine) continue;
          boundary = abs;
          break;
        }
        consumed = Math.max(consumed, abs + 1);
        // Already stored: everything above the stored walk is content this feed already ingested.
        // Positions are exact, so no overlap page is re-read (the mirror rejects odd offsets anyway).
        if (phase === 'backfill' && abs < skipBelow) continue;
        if (p.published && (!runNewest || p.published > runNewest)) runNewest = p.published;
        // The mirror's ids fall as posts get older: at or above the oldest stored id is stored too
        // (covers a feed whose walk was saved before positions were exact).
        const id = Number(p.id);
        if (phase === 'backfill' && prevOldestId && id && id >= prevOldestId) continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        fresh++;
        // Coomer mirrors what a logged-in viewer sees; the engine's safety / takedown / male-scope
        // gates re-check every item (tombstones and creator takedowns are recorded there, not fetched
        // per post — a request per post would blow the site's rate limit immediately).
        items.push(...itemsFromPost(p, feed));
        if (id && (!runOldestId || id < runOldestId)) runOldestId = id;
        if (items.length >= itemCap) break;
      }
      if (boundary >= 0) {
        // New posts were found at the front and the stored region begins at `boundary`, so the
        // stored walk sits right behind it. Resume the backfill there: everything up to that point
        // is already stored, and the walk moves on from the boundary.
        skipBelow = boundary + walk;
        consumed = Math.max(consumed, skipBelow);
        offset = pageStart(skipBelow);
        phase = 'backfill';
        continue;
      }
      offset += posts.length;
      if (items.length >= itemCap) break;
      if (posts.length < PAGE) break; // last page: the list ran out
      // A keyword feed's query only names the term in some posts: keep paging until the mirror runs dry.
      if (!fresh && !mine && phase === 'front') break; // fully behind the cursor: no newer content
    }
    // The walk is kept even at the end of the list: a run with nothing new then costs two requests
    // (is anything new? · resume at the end → empty) instead of re-reading the whole backlog.
    const cursor = {};
    if (runNewest) cursor.newestAt = runNewest;
    if (runOldestId) cursor.oldestId = runOldestId;
    if (consumed > 0) cursor.walk = consumed;
    return {
      items,
      cursor: Object.keys(cursor).length ? cursor : undefined,
      profile: feed.kind === 'user' ? {
        displayName: splitTarget(feed.target).handle,
        bio: null,
        avatarUrl: iconUrl(svc0, handle0),
        bannerUrl: bannerUrl(svc0, handle0),
        links: svc0 === 'onlyfans'
          ? [{ platform: 'external', service: 'OnlyFans', label: `OnlyFans · ${handle0}`, url: `https://onlyfans.com/${handle0}`, handle: handle0 }]
          : svc0 === 'fansly'
            ? [{ platform: 'external', service: 'Fansly', label: `Fansly · ${handle0}`, url: `https://fansly.com/${handle0}`, handle: handle0 }]
            : svc0 === 'justforfans'
              ? [{ platform: 'external', service: 'JustFor.Fans', label: `JustFor.Fans · ${handle0}`, url: `https://justfor.fans/${handle0}`, handle: handle0 }]
              : [],
      } : null,
      notes,
      via: 'coomer-api',
    };
  },
};
