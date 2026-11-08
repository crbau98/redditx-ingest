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
const COOLDOWN_MS = { manual: 15 * 60 * 1000, lookup: 6 * 60 * 60 * 1000 };
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
    found: p ? p.found || { pages: 0, feeds: 0, pictures: 0, reviews: 0, results: 0 } : null,
    queries: p ? p.queries || [] : [],
    cooldownMs: lastAt ? Math.max(0, lastAt + cooldown - Date.now()) : 0,
    enabled: !!settingsStore.get().deepSearch,
  };
}

/* ------------------------------------------------------------------ queries */

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Is this result about the man we searched? A handle that contains his name (or the reverse) and
 * is long enough to be a real identity, or his name's words all appearing in the result's own text.
 * A page that only *mentions* him (a listicle, a friend's post) is never his feed.
 */
function samePerson(creator, handle, ...texts) {
  const n = compact(creator.display_name || creator.handle);
  const h = compact(handle);
  // Containment counts only with enough letters to be an identity: a bare surname ("doe" in
  // "Jake Doe") is far too common to claim somebody's account on.
  if (n && h && (n === h || (h.length >= 5 && h.includes(n)) || (n.length >= 5 && h.length >= 4 && n.includes(h)))) return true;
  const blob = compact(texts.join(' '));
  if (!blob || !n) return false;
  const words = String(creator.display_name || creator.handle).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) return false;
  return words.every((w) => blob.includes(compact(w)));
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
async function takeResult(hit, creator, out, ctx) {
  const res = { feeds: 0, pages: 0, paid: 0 };
  if (!passesGates(hit)) return res;
  const text = `${hit.title || ''} ${hit.description || ''}`;
  const specs = [parseProfile(hit.url), ...extractLinks(text)].filter(Boolean);
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
    const handle = spec.platform === 'linkinbio'
      ? (linkHubHandle(spec.target) || (() => { try { return new URL(spec.target).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })())
      : String(spec.target).split('@')[0];
    // The proof differs by kind: a hub or profile page must be under his own name/handle, a web page
    // must name him in its own text. Everything else is only a mention of him.
    const proven = spec.platform === 'web'
      ? namesCreator({ url: spec.target, title: hit.title, description: hit.description }, creator, ctx.paidHandle)
      : samePerson(creator, handle, hit.title, hit.description, spec.target);
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
    const found = { pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0 };
    const s = settingsStore.get();
    const of = require('../lib/onlyfans').creatorOnlyFans(creator);
    const paid = of ? { service: 'onlyfans', handle: of.handle } : (require('../lib/paid').creatorPaid(creator)[0] || {});
    const ctx = { paidHandle: paid.handle || null };
    const { text, video, rotate } = buildQueries(creator);
    const budget = s.braveDailyBudget;
    writeProgress(creatorId, { phase: 'text', queries: [...text, ...video], found: { pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0 } });

    // 1. text
    for (const q of text) {
      if (aborted()) break;
      let results = [];
      try { results = await searchFn(q, { count: MAX_RESULTS_PER_QUERY, budget, preferKeyless: true }); }
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
        found.feeds += r.feeds; found.paid += r.paid;
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
        found.feeds += r.feeds; found.paid += r.paid;
        if (r.pages) found.pages++;
      }
    }
    writeProgress(creatorId, { phase: 'image', found: { ...found } });

    // 3 + 4. image sweep (same picture / face / reverse image) — engine/imagematch does the attribution
    if (s.imageMatch !== false) {
      try {
        const r = await imagematch.matchCreator(creator, {
          budget, aborted, service: paid.service || null, paidHandle: paid.handle || null,
          maxQueries: 6, maxPages: MAX_PAGES, cbirRefs: 3,
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

module.exports = { pull, kick, fromLookup, status, buildQueries, samePerson, readProgress, _setSearchers, _resetSearchers };