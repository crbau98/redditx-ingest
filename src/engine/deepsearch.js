'use strict';
/**
 * Deep pull: search for ONE creator and bring back everything the public web has on him —
 * profile pages, pictures and videos — instead of waiting for the background rotation to reach him.
 *
 * It runs when a search in the app resolves to a creator PRISM already follows (admin or public
 * lookup) and when his profile's "Pull from the web" button is pressed. Four bounded phases, each
 * corroborated before anything is attributed to him:
 *
 *   text    plain web search over a rotating bank of shapes: his name and handle on every platform
 *           PRISM reads, his paid pages, mirrors / leaks / reposts, link hubs
 *   video   video search on the same names (video results become page feeds when they name him)
 *   image   image search + the same-picture check (perceptual hash), the local face match, and —
 *           where the page names him — the page becomes his feed (engine/imagematch)
 *   reverse Yandex reverse-image over several of his own pictures → review rows for a human,
 *           never an automatic attribution
 *
 * One pull per creator at a time, a cooldown between them, progress written to discovery_state
 * (key `deepsearch.<id>`) so the profile can show what it is doing. Every result passes the same
 * safety, male-only, body, takedown, robots and blocklist gates as an ordinary ingest.
 */
const repo = require('../db/repo');
const config = require('../config');
const settingsStore = require('../settings');
const websearch = require('../lib/websearch');
const brave = require('../lib/brave');
const events = require('./events');
const takedowns = require('../lib/takedowns');
const { parseProfile, extractLinks, linkHubHandle } = require('../lib/links');
const { checkText } = require('../lib/safety');
const { femaleCheck } = require('../lib/scope');
const { hostBlocked } = require('../lib/mediaurl');
const faceMatch = require('../lib/face-match');
const targets = require('../services/targets');
const imagematch = require('./imagematch');

const KEY = (id) => `deepsearch.${id}`;
const ROTATE_KEY = 'deepsearch.rotate';

/** Manual pulls may repeat sooner than the automatic ones a search triggers. */
const COOLDOWN_MS = { manual: 15 * 60 * 1000, lookup: 6 * 60 * 60 * 1000, rotation: 24 * 60 * 60 * 1000 };
const MAX_TEXT_QUERIES = 8;
const MAX_VIDEO_QUERIES = 3;
const MAX_PAGES = 8;
/** One pull may add this many feeds: each new feed is a feed the scheduler now polls for ever. */
const MAX_FEEDS = 10;
const MAX_RESULTS_PER_QUERY = 20;

/** Site shapes rotate so repeated pulls keep widening the sweep instead of re-asking the same eight. */
const SITE_SHAPES = [
  'site:x.com OR site:t.co', 'site:reddit.com', 'site:tiktok.com', 'site:youtube.com OR site:youtu.be',
  'site:t.me', 'site:tumblr.com', 'site:redgifs.com', 'site:bsky.app',
  'site:xhamster.com OR site:pornhub.com OR site:spankbang.com', 'site:linktr.ee OR site:allmylinks.com OR site:beacons.ai',
  'site:coomer.st OR site:kemono.su OR site:cumgifs.com', 'site:onlyfans.com OR site:fansly.com OR site:justfor.fans',
];
/** Phrases that never depend on a platform: mirrors, leaks, reposts, his own link page. */
const PHRASE_SHAPES = [
  '"{name}" (nude OR naked OR leaked OR repost OR mirror)',
  '"{name}" video full',
  '"{name}" (onlyfans OR fansly OR "justfor.fans")',
  '"{handle}" (twitter OR x.com OR bluesky OR telegram)',
];

/* ------------------------------------------------------------------ progress */

function readProgress(creatorId) {
  try { return JSON.parse(repo.discoveryState.get(KEY(creatorId)) || 'null') || null; } catch { return null; }
}

function writeProgress(creatorId, patch) {
  const next = { ...(readProgress(creatorId) || {}), ...patch, updatedAt: new Date().toISOString() };
  try { repo.discoveryState.set(KEY(creatorId), JSON.stringify(next)); } catch { /* progress must never fail a pull */ }
  return next;
}

