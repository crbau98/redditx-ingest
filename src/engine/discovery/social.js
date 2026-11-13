'use strict';
/** Part of discovery (src/engine/discovery.js), moved here unchanged: social and search scouts: the Bluesky graph and suggestions, web identity and topic search, community and people search, the Reddit archive poster scout, image-keyword search and creator-mention search. */
const config = require('../../config');
const repo = require('../../db/repo');
const settingsStore = require('../../settings');
const events = require('../events');
const brave = require('../../lib/brave');
const websearch = require('../../lib/websearch');
const registry = require('../../sources');
const { parseProfile, extractLinks, profileUrl, linkHubHandle, isMisskeyHost, cleanDisplayName, cleanSlug } = require('../../lib/links');
const takedowns = require('../../lib/takedowns');
const { classify, femaleCheck } = require('../../lib/scope');
const net = require('../../lib/net');
const jina = require('../../lib/jina');
const phash = require('../../lib/phash');
const dedupe = require('../../services/dedupe');
const paid = require('../../lib/paid');
const { WEIGHTS, CAPS, scoreOf, describeSignals, mergeSignal } = require('../discovery-score');
const { leadKey, bskyHttp, archiveHttp, splitCamel, gate, borderline, CREATOR_STRONG, CREATOR_HINT, coreHandle, usable, consider, sameName, noteSearchedPaid, ADULT_HINT, keywordList } = require('./core');

/** Who do followed Bluesky creators follow? Accounts followed by several of them are strong leads. */
async function blueskyGraph({ creators = 4, aborted = () => false } = {}) {
  const targets = repo.discoveryTargets({ platform: 'bluesky', prefix: 'bsky.follows.', staleDays: 7, limit: creators });
  let found = 0; let checked = 0;
  for (const t of targets) {
    if (aborted()) break;
    try {
      const json = await bskyHttp.json(`${config.baseUrls.bsky}/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(t.target)}&limit=100`);
      checked++;
      for (const p of json.follows || []) {
        const labels = (p.labels || []).map((l) => l.val);
        if (labels.includes('!no-unauthenticated')) continue;
        const spec = parseProfile(`https://bsky.app/profile/${p.handle}`);
        if (!spec) continue;
        const adult = labels.some((l) => ['porn', 'sexual', 'nudity'].includes(l));
        const existing = repo.candidates.find(spec.platform, spec.kind, spec.target);
        // Only open a new candidate for accounts that look like creators; always add to existing ones.
        if (!existing && !adult && !CREATOR_HINT.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
        if (consider(spec, 'cofollow', t.id, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar })) found++;
      }
    } catch (e) { events.log('WARN', `Discovery: Bluesky follows of ${t.target} — ${e.message}`); }
    repo.discoveryState.set(`bsky.follows.${t.id}`, new Date().toISOString());
  }
  return { checked, found };
}

