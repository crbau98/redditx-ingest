'use strict';
/** Part of discovery (src/engine/discovery.js), moved here unchanged: performer directories: GayForFans / JustTheGays, xHamster and Pornhub creator indexes. */
const repo = require('../../db/repo');
const settingsStore = require('../../settings');
const events = require('../events');
const registry = require('../../sources');
const { parseProfile, extractLinks, profileUrl, linkHubHandle, isMisskeyHost, cleanDisplayName, cleanSlug } = require('../../lib/links');
const { classify, femaleCheck } = require('../../lib/scope');
const { heavyRule, gate, consider } = require('./core');

/** The performer directory's sister sites: the same /performer/<slug> pages, so a refusal from one is read from the other. */
const GFF_DIRECTORY_HOSTS = ['https://gayforfans.com', 'https://justthegays.tv'];
/**
 * One page of the performer directory. gayforfans.com refusing (403) or failing (503) is read from JustTheGays, the sister
 * directory gff.js already uses when gayforfans is bot-checked. Any other failure is thrown as before.
 */
async function fetchPerformerDirectory(client, page) {
  const path = `/performer${page ? `?page=${page + 1}` : ''}`;
  const opts = { maxBytes: 3_000_000, retries: 1, headers: { accept: 'text/html' } };
  try {
    return { host: GFF_DIRECTORY_HOSTS[0], html: await client.text(`${GFF_DIRECTORY_HOSTS[0]}${path}`, opts) };
  } catch (e) {
    if (!e || (e.status !== 403 && e.status !== 503)) throw e;
    events.log('INFO', `Discovery: gayforfans directory HTTP ${e.status} — reading the JustTheGays performer directory`);
    return { host: GFF_DIRECTORY_HOSTS[1], html: await client.text(`${GFF_DIRECTORY_HOSTS[1]}${path}`, opts) };
  }
}

/**
 * GayForFans directory: the public /performer index ranks every gay male performer on the site
 * (~3,500 across 75 pages). Walk it a page or two per run, take the ranked names we do not follow
 * yet, gate them (safety + male-scope), and register each performer page as a feed — his page then
 * pulls his whole video library through the gff adapter.
 */
async function gffDiscovery({ pages = 2, perPage = 6, coomerLimit = 12, maxFollows = 12, aborted = () => false } = {}) {
  const out = { scanned: 0, followed: 0, rejected: 0, seen: 0, coomer: 0 };
  const t = require('../../services/targets');
  const index = require('../../lib/coomer-index');
  let indexReady = false; // the creator index is one big request: only fetch it when a page actually lists performers
  const http = require('../../sources/http').forPlatform('gff', 1000);
  const gff = registry.get('gff');
  // Follow the performers on one list (and their coomer mirror pages), through the usual gates.
  const consider = async (links) => {
    out.scanned += links.length;
    let added = 0;
    // GayForFans is a gay-male OnlyFans directory: each performer here is a gay male creator by the
    // site's own definition. His page gives us his name and (usually) his paid handle, which is
    // enough to match him in coomer's creator index — so his mirrored content is followed too,
    // without guessing a handle or spending a search on him.
    if (links.length && coomerLimit > 0 && !indexReady) { indexReady = true; await index.ensure(); }
    for (const l of links) {
      if (aborted()) break;
      if (out.followed >= maxFollows) break;
      const baseSlug = cleanSlug(l.slug);
      const name = cleanDisplayName(l.label) || (baseSlug ? baseSlug.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : l.slug);
      // Same gates as every other discovery: safety first, then male-only scope, then the body filter.
      const verdict = gate(name, l.slug);
      const gender = femaleCheck(name, l.slug);
      if (verdict.level === 'block' || gender.level === 'hard') { out.rejected++; continue; }
      if (settingsStore.get().physiqueFilter && heavyRule(name, l.slug)) { out.rejected++; continue; }
      let gffCreatorId = null;
      if (added < perPage) {
        const r = t.addSpec({ platform: 'gff', kind: 'user', target: l.url, label: name, ingestable: true }, { origin: 'discovered', trusted: true });
        if (r.creator) gffCreatorId = r.creator.id;
        if (r.status === 'created') { added++; out.followed++; }
      }
      if (out.coomer >= coomerLimit) continue;
      const hit = coomerMatchForPerformer(l, name, index);
      if (!hit) continue;
      if (verdict.level === 'block' || gender.level === 'hard') { out.rejected++; continue; }
      if (settingsStore.get().physiqueFilter && heavyRule(hit.id, hit.name, name)) continue;
      const r = t.addSpec({ platform: 'coomer', kind: 'user', target: `${hit.service}/${hit.id}`, label: `${hit.id} (${hit.service} on Coomer)`, ingestable: true }, { creatorId: gffCreatorId, origin: 'discovered', trusted: true });
      if (r.status === 'created') { out.coomer++; events.log('OK', `Discovery: gayforfans performer ${name} → coomer ${hit.service}/${hit.id}`); }
    }
    out.seen += links.length;
  };

  // JustTheGays first: its public lists (latest, trending, popular, most viewed, top rated) answer with
  // plain HTML, while gayforfans.com bot-checks this server. It is the 2026-era sister directory on the
  // same infrastructure, where the newly rising performers appear first.
  if (gff && typeof gff.trendingPerformers === 'function') {
    let fresh = [];
    try { fresh = await gff.trendingPerformers({ limit: 150 }); } catch (e) { events.log('WARN', `Discovery: JustTheGays lists — ${e.message}`); }
    if (fresh.length) {
      await consider(fresh.map((f) => ({ url: f.url, slug: f.slug, label: f.name })));
      if (out.followed || out.coomer) return out;
    }
  }

  // Fallback, only when JustTheGays found nobody new: walk the gayforfans.com performer directory.
  let page = parseInt(repo.discoveryState.get('gff.page', '0'), 10) || 0;
  for (let p = 0; p < Math.max(1, pages); p++) {
    if (aborted()) break;
    let html; let host = GFF_DIRECTORY_HOSTS[0];
    try {
      ({ html, host } = await fetchPerformerDirectory(http, page));
    } catch (e) { events.log('WARN', `Discovery: gayforfans directory — ${e.message}`); break; }
    const cheerio = require('cheerio');
    const $ = cheerio.load(String(html));
    const seen = new Set();
    const links = [];
    $('a[href*="/performer/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/performer\/([a-z0-9-]{3,})/i);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const label = ($(el).text() || '').replace(/#\d+\s*/, '').replace(/\s+/g, ' ').trim();
      links.push({ url: /^https?:/i.test(href) ? href : `${host}${href}`, slug: m[1], label });
    });
    await consider(links);
    page = gffNextPage(page);
    repo.discoveryState.set('gff.page', String(page));
    if (links.length < 10) break;
  }
  return out;
}

