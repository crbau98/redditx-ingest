'use strict';
/** Part of discovery (src/engine/discovery.js), moved here unchanged: paid-page work: OnlyFans / Fansly / JustFor.Fans lead tracing, the coomer mirror passes and the paid-directory harvest. */
const config = require('../../config');
const repo = require('../../db/repo');
const settingsStore = require('../../settings');
const events = require('../events');
const websearch = require('../../lib/websearch');
const tgBot = require('../../lib/telegram-bot');
const registry = require('../../sources');
const { parseProfile, extractLinks, profileUrl, linkHubHandle, isMisskeyHost, cleanDisplayName, cleanSlug } = require('../../lib/links');
const takedowns = require('../../lib/takedowns');
const { classify, femaleCheck } = require('../../lib/scope');
const { findOnlyFans, freeHint, ofLink, creatorOnlyFans } = require('../../lib/onlyfans');
const paid = require('../../lib/paid');
const { heavyRule, leadKey, fetchBskyProfiles, gate, coreHandle, usable, consider, sameName, notePaidHandles } = require('./core');

/* ------------------------------------------------------ v4.14: OnlyFans */

const BSKY_HANDLE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TG_HANDLE = /^[a-z][a-z0-9_]{4,31}$/;
const namesOf = (text, handle) => findOnlyFans(text).includes(String(handle).toLowerCase());

/**
 * Look for the free, public accounts of the person behind a paid page: the same handle on RedGIFs and
 * Bluesky (free lookups), a web search for the exact page link (budgeted), and same-handle X / Telegram
 * leads that enrich() verifies. An account whose profile links that exact page is proven to be them.
 * The paid page itself is followed like any other public page; what is searched for is the same person's free public accounts. Lead services: OnlyFans, Fansly, JustFor.Fans.
 * @param {{handle: string, service?: string}} lead
 * @param {(spec, proven: boolean, meta) => any} found  called for every account found
 */
async function probeOnlyFans(lead, found, { budget, search = true } = {}) {
  const handle = lead.handle;
  const service = lead.service || 'OnlyFans';
  const pageHost = paid.PAID_HOSTS[service] || 'onlyfans.com';
  const linked = (text) => paid.pageLinked(service, text, handle);
  const rg = registry.get('redgifs');
  if (rg && rg.lookupUser) {
    try {
      const u = await rg.lookupUser(handle);
      if (u && u.gifs > 0) {
        const proven = linked(`${u.description || ''} ${u.links.join(' ')}`);
        found(parseProfile(`https://www.redgifs.com/users/${u.username}`), proven, { displayName: u.name || u.username, bio: u.description, avatarUrl: u.avatar, popularity: u.followers });
      }
    } catch (e) { events.log('WARN', `Discovery: RedGIFs lookup for ${service} ${handle} — ${e.message}`); }
  }
  const bh = handle.replace(/[_.]/g, '');
  if (BSKY_HANDLE.test(bh)) {
    const bskyDash = handle.replace(/[_.]/g, '-');
    const actors = [`${bh}.bsky.social`];
    if (bskyDash !== bh && BSKY_HANDLE.test(bskyDash)) actors.push(`${bskyDash}.bsky.social`);
    try {
      for (const p of await fetchBskyProfiles(actors)) {
        if ((p.labels || []).some((l) => l.val === '!no-unauthenticated')) continue;
        const proven = linked(p.description);
        found(parseProfile(`https://bsky.app/profile/${p.handle}`), proven, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar, popularity: p.followersCount });
      }
    } catch (e) { if (e.status !== 400) events.log('WARN', `Discovery: Bluesky lookup for ${service} ${handle} — ${e.message}`); }
  }
  // Same-handle guesses that enrich() confirms (or drops) once it reads the profile.
  const xa = registry.get('x');
  if (xa && xa.apiAvailable && xa.apiAvailable() && /^[a-z0-9_]{3,15}$/i.test(handle)) found(parseProfile(`https://x.com/${handle}`), false, {});
  const canTgPreview = !config.isTest || !!process.env.TELEGRAM_WEB_BASE_URL;
  if ((tgBot.configured() || canTgPreview) && TG_HANDLE.test(handle)) found(parseProfile(`https://t.me/${handle}`), false, {});
  if (search && websearch.configured()) {
    let results = [];
    try { results = await websearch.search(`"${pageHost}/${handle}"`, { budget }); } catch (e) {
      if (!e.budget && !e.skip) events.log('WARN', `Discovery: web search for ${service} ${handle} — ${e.message}`);
      return { searched: false, outOfBudget: !!(e.budget || e.skip) };
    }
    for (const r of results) {
      const snippet = `${r.title || ''} ${r.description || ''}`;
      if (takedowns.checkUrl(r.url)) continue;
      const page = parseProfile(r.url);
      const named = linked(snippet); // the result page itself shows the exact paid-page link
      for (const spec of [page, ...extractLinks(snippet)]) {
        if (!usable(spec) || spec.kind === 'community') continue;
        const own = spec.platform === 'linkinbio' ? (linkHubHandle(spec.target) || new URL(spec.target).pathname.split('/').filter(Boolean)[0] || '') : spec.target;
        // Proof needs the page to be theirs, not a fan's post that names the link: a link page (owner-curated)
        // or an account under the same name. Anyone else is just mentioning them.
        const same = sameName(own, handle);
        const proven = named && spec === page && (spec.platform === 'linkinbio' || same);
        if (!proven && !same) continue;
        found(spec, proven, { displayName: (r.title || '').split(/[(|•·-]/)[0].trim() || null, bio: r.description || null });
      }
    }
    return { searched: true };
  }
  return { searched: false };
}
/**
 * Coomer discovery: the public mirror index of paid gay creator pages.
 *
 * lib/coomer-scout explains the two halves. In short: a rotating bank of specific male-creator
 * niches (eight per run, so the whole bank is covered in about six runs — the old pass re-asked the
 * same four generic phrases forever), creators ranked by how many *independent* queries surfaced
 * them, and then each candidate's own mirrored page read once and classified. A page whose captions
 * read female is dropped; a page whose captions read male is followed even when the handle is opaque
 * ("xxl_92"); a page with nothing readable is followed only when several queries already agree.
 * Every creator still passes the safety / male-scope / body / takedown gates, and the pipeline
 * re-checks each item before it is published.
 */