/** Find a known creator's other accounts by searching the web for their exact handle. */
async function braveIdentity({ creators = 3, budget, aborted = () => false } = {}) {
  const targets = repo.discoveryTargets({ prefix: 'brave.identity.', staleDays: 14, limit: creators, minMedia: 2, maxAccounts: 4 })
    .filter((t) => coreHandle(t.handle).length >= 4);
  let linked = 0; let searched = 0;
  for (const t of targets) {
    if (aborted()) break;
    const core = coreHandle(t.handle);
    const namePart = String(t.display_name || '').trim().split(/\s+/).slice(0, 2).join(' ');
    const nameQ = namePart && namePart.length >= 3 ? ` OR "${namePart}"` : '';
    let results;
    try { results = await websearch.search(`("${core}"${nameQ}) (onlyfans OR fansly OR "justfor.fans" OR manyvids OR loyalfans OR fanvue OR patreon OR bluesky OR twitter OR x.com OR reddit OR redgifs OR telegram OR linktree OR allmylinks OR beacons)`, { budget }); searched++; } catch (e) {
      if (e.budget || e.skip) break; // out of budget: try this creator again next time
      events.log('WARN', `Discovery: web search for ${t.handle} failed — ${e.message}`);
      results = [];
    }
    repo.discoveryState.set(`brave.identity.${t.id}`, new Date().toISOString());
    for (const r of results) {
      if (takedowns.checkUrl(r.url)) continue;
      const snippet = `${r.title || ''} ${r.description || ''}`;
      const specs = [parseProfile(r.url), ...extractLinks(snippet)];
      for (const spec of specs) {
        if (!usable(spec) || spec.kind === 'community') continue;
        const handle = spec.platform === 'linkinbio' ? (linkHubHandle(spec.target) || (() => { try { return new URL(spec.target).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })()) : spec.target;
        const same = handle && coreHandle(handle) === core;
        // Same handle = strong identity signal; different handle on a page that mentions the core name/handle is still a lead, attributed to this creator
        if (!same && !snippet.toLowerCase().includes(core.toLowerCase()) && !String(t.display_name || '').toLowerCase().split(/\s+/).some((w) => w.length >= 4 && snippet.toLowerCase().includes(w.toLowerCase()))) continue;
        const c = consider(spec, 'identity', t.id, { displayName: t.display_name, creatorId: t.id });
        if (c) linked++;
      }
      // Paid page in search becomes ingestible public page + traced to free accounts in the same run (discovery does this already via noteSearchedPaid)
      const svc = paid.serviceOf(r.url);
      const ph = svc ? paid.paidHandle(svc, r.url) : null;
      if (svc && ph) noteSearchedPaid(svc, ph, r);
    }
  }
  return { searched, linked };
}

/** Rotate through the admin's topic searches; every profile link in the results becomes a lead. */
async function braveTopics({ queries = 1, budget, aborted = () => false } = {}) {
  // The admin's queries first, then the ones Claude planned today (engine/ai.js; empty without it).
  const own = String(settingsStore.get().discoveryQueries || '').split('\n').map((q) => q.trim()).filter(Boolean);
  const list = [...own, ...require('../ai').plannedQueries().filter((q) => !own.some((o) => o.toLowerCase() === q.toLowerCase()))];
  if (!list.length) return { searched: 0, found: 0 };
  let idx = parseInt(repo.discoveryState.get('brave.topics.index', '0'), 10) || 0;
  let found = 0; let searched = 0;
  for (let i = 0; i < queries; i++) {
    if (aborted()) break;
    const q = list[idx % list.length];
    idx++;
    let results;
    try { results = await websearch.search(q, { budget }); searched++; } catch (e) {
      if (e.budget || e.skip) break;
      events.log('WARN', `Discovery: web search "${q}" failed — ${e.message}`);
      continue;
    }
    for (const r of results) {
      const svc = paid.serviceOf(r.url);
      const ph = svc ? paid.paidHandle(svc, r.url) : null;
      if (svc && paid.SERVICES[svc] && paid.SERVICES[svc].trace && ph) {
        // A paid page is a public page too: read it so its public media is ingested, and keep
        // tracing it to his free public accounts as before.
        try { require('../paidpage').registerPaidPage(r.url, { origin: 'search-paid' }); }
        catch (err) { events.log('WARN', `Could not register the paid page ${r.url}: ${err.message}`); }
        if (noteSearchedPaid(svc, ph, r)) found++;
        continue;
      }
      const specs = [parseProfile(r.url), ...extractLinks(`${r.description} ${r.title}`)];
      for (const spec of specs) if (consider(spec, 'search', q, { displayName: (r.title || '').split(/[(|•·-]/)[0].trim() || null, bio: r.description || null })) found++;
    }
  }
  repo.discoveryState.set('brave.topics.index', String(idx % Math.max(1, list.length)));
  return { searched, found };
}

/**
 * Reach beyond who we already follow: search Reddit for NSFW subreddits, Bluesky for popular
 * custom feeds, and list the busiest NSFW communities on known Lemmy instances (once a day).
 * Keywords rotate (two per run). Every hit is a 'search' signal plus its audience size.
 */
async function communityDiscovery({ keywords = 2, aborted = () => false } = {}) {
  const list = keywordList();
  const out = { searched: 0, found: 0, reddit: 0, bluesky: 0 };
  const reddit = registry.get('reddit'); const bluesky = registry.get('bluesky');
  let idx = parseInt(repo.discoveryState.get('community.index', '0'), 10) || 0;
  for (let i = 0; i < Math.min(keywords, list.length); i++) {
    if (aborted()) break;
    const kw = list[idx % list.length];
    idx++;
    if (reddit && reddit.searchSubreddits) {
      try {
        out.searched++;
        for (const sr of await reddit.searchSubreddits(kw, 25)) {
          if (!sr.over18 || borderline(sr.name, sr.title, sr.description)) continue; // SFW subs rarely carry the media this app is for
          const c = consider(parseProfile(`r/${sr.name}`), 'search', `reddit:${kw}`, { displayName: sr.title || splitCamel(sr.name), bio: sr.description, popularity: sr.subscribers, avatarUrl: sr.icon });
          if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.reddit++; }
        }
      } catch (e) { events.log('WARN', `Discovery: Reddit community search "${kw}" — ${e.message}`); }
    }
    if (aborted()) break;
    if (bluesky && bluesky.searchFeeds) {
      try {
        out.searched++;
        for (const f of await bluesky.searchFeeds(kw, 25)) {
          if (!ADULT_HINT.test(`${f.displayName || ''} ${f.description || ''}`) || borderline(f.displayName, f.description)) continue;
          const spec = parseProfile(f.uri);
          if (spec && f.displayName) spec.label = `Feed: ${f.displayName}`;
          const c = consider(spec, 'search', `bluesky:${kw}`, { displayName: f.displayName, bio: f.description, popularity: f.likeCount, avatarUrl: f.avatar });
          if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.bluesky++; }
        }
      } catch (e) { events.log('WARN', `Discovery: Bluesky feed search "${kw}" — ${e.message}`); }
    }
  }
  if (list.length) repo.discoveryState.set('community.index', String(idx % list.length));
  return out;
}

