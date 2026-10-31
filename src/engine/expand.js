'use strict';
/**
 * Browser4 site expansion: one page in, many page feeds out.
 *
 * A JavaScript-built site lists its galleries / posts / profiles as links that only exist once the page has run. This reads
 * a page in the browser, takes the links that stay on the same site, and adds each as a `web/page` feed, so the normal
 * engine then reads them (themselves rendered when needed) and the library keeps growing from that one starting point.
 *
 * Bounded on purpose - growth that nobody can see is how crawlers get banned:
 *   - same site only (www. is ignored); depth <= 2; at most 100 feeds per call; never past the "Cap on enabled feeds"
 *   - feeds made here are UNTRUSTED (every item still needs a male-focus signal, then the safety, picture and
 *     duplicate gates), carry origin 'expand', and an 'expand' feed never expands again by itself
 *   - takedown matches are not followed (the same checks as everywhere else);
 *     robots.txt is read when each feed runs and, for the seed, before anything is fetched
 *   - login / cart / account / legal pages and files are not pages worth reading
 */
const cheerio = require('cheerio');
const repo = require('../db/repo');
const settingsStore = require('../settings');
const events = require('./events');
const render = require('../lib/render'); // Browser4 or Playwright (RENDER_ENGINE)
const takedowns = require('../lib/takedowns');
const { absUrl } = require('../sources/util');

const NOT_A_PAGE = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|m4v|m3u8|mp3|zip|rar|7z|pdf|docx?|xlsx?|css|js|json|xml|rss|atom|txt)(?:$|\?)/i;
const NOISE_PATH = /(?:^|\/)(?:log-?in|log-?out|sign-?in|sign-?up|register|cart|checkout|account|settings|admin|wp-admin|wp-login|contact|about|privacy|terms|tos|dmca|cookies?|unsubscribe|subscribe|sitemap|feed|comments?|search|tag-cloud|ads?)(?:\/|$|\.)/i;
const TRACKING_PARAM = /^(?:utm_.*|fbclid|gclid|mc_.*|ref|ref_src|igshid|_ga)$/i;
const clamp = (n, lo, hi, d) => { const v = parseInt(n, 10); return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d; };

const state = { running: false, last: null };

// What a gallery / profile / post page looks like in a URL, and what a navigation or listing page looks like.
const CONTENT_PATH = /(?:^|\/)(?:gallery|galleries|album|albums|photos?|pics?|pictures?|images?|sets?|shoots?|videos?|clips?|posts?|p|u|user|users|profiles?|models?|creators?|performers?|@[^/]+)(?:\/|$)/i;
const LISTING_PATH = /(?:^|\/)(?:tags?|categor(?:y|ies)|archives?|pages?|search|sort|filter|latest|popular|top|random)(?:\/|$)|[?&](?:page|sort|q|s|order|filter)=/i;
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f-]{32,})$/i;

/** A URL's "shape": numeric ids collapsed and the last segment wildcarded, so /set/alpha and /set/beta are one shape. */
function shapeOf(u) {
  const segs = u.pathname.split('/').filter(Boolean).map((x) => (ID_SEGMENT.test(x) ? '#' : x.toLowerCase()));
  if (segs.length >= 2) segs[segs.length - 1] = '*';
  return `/${segs.join('/')}`;
}

/**
 * Same-site, page-like links of parsed documents ([{$, url}]), best first, without the page itself. Ranked by how much they
 * look like a page of content rather than navigation (the feed budget is small, so the order decides what is read):
 *   +3 the link wraps a picture or video (a thumbnail card)         +2 a path word like gallery / set / video / profile / @name
 *   +2 three or more links share its URL shape (an item in a listing)  +1 two or more path segments
 *   -2 a listing or navigation path (tag, category, page, search, sort ...)
 * Ties keep document order, so a plain page with no signals behaves exactly as before.
 * @returns {{url: string, score: number}[]}
 */