async function coomerDiscovery({ queries = 0, perQuery = 0, limit = 0, aborted = () => false } = {}) {
  const out = { searched: 0, creators: 0, feeds: 0, rejected: 0, deferred: 0, verified: 0, ranked: 0 };
  const t = require('../../services/targets');
  const registry = require('../../sources');
  const scout = require('../../lib/coomer-scout');
  const s = settingsStore.get();
  const wanted = Math.max(1, Number(queries) || Number(s.coomerScoutQueries) || 8);
  const cap = Math.max(0, Number(limit) || 0) || 6;
  const rotate = parseInt(repo.discoveryState.get('coomer.query.rotate', '0'), 10) || 0;
  const picks = scout.pickQueries(rotate, wanted);
  const tally = new Map();
  // The whole pass is time-boxed. The mirror spaces requests 2.5 s apart, so eight queries read
  // deeply would run past ten minutes and hold the discovery cycle open; 150 s covers eight queries
  // at one to two pages each plus a handful of page reads, and the rotation means a shortened run
  // simply continues the bank next time.
  const started = Date.now();
  const budgetMs = 150_000;
  const left = () => budgetMs - (Date.now() - started);

  for (const q of picks) {
    if (aborted() || left() < 40_000) break; // leave room to verify what was found
    try {
      const res = await registry.get('coomer').fetch({ platform: 'coomer', kind: 'search', target: q }, { limit: 50 });
      out.searched++;
      scout.merge(tally, scout.tally(res.items || [], q));
    } catch (e) { events.log('WARN', `Discovery: coomer "${q}" — ${e.message}`); }
  }
  // The cursor advances even when a query failed: the next run continues the bank instead of
  // re-spending its whole budget on the same phrase that just timed out.
  repo.discoveryState.set('coomer.query.rotate', String(scout.nextRotate(rotate, picks.length)));

  // Evidence from previous runs counts too: a creator surfaced by "gay jock" today and "gay
  // massage" last week is corroborated, and the rotation means that is the normal way he is found.
  let stored = {};
  try { stored = JSON.parse(repo.discoveryState.get('coomer.evidence', '{}') || '{}'); } catch { stored = {}; }
  const surfacedNow = new Set(tally.keys()); // only re-verify men this run actually surfaced
  scout.restore(tally, stored);
  repo.discoveryState.set('coomer.evidence', JSON.stringify(scout.snapshot(tally, stored)));

  const ranked = [...tally.values()].filter((e) => surfacedNow.has(e.handle) && scout.candidate(e)).sort((a, b) => scout.score(b) - scout.score(a));
  out.ranked = ranked.length;
  const verify = s.coomerScoutVerify !== false;

  for (const entry of ranked) {
    if (aborted() || out.feeds >= cap) break;
    if (left() < 8_000) break; // a verification read costs 2.5 s + the page fetch
    const handle = entry.handle;
    // A creator page is one creator: a hard-female or unsafe name rejects it before any fetching.
    const verdict = gate(handle, handle.replace(/[._-]+/g, ' '));
    const named = scout.nameGate(handle, null);
    if (verdict.level === 'block' || !named.ok) { out.rejected++; continue; }
    if (s.physiqueFilter && heavyRule(handle)) { out.rejected++; continue; }
    if (takedowns.checkHandle(handle, 'coomer')) { out.rejected++; continue; }

    let check = { verdict: 'unverified', maleRatio: 0, femaleRatio: 0, total: 0, reason: 'content not read' };
    if (verify) {
      try {
        // A small limit makes the adapter read exactly one page: the evidence, not the backfill.
        const page = await registry.get('coomer').fetch({ platform: 'coomer', kind: 'user', target: `${entry.service}/${handle}` }, { limit: 15 });
        check = scout.verify(page.items || []);
        if (check.verdict === 'verified') out.verified++;
      } catch (e) {
        events.log('WARN', `Discovery: coomer verify ${handle} — ${e.message}`);
        out.deferred++; continue; // cannot judge this run: try again next time rather than follow blind
      }
    }
    const d = scout.decide(entry, check);
    if (!d.follow) {
      if (check.verdict === 'female') out.rejected++; else out.deferred++;
      continue;
    }
    const r = t.addSpec({ platform: 'coomer', kind: 'user', target: `${entry.service}/${handle}`, label: `${handle} (${entry.service} on Coomer)`, ingestable: true }, { origin: 'discovered', trusted: true });
    if (r.status === 'created') { out.feeds++; out.creators++; events.log('OK', `Discovery: coomer scout — ${entry.service}/${handle} (${d.reason})`); }
  }
  return out;
}