/* ------------------------------------------------- v4.9: prolific Reddit posters */
// One appearance in a listing proves little. Read the newest posts of the communities we already
// follow from the Arctic Shift archive (keyless, free, real time, and it does not spend Reddit's
// one-request-a-minute anonymous quota), tally who actually posts there, then measure each
// shortlisted author on their own last 100 submissions and count only posts that carry usable
// media. Only sustained output becomes a lead; a chatterbox in a text-only sub does not.
const POSTER_7D = 4;    // media posts in the last 7 days
const POSTER_30D = 12;  // or media posts in the last 30 days
const POSTER_LOOKBACK = 100; // archive rows per request; the API's maximum

// Arctic Shift answers 422 two ways. "Timeout. Maybe slow down a bit" is its rate limit: a wait, so it is thrown as one,
// never an empty result. Any other 422 is a name it will not search (an odd character): retried once with letters,
// digits, "_" and "-" only; a name with nothing to clean is a clean empty result.
const archiveErrorText = (e) => (typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? e.message ?? ''));
const isArchiveRateLimit = (e) => /slow down|timeout/i.test(archiveErrorText(e));
const rateLimitedArchive = (e) => Object.assign(new Error(`Reddit archive is rate limiting: ${archiveErrorText(e).slice(0, 80)}`), { status: 429, retryAfter: 60_000 });
async function archivePosts(params) {
  const send = (p) => archiveHttp.json(`${config.baseUrls.redditArchive}/api/posts/search?${new URLSearchParams({ limit: String(POSTER_LOOKBACK), sort: 'desc', ...p })}`);
  let json;
  try {
    json = await send(params);
  } catch (e) {
    if (!e || e.status !== 422) throw e;
    if (isArchiveRateLimit(e)) throw rateLimitedArchive(e);
    const clean = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v).replace(/[^A-Za-z0-9_-]/g, '')]));
    if (Object.keys(params).every((k) => clean[k] === String(params[k]))) return [];
    try {
      json = await send(clean);
    } catch (e2) {
      if (!e2 || e2.status !== 422) throw e2;
      if (isArchiveRateLimit(e2)) throw rateLimitedArchive(e2);
      return [];
    }
  }
  return ((Array.isArray(json) ? json : json.data) || []).filter((r) => r && r.id);
}

/** Posts inside the window that really parse to media (galleries and videos included). */
function mediaCount(reddit, rows, windowSeconds) {
  const cutoff = Date.now() / 1000 - windowSeconds;
  let n = 0;
  for (const row of rows) {
    if (Number(row.created_utc) < cutoff) continue;
    try { if (reddit.parsePost(row).some((i) => i.mediaUrl)) n++; } catch { /* one odd row must not stop the count */ }
  }
  return n;
}

/**
 * Follow people who provably post: sample the newest submissions of followed communities, tally
 * authors, measure the busiest ones over 7 and 30 days, and queue the sustained ones with the
 * `poster` signal. Communities rotate (cursor), so the whole followed set is covered over time.
 */
async function redditPosters({ subreddits = 3, leads = 8, aborted = () => false } = {}) {
  const reddit = registry.get('reddit');
  const out = { subreddits: 0, authors: 0, measured: 0, qualified: 0, found: 0 };
  if (!reddit || !reddit.parsePost || !settingsStore.get().redditEnabled) return out;
  const subs = repo.db.prepare(`SELECT target FROM feeds WHERE platform = 'reddit' AND kind = 'community'
      AND enabled = 1 AND items_total >= 20 ORDER BY id`).all().map((r) => r.target);
  if (!subs.length) return out;
  let idx = parseInt(repo.discoveryState.get('poster.index', '0'), 10) || 0;
  const tally = new Map();
  for (let i = 0; i < Math.min(subreddits, subs.length); i++) {
    if (aborted()) break;
    const sub = subs[idx % subs.length];
    idx++;
    let rows;
    try { rows = await archivePosts({ subreddit: sub }); } catch (e) { events.log('WARN', `Discovery: Reddit archive r/${sub} — ${e.message}`); continue; }
    out.subreddits++;
    for (const row of rows) {
      if (!row.author || row.author === '[deleted]' || /^automoderator$/i.test(row.author)) continue;
      try { if (!reddit.parsePost(row).some((i) => i.mediaUrl)) continue; } catch { continue; }
      tally.set(row.author, (tally.get(row.author) || 0) + 1);
    }
  }
  if (subs.length) repo.discoveryState.set('poster.index', String(idx % subs.length));
  out.authors = tally.size;
  // Busiest first. A person we already follow, or already have queued, does not need a second look.
  const shortlist = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
    .filter((name) => !repo.feeds.find('reddit', 'user', name))
    .filter((name) => { const c = repo.candidates.find('reddit', 'user', name); return !c || c.status !== 'pending'; })
    .slice(0, leads);
  for (const author of shortlist) {
    if (aborted()) break;
    let rows;
    try { rows = await archivePosts({ author }); } catch (e) { events.log('WARN', `Discovery: Reddit archive u/${author} — ${e.message}`); continue; }
    out.measured++;
    const d7 = mediaCount(reddit, rows, 7 * 86400);
    const d30 = mediaCount(reddit, rows, 30 * 86400);
    if (d7 < POSTER_7D && d30 < POSTER_30D) continue;
    out.qualified++;
    const own = rows.filter((r) => Number(r.created_utc) >= Date.now() / 1000 - 30 * 86400);
    // The community names are the account-level evidence: a single post title that says "my girl took
    // this" would otherwise reject the person outright, while every item is judged again at ingest.
    const where = [...new Set(own.map((r) => r.subreddit).filter(Boolean))].slice(0, 6);
    const karma = own.reduce((n, r) => n + (Number(r.score) || 0), 0);
    const c = consider(
      { platform: 'reddit', kind: 'user', target: author, label: `u/${author}`, ingestable: true },
      'poster', `${d7} in 7d, ${d30} in 30d`,
      { displayName: author, bio: where.join(' · '), popularity: karma },
    );
    if (c && c.status === 'pending' && c.scope !== 'excluded') out.found++;
  }
  return out;
}