/** What a profile or the admin console shows: running?, the phase, the counts, when it last ran. */
function status(creatorId) {
  const p = readProgress(creatorId);
  const lastAt = p && p.lastAt ? Date.parse(p.lastAt) : 0;
  const cooldown = COOLDOWN_MS.lookup;
  return {
    running: running.has(creatorId),
    phase: p ? p.phase || null : null,
    done: !!(p && p.done),
    startedAt: p ? p.startedAt || null : null,
    lastAt: p ? p.lastAt || null : null,
    error: p ? p.error || null : null,
    found: p ? p.found || { pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0, aliases: 0 } : null,
    queries: p ? p.queries || [] : [],
    cooldownMs: lastAt ? Math.max(0, lastAt + cooldown - Date.now()) : 0,
    enabled: !!settingsStore.get().deepSearch,
  };
}

/* ------------------------------------------------------------------ queries */

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Is this ACCOUNT his? Only when the account's own handle is his: the same as his name or handle, or one containing it
 * (enough letters to be an identity). A search result that merely mentions him (fan art, a repost, a site-wide feed or
 * index whose snippet names him) proves nothing about whose account it is: attaching those glued other men's accounts,
 * their posts and their names onto one creator. Pages are judged separately (namesCreator) and stay page feeds.
 */
function samePerson(creator, handle) {
  const h = compact(handle);
  if (!h) return false;
  for (const name of [creator.display_name, creator.handle]) {
    const n = compact(name);
    // Containment counts only with enough letters to be an identity: a bare surname ("doe" in
    // "Jake Doe") is far too common to claim somebody's account on.
    if (n && (n === h || (h.length >= 5 && n.length >= 5 && h.includes(n)) || (n.length >= 5 && h.length >= 4 && n.includes(h)))) return true;
  }
  return false;
}