/**
 * Coomer's creator index (lib/coomer-index): the mirror publishes every account it has indexed —
 * 220k+ OnlyFans / Fansly / JustFor.Fans creators — in one public response. Matching the paid
 * handles this app already knows about against that index means a creator's whole mirrored page is
 * followed from a lookup, not from a guess: no per-handle probe, no rate limit burned on handles
 * that were never mirrored at all.
 *
 * Two sources of handles, in order of how much we already know about the man:
 *   paid leads   — OnlyFans/Fansly handles harvested from listicles, bios and directory pages
 *   paid pages   — creators already followed here whose stored links name a paid page
 * Every one passes the same safety + male-scope + body gates as any other discovered account
 * before it becomes a feed; the index only says "this account exists on the mirror".
 */
async function coomerIndexDiscovery({ leads = 40, reach = 40, limit = 25, aborted = () => false } = {}) {
  const out = { indexed: false, checked: 0, matched: 0, feeds: 0, rejected: 0, leads: 0, creators: 0 };
  const t = require('../../services/targets');
  const index = require('../../lib/coomer-index');
  const info = await index.ensure();
  if (!info || !info.count) { events.log('WARN', 'Discovery: coomer creator index unavailable'); return out; }
  out.indexed = true;

  const queue = []; // {handle, name, service, where, creatorId}
  for (const lead of repo.onlyfans.workable(leads)) {
    if (aborted()) break;
    queue.push({ handle: lead.handle, name: lead.display_name || null, service: lead.service || 'OnlyFans', where: 'lead', creatorId: lead.creator_id || null });
  }
  for (const c of repo.onlyfans.reachTargets(reach, 30, 6, 'OnlyFans', 'coomer.reach.')) {
    if (aborted()) break;
    const of = creatorOnlyFans(c);
    if (!of) continue;
    repo.discoveryState.set(`coomer.reach.${c.id}`, new Date().toISOString());
    queue.push({ handle: of.handle, name: c.display_name || c.handle, service: 'OnlyFans', where: 'creator', creatorId: c.id });
  }

  for (const q of queue) {
    if (aborted() || out.feeds >= limit) break;
    out.checked++;
    const hit = index.best({ handle: q.handle, name: q.name });
    if (!hit) continue;
    out.matched++;
    if (q.where === 'lead') out.leads++; else out.creators++;
    // A creator page is one creator: a hard female name or a safety hit rejects it before it is a feed.
    const verdict = gate(q.handle, hit.name || hit.id, q.name);
    const gender = femaleCheck(q.handle, hit.name || hit.id, q.name);
    if (verdict.level === 'block' || gender.level === 'hard') { out.rejected++; continue; }
    if (settingsStore.get().physiqueFilter && heavyRule(q.handle, hit.name || hit.id, q.name)) { out.rejected++; continue; }
    if (takedowns.checkHandle(hit.id, 'coomer')) { out.rejected++; continue; }
    const r = t.addSpec({ platform: 'coomer', kind: 'user', target: `${hit.service}/${hit.id}`, label: `${hit.id} (${hit.service} on Coomer)`, ingestable: true }, { creatorId: q.creatorId || null, origin: 'discovered', trusted: true });
    if (r.status === 'created') { out.feeds++; events.log('OK', `Discovery: coomer index — ${hit.service}/${hit.id} (${q.where})`); }
  }
  return out;
}