/* ---------------------------------------------- v4.9: keyword image discovery */
// Text search finds pages that SAY the right words. Image search finds pages that SHOW the right
// picture, which is how the best amateur profiles are tagged. Free tiers only: Bing's image feed over
// plain HTTP, then the same query through Jina's renderer when the plain feed is challenged or empty.
// Nobody is charged and the page itself is never scraped here: a picture only proves the page exists.
// A picture already in the library (same perceptual hash) is skipped before it is fetched twice, so
// the lane cannot re-queue a page PRISM already knows from a copy of a photo it already has.
const IMAGE_HITS = 20;
const IMAGE_LEADS = 6;
const IMAGE_MAX_BYTES = 2_000_000;
let imageProvider = null; // tests replace the search provider

async function searchImages(query, count) {
  if (imageProvider) return imageProvider(query, count);
  const hits = await brave.bingImages(query, { count });
  if (hits.length) return hits;
  // Second free tier: the same query rendered by Jina (it runs a real browser elsewhere). Budgeted.
  const s = settingsStore.get();
  if (!jina.configured() || !s.jinaDailyBudget) return hits;
  try {
    const r = await jina.read(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}`, { format: 'html', budget: s.jinaDailyBudget });
    return brave.parseBingImages(r.html, count);
  } catch (e) { events.log('INFO', `Discovery: image search "${query}" via Jina — ${e.message}`); return hits; }
}

/**
 * Search the rotation of keywords for pictures and queue the pages they come from. A page is skipped
 * when the picture is already stored (pHash), when the host is blocked, or when the page is not a
 * profile shape PRISM can follow.
 */
async function imageKeywordDiscovery({ keywords = 1, hits = IMAGE_HITS, leads = IMAGE_LEADS, aborted = () => false } = {}) {
  const list = keywordList();
  const out = { searched: 0, hits: 0, fetched: 0, duplicates: 0, found: 0 };
  if (!list.length || hits <= 0 || leads <= 0) return out;
  let idx = parseInt(repo.discoveryState.get('image.index', '0'), 10) || 0;
  for (let i = 0; i < Math.min(keywords, list.length) && out.found < leads; i++) {
    if (aborted()) break;
    const kw = list[idx % list.length];
    idx++;
    let rows;
    try { rows = await searchImages(kw, hits); } catch (e) { events.log('WARN', `Discovery: image search "${kw}" — ${e.message}`); continue; }
    out.searched++;
    const seen = new Set();
    // Loaded once per batch, not per hit: the index is complete before a check (a partial one can miss a duplicate or a blocked picture).
    if (rows.length) await dedupe.loadChunked().catch(() => {});
    for (const hit of rows) {
      if (aborted() || out.found >= leads) break;
      const page = hit.pageUrl || hit.url;
      const img = hit.imageUrl || hit.mediaUrl;
      if (!page || !img || page === img || seen.has(page)) continue;
      seen.add(page);
      let spec;
      try { spec = parseProfile(page); } catch { spec = null; }
      if (!spec || !usable(spec)) continue;
      if (repo.feeds.find(spec.platform, spec.kind, spec.target)) continue;
      out.hits++;
      let hex = null;
      try {
        const res = await net.request(img, { maxBytes: IMAGE_MAX_BYTES, timeout: 12000 });
        out.fetched++;
        hex = await phash.hashBuffer(res.body);
      } catch { /* an unreadable picture still proves the page exists, but cannot be de-duplicated */ }
      if (hex) {
        await new Promise((r) => setTimeout(r, 0)); // one hit at a time: a batch of checks never blocks the loop in one stretch
        const d = dedupe.check({ phash: hex, mediaType: 'image' }, { distance: 6 });
        if (d.dup || d.blocked) { out.duplicates++; continue; }
      }
      const c = consider(spec, 'imagesearch', `image:${kw}`, { displayName: hit.title || spec.label, bio: hit.description || null, avatarUrl: spec.platform === 'linkinbio' ? img : null });
      if (c && c.status === 'pending' && c.scope !== 'excluded') out.found++;
    }
  }
  if (list.length) repo.discoveryState.set('image.index', String(idx % list.length));
  return out;
}

/* ------------------------------------------------------- v4.7: wider reach */

/** Communities where several of the creators we follow already post. Pure SQL. */
function creatorHangouts({ minCreators = 2 } = {}) {
  let found = 0;
  for (const h of repo.communityHangouts({ minCreators })) {
    let spec = null;
    if (h.platform === 'reddit') spec = parseProfile(`r/${h.community}`);
    // the RedGIFs niches followed creators post in (an untrusted feed: every item still needs a male signal)
    else if (h.platform === 'redgifs' && /^[a-z0-9-]{2,60}$/i.test(h.community)) spec = { platform: 'redgifs', kind: 'niche', target: h.community.toLowerCase(), label: h.community, ingestable: true };
    if (!spec) continue;
    let c = null;
    const shown = h.platform === 'reddit' ? `r/${h.community}` : h.platform === 'redgifs' ? h.community.replace(/-/g, ' ') : h.community;
    for (const cid of h.ids.slice(0, CAPS.hangout)) c = consider(spec, 'hangout', cid, { displayName: shown }) || c;
    if (c && c.status === 'pending' && c.scope !== 'excluded') found++;
  }
  return { found };
}

/** Bluesky's own "accounts like this one" for followed creators (refreshed weekly per creator). */
async function blueskySuggested({ creators = 4, aborted = () => false } = {}) {
  const bsky = registry.get('bluesky');
  if (!bsky || !bsky.suggestedFor) return { checked: 0, found: 0 };
  const targets = repo.discoveryTargets({ platform: 'bluesky', prefix: 'bsky.similar.', staleDays: 7, limit: creators });
  let found = 0; let checked = 0;
  for (const t of targets) {
    if (aborted()) break;
    try {
      for (const p of await bsky.suggestedFor(t.target)) {
        if (p.labels.includes('!no-unauthenticated')) continue;
        const spec = parseProfile(`https://bsky.app/profile/${p.handle}`);
        if (!spec) continue;
        const adult = p.labels.some((l) => ['porn', 'sexual', 'nudity'].includes(l));
        const existing = repo.candidates.find(spec.platform, spec.kind, spec.target);
        if (!existing && !adult && !CREATOR_HINT.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
        const c = consider(spec, 'similar', t.id, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar, popularity: p.followers });
        if (c && c.status === 'pending') found++;
      }
      checked++;
    } catch (e) { events.log('WARN', `Discovery: Bluesky suggestions for ${t.target} — ${e.message}`); }
    repo.discoveryState.set(`bsky.similar.${t.id}`, new Date().toISOString());
  }
  return { checked, found };
}