/** The handle an account feed is known by: a link hub's own name, else the target before any "@instance". */
function accountHandle(platform, target) {
  if (platform === 'linkinbio') {
    return linkHubHandle(target) || (() => { try { return new URL(target).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })();
  }
  return String(target || '').split('@')[0];
}

/**
 * Admin, read-only: account feeds that discovery or a deep pull attached to a creator although the account's own
 * handle is not his (samePerson). Before f63d517 a result that only mentioned him could attach an account; this lists
 * what to check. Web page feeds are left out: a page is attached because it names him, not as his account. Nothing is
 * changed here; each row is cleaned up with POST /api/admin/feeds/:id/media/reassign.
 */
const FOREIGN_ORIGINS = ['deep-search', 'discovered'];
function foreignFeeds({ limit = 100, offset = 0 } = {}) {
  const rows = repo.db.prepare(`SELECT f.id, f.platform, f.kind, f.target, f.origin, f.enabled, c.id AS creatorId, c.handle AS creatorHandle,
      c.display_name AS creatorName
    FROM feeds f JOIN creators c ON c.id = f.creator_id
    WHERE f.origin IN (${FOREIGN_ORIGINS.map(() => '?').join(',')}) AND f.platform != 'web'
    ORDER BY c.handle, f.platform, f.target`).all(...FOREIGN_ORIGINS);
  const foreign = rows.filter((r) => !samePerson({ handle: r.creatorHandle, display_name: r.creatorName }, accountHandle(r.platform, r.target)));
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  const page = foreign.slice(off, off + lim);
  const counts = page.length
    ? new Map(repo.db.prepare(`SELECT feed_id, COUNT(*) AS n FROM media WHERE feed_id IN (${page.map(() => '?').join(',')}) GROUP BY feed_id`).all(...page.map((r) => r.id)).map((r) => [r.feed_id, r.n]))
    : new Map();
  return {
    total: foreign.length, limit: lim, offset: off,
    items: page.map((r) => ({ ...r, enabled: !!r.enabled, handle: accountHandle(r.platform, r.target), mediaCount: counts.get(r.id) || 0,
      cleanup: { method: 'POST', path: `/api/admin/feeds/${r.id}/media/reassign`, body: { creatorId: '' } } })),
  };
}

/** The eight rotating site shapes plus the four standing phrases, name and handle substituted. */
function buildQueries(creator) {
  const name = String(creator.display_name || creator.handle || '').trim();
  const handle = String(creator.handle || '').trim();
  const phrase = (s) => s.replace(/\{name\}/g, name).replace(/\{handle\}/g, handle || name);
  const rotate = parseInt(repo.discoveryState.get(ROTATE_KEY) || '0', 10) || 0;
  const sites = SITE_SHAPES.map((_, i) => SITE_SHAPES[(i + rotate) % SITE_SHAPES.length]);
  return {
    text: [...PHRASE_SHAPES.map(phrase), ...sites.slice(0, MAX_TEXT_QUERIES - PHRASE_SHAPES.length).map((s) => `"${name}" ${s}`)],
    video: [`${name} video`, `"${name}" (nude OR naked OR full video)`].slice(0, MAX_VIDEO_QUERIES),
    rotate,
  };
}

/* ------------------------------------------------------------------ results */

/** Does the result page itself name him? (already used by image match: same rule, one place) */
const namesCreator = imagematch.namesCreator;

function passesGates(hit) {
  if (!hit || !hit.url) return false;
  if (takedowns.checkUrl(hit.url)) return false;
  if (checkText(hit.title, hit.description, hit.url).level === 'block') return false;
  if (femaleCheck(hit.title, hit.description).level === 'hard') return false;
  let host = null;
  try { host = new URL(hit.url).hostname; } catch { /* not a URL we can judge */ }
  if (host && hostBlocked(host)) return false;
  return true;
}

/**
 * One text/video search result → registered pages, feeds and review rows.
 * @returns {Promise<{feeds:number, pages:number, paid:number}>}
 */
/** Platforms PRISM deliberately only link-outs: a proven profile there becomes an alias, never a feed. */
const LINK_OUT_SERVICES = new Set(['Instagram', 'Snapchat', 'Twitch']);
const OK_HANDLE = /^[A-Za-z0-9._]{3,30}$/;

async function takeResult(hit, creator, out, ctx) {
  const res = { feeds: 0, pages: 0, paid: 0, aliases: 0 };
  if (!hit || !hit.url) return res;
  // The cheap text gates first: a takedown or a safety block kills the result outright.
  if (takedowns.checkUrl(hit.url)) return res;
  if (checkText(hit.title, hit.description, hit.url).level === 'block') return res;
  if (femaleCheck(hit.title, hit.description).level === 'hard') return res;
  const text = `${hit.title || ''} ${hit.description || ''}`;
  const specs = [parseProfile(hit.url), ...extractLinks(text)].filter(Boolean);
  // A proven profile on a link-out platform (Instagram, Threads, …): remember the handle as HIS
  // alias so lookup, identity and the graph connect him later. Never a feed, never a fetch — and
  // deliberately BEFORE the fetch gates: a host we refuse to read still teaches us who he is.
  for (const spec of specs) {
    if (!spec || !spec.external) continue;
    const host = (() => { try { return new URL(spec.url || spec.target || '').hostname; } catch { return ''; } })();
    const linkOut = LINK_OUT_SERVICES.has(spec.service) || /(^|\.)(threads\.(net|com)|instagram\.com|tiktok\.com)$/i.test(host);
    const handle = String(spec.handle || (spec.label || '').split('·')[1] || '').trim().replace(/^@/, '')
      || (() => { try { return decodeURIComponent(new URL(spec.url || spec.target || '').pathname.split('/').filter(Boolean)[0] || ''); } catch { return ''; } })();
    if (linkOut && OK_HANDLE.test(handle) && samePerson(creator, handle)) {
      try {
        require('./identity').addAlias(creator.id, handle.toLowerCase(), { kind: 'handle', source: 'lookup', evidenceUrl: hit.url });
        res.aliases++;
      } catch { /* alias bookkeeping must never fail a pull */ }
    }
  }
  if (!passesGates(hit)) return res;
  for (const spec of specs) {
    if (!spec) continue;
    // A paid page is a public page (owner decision 2026-11-05): read it, never drop it.
    if (spec.external || spec.platform === 'paid') {
      if (spec.url || hit.url) {
        try { require('./paidpage').registerPaidPage(spec.url || hit.url, { creatorId: creator.id, origin: 'deep-search' }); res.paid++; }
        catch (e) { events.log('WARN', `Deep pull: paid page ${spec.url || hit.url} — ${e.message}`); }
      }
      continue;
    }
    if (!spec.ingestable) continue;
    const handle = accountHandle(spec.platform, spec.target);
    // The proof differs by kind: a hub or profile page must be under his own name/handle, a web page
    // must name him in its own text. Everything else is only a mention of him.
    const proven = spec.platform === 'web'
      ? namesCreator({ url: spec.target, title: hit.title, description: hit.description }, creator, ctx.paidHandle)
      : samePerson(creator, handle);
    if (!proven) continue;
    if (spec.platform === 'web') {
      try { if (!(await require('../sources/web').robotsAllows(spec.target))) continue; } catch { continue; }
    }
    const r = targets.addSpec(spec, { creatorId: creator.id, origin: 'deep-search', trusted: true });
    if (r && r.status === 'created') {
      res.feeds++;
      faceMatch.recordWebMatch({
        creatorId: creator.id,
        pageUrl: spec.url || spec.target,
        title: spec.label || hit.title || null,
        platform: spec.platform,
        matchKind: 'text_search',
        evidence: `web search: ${(hit.title || hit.url || '').slice(0, 120)}`,
        status: 'confirmed',
      });
      repo.logAction('creator', creator.id, 'deep-search', `${spec.platform}:${spec.target} — ${(hit.title || hit.url || '').slice(0, 90)}`, 'discovery');
    }
    res.pages++;
  }
  return res;
}

/* ------------------------------------------------------------------ injection (tests) */
let searchFn = (...a) => websearch.search(...a);
let videoFn = (...a) => brave.videos(...a);
const _setSearchers = (s, v) => { if (s) searchFn = s; if (v) videoFn = v; };
const _resetSearchers = () => { searchFn = (...a) => websearch.search(...a); videoFn = (...a) => brave.videos(...a); };

/* ------------------------------------------------------------------ the pull */

const running = new Map();

function lastAtOf(creatorId) {
  const p = readProgress(creatorId);
  return p && p.lastAt ? Date.parse(p.lastAt) : 0;
}

/**
 * The whole sweep for one creator. Resolves when it is finished; the caller normally does not wait
 * (`kick` fires it). `force` ignores the cooldown (the profile's own button).
 */
async function pull(creatorId, { trigger = 'manual', force = false, aborted = () => false } = {}) {
  const creator = repo.creators.get(creatorId);
  if (!creator) return { ok: false, error: 'Creator not found' };
  if (running.has(creatorId)) return { ok: false, started: false, reason: 'already running' };
  const cooldown = COOLDOWN_MS[trigger] || COOLDOWN_MS.manual;
  const last = lastAtOf(creatorId);
  if (!force && Date.now() - last < cooldown) {
    return { ok: true, started: false, reason: 'cooldown', until: new Date(last + cooldown).toISOString() };
  }

  const startedAt = new Date().toISOString();
  writeProgress(creatorId, { startedAt, phase: 'text', done: false, error: null, lastAt: startedAt });
  const work = (async () => {
    const found = { pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0, aliases: 0 };
    const s = settingsStore.get();
    const of = require('../lib/onlyfans').creatorOnlyFans(creator);
    const paid = of ? { service: 'onlyfans', handle: of.handle } : (require('../lib/paid').creatorPaid(creator)[0] || {});
    const ctx = { paidHandle: paid.handle || null };
    const { text, video, rotate } = buildQueries(creator);
    const budget = s.braveDailyBudget;
    writeProgress(creatorId, { phase: 'text', queries: [...text, ...video], found: { pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0, aliases: 0 } });

    // 1. text
    for (const q of text) {
      if (aborted()) break;
      let results = [];
      // Oxylabs answers last, only when every other engine came back empty: deep pulls are where its credits are spent.
      try { results = await searchFn(q, { count: MAX_RESULTS_PER_QUERY, budget, preferKeyless: true, also: ['oxylabs'] }); }
      catch (e) {
        if (e && (e.budget || e.skip)) break; // out of search: keep what we have, try again next time
        events.log('WARN', `Deep pull: "${q}" — ${e.message}`);
        continue;
      }
      for (const hit of results) {
        if (found.pages >= MAX_PAGES || found.feeds >= MAX_FEEDS || aborted()) break;
        found.results++;
        const r = await takeResult(hit, creator, found, ctx);
        if (found.feeds + r.feeds > MAX_FEEDS) r.feeds = Math.max(0, MAX_FEEDS - found.feeds);
        found.feeds += r.feeds; found.paid += r.paid; found.aliases += r.aliases || 0;
        if (r.pages) found.pages++;
      }
    }
    writeProgress(creatorId, { phase: 'video', found: { ...found } });

    // 2. video
    for (const q of video) {
      if (aborted() || found.pages >= MAX_PAGES) break;
      let results = [];
      try { results = await videoFn(q, { count: 12, budget }); } catch { continue; }
      for (const hit of results) {
        if (found.pages >= MAX_PAGES || found.feeds >= MAX_FEEDS) break;
        found.results++;
        const r = await takeResult({ ...hit, url: hit.pageUrl || hit.url }, creator, found, ctx);
        if (found.feeds + r.feeds > MAX_FEEDS) r.feeds = Math.max(0, MAX_FEEDS - found.feeds);
        found.feeds += r.feeds; found.paid += r.paid; found.aliases += r.aliases || 0;
        if (r.pages) found.pages++;
      }
    }
    writeProgress(creatorId, { phase: 'image', found: { ...found } });

    // 3 + 4. image sweep (same picture / face / reverse image) — engine/imagematch does the attribution
    if (s.imageMatch !== false) {
      try {
        const r = await imagematch.matchCreator(creator, {
          budget, aborted, service: paid.service || null, paidHandle: paid.handle || null,
          maxQueries: 6, maxPages: MAX_PAGES, cbirRefs: 3, maxCbir: 12,
        });
        found.pictures += r.pictures || 0;
        found.reviews += r.cbir || 0;                       // reverse-image rows: review queue, no feed
        const registered = Math.max(0, (r.pages || 0) - (r.cbir || 0));
        found.pages += registered;
        found.feeds = Math.min(MAX_FEEDS, found.feeds + registered);
      } catch (e) { events.log('WARN', `Deep pull: image match — ${e.message}`); }
    }

    repo.discoveryState.set(ROTATE_KEY, String((rotate + 1) % SITE_SHAPES.length));
    try { repo.discoveryState.set(`imgmatch.${creator.id}`, new Date().toISOString()); } catch { /* optional */ }
    writeProgress(creatorId, {
      phase: 'done', done: true, error: null, lastAt: new Date().toISOString(), found: { ...found },
    });
    events.log('OK', `Deep pull ${creator.display_name || creator.handle}: ${found.feeds} new feed(s) (cap ${MAX_FEEDS}), ${found.pictures} picture(s) matched, ${found.reviews} review row(s), ${found.results} result(s) read`);
    return { ok: true, ...found };
  })().catch((e) => {
    writeProgress(creatorId, { phase: 'done', done: true, error: String(e.message || e).slice(0, 200), lastAt: new Date().toISOString() });
    events.log('ERR', `Deep pull failed: ${e.message}`);
    return { ok: false, error: e.message };
  }).finally(() => { running.delete(creatorId); });

  running.set(creatorId, work);
  return work;
}

/** Fire and forget: used by the lookup routes and the profile button (it returns at once). */
function kick(creatorId, { trigger = 'lookup', force = false } = {}) {
  if (!settingsStore.get().deepSearch && trigger !== 'manual') return { started: false, reason: 'off in Settings' };
  const creator = repo.creators.get(creatorId);
  if (!creator) return { started: false, error: 'Creator not found' };
  if (running.has(creatorId)) return { started: false, reason: 'already running' };
  const cooldown = COOLDOWN_MS[trigger] || COOLDOWN_MS.manual;
  if (!force && Date.now() - lastAtOf(creatorId) < cooldown) return { started: false, reason: 'cooldown' };
  pull(creatorId, { trigger, force }).catch(() => { /* pull reports its own errors */ });
  return { started: true, creatorId };
}

/**
 * A lookup finished: if it resolved to a creator PRISM already follows, sweep the web for him.
 * Returns the creatorId it kicked (null when the search found nobody we follow).
 */
function fromLookup(result, query) {
  if (!settingsStore.get().deepSearch) return null;
  if (!result || result.error) return null;
  const hit = (result.candidates || []).find((c) => c.creatorId);
  let id = hit ? hit.creatorId : null;
  if (!id) {
    // The query itself may be his name even when none of the found accounts are already followed.
    const q = String(query || result.query || '').replace(/^@/, '').trim();
    if (q.length >= 3) {
      const rows = repo.creators.list({ q, limit: 6, sort: 'name' }).items || [];
      const exact = rows.find((c) => compact(c.handle) === compact(q) || compact(c.display_name) === compact(q));
      id = exact ? exact.id : null;
    }
  }
  if (!id) return null;
  const kicked = kick(id, { trigger: 'lookup' });
  return kicked.started ? id : null;
}

/**
 * Whole-library rotation: nobody should wait for a user to search for him to get the whole-web
 * sweep. Every hour (maintenance tick) a bounded number of followed creators are kicked in a
 * priority order — creatorSeeds names first (the owner's focus list), then creators with a
 * claimed paid page, then whoever has the most live feeds — each at most once a day, so the
 * free search budget stretches across everyone in about two weeks.
 * @returns {{started: number, kicked: string[], skipped: string}}
 */
function rotate({ limit = 2 } = {}) {
  if (!settingsStore.get().deepSearch) return { started: 0, kicked: [], skipped: 'off in Settings' };
  const seeds = String(settingsStore.get().creatorSeeds || '')
    .split(/\n+/).map((s) => compact(s)).filter((s) => s.length >= 3);
  const rows = repo.db.prepare(`SELECT c.id, c.display_name, c.handle, c.media_count,
      (SELECT COUNT(*) FROM feeds f WHERE f.creator_id = c.id AND f.enabled = 1) AS feeds,
      EXISTS(SELECT 1 FROM onlyfans_leads o WHERE o.creator_id = c.id AND o.status = 'claimed') AS paid
    FROM creators c WHERE c.status = 'active' AND c.media_count >= 0
    ORDER BY c.media_count DESC LIMIT 600`).all();
  const scored = rows.map((r) => {
    const blob = compact(`${r.display_name} ${r.handle}`);
    const seed = seeds.some((s) => s && (blob.includes(s) || s.includes(blob)));
    return { ...r, score: (seed ? 3 : 0) + (r.paid ? 2 : 0) + (r.feeds > 0 ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || b.feeds - a.feeds);
  const kicked = [];
  const blockwatch = require('../lib/blockwatch');
  for (const r of scored) {
    if (kicked.length >= limit) break;
    blockwatch.work('deepPull'); // the kick's own search fan-out must not wear whoever ran before it
    const out = kick(r.id, { trigger: 'rotation' });
    blockwatch.work('idle');
    if (out.started) kicked.push(r.display_name || r.handle);
  }
  if (kicked.length) events.log('OK', `Deep-pull rotation: ${kicked.join(', ')}`);
  return { started: kicked.length, kicked };
}

module.exports = { pull, kick, fromLookup, rotate, status, buildQueries, samePerson, accountHandle, foreignFeeds, readProgress, _setSearchers, _resetSearchers };