/**
 * Coomer by name: the index pass above starts from a *paid handle* this app harvested. Most popular
 * creators never publish their OnlyFans handle anywhere the harvest can see, but their display name
 * is everywhere ("Jordan Brandt", "Owen Hawk"). The mirror's creator index publishes names too, so a
 * followed creator can be matched by the name he actually uses, and his mirrored page followed.
 *
 * The index only says "an account with this name is mirrored". The match is deliberately strict
 * (lib/coomer-index `best`: the indexed handle must be built from the name, never a namesake), and
 * every candidate still passes safety + male-scope + body + takedown before it becomes a feed.
 */
async function coomerNameDiscovery({ limit = 8, scan = 60, aborted = () => false } = {}) {
  const out = { indexed: false, checked: 0, matched: 0, feeds: 0, rejected: 0 };
  const t = require('../../services/targets');
  const index = require('../../lib/coomer-index');
  const info = await index.ensure();
  if (!info || !info.count) return out;
  out.indexed = true;
  const s = settingsStore.get();
  for (const c of repo.onlyfans.nameTargets(Math.max(scan, limit * 4))) {
    if (aborted() || out.feeds >= limit) break;
    const name = String(c.display_name || '').trim();
    if (!name) continue;
    // Cheap local check first: never spend a state write on a name the index cannot match.
    // The handle counts too — a creator followed from Reddit or Bluesky often uses the same handle
    // on his paid page, and the mirror indexes handles as well as names. Fediverse handles carry an
    // instance ("toiida@library.love", "x.bsky.social"), so the bare name is tried as well.
    const core = coreHandle(c.handle);
    const hit = index.best({ handle: c.handle, name })
      || (core && core !== String(c.handle).toLowerCase() ? index.best({ handle: core }) : null);
    out.checked++;
    repo.discoveryState.set(`coomer.name.${c.id}`, new Date().toISOString());
    if (!hit) continue;
    out.matched++;
    const verdict = gate(c.handle, name, hit.id);
    const gender = femaleCheck(c.handle, name, hit.id);
    if (verdict.level === 'block' || gender.level === 'hard') { out.rejected++; continue; }
    if (s.physiqueFilter && heavyRule(c.handle, name, hit.id)) { out.rejected++; continue; }
    if (takedowns.checkHandle(hit.id, 'coomer')) { out.rejected++; continue; }
    const r = t.addSpec(
      { platform: 'coomer', kind: 'user', target: `${hit.service}/${hit.id}`, label: `${hit.id} (${hit.service} on Coomer)`, ingestable: true },
      { creatorId: c.id, origin: 'discovered', trusted: true },
    );
    if (r.status === 'created') { out.feeds++; events.log('OK', `Discovery: coomer by name — ${name} → ${hit.service}/${hit.id}`); }
  }
  return out;
}

/**
 * Listicle & directory harvest: the open web already published lists of gay male creators —
 * "top gay onlyfans" roundups, link-hub directories, forum threads, performer indexes. Search finds
 * the pages (keyless Bing + DuckDuckGo merge, see lib/websearch), each page is read once (robots.txt
 * honoured), and everything on it becomes signal:
 *
 *   paid handles  → OnlyFans/Fansly/JFF leads → the existing trace finds each man's free accounts
 *                   → scored candidates → auto-follow (safety + male-scope gates unchanged)
 *   profile links → directly-scored candidates (same as any other search hit)
 *
 * Pages are remembered so a run never re-reads what it already harvested.
 */