/**
 * Keyword people search: Bluesky and Misskey-family accounts whose name/bio match, and the RedGIFs
 * creators behind the top results for the keyword. Uses the same rotating community keywords (one per run).
 */
async function peopleSearch({ aborted = () => false } = {}) {
  const list = keywordList();
  const out = { searched: 0, found: 0, bluesky: 0, redgifs: 0, misskey: 0 };
  if (!list.length) return out;
  let idx = parseInt(repo.discoveryState.get('people.index', '0'), 10) || 0;
  const kw = list[idx % list.length];
  repo.discoveryState.set('people.index', String((idx + 1) % list.length));
  const bsky = registry.get('bluesky');
  if (bsky && bsky.searchActors && !aborted()) {
    try {
      out.searched++;
      for (const p of await bsky.searchActors(kw, 25)) {
        if (p.labels.includes('!no-unauthenticated')) continue;
        const adult = p.labels.some((l) => ['porn', 'sexual', 'nudity'].includes(l));
        if (!adult && !CREATOR_STRONG.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
        const c = consider(parseProfile(`https://bsky.app/profile/${p.handle}`), 'search', `bluesky-people:${kw}`, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar, popularity: p.followers });
        if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.bluesky++; }
      }
    } catch (e) { events.log('WARN', `Discovery: Bluesky people search "${kw}" — ${e.message}`); }
  }
  const mk = registry.get('misskey');
  if (mk && mk.searchUsers && !aborted()) {
    for (const host of (config.misskeyInstances || []).slice(0, 2)) {
      if (aborted()) break;
      try {
        out.searched++;
        for (const u of await mk.searchUsers(kw, host, 10)) {
          if (!CREATOR_STRONG.test(`${u.displayName || ''} ${u.description || ''}`)) continue;
          const uHost = (u.host || host).toLowerCase();
          const plHint = uHost === host.toLowerCase() || isMisskeyHost(uHost) ? { platform: 'misskey' } : { platform: 'mastodon' };
          const c = consider(parseProfile(`@${u.username}@${uHost}`, plHint), 'search', `misskey-people:${kw}`, { displayName: u.displayName, bio: u.description, avatarUrl: u.avatar, popularity: u.followers });
          if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.misskey++; }
        }
      } catch (e) { events.log('WARN', `Discovery: Misskey people search "${kw}" on ${host} — ${e.message}`); }
    }
  }
  const rg = registry.get('redgifs');
  if (rg && rg.searchCreators && !aborted()) {
    try {
      out.searched++;
      for (const u of (await rg.searchCreators(kw)).slice(0, 25)) {
        if (u.gifs < 2) continue; // one stray result is not a creator of this kind of content
        const spec = parseProfile(`https://www.redgifs.com/users/${u.username}`);
        const c = consider(spec, 'search', `redgifs:${kw}`, { displayName: u.name || u.username, bio: [u.description, u.tags.join(' ')].filter(Boolean).join(' · ') || null, avatarUrl: u.avatar, popularity: u.followers });
        if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.redgifs++; }
      }
    } catch (e) { events.log('WARN', `Discovery: RedGIFs creator search "${kw}" — ${e.message}`); }
  }
  // Related creators: who posts the most in one of the RedGIFs niches PRISM follows (one niche per run, in rotation).
  // A verified poster is a "similar" lead per niche; an unverified one needs several gifs there and counts as a search hit.
  const niches = rg && rg.nicheCreators ? repo.feeds.list({ platform: 'redgifs', kind: 'niche', enabled: true, limit: 200 }).items.map((f) => f.target) : [];
  if (niches.length && !aborted()) {
    const n = parseInt(repo.discoveryState.get('people.niche', '0'), 10) || 0;
    const niche = niches[n % niches.length];
    repo.discoveryState.set('people.niche', String((n + 1) % niches.length));
    out.niche = niche;
    try {
      out.searched++;
      for (const u of (await rg.nicheCreators(niche)).slice(0, 30)) {
        if (u.gifs < (u.verified ? 2 : 3)) continue;
        const spec = parseProfile(`https://www.redgifs.com/users/${u.username}`);
        const c = consider(spec, u.verified ? 'similar' : 'search', `redgifs-niche:${niche}`, { displayName: u.name || u.username, bio: [u.description, u.tags.join(' ')].filter(Boolean).join(' · ') || null, avatarUrl: u.avatar, popularity: u.followers });
        if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.redgifs++; }
      }
    } catch (e) { events.log('WARN', `Discovery: RedGIFs niche creators "${niche}" — ${e.message}`); }
  }
  return out;
}