/** The directory has 75 pages: state 0 → ?page=1 … state 74 → ?page=75, then start over.
 * (The wrap used to be applied to a local copy AFTER the state was written, so the reset never
 * persisted — the cursor drifted past the last page forever and discovery stopped finding anyone.) */
const GFF_LAST_STATE = 74;
function gffNextPage(current) {
  const next = (Number.isFinite(current) ? current : 0) + 1;
  return next > GFF_LAST_STATE ? 0 : next;
}

/**
 * Which coomer account (if any) is this gayforfans performer? The page names him as
 * "First Last (paidhandle)" or just "First Last", and the slug carries the same words. A handle
 * match wins; a name match only counts when the indexed account's own handle is built from that
 * name, so a namesake never becomes his feed.
 */
function coomerMatchForPerformer(link, name, index) {
  const paren = String(name || '').match(/\(([^)]+)\)\s*$/);
  const hit = index.best({ handle: paren ? paren[1].trim() : null, name });
  if (hit) return hit;
  for (const p of String(link.slug || '').split('-')) {
    if (p.length < 4) continue;
    const h = index.lookup(p);
    if (h) return { ...h, how: 'handle' };
  }
  return null;
}

/**
 * xHamster's gay creator directory lists its creators by rating, 40+ a page, in the page's own
 * JSON. Every card is a gay creator by the site's category and every creator page is a feed, so one
 * directory page a run (the cursor rotates across the five robots-allowed pages) brings creators in
 * without anyone naming them. The same gates as every other discovery run on each name.
 */
