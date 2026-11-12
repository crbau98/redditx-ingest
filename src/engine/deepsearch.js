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
const COOLDOWN_MS = { manual: 15 * 60 * 1000, lookup: 6 * 60 * 60 * 1000, rotation: 24 * 60 * 60 * 1000, public: 10 * 60 * 1000 };
const FEED_FRESH_MS = 10 * 60 * 1000;
const PULL_WAIT_MS = 8_000;
const PULL_POLL_MS = 500;
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
  const found = p && p.found ? { enqueuedFeeds: 0, ...p.found } : null;
  return {
    running: running.has(creatorId),
    phase: p ? p.phase || null : null,
    done: !!(p && p.done),
    startedAt: p ? p.startedAt || null : null,
    lastAt: p ? p.lastAt || null : null,
    error: p ? p.error || null : null,
    found,
    postsAdded: p ? postsAddedFromProgress(creatorId, p) : 0,
    queries: p ? p.queries || [] : [],
    // Visitors may start another pull after this window. Lookup and rotation keep their own, longer gaps.
    cooldownMs: lastAt ? Math.max(0, lastAt + COOLDOWN_MS.public - Date.now()) : 0,
    enabled: !!settingsStore.get().deepSearch,
  };
}

function publishedMediaCount(creatorId) {
  try {
    return repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE creator_id = ? AND publish_state = 'published'").get(creatorId).n || 0;
  } catch { return 0; }
}

function postsAddedOf(job) {
  if (!job) return 0;
  return Math.max(0, publishedMediaCount(job.creatorId) - (job.baselineMediaCount || 0)) + (job.directAdded || 0);
}

function postsAddedFromProgress(creatorId, p) {
  if (!p || p.baselineMediaCount == null) return (p && p.postsAdded) || 0;
  return Math.max(0, publishedMediaCount(creatorId) - p.baselineMediaCount) + (p.directAdded || 0);
}

const blankFound = () => ({ pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0, aliases: 0, enqueuedFeeds: 0 });

/* ------------------------------------------------------------------ queries */

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Is this ACCOUNT his? Only when the account's own handle is his: the same as his name or handle, or one containing it
 * (enough letters to be an identity). A search result that merely mentions him (fan art, a repost, a site-wide feed or
 * index whose snippet names him) proves nothing about whose account it is: attaching those glued other men's accounts,
 * their posts and their names onto one creator. Pages are judged separately (namesCreator) and stay page feeds.
 */
// A real given name that starts with a filler ("the" in Theodore) must not lose that stem.
const GIVEN_STEM = /^(theodor|theophil|theobald|theodoric|thelonious)/;
const STEM_WORDS = ['official', 'real', 'the', 'vip', 'free', 'xxx', 'xx', 'nsfw', 'gay', 'fit'];

/** Platform filler off a compact handle: official/real/the/vip/free/xxx/xx/nsfw/gay/fit, one trailing x, or 1–2 trailing digits. */
function stemHandle(norm) {
  let s = String(norm || '');
  let prev;
  do {
    prev = s;
    for (const w of STEM_WORDS) {
      const rest = s.length - w.length;
      if (rest < 5) continue;
      if (s.startsWith(w) && !(w === 'the' && GIVEN_STEM.test(s))) s = s.slice(w.length);
      if (s.endsWith(w) && s.length - w.length >= 5) s = s.slice(0, s.length - w.length);
    }
    if (s.endsWith('x') && s.length - 1 >= 5) s = s.slice(0, -1);
    const digits = /^(.*?)(\d{1,2})$/.exec(s);
    if (digits && digits[1].length >= 5) s = digits[1];
  } while (s !== prev && s.length);
  return s;
}

/** True when the two compact handles differ by at most one insert, delete, or substitution. */
function editWithinOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 1) return false;
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[n] <= 1;
}

/**
 * Is this ACCOUNT his? His own name or handle (containment needs enough letters), a known alias or lead,
 * the same stem once filler is removed, or one edit away on a handle of 7+ characters.
 * A third argument that is not a list is ignored: a snippet that merely mentions him is not a handle.
 * @param {object} creator
 * @param {string} handle
 * @param {string[]} [knownHandles]
 */