/**
 * One web query per subject. The paid-page slug is a search term only — the paid host is just another public page in the results.
 * Display name is added when it is not just the handle, so one request covers handle, name and slug.
 */
function mentionSearchQuery(subject) {
  const handle = String((subject && subject.handle) || '').replace(/^@/, '').trim();
  const service = (subject && subject.service) || 'OnlyFans';
  const host = (paid.PAID_HOSTS && paid.PAID_HOSTS[service]) || 'onlyfans.com';
  const name = String((subject && subject.displayName) || '').replace(/["<>]/g, '').trim();
  const nameBit = name && name.length >= 3 && name.length <= 80 && name.toLowerCase() !== handle.toLowerCase()
    ? ` OR "${name}"` : '';
  const sites = [
    'site:x.com', 'site:twitter.com', 'site:reddit.com', 'site:redgifs.com', 'site:bsky.app',
    'site:t.me', 'site:youtube.com', 'site:pixelfed.social', 'site:mastodon.social',
  ].join(' OR ');
  return `"${host}/${handle}" OR "@${handle}"${nameBit} (${sites})`;
}

function fediHostIsLocal(host) {
  return /^(127\.0\.0\.1|localhost)(:|$)/i.test(String(host || ''));
}

/** Live instances in production. Tests only probe when the instance list points at the mock, so a suite never fans out to the public fediverse. */
function fediMentionsOn() {
  if (!config.isTest) return true;
  const hosts = [...(config.mastodonInstances || []).slice(0, 1), ...(config.misskeyInstances || []).slice(0, 1)];
  return hosts.some(fediHostIsLocal);
}

/**
 * One Mastodon account search and one Misskey username search for this subject.
 * Two requests at most. Bios that do not name the subject and do not read as a creator are dropped.
 */
async function probeFediMentions(subject, creatorId = null, aborted = () => false) {
  const tally = { found: 0, linked: 0 };
  if (aborted() || !subject || !subject.handle || !fediMentionsOn()) return tally;
  const note = (spec, bio, displayName, avatar, followers) => {
    if (!usable(spec) || spec.kind !== 'user') return;
    if (takedowns.checkHandle(spec.target, spec.platform)) return;
    const own = String(spec.target || '').split('@')[0];
    const text = `${displayName || ''} ${bio || ''}`;
    const isSame = sameName(own, subject.handle) || paid.pageLinked(subject.service || 'OnlyFans', text, subject.handle);
    const mentions = String(bio || '').toLowerCase().includes(String(subject.handle).toLowerCase());
    if (!isSame && !mentions && !CREATOR_STRONG.test(text)) return;
    if (gate(displayName, bio, own).level) return;
    const c = consider(spec, creatorId && isSame ? 'identity' : 'mention', creatorId || subject.handle, {
      displayName: displayName || own,
      bio: bio || null,
      avatarUrl: avatar || null,
      popularity: followers,
      ...(creatorId && isSame ? { creatorId } : {}),
    });
    if (!c) return;
    if (creatorId && isSame) tally.linked++; else tally.found++;
  };
  const mastodon = registry.get('mastodon');
  if (mastodon && mastodon.searchAccounts && !aborted()) {
    try {
      for (const u of (await mastodon.searchAccounts(subject.handle, { limit: 5 })).slice(0, 5)) {
        if (aborted()) break;
        const parts = String(u.acct || '').split('@');
        if (parts.length < 2 || !parts[0] || !parts[1]) continue;
        note(parseProfile(`https://${parts[1]}/@${parts[0]}`), u.note, u.displayName, u.avatar, u.followers);
      }
    } catch { /* best effort */ }
  }
  const misskey = registry.get('misskey');
  const mkHost = (config.misskeyInstances || [])[0];
  if (misskey && misskey.searchUsers && mkHost && !aborted()) {
    try {
      for (const u of (await misskey.searchUsers(subject.handle, mkHost, 5)).slice(0, 5)) {
        if (aborted()) break;
        note(parseProfile(`https://${u.host}/@${u.username}`), u.description, u.displayName, u.avatar, u.followers);
      }
    } catch { /* best effort */ }
  }
  return tally;
}

/**
 * Creator mention / collab / feature discovery across X, Reddit, RedGIFs, Bluesky,
 * Telegram, Mastodon, Misskey, YouTube, and the open web (via Brave Web + Images + Videos and DDG fallback).
 *
 * For known creators and active OF/Fansly/JFF leads, searches for public posts, videos, and images
 * mentioning the creator's `@handle`, display name, or paid-page slug (`onlyfans.com/<handle>` and
 * the Fansly / JustFor.Fans equivalents). The slug is a search term only. Every candidate passes
 * `takedowns.check`, `safety`, and `scope.classify`.
 */
async function discoverCreatorMentions({ creators = 3, leads = 3, budget, aborted = () => false } = {}) {
  const out = { checked: 0, found: 0, linked: 0, searched: 0 };
  const activeCreators = repo.discoveryTargets({ prefix: 'mentions.web.', staleDays: 14, limit: creators, minMedia: 0, maxAccounts: 10 });
  const workableLeads = repo.onlyfans.workable(leads);

  const ingestSearchHit = (hit, subject, creatorId = null) => {
    if (!hit || !hit.url) return 0;
    const text = `${hit.title || ''} ${hit.description || ''} ${hit.creator || ''} ${hit.publisher || ''}`;
    if (takedowns.checkUrl(hit.url) || takedowns.checkItem({ title: hit.title, text: hit.description, permalink: hit.url })) return 0;
    if (gate(hit.title, hit.description).level) return 0;

    let added = 0;
    const specs = [parseProfile(hit.url), ...extractLinks(`${hit.url} ${text}`)];
    for (const spec of specs) {
      if (!usable(spec) || spec.kind === 'community') continue;
      if (takedowns.checkHandle(spec.target, spec.platform)) continue;
      const own = spec.platform === 'linkinbio' ? (linkHubHandle(spec.target) || '') : spec.target;
      const isSame = sameName(own, subject.handle);
      const isPaidNamed = subject.service ? paid.pageLinked(subject.service, text, subject.handle) : false;
      const sc = classify([hit.title, hit.description, spec.target, subject.displayName], { trusted: isSame || isPaidNamed });
      if (sc.scope === 'excluded') continue;

      if (creatorId && (isSame || (isPaidNamed && spec.platform === 'linkinbio'))) {
        if (consider(spec, 'identity', creatorId, { displayName: subject.displayName || hit.title, bio: hit.description, creatorId })) {
          out.linked++;
          added++;
        }
      } else if (isPaidNamed || isSame || sc.scope === 'in') {
        const sigType = isPaidNamed && isSame ? 'ofconfirmed' : 'mention';
        const sigVal = creatorId || (subject.service ? leadKey(subject.service, subject.handle) : subject.handle);
        const c = consider(spec, sigType, sigVal, {
          displayName: (hit.title || '').split(/[(|•·-]/)[0].trim() || null,
          bio: hit.description || null,
          avatarUrl: hit.thumbnailUrl || null,
        });
        if (c && c.status === 'pending' && c.scope !== 'excluded') {
          out.found++;
          added++;
        }
      }
    }
    return added;
  };

  const searchAdaptersForSubject = async (subject, creatorId = null) => {
    const qHandle = subject.handle;
    const paidPage = subject.service ? `${paid.PAID_HOSTS[subject.service] || 'onlyfans.com'}/${qHandle}` : `onlyfans.com/${qHandle}`;
    const fedi = await probeFediMentions(subject, creatorId, aborted);
    out.found += fedi.found;
    out.linked += fedi.linked;

    // 1. Reddit post search for paid page or @handle mentions
    const reddit = registry.get('reddit');
    if (reddit && reddit.searchPosts && !aborted()) {
      try {
        const posts = await reddit.searchPosts(`"${paidPage}" OR "${qHandle}"`, 15);
        for (const p of posts || []) {
          if (!p || !p.author) continue;
          if (gate(p.title, p.selftext, p.author).level) continue;
          const spec = parseProfile(`u/${p.author}`);
          if (spec && usable(spec)) {
            const isSame = sameName(p.author, qHandle);
            const sigType = creatorId && isSame ? 'identity' : 'mention';
            const c = consider(spec, sigType, creatorId || qHandle, {
              displayName: p.author,
              bio: p.title || null,
              ...(creatorId && isSame ? { creatorId } : {}),
            });
            if (c && c.status === 'pending') out.found++;
          }
        }
      } catch { /* best effort */ }
    }

    // 2. RedGIFs creator search
    const rg = registry.get('redgifs');
    if (rg && rg.searchCreators && !aborted()) {
      try {
        for (const u of (await rg.searchCreators(qHandle)).slice(0, 8)) {
          if (!u || !u.username || u.gifs < 1) continue;
          const spec = parseProfile(`https://www.redgifs.com/users/${u.username}`);
          if (!usable(spec)) continue;
          const uBio = `${u.description || ''} ${(u.links || []).join(' ')}`;
          const isSame = sameName(u.username, qHandle) || paid.pageLinked(subject.service || 'OnlyFans', uBio, qHandle);
          const mentionsHandle = uBio.toLowerCase().includes(qHandle.toLowerCase());
          if (!isSame && !mentionsHandle && !CREATOR_STRONG.test(uBio)) continue;
          const sigType = isSame ? (creatorId ? 'identity' : 'ofconfirmed') : 'mention';
          const c = consider(spec, sigType, creatorId || leadKey(subject.service || 'OnlyFans', qHandle), {
            displayName: u.name || u.username,
            bio: u.description || null,
            avatarUrl: u.avatar || null,
            popularity: u.followers,
            ...(creatorId && isSame ? { creatorId } : {}),
          });
          if (c) { if (creatorId && isSame) out.linked++; else out.found++; }
        }
      } catch { /* best effort */ }
    }

    // 3. Bluesky actor search
    const bsky = registry.get('bluesky');
    if (bsky && bsky.searchActors && !aborted()) {
      try {
        for (const p of (await bsky.searchActors(qHandle, 8))) {
          if (!p || !p.handle || (p.labels || []).includes('!no-unauthenticated')) continue;
          const spec = parseProfile(`https://bsky.app/profile/${p.handle}`);
          if (!usable(spec)) continue;
          const isSame = sameName(p.handle, qHandle) || paid.pageLinked(subject.service || 'OnlyFans', p.description || '', qHandle);
          if (!isSame && !CREATOR_STRONG.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
          const c = consider(spec, creatorId && isSame ? 'identity' : 'mention', creatorId || qHandle, {
            displayName: p.displayName,
            bio: p.description,
            avatarUrl: p.avatar,
            popularity: p.followers,
            ...(creatorId && isSame ? { creatorId } : {}),
          });
          if (c) { if (creatorId && isSame) out.linked++; else out.found++; }
        }
      } catch { /* best effort */ }
    }

    // 4. Web + Images + Videos search (Brave API or DDG HTML fallback)
    if (!aborted()) {
      const webQ = mentionSearchQuery(subject);
      try {
        const webHits = websearch.configured()
          ? await websearch.search(webQ, { count: 15, budget })
          : await brave.web(webQ, { count: 15, budget });
        out.searched++;
        for (const h of webHits || []) ingestSearchHit(h, subject, creatorId);
      } catch { /* ignore */ }

      try {
        const imgHits = await brave.images(`"${qHandle}" "${paidPage}"`, { count: 10, budget });
        for (const h of imgHits || []) ingestSearchHit(h, subject, creatorId);
      } catch { /* ignore */ }

      try {
        const vidHits = await brave.videos(`"${qHandle}"`, { count: 10, budget });
        for (const h of vidHits || []) ingestSearchHit(h, subject, creatorId);
      } catch { /* ignore */ }
    }
  };

  for (const c of activeCreators) {
    if (aborted()) break;
    if (takedowns.checkHandle(c.handle) || takedowns.checkItem({ creator_id: c.id, author: c.handle })) continue;
    const paidEntries = paid.creatorPaid(c);
    const primaryPaid = paidEntries.find((p) => p.handle) || null;
    await searchAdaptersForSubject({
      handle: (primaryPaid && primaryPaid.handle) || c.handle,
      displayName: c.display_name || c.handle,
      service: (primaryPaid && primaryPaid.service) || 'OnlyFans',
    }, c.id);
    repo.discoveryState.set(`mentions.web.${c.id}`, new Date().toISOString());
    out.checked++;
  }

  for (const lead of workableLeads) {
    if (aborted()) break;
    if (takedowns.checkHandle(lead.handle)) continue;
    if (gate(lead.handle, lead.display_name, lead.bio).level) continue;
    await searchAdaptersForSubject({
      handle: lead.handle,
      displayName: lead.display_name || lead.handle,
      service: lead.service || 'OnlyFans',
    }, lead.creator_id || null);
    out.checked++;
  }

  return out;
}

module.exports = { blueskyGraph, braveIdentity, braveTopics, communityDiscovery, POSTER_7D, POSTER_30D, POSTER_LOOKBACK, archiveErrorText, isArchiveRateLimit, rateLimitedArchive, archivePosts, mediaCount, redditPosters, IMAGE_HITS, IMAGE_LEADS, IMAGE_MAX_BYTES, imageProvider, searchImages, imageKeywordDiscovery, creatorHangouts, blueskySuggested, peopleSearch, mentionSearchQuery, fediHostIsLocal, fediMentionsOn, probeFediMentions, discoverCreatorMentions, _setImageProvider: (fn) => { imageProvider = fn; } };