const XH_LAST_PAGE = 5;
async function xhamsterDiscovery({ pages = 1, maxFollows = 6, aborted = () => false } = {}) {
  const out = { scanned: 0, followed: 0, rejected: 0 };
  const t = require('../../services/targets');
  const xh = registry.get('xhamster');
  if (!xh || typeof xh.creatorsFromDirectory !== 'function') return out;
  const http = require('../../sources/http').forPlatform('xhamster', 1200);
  let page = parseInt(repo.discoveryState.get('xhamster.page', '0'), 10) || 0;
  for (let p = 0; p < Math.max(1, pages); p++) {
    if (aborted()) break;
    // robots.txt: the index and its pages 2-5 are allowed; 6-50 are disallowed, so the cursor wraps at 5.
    const url = page ? `https://xhamster.com/gay/creators/${page + 1}` : 'https://xhamster.com/gay/creators';
    let html;
    try {
      html = await http.text(url, { maxBytes: 3_000_000, retries: 1, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } });
    } catch (e) { events.log('WARN', `Discovery: xHamster creators — ${e.message}`); break; }
    const list = xh.creatorsFromDirectory(String(html));
    out.scanned += list.length;
    for (const c of list) {
      if (aborted() || out.followed >= maxFollows) break;
      const verdict = gate(c.name, c.slug);
      const gender = femaleCheck(c.name, c.slug);
      if (verdict.level === 'block' || gender.level === 'hard') { out.rejected++; continue; }
      if (settingsStore.get().physiqueFilter && heavyRule(c.name, c.slug)) { out.rejected++; continue; }
      const r = t.addSpec({ platform: 'xhamster', kind: 'user', target: c.url, label: c.name, ingestable: true }, { origin: 'discovered', trusted: true });
      if (r.status === 'created') { out.followed++; events.log('OK', `Discovery: xHamster creator ${c.name} → followed`); }
    }
    page = (page + 1) % XH_LAST_PAGE;
    repo.discoveryState.set('xhamster.page', String(page));
    if (list.length < 10) break;
  }
  return out;
}

/**
 * Pornhub's gay performer directory (https://www.pornhub.com/gay/pornstars) lists 25-69 performers
 * a page (7-11 on the deep pages) across ~1,650 pages, and every model/pornstar page is a feed.
 * robots.txt allows the directory and its ?page= links and the bare performer page. Six pages a run,
 * with the page persisted so the walk resumes; past the follow cap the rest are queued as candidates
 * (promote() follows the backlog later) instead of being rescanned next time.
 */
const PH_LAST_PAGE = 1699;   // ?page=1700 is a 404
const PH_PAGES_PER_RUN = 6;
async function pornhubDiscovery({ pages = PH_PAGES_PER_RUN, maxFollows = 6, aborted = () => false } = {}) {
  const out = { scanned: 0, followed: 0, queued: 0, rejected: 0 };
  const t = require('../../services/targets');
  const ph = registry.get('pornhub');
  if (!ph || typeof ph.modelsFromDirectory !== 'function') return out;
  const http = require('../../sources/http').forPlatform('pornhub', 1200);
  let page = parseInt(repo.discoveryState.get('pornhub.page', '0'), 10) || 0;
  if (page >= PH_LAST_PAGE) page = 0;
  for (let p = 0; p < Math.max(1, pages); p++) {
    if (aborted()) break;
    const url = page ? `https://www.pornhub.com/gay/pornstars?page=${page + 1}` : 'https://www.pornhub.com/gay/pornstars';
    let html;
    try {
      html = await http.text(url, { maxBytes: 3_000_000, retries: 1, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' } });
    } catch (e) {
      events.log('WARN', `Discovery: Pornhub performers — ${e.message}`);
      if (e.status === 404) { page = 0; repo.discoveryState.set('pornhub.page', '0'); }
      break;
    }
    const list = ph.modelsFromDirectory(String(html));
    out.scanned += list.length;
    if (!list.length) { page = 0; repo.discoveryState.set('pornhub.page', '0'); break; }
    for (const c of list) {
      if (aborted()) break;
      const verdict = gate(c.name, c.slug);
      const gender = femaleCheck(c.name, c.slug);
      if (verdict.level === 'block' || gender.level === 'hard') { out.rejected++; continue; }
      if (settingsStore.get().physiqueFilter && heavyRule(c.name, c.slug)) { out.rejected++; continue; }
      const spec = { platform: 'pornhub', kind: 'user', target: c.url, label: c.name, ingestable: true };
      if (out.followed >= maxFollows) { consider(spec, 'directory', 'pornhub-gay', {}); out.queued++; continue; }
      const r = t.addSpec(spec, { origin: 'discovered', trusted: true });
      if (r.status === 'created') { out.followed++; events.log('OK', `Discovery: Pornhub performer ${c.name} → followed`); }
    }
    page = (page + 1) % PH_LAST_PAGE;
    repo.discoveryState.set('pornhub.page', String(page));
  }
  return out;
}

module.exports = { GFF_DIRECTORY_HOSTS, fetchPerformerDirectory, gffDiscovery, GFF_LAST_STATE, gffNextPage, coomerMatchForPerformer, XH_LAST_PAGE, xhamsterDiscovery, PH_LAST_PAGE, PH_PAGES_PER_RUN, pornhubDiscovery };