function rankLinks(docs, seedUrl) {
  const found = new Map();
  const seedKey = keyOf(seedUrl);
  for (const { $, url } of docs) {
    $('a[href]').each((_, a) => {
      const href = absUrl($(a).attr('href'), url);
      if (!href) return;
      let u;
      try { u = new URL(href); } catch { return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      if (!render.sameSite(u.href, seedUrl)) return;
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
      if (NOT_A_PAGE.test(u.pathname) || NOISE_PATH.test(u.pathname) || u.href.length > 300) return;
      if (u.pathname === '/' && !u.search) return; // the home page is navigation, not a page of content
      const key = keyOf(u.href);
      if (key === seedKey) return;
      const thumb = $(a).find('img, picture, video, source').length > 0;
      const prev = found.get(key);
      if (prev) { prev.thumb = prev.thumb || thumb; return; } // the same page linked twice: any thumbnail counts
      found.set(key, { url: u.href, u, thumb, order: found.size });
    });
  }
  const shapes = new Map();
  for (const f of found.values()) { const sh = shapeOf(f.u); shapes.set(sh, (shapes.get(sh) || 0) + 1); }
  return [...found.values()].map((f) => {
    const path = f.u.pathname + f.u.search;
    let score = 0;
    if (f.thumb) score += 3;
    if (CONTENT_PATH.test(f.u.pathname)) score += 2;
    if ((shapes.get(shapeOf(f.u)) || 0) >= 3) score += 2;
    if (f.u.pathname.split('/').filter(Boolean).length >= 2) score += 1;
    if (LISTING_PATH.test(path)) score -= 2;
    return { url: f.url, score, order: f.order };
  }).sort((a, b) => b.score - a.score || a.order - b.order).map(({ url, score }) => ({ url, score }));
}

/** The ranked URLs only. */
const candidateLinks = (docs, seedUrl) => rankLinks(docs, seedUrl).map((l) => l.url);

function keyOf(href) { try { const u = new URL(href); return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase(); } catch { return String(href); } }

/** The content policy shared with the rest of PRISM: takedowns. */
const policyOk = (url) => !takedowns.checkUrl(url);

/**
 * Add the same-site links of already-parsed documents as untrusted `web/page` feeds.
 * @param {object} feed        the feed (or {target, creator_id}) the links were found on
 * @param {{$:object,url:string}[]} docs
 * @returns {{created:number, ids:string[], urls:string[], skipped:{policy:number, existing:number, cap:number}}}
 */
function adoptLinks(feed, docs, cfg = settingsStore.get(), { limit } = {}) {
  const room = Math.max(0, cfg.maxFeeds - repo.feeds.countEnabled());
  const budget = Math.min(limit === undefined ? cfg.browser4ExpandPerRun : limit, room);
  const linkCreator = !!(feed && feed.creator_id && cfg.autoLinkProfiles);
  const out = { created: 0, ids: [], urls: [], skipped: { policy: 0, existing: 0, cap: 0 } };
  const physique = require('./physique');
  for (const url of candidateLinks(docs, feed.target)) {
    if (out.created >= budget) { out.skipped.cap++; continue; }
    if (!policyOk(url)) { out.skipped.policy++; continue; }
    if (repo.feeds.find('web', 'page', url)) { out.skipped.existing++; continue; }
    const r = repo.feeds.upsert({ platform: 'web', kind: 'page', target: url, creatorId: linkCreator ? feed.creator_id : null, trusted: 0, origin: 'expand', intervalMin: 720, runNow: true });
    if (!r.created) { out.skipped.existing++; continue; }
    physique.screenFeed(r); // a page named for a heavy build is paused, like any other new feed
    out.created++; out.ids.push(r.feed.id); out.urls.push(url);
  }
  return out;
}

/**
 * Expand from a starting page: read it (and, at depth 2, the pages it led to) in the browser and add what it links to.
 * Takes minutes at depth 2: run it in the background (see start()).
 * @returns {Promise<{seed:string, visited:string[], created:number, urls:string[], skipped:object, notes:string[]}>}
 */
async function run(seedUrl, { depth = 1, limit = 25, creatorId = null, trustSeed = false } = {}) {
  depth = clamp(depth, 1, 2, 1); limit = clamp(limit, 1, 100, 25);
  const cfg = settingsStore.get();
  const { robotsAllows } = require('../sources/web');
  const seed = await render.assertAllowed(seedUrl);
  if (!(await robotsAllows(seed))) throw Object.assign(new Error('robots.txt disallows this page'), { skip: true });

  const result = { seed, visited: [], created: 0, urls: [], skipped: { policy: 0, existing: 0, cap: 0 }, notes: [] };
  // the starting page is a feed too: its own media is wanted
  repo.feeds.upsert({ platform: 'web', kind: 'page', target: seed, creatorId, trusted: trustSeed ? 1 : 0, origin: 'admin', intervalMin: 720, runNow: true });

  let frontier = [seed];
  const seen = new Set([keyOf(seed)]);
  for (let d = 0; d < depth && frontier.length && result.created < limit; d++) {
    const next = [];
    for (const url of frontier) {
      if (result.created >= limit) break;
      // allowUrl below only guards pagination AFTER a page's first load, so every page entering the browser is checked here
      if (!(await robotsAllows(url))) { result.notes.push(`${url}: robots.txt disallows this page`); continue; }
      let r;
      try { r = await render.renderPages(url, { scrolls: cfg.browser4Scrolls, pages: 1, allowUrl: robotsAllows }); } catch (e) { result.notes.push(`${url}: ${e.message}`); continue; }
      result.visited.push(url);
      const docs = r.pages.map((p) => ({ $: cheerio.load(p.html), url: p.url }));
      const a = adoptLinks({ target: url, creator_id: creatorId }, docs, cfg, { limit: limit - result.created });
      result.created += a.created; result.urls.push(...a.urls);
      for (const k of Object.keys(result.skipped)) result.skipped[k] += a.skipped[k];
      for (const u of a.urls) if (!seen.has(keyOf(u))) { seen.add(keyOf(u)); next.push(u); }
    }
    frontier = next;
  }
  events.log('INFO', `Expand ${seed}: read ${result.visited.length} page${result.visited.length === 1 ? '' : 's'}, added ${result.created} feed${result.created === 1 ? '' : 's'}${result.skipped.policy ? ` · ${result.skipped.policy} refused by policy` : ''}`);
  return result;
}

/** Run an expansion in the background (admin console); one at a time. The outcome is kept for status(). */
function start(seedUrl, opts = {}) {
  if (state.running) return { started: false, reason: 'an expansion is already running' };
  state.running = true;
  state.last = { seed: seedUrl, startedAt: new Date().toISOString(), status: 'running' };
  run(seedUrl, opts).then(
    (r) => { state.last = { ...state.last, status: 'done', finishedAt: new Date().toISOString(), ...r }; },
    (e) => { state.last = { ...state.last, status: e.skip ? 'skipped' : 'error', finishedAt: new Date().toISOString(), error: e.message }; events.log('WARN', `Expand ${seedUrl}: ${e.message}`); },
  ).finally(() => { state.running = false; });
  return { started: true };
}

const status = () => ({ running: state.running, last: state.last });

module.exports = { run, start, status, adoptLinks, candidateLinks, rankLinks };