const HARVEST_QUERIES = [
  'top gay onlyfans creators list',
  'gay male onlyfans creators to follow',
  'gay onlyfans directory link hub',
  'gay male creators linktree allmylinks directory',
  'best gay onlyfans accounts list',
  'gay porn performers onlyfans links list',
  'gay creators beacons page list 18+',
  'gay creators fansly justforfans links list',
  'male onlyfans model beacons bio linktree',
  'gay adult creator links allmylinks directory',
];

async function directoryHarvest({ queries = 3, pages = 5, budget, aborted = () => false } = {}) {
  const out = { searched: 0, read: 0, leads: 0, candidates: 0, rejected: 0, failed: 0 };
  if (!websearch.configured()) return out;
  const http = require('../../sources/http').forPlatform('harvest', 1100);
  const cheerio = require('cheerio');
  const { robotsAllows } = require('../../sources/web');
  const seenPages = new Set(JSON.parse(repo.discoveryState.get('harvest.pages', '[]') || '[]'));
  let rotate = parseInt(repo.discoveryState.get('harvest.rotate', '0'), 10) || 0;
  const spent = new Set();
  let fails = 0;
  const urls = []; // {url, q} — the query stays with the page so the signal names its source

  for (let i = 0; i < queries && !aborted(); i++) {
    const q = HARVEST_QUERIES[(rotate + i) % HARVEST_QUERIES.length];
    if (spent.has(q)) continue;
    spent.add(q);
    try {
      const hits = await websearch.search(q, { count: 12, budget, preferKeyless: true });
      out.searched++;
      fails = 0;
      for (const h of hits) if (h.url && !seenPages.has(h.url) && !takedowns.checkUrl(h.url)) urls.push({ url: h.url, q });
    } catch (e) {
      out.failed++;
      // One failed query must not kill the whole pass: a wall or a spent metered budget can clear
      // between queries (the keyless providers cool down and retry themselves). Two in a row means
      // search really is unavailable — stop instead of burning a query per page read.
      if (++fails >= 2) {
        events.log('WARN', `Discovery: harvest stopped — search unavailable (${String(e.message).slice(0, 110)})`);
        break;
      }
      events.log('WARN', `Discovery: harvest "${q}" — ${e.message}`);
    }
  }
  repo.discoveryState.set('harvest.rotate', String((rotate + queries) % HARVEST_QUERIES.length));

  for (const { url: pageUrl, q } of urls) {
    if (aborted() || out.read >= pages) break;
    if (seenPages.has(pageUrl)) continue;
    seenPages.add(pageUrl);
    try {
      if (!(await robotsAllows(pageUrl))) continue;
      const html = await http.text(pageUrl, { maxBytes: 1_500_000, retries: 0, timeout: 12000, headers: { accept: 'text/html' } });
      out.read++;
      const $ = cheerio.load(String(html));
      $('script, style, noscript').remove();
      // Anchor hrefs count too: a listicle's creator links are often the only place the URL exists
      // (anchor text is just a name), and paid handles hide in query strings and paths.
      const hrefs = [];
      $('a[href]').each((_, el) => { const h = $(el).attr('href'); if (h && /^(https?:)?\/\//i.test(h)) hrefs.push(h.replace(/^(?!https?:)/i, 'https:')); });
      const text = `${$('title').text()}\n${$('h1, h2, h3').text()}\n${$('body').text()}\n${hrefs.join('\n')}`.replace(/[ \t]+/g, ' ').slice(0, 200_000);
      if (gate(text.slice(0, 4000)).level === 'block') { out.rejected++; continue; }

      // 1. Paid pages named on the page → leads the existing trace works (accounts, scores, auto-follow).
      out.leads += notePaidHandles(text, null);

      // 2. Profile links on the page → scored candidates (male-scope + safety enforced by consider()).
      for (const spec of extractLinks(text)) {
        if (!usable(spec)) continue;
        if (spec.platform === 'linkinbio') spec = { ...spec, target: spec.target.split('#')[0] };
        const c = consider(spec, 'search', q || pageUrl, { bio: null, displayName: null });
        if (c) out.candidates++;
      }
    } catch (e) {
      if (e && /robots/.test(String(e.message))) continue;
      // one bad page is one page: keep harvesting
    }
  }
  repo.discoveryState.set('harvest.pages', JSON.stringify([...seenPages].slice(-600)));
  return out;
}

/**
 * Work the paid leads: (1) pages creators promote that we do not follow yet become discovery
 * candidates for that person's public accounts; (2) followed creators who have a paid page but few
 * known accounts get the same search, and what it finds is linked to them (their content from elsewhere).
 * OnlyFans, Fansly and JustFor.Fans; the paid pages are read like any other public page.
 */
async function onlyfansDiscovery({ leads = 10, reach = 4, searches = 4, budget, aborted = () => false } = {}) {
  const out = { checked: 0, found: 0, linked: 0, searched: 0, rejected: 0 };
  let searchLeft = searches;
  for (const lead of repo.onlyfans.workable(leads)) {
    if (aborted()) break;
    const key = leadKey(lead.service, lead.handle);
    const owner = repo.onlyfans.ownerOf(lead.handle, lead.service);
    if (owner) { repo.onlyfans.claim(lead.handle, owner.id, lead.service); continue; }
    const verdict = gate(lead.handle, lead.display_name, lead.bio);
    const gender = femaleCheck(lead.handle, lead.display_name, lead.bio);
    // Borderline wording ("teen") is not traced at all: unlike a queued candidate, a lead has no human checkpoint.
    if (verdict.level || gender.level === 'hard') {
      repo.onlyfans.update(lead.handle, { service: lead.service, status: 'rejected', reason: verdict.level ? `safety: ${verdict.rule}` : `scope: ${gender.rule}`, checked_at: new Date().toISOString() });
      out.rejected++;
      continue;
    }
    const accounts = [];
    // Web searches are the scarce resource: spend them on pages more than one source vouches for.
    const search = searchLeft > 0 && (lead.mentions >= 2 || lead.origin === 'search' || lead.attempts > 0);
    const r = await probeOnlyFans(lead, (spec, proven, meta) => {
      const c = consider(spec, proven ? 'ofconfirmed' : 'onlyfans', key, { ...meta, ofSources: Math.max(1, lead.sources.length || lead.mentions || 1) });
      if (c) accounts.push({ platform: spec.platform, kind: spec.kind, target: spec.target, proven, candidate: c.id });
    }, { budget, search });
    if (r.searched) { searchLeft--; out.searched++; }
    if (r.outOfBudget) searchLeft = 0;
    out.checked++;
    if (accounts.length) out.found++;
    repo.onlyfans.update(lead.handle, { service: lead.service, status: accounts.length ? 'found' : 'searching', accounts: accounts.length ? accounts : lead.accounts, attempts: (lead.attempts || 0) + 1, checked_at: new Date().toISOString() });
  }
  for (const service of Object.keys(paid.SERVICES).filter((s) => paid.SERVICES[s].trace)) {
    const keyPrefix = service === 'OnlyFans' ? 'of.reach.' : `paid.reach.${service}.`;
    for (const t of repo.onlyfans.reachTargets(reach, 30, 4, service, keyPrefix)) {
      if (aborted()) break;
      const of = service === 'OnlyFans' ? creatorOnlyFans(t) : paid.creatorPaid(t).find((l) => l.service === service && l.handle);
      repo.discoveryState.set(`${keyPrefix}${t.id}`, new Date().toISOString());
      if (!of) continue;
      const r = await probeOnlyFans({ handle: of.handle, service }, (spec, proven, meta) => {
        // the creator's own other account: an identity link (same person), not a new creator
        const owner = spec.kind === 'user' ? repo.creators.byAccount(spec.platform, spec.target) : null;
        if (owner) return;
        // probeOnlyFans only reports same-handle or proven accounts; a same-handle one is theirs only when
        // the paid handle is also the creator's own name (otherwise it may be a namesake)
        if (!proven && !sameName(t.handle, of.handle)) return;
        if (consider(spec, 'identity', t.id, { ...meta, creatorId: t.id })) out.linked++;
      }, { budget, search: searchLeft > 0 });
      if (r.searched) { searchLeft--; out.searched++; }
      if (r.outOfBudget) searchLeft = 0;
    }
  }
  return out;
}

module.exports = { BSKY_HANDLE, TG_HANDLE, namesOf, probeOnlyFans, coomerDiscovery, coomerIndexDiscovery, coomerNameDiscovery, HARVEST_QUERIES, directoryHarvest, onlyfansDiscovery };