function samePerson(creator, handle, knownHandles = []) {
  const h = compact(handle);
  if (!h) return false;
  const extras = Array.isArray(knownHandles) ? knownHandles : [];
  const primary = [creator && creator.display_name, creator && creator.handle, creator && creator.slug];
  const seen = new Set();
  for (let i = 0; i < primary.length + extras.length; i++) {
    const raw = i < primary.length ? primary[i] : extras[i - primary.length];
    const n = compact(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (n === h) return true;
    // Containment stays on his own name and handle. An alias of "smith" must not claim every *smith account.
    if (i < primary.length && ((h.length >= 5 && n.length >= 5 && h.includes(n)) || (n.length >= 5 && h.length >= 4 && n.includes(h)))) return true;
    const hs = stemHandle(h);
    const ns = stemHandle(n);
    if (hs.length >= 5 && hs === ns) return true;
    if (h.length >= 7 && n.length >= 7 && editWithinOne(h, n)) return true;
  }
  return false;
}

/** The handle an account feed is known by: a link hub's own name, else the target before any "@instance". */
function accountHandle(platform, target) {
  const t = String(target || '').trim();
  if (platform === 'linkinbio') {
    return linkHubHandle(t) || (() => { try { return new URL(t).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })();
  }
  // A page URL (pornhub / xhamster models, …): the account is its last path segment.
  if (/^https?:\/\//i.test(t)) {
    try { const segs = new URL(t).pathname.split('/').filter(Boolean); return decodeURIComponent(segs[segs.length - 1] || ''); } catch { return t; }
  }
  // A mirror target ("onlyfans/dante_colle", "fansly/jake"): the account is after the service.
  if (platform === 'coomer' || /^[a-z]+\/[^/]+$/i.test(t)) return t.split('/').pop();
  // "@handle" (YouTube) or "user@instance" (Mastodon, Misskey): the handle, without the "@" or the instance.
  return t.replace(/^@+/, '').split('@')[0];
}

/**
 * Admin, read-only: account feeds that discovery or a deep pull attached to a creator although the account's own
 * handle is not his (samePerson). Before f63d517 a result that only mentioned him could attach an account; this lists
 * what to check. Web page and RSS feeds are left out: they are editorial (attached because they name him), not his
 * account. Nothing is
 * changed here; each row is cleaned up with POST /api/admin/feeds/:id/media/reassign.
 */
const FOREIGN_ORIGINS = ['deep-search', 'discovered'];
function foreignFeeds({ limit = 100, offset = 0 } = {}) {
  const rows = repo.db.prepare(`SELECT f.id, f.platform, f.kind, f.target, f.origin, f.enabled, c.id AS creatorId, c.handle AS creatorHandle,
      c.display_name AS creatorName
    FROM feeds f JOIN creators c ON c.id = f.creator_id
    WHERE f.origin IN (${FOREIGN_ORIGINS.map(() => '?').join(',')}) AND f.platform NOT IN ('web', 'rss')
    ORDER BY c.handle, f.platform, f.target`).all(...FOREIGN_ORIGINS);
  // Already-attached feeds are not proof of themselves, or a wrong account would vanish from this list.
  const matchByCreator = new Map();
  const matchHandles = (id) => {
    if (!matchByCreator.has(id)) {
      matchByCreator.set(id, gatherKnown(id).filter((row) => row.match && row.source !== 'feed').map((row) => row.handle));
    }
    return matchByCreator.get(id);
  };
  const foreign = rows.filter((r) => !samePerson({ handle: r.creatorHandle, display_name: r.creatorName }, accountHandle(r.platform, r.target), matchHandles(r.creatorId)));
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

/**
 * Handles we already believe are his.
 * Columns are the live ones: creator_aliases.alias (not term), onlyfans_leads.status (not state),
 * feeds.target (there is no feeds.handle). A bio-only alias is searched but not trusted to attach an account.
 * @returns {{handle: string, match: boolean, source: 'alias'|'lead'|'feed'}[]}
 */
function gatherKnown(creatorId) {
  const out = [];
  if (!creatorId) return out;
  try {
    for (const row of repo.db.prepare('SELECT alias, kind, source FROM creator_aliases WHERE creator_id = ?').all(creatorId)) {
      if (row.alias) out.push({ handle: row.alias, match: row.source !== 'bio', source: 'alias' });
    }
    for (const row of repo.db.prepare("SELECT handle FROM onlyfans_leads WHERE creator_id = ? AND status != 'rejected'").all(creatorId)) {
      if (row.handle) out.push({ handle: row.handle, match: true, source: 'lead' });
    }
    for (const row of repo.db.prepare('SELECT platform, target FROM feeds WHERE creator_id = ? AND target IS NOT NULL AND enabled = 1').all(creatorId)) {
      const handle = feedHandle(row.platform, row.target);
      if (handle) out.push({ handle, match: true, source: 'feed' });
    }
  } catch { /* identity tables must never fail a pull */ }
  return out;
}

/** The strings loadCreatorKnownHandles promises: every alias, live lead, and enabled account feed. */
function loadCreatorKnownHandles(creatorId) {
  return gatherKnown(creatorId).map((row) => row.handle);
}

/** A feed target worth searching as a handle. Page and RSS URLs are not handles. */
function feedHandle(platform, target) {
  if (!platform || platform === 'web' || platform === 'rss') return '';
  const h = accountHandle(platform, target);
  if (!h || /[/?#\s]/.test(h) || h.length > 40) return '';
  if (compact(h).length < 4) return '';
  return h;
}

/** Up to three aliases that say more than his display name. Longer compact forms first. */
function pickSearchHandles(creator, known) {
  const own = new Set([compact(creator && creator.handle), compact(creator && creator.display_name)].filter(Boolean));
  const scored = [];
  const seen = new Set();
  for (const raw of known || []) {
    const alias = String(raw || '').trim().replace(/["']/g, '').slice(0, 40);
    const n = compact(alias);
    if (n.length < 4 || own.has(n) || seen.has(n)) continue;
    seen.add(n);
    scored.push({ alias, n });
  }
  scored.sort((a, b) => b.n.length - a.n.length || a.alias.localeCompare(b.alias));
  return scored.slice(0, 3).map((row) => row.alias);
}

/** The eight rotating site shapes plus the four standing phrases, name and handle substituted. */
function buildQueries(creator, knownHandles) {
  const name = String(creator.display_name || creator.handle || '').trim();
  const handle = String(creator.handle || '').trim();
  const phrase = (s) => s.replace(/\{name\}/g, name).replace(/\{handle\}/g, handle || name);
  const rotate = parseInt(repo.discoveryState.get(ROTATE_KEY) || '0', 10) || 0;
  const sites = SITE_SHAPES.map((_, i) => SITE_SHAPES[(i + rotate) % SITE_SHAPES.length]);
  const known = knownHandles === undefined
    ? loadCreatorKnownHandles(creator && creator.id)
    : (Array.isArray(knownHandles) ? knownHandles : []);
  const extras = [];
  for (const alias of pickSearchHandles(creator, known)) {
    extras.push(`"${alias}" (onlyfans OR linktree OR twitter OR x.com OR instagram OR tiktok OR reddit OR bsky)`);
    extras.push(`"${alias}" (gay OR nsfw OR muscle OR bear OR hunk OR jock OR porn OR xxx)`);
  }
  return {
    text: [...PHRASE_SHAPES.map(phrase), ...sites.slice(0, MAX_TEXT_QUERIES - PHRASE_SHAPES.length).map((s) => `"${name}" ${s}`), ...extras],
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
    if (linkOut && OK_HANDLE.test(handle) && samePerson(creator, handle, ctx && ctx.matchHandles)) {
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
      : samePerson(creator, handle, ctx && ctx.matchHandles);
    if (!proven) continue;
    if (spec.platform === 'web') {
      try { if (!(await require('../sources/web').robotsAllows(spec.target))) continue; } catch { continue; }
    }
    const r = targets.addSpec(spec, { creatorId: creator.id, origin: 'deep-search', trusted: true });
    if (r && r.feed && ctx && ctx.enqueuedFeedIds && shouldEnqueueFeed(r.feed, r.status === 'created') && !ctx.enqueuedFeedIds.has(r.feed.id)) {
      ctx.enqueuedFeedIds.add(r.feed.id);
      try { enqueueDiscovered([r.feed.id]); } catch { /* a pull finishes even when the scheduler is down */ }
    }
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
let enqueueImpl = null;
const _setEnqueuer = (fn) => { enqueueImpl = typeof fn === 'function' ? fn : null; };
const _resetSearchers = () => {
  searchFn = (...a) => websearch.search(...a);
  videoFn = (...a) => brave.videos(...a);
  enqueueImpl = null;
};

/** A new feed, or one this creator has not fetched in the last 10 minutes, should run now. */
function shouldEnqueueFeed(feed, created) {
  if (!feed || !feed.id) return false;
  if (created) return true;
  const at = feed.last_run_at ? Date.parse(feed.last_run_at) : NaN;
  if (!at || Number.isNaN(at)) return true;
  return Date.now() - at >= FEED_FRESH_MS;
}

function enqueueDiscovered(feedIds) {
  if (!feedIds || !feedIds.length) return 0;
  try {
    if (enqueueImpl) return enqueueImpl(feedIds) || 0;
    // Tests must not start live platform fetches. Production enqueues with force so the new account is read now.
    if (config.isTest) return 0;
    return require('./engine').enqueue(feedIds, { force: true, trigger: 'deep-search' }) || 0;
  } catch { return 0; }
}

function enqueuedSettled(job) {
  let engine;
  try { engine = require('./engine'); } catch { return true; }
  const state = engine._state;
  if (!state) return true;
  for (const id of job.enqueuedFeedIds) {
    if (state.running.has(id)) return false;
    if (state.queue.some((q) => q.feedId === id)) return false;
  }
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** After the search, give the enqueued feeds a short window to land posts. Tests do not wait. */
async function waitForEnqueued(job, aborted) {
  const budget = config.isTest ? 0 : PULL_WAIT_MS;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (typeof aborted === 'function' && aborted()) break;
    if (postsAddedOf(job) > 0) break;
    if (enqueuedSettled(job)) break;
    const slice = Math.min(PULL_POLL_MS, deadline - Date.now());
    if (slice <= 0) break;
    await sleep(slice);
  }
}

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
  const baselineMediaCount = publishedMediaCount(creatorId);
  const job = { creatorId, baselineMediaCount, enqueuedFeedIds: new Set(), directAdded: 0 };
  writeProgress(creatorId, { startedAt, phase: 'text', done: false, error: null, lastAt: startedAt, baselineMediaCount, postsAdded: 0 });
  const work = (async () => {
    const found = blankFound();
    const s = settingsStore.get();
    const of = require('../lib/onlyfans').creatorOnlyFans(creator);
    const paid = of ? { service: 'onlyfans', handle: of.handle } : (require('../lib/paid').creatorPaid(creator)[0] || {});
    const gathered = gatherKnown(creator.id);
    const ctx = {
      paidHandle: paid.handle || null,
      enqueuedFeedIds: job.enqueuedFeedIds,
      matchHandles: gathered.filter((row) => row.match).map((row) => row.handle),
    };
    const { text, video, rotate } = buildQueries(creator, gathered.map((row) => row.handle));
    const budget = s.braveDailyBudget;
    const foundNow = () => ({ ...found, enqueuedFeeds: job.enqueuedFeedIds.size });
    writeProgress(creatorId, { phase: 'text', queries: [...text, ...video], found: foundNow(), postsAdded: 0, baselineMediaCount });

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
    writeProgress(creatorId, { phase: 'video', found: foundNow(), postsAdded: postsAddedOf(job), baselineMediaCount });

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
    writeProgress(creatorId, { phase: 'image', found: foundNow(), postsAdded: postsAddedOf(job), baselineMediaCount });

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
    if (job.enqueuedFeedIds.size > 0) {
      writeProgress(creatorId, { phase: 'pulling', found: foundNow(), postsAdded: postsAddedOf(job), baselineMediaCount });
      await waitForEnqueued(job, aborted);
    }
    const postsAdded = postsAddedOf(job);
    writeProgress(creatorId, {
      phase: 'done', done: true, error: null, lastAt: new Date().toISOString(),
      found: foundNow(), postsAdded, baselineMediaCount, directAdded: job.directAdded,
    });
    events.log('OK', `Deep pull ${creator.display_name || creator.handle}: ${found.feeds} new feed(s) (cap ${MAX_FEEDS}), ${job.enqueuedFeedIds.size} enqueued, ${postsAdded} new post(s), ${found.pictures} picture(s) matched, ${found.reviews} review row(s), ${found.results} result(s) read`);
    return { ok: true, ...foundNow(), postsAdded };
  })().catch((e) => {
    writeProgress(creatorId, { phase: 'done', done: true, error: String(e.message || e).slice(0, 200), lastAt: new Date().toISOString() });
    events.log('ERR', `Deep pull failed: ${e.message}`);
    return { ok: false, error: e.message };
  }).finally(() => { running.delete(creatorId); });

  running.set(creatorId, work);
  return work;
}

/**
 * Visitor entry: the public route calls this with force false, so the 10-minute public cooldown holds.
 * A client cannot skip it; the route does not forward a force flag.
 */
function start(creatorId, { force = false } = {}) {
  return kick(creatorId, { trigger: 'public', force: !!force });
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

module.exports = {
  pull, kick, start, fromLookup, rotate, status, buildQueries, samePerson, stemHandle,
  loadCreatorKnownHandles, accountHandle, foreignFeeds, readProgress, _setSearchers, _setEnqueuer, _resetSearchers,
};