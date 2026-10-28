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
 *   - feeds made here are UNTRUSTED (every item still needs a male-focus signal, then the safety, leak, picture and
 *     duplicate gates), carry origin 'expand', and an 'expand' feed never expands again by itself
 *   - leak sites, paywalled hosts and takedown matches are not followed (the same checks as everywhere else);
 *     robots.txt is read when each feed runs and, for the seed, before anything is fetched
 *   - login / cart / account / legal pages and files are not pages worth reading
 */
const cheerio = require('cheerio');
const repo = require('../db/repo');
const settingsStore = require('../settings');
const events = require('./events');
const browser4 = require('../lib/browser4');
const leaks = require('../lib/leaks');
const takedowns = require('../lib/takedowns');
const { isPaywalledHost } = require('../lib/brave');
const { absUrl } = require('../sources/util');

const NOT_A_PAGE = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|m4v|m3u8|mp3|zip|rar|7z|pdf|docx?|xlsx?|css|js|json|xml|rss|atom|txt)(?:$|\?)/i;
const NOISE_PATH = /(?:^|\/)(?:log-?in|log-?out|sign-?in|sign-?up|register|cart|checkout|account|settings|admin|wp-admin|wp-login|contact|about|privacy|terms|tos|dmca|cookies?|unsubscribe|subscribe|sitemap|feed|comments?|search|tag-cloud|ads?)(?:\/|$|\.)/i;
const TRACKING_PARAM = /^(?:utm_.*|fbclid|gclid|mc_.*|ref|ref_src|igshid|_ga)$/i;
const clamp = (n, lo, hi, d) => { const v = parseInt(n, 10); return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d; };

const state = { running: false, last: null };

/** Same-site, page-like links of parsed documents ([{$, url}]), in document order, without the page itself. */
function candidateLinks(docs, seedUrl) {
  const out = new Map();
  const seedKey = keyOf(seedUrl);
  for (const { $, url } of docs) {
    $('a[href]').each((_, a) => {
      const href = absUrl($(a).attr('href'), url);
      if (!href) return;
      let u;
      try { u = new URL(href); } catch { return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      if (!browser4.sameSite(u.href, seedUrl)) return;
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
      if (NOT_A_PAGE.test(u.pathname) || NOISE_PATH.test(u.pathname) || u.href.length > 300) return;
      if (u.pathname === '/' && !u.search) return; // the home page is navigation, not a page of content
      const key = keyOf(u.href);
      if (key === seedKey || out.has(key)) return;
      out.set(key, u.href);
    });
  }
  return [...out.values()];
}

function keyOf(href) { try { const u = new URL(href); return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase(); } catch { return String(href); } }

/** The content policy shared with the rest of PRISM: leak sites, paywalled hosts, takedowns. */
const policyOk = (url) => !leaks.isLeakUrl(url) && !isPaywalledHost(url) && !takedowns.checkUrl(url);

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
  const seed = await browser4.assertAllowed(seedUrl);
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
      let r;
      try { r = await browser4.renderPages(url, { scrolls: cfg.browser4Scrolls, pages: 1, allowUrl: robotsAllows }); } catch (e) { result.notes.push(`${url}: ${e.message}`); continue; }
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

module.exports = { run, start, status, adoptLinks, candidateLinks };
