'use strict';
/**
 * Creator lookup: type a name, a performer name, a handle or a profile link and PRISM finds the person's public
 * accounts across the platforms it can read, shows the evidence, and (on request) follows them all as ONE creator
 * and pulls their material in straight away.
 *
 *   1. direct probes   the handle (and a few name-derived variants) on every platform that has user profiles
 *   2. searches        Bluesky people search, RedGIFs creators, web search (Brave / SearXNG) over the name
 *   3. expansion       bios and link-in-bio pages of what was found reveal their other accounts
 *   4. verification    every candidate is read through its real adapter (profile + a few posts), so "found" means
 *                      "exists and has content", never just "a URL looked plausible"
 *   5. gates           minor-safety (dropped), male-only scope incl. the picture filter on avatars (excluded)
 *
 * Nothing here writes until `follow()` is called, and `follow()` re-applies every gate.
 */
const registry = require('../sources');
const repo = require('../db/repo');
const config = require('../config');
const websearch = require('../lib/websearch');
const brave = require('../lib/brave');
const imagefilter = require('../lib/imagefilter');
const { parseProfile, extractLinks, profileUrl, linkHubHandle } = require('../lib/links');
const { checkText } = require('../lib/safety');
const takedowns = require('../lib/takedowns');
const { femaleCheck, classify } = require('../lib/scope');
const { ofLink } = require('../lib/onlyfans');
const paid = require('../lib/paid');
const events = require('./events');

const PROBE_TIMEOUT_MS = 18000;
const DEADLINE_MS = 55000;
const CONCURRENCY = 6;
const MAX_VARIANTS = 3;
const MAX_VERIFY = 14;

/* -------------------------------------------------------------------- helpers */
const compact = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);

function bigrams(s) { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); } return out; }
/** Sørensen–Dice over character bigrams, 0..1. */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a); const B = bigrams(b);
  let inter = 0;
  for (const [k, n] of A) inter += Math.min(n, B.get(k) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/** How well does a handle / display name match what the user typed? 0..1 */
function nameSimilarity(query, ...fields) {
  const q = compact(query); const qw = words(query);
  let best = 0;
  for (const f of fields) {
    const c = compact(f); if (!c) continue;
    let s = dice(q, c);
    if (c === q) s = 1;
    else if (q.length >= 4 && (c.includes(q) || (c.length >= 4 && q.includes(c)))) s = Math.max(s, 0.88);
    const fw = new Set(words(f));
    if (qw.length > 1 && qw.every((w) => fw.has(w) || c.includes(w))) s = Math.max(s, 0.9);
    best = Math.max(best, s);
  }
  return best;
}

/** Split what was typed into a display name and handle guesses. */
function parseQuery(input) {
  const raw = String(input || '').trim().slice(0, 200);
  const out = { raw, name: null, handles: [], spec: null, externalSpec: null };
  if (!raw) return out;
  const spec = registry.parseInput(raw);
  if (spec && !spec.external && (spec.kind === 'user' || (spec.kind === 'channel' && spec.platform === 'youtube')) && spec.platform !== 'rss') {
    out.spec = spec;
    const h = String(spec.target).split('@')[0].replace(/\.bsky\.social$/, '') || String(spec.target).replace(/^@/, '');
    if (spec.kind === 'user') out.handles.push(h);
    out.name = h;
    return out;
  }
  if (spec && spec.external) {
    const h = spec.handle
      || (spec.service ? paid.paidHandle(spec.service, raw) : null)
      || (() => { try { return (new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, ''); } catch { return ''; } })();
    if (h && /^[A-Za-z0-9_.\-]{2,40}$/.test(h)) {
      out.externalSpec = spec;
      out.handles.push(h.toLowerCase());
      const stripped = h.toLowerCase().replace(/[_.\-]+/g, '');
      if (stripped !== h.toLowerCase() && stripped.length >= 3) out.handles.push(stripped);
      out.name = h;
      out.handles = out.handles.slice(0, MAX_VARIANTS);
      return out;
    }
  }
  const bare = raw.replace(/^@/, '').replace(/^u\//i, '');
  const ws = words(bare);
  if (/^[A-Za-z0-9_.\-]{2,40}$/.test(bare) && !/\s/.test(raw)) { // handle-like
    out.handles.push(bare.toLowerCase());
    const stripped = bare.toLowerCase().replace(/[_.\-]+/g, '');
    if (stripped !== bare.toLowerCase() && stripped.length >= 3) out.handles.push(stripped);
    out.name = bare;
  } else if (ws.length) { // "Jax Stone" -> jaxstone, jax_stone, jax.stone
    out.name = raw;
    const joined = (sep) => ws.slice(0, 3).join(sep);
    for (const v of [joined(''), ws.length > 1 ? joined('_') : '']) if (v.length >= 3 && !out.handles.includes(v)) out.handles.push(v);
  }
  out.handles = out.handles.slice(0, MAX_VARIANTS);
  return out;
}

async function pool(tasks, limit, deadline) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      if (Date.now() > deadline) return;
      const idx = i++;
      try { results[idx] = await tasks[idx](); } catch (e) { results[idx] = { error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label || 'request'} timed out`), { status: 0 })), ms).unref())]);

/* ----------------------------------------------------------------- candidates */
const keyOf = (c) => `${c.platform}:${c.kind}:${String(c.target).toLowerCase()}`;

class Pool {
  constructor() { this.map = new Map(); }
  add(spec, { source, evidence, displayName, bio, avatarUrl, followers, handleExact } = {}) {
    if (!spec || spec.external || !spec.ingestable) return null;
    if (!['user', 'page'].includes(spec.kind) && !(spec.kind === 'channel' && spec.platform === 'youtube')) return null; // a person's accounts, not communities / searches
    if (spec.platform === 'web' || spec.platform === 'rss') return null;
    if (spec.platform === 'linkinbio' && spec.kind !== 'page') return null;
    if (takedowns.checkHandle(spec.target, spec.platform) || (spec.url && takedowns.checkUrl(spec.url))) return null;
    const k = keyOf(spec);
    let c = this.map.get(k);
    if (!c) {
      c = { platform: spec.platform, kind: spec.kind, target: spec.target, label: spec.label || spec.target, url: spec.url || profileUrl(spec.platform, spec.kind, spec.target), displayName: null, bio: null, avatarUrl: null, followers: 0, sources: new Set(), evidence: [], verified: false, sampleCount: 0, samples: [], links: [], handleExact: false };
      this.map.set(k, c);
    }
    if (source) c.sources.add(source);
    if (evidence && !c.evidence.includes(evidence)) c.evidence.push(evidence);
    if (displayName && !c.displayName) c.displayName = displayName;
    if (bio && !c.bio) c.bio = bio;
    if (avatarUrl && !c.avatarUrl) c.avatarUrl = avatarUrl;
    if (followers) c.followers = Math.max(c.followers, followers);
    if (handleExact) c.handleExact = true;
    return c;
  }
  list() { return [...this.map.values()]; }
}

/* ---------------------------------------------------------------------- probes */
/** Read a candidate through its real adapter: profile + a few posts. Marks it verified when something is there. */
async function verify(c) {
  const adapter = registry.get(c.platform);
  if (!adapter || !adapter.kinds.includes(c.kind)) return false;
  const conf = adapter.isConfigured(c.kind);
  if (conf && conf.ok === false) { c.note = conf.note || 'not configured'; return false; }
  try {
    const feed = { id: 'lookup', platform: c.platform, kind: c.kind, target: c.target, trusted: 1, label: c.label };
    const res = await withTimeout(adapter.fetch(feed, { cursor: {}, limit: 8, force: true, needProfile: true, aborted: () => false }), PROBE_TIMEOUT_MS, `${c.platform} read`);
    const items = res.items || [];
    const p = res.profile || {};
    c.sampleCount = items.length;
    c.samples = items.slice(0, 4).map((i) => {
      const preview = i.previewUrl || (i.mediaType === 'image' ? i.mediaUrl : null);
      return { type: i.mediaType, preview, thumb: preview, title: i.title || null, url: i.permalink || c.url || null };
    });
    if (p.displayName && !c.displayName) c.displayName = p.displayName;
    if (p.bio && !c.bio) c.bio = String(p.bio).slice(0, 500);
    if (p.avatarUrl && !c.avatarUrl) c.avatarUrl = p.avatarUrl;
    c.links = (p.links || []).filter((l) => l && (l.target || l.url));
    c.verified = !!(items.length || p.displayName || p.bio);
    // Handles that differ only by case/platform suffix: keep what the platform itself reports.
    if (p.handle && c.platform === 'bluesky') c.target = p.handle;
    return c.verified;
  } catch (e) {
    c.note = e && e.status === 404 ? 'not found' : String((e && e.message) || e).slice(0, 120);
    return false;
  }
}

function instancesFor(platform) { return (platform === 'mastodon' ? config.mastodonInstances : config.misskeyInstances).slice(0, 2); }

/** Handles to try directly, per platform. */
function directSpecs(q) {
  const specs = [];
  if (q.spec) specs.push(q.spec);
  for (const h of q.handles) {
    const handle = h.replace(/^@/, '');
    if (/^[A-Za-z0-9_]{3,40}$/.test(handle)) {
      specs.push({ platform: 'reddit', kind: 'user', target: handle, label: `u/${handle}`, ingestable: true });
      specs.push({ platform: 'redgifs', kind: 'user', target: handle, label: handle, ingestable: true });
      specs.push({ platform: 'x', kind: 'user', target: handle, label: `@${handle}`, ingestable: true });
      specs.push({ platform: 'telegram', kind: 'user', target: handle, label: handle, ingestable: true });
      for (const inst of instancesFor('mastodon')) specs.push({ platform: 'mastodon', kind: 'user', target: `${handle}@${inst}`, label: `@${handle}@${inst}`, ingestable: true });
      for (const inst of instancesFor('misskey')) specs.push({ platform: 'misskey', kind: 'user', target: `${handle}@${inst}`, label: `@${handle}@${inst}`, ingestable: true });
    }
    if (/^[A-Za-z0-9][A-Za-z0-9.-]{1,60}$/.test(handle)) {
      const bsky = handle.replace(/_/g, '-'); // Bluesky handles are domain names: no underscores
      specs.push({ platform: 'bluesky', kind: 'user', target: bsky.includes('.') ? bsky : `${bsky}.bsky.social`, label: bsky, ingestable: true });
      if (/^[A-Za-z0-9-]{3,32}$/.test(handle)) specs.push({ platform: 'tumblr', kind: 'user', target: handle.toLowerCase(), label: `${handle} (Tumblr)`, ingestable: true });
      if (/^[A-Za-z0-9_.-]{3,40}$/.test(handle)) specs.push({ platform: 'youtube', kind: 'user', target: `@${handle.toLowerCase()}`, label: `@${handle} (YouTube)`, ingestable: true });
    }
    // Federated user probes: PeerTube + Lemmy join the direct handle sweep.
    if (/^[A-Za-z0-9_.-]{3,40}$/.test(handle)) {
      for (const inst of (config.peertubeInstances || []).slice(0, 2)) {
        specs.push({ platform: 'peertube', kind: 'user', target: `${handle.toLowerCase()}@${inst}`, label: `${handle}@${inst} (PeerTube)`, ingestable: true });
      }
      const lemmyInst = (config.lemmyInstances || [])[0];
      if (lemmyInst && /^[A-Za-z0-9_]{3,30}$/.test(handle)) {
        specs.push({ platform: 'lemmy', kind: 'user', target: `${handle}@${lemmyInst}`, label: `${handle}@${lemmyInst} (Lemmy)`, ingestable: true });
      }
    }
  }
  const seen = new Set();
  return specs.filter((s) => { const k = keyOf(s); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function searchPeople(q, pl, notes, deadline) {
  const term = q.name || q.raw;
  const tasks = [];
  const bsky = registry.get('bluesky');
  if (bsky && bsky.searchActors) {
    tasks.push(async () => {
      try {
        const actors = await withTimeout(bsky.searchActors(term, 8), 12000, 'bluesky search');
        for (const a of actors) {
          const sim = nameSimilarity(term, a.handle.split('.')[0], a.displayName);
          if (sim < 0.5) continue;
          pl.add({ platform: 'bluesky', kind: 'user', target: a.handle, label: a.handle, ingestable: true }, { source: 'people-search', evidence: 'Bluesky people search', displayName: a.displayName, bio: a.description, avatarUrl: a.avatar, followers: a.followers });
        }
        notes.push({ platform: 'bluesky', step: 'people search', ok: true });
      } catch (e) { notes.push({ platform: 'bluesky', step: 'people search', ok: false, note: e.message }); }
    });
  }
  const rg = registry.get('redgifs');
  if (rg && rg.searchCreators) {
    tasks.push(async () => {
      try {
        const found = await withTimeout(rg.searchCreators(term, { order: 'trending', count: 60 }), 12000, 'redgifs search');
        for (const f of found) {
          const sim = nameSimilarity(term, f.username, f.name);
          if (sim < 0.55) continue;
          pl.add({ platform: 'redgifs', kind: 'user', target: f.username, label: f.username, ingestable: true }, { source: 'people-search', evidence: 'RedGIFs creator search', displayName: f.name, bio: f.description, avatarUrl: f.avatar, followers: f.followers });
        }
        notes.push({ platform: 'redgifs', step: 'creator search', ok: true });
      } catch (e) { notes.push({ platform: 'redgifs', step: 'creator search', ok: false, note: e.message }); }
    });
  }
  await pool(tasks, 3, deadline);
}

async function searchWeb(q, pl, notes, mediaHits = [], webLinks = []) {
  const term = (q.name || q.raw).replace(/"/g, '');
  const canWebSearch = websearch.configured();
  const canDdg = !config.isTest || !!process.env.DDG_BASE_URL || brave.configured();
  if (!canWebSearch && !canDdg) {
    notes.push({ platform: 'web', step: 'web search', ok: false, note: 'no web search configured (BRAVE_API_KEY or SEARXNG_URL)' });
    return null;
  }

  const queries = [`"${term}" (onlyfans OR fansly OR "justfor.fans" OR twitter OR bluesky OR reddit OR redgifs OR telegram OR linktree OR tumblr)`, `"${term}" gay creator links`];
  if (q.handles[0] && compact(q.handles[0]) !== compact(term)) queries.unshift(`"${q.handles[0]}" (onlyfans OR fansly OR "justfor.fans" OR twitter OR bluesky OR reddit OR redgifs OR linktree)`);
  const jobs = queries.slice(0, 3).map((query) => ({ query }));
  for (const site of ['linktr.ee', 'bsky.app', 'x.com']) jobs.push({ query: `"${term}"`, site });
  let provider = null;
  const seenWeb = new Set();
  const seenMedia = new Set();

  const ingestResultSpecs = (r, sourceLabel = 'web-search') => {
    if (!r || !r.url) return;
    const text = `${r.title || ''} ${r.description || ''}`;
    if (takedowns.checkUrl(r.url)) return;
    if (checkText(r.title, r.description).level === 'block') return;
    const specs = [parseProfile(r.url), ...extractLinks(text)].filter(Boolean);
    for (const spec of specs) {
      const handle = spec.platform === 'linkinbio' ? (linkHubHandle(spec.target) || (() => { try { return new URL(spec.target).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })()) : String(spec.target).split('@')[0];
      const sim = Math.max(nameSimilarity(term, handle), nameSimilarity(term, (r.title || '').split(/[(|•·\-–]/)[0]));
      const mentions = compact(text).includes(compact(term)) || words(term).every((w) => compact(text).includes(w));
      if (sim < 0.5 && !(mentions && spec.url === r.url)) continue;
      pl.add(spec, { source: sourceLabel, evidence: `web search: ${(r.title || r.url).slice(0, 70)}`, displayName: (r.title || '').split(/[(|•·\-–]/)[0].trim() || null, bio: r.description });
    }
    if (!seenWeb.has(r.url)) {
      seenWeb.add(r.url);
      webLinks.push({ url: r.url, title: r.title || null, description: r.description || null });
    }
  };

  for (const { query, site } of jobs) {
    try {
      let results;
      if (canWebSearch) {
        results = await websearch.search(query, { count: 20, budget: 200, site });
        provider = results.provider || provider;
      } else {
        results = await brave.web(site ? `${query} site:${site}` : query, { count: 20, budget: 200 });
        provider = provider || (brave.configured() ? 'brave' : 'ddg');
      }
      for (const r of results) ingestResultSpecs(r, 'web-search');
      notes.push({ platform: 'web', step: `web search (${provider || '?'})`, ok: true });
    } catch (e) {
      if (canDdg && (e.skip || e.budget)) {
        try {
          const fallbackHits = await brave.ddgWeb(site ? `${query} site:${site}` : query, { count: 20 });
          provider = provider || 'ddg';
          for (const r of fallbackHits) ingestResultSpecs(r, 'web-search');
          notes.push({ platform: 'web', step: 'web search (ddg)', ok: true });
          continue;
        } catch { /* fall through */ }
      }
      notes.push({ platform: 'web', step: 'web search', ok: false, note: e.message });
      if (e.skip || e.budget) break;
    }
  }

  // Enrich lookup with public web image & video appearances (Brave Images/Videos + DDG fallback)
  if (canDdg) {
    const mediaQuery = q.handles[0] ? `"${q.handles[0]}"` : `"${term}"`;
    const pushMediaHit = (hit) => {
      if (!hit || !hit.url) return;
      const text = `${hit.title || ''} ${hit.description || ''}`;
      if (takedowns.checkUrl(hit.url) || (hit.mediaUrl && takedowns.checkUrl(hit.mediaUrl))) return;
      if (checkText(hit.title, hit.description).level === 'block') return;
      if (femaleCheck(hit.title, hit.description).level === 'hard') return;
      const key = hit.mediaUrl || hit.url;
      if (seenMedia.has(key)) return;
      seenMedia.add(key);
      const parsed = parseProfile(hit.pageUrl || hit.url);
      if (parsed && !parsed.external && parsed.ingestable) {
        ingestResultSpecs({ url: hit.pageUrl || hit.url, title: hit.title || '', description: hit.description || '' }, 'media-search');
      }
      mediaHits.push({
        url: hit.url,
        pageUrl: hit.pageUrl || hit.url,
        mediaUrl: hit.mediaUrl || hit.imageUrl || hit.url,
        thumbnailUrl: hit.thumbnailUrl || hit.imageUrl || null,
        type: hit.type || 'image',
        title: hit.title || null,
        source: hit.source || null,
        platform: parsed && !parsed.external ? parsed.platform : 'web',
      });
    };

    try {
      const [imgs, vids] = await Promise.all([
        brave.images(mediaQuery, { count: 10, budget: 200 }).catch(() => []),
        brave.videos(mediaQuery, { count: 10, budget: 200 }).catch(() => []),
      ]);
      for (const h of imgs || []) pushMediaHit(h);
      for (const h of vids || []) pushMediaHit(h);
    } catch { /* best effort */ }
  }

  return provider;
}

/** Everything external a verified candidate links to (paid pages, tip jars...): shown and stored. */
function externalLinksOf(c) {
  const out = [];
  const free = paid.freeHint(c.bio);
  for (const l of c.links || []) {
    if (!l.external) continue;
    if (l.handle && l.service && paid.SERVICES[l.service] && paid.SERVICES[l.service].trace) out.push(paid.paidLink(l.service, l.handle, { free }));
    else if (l.handle && (!l.service || l.service === 'OnlyFans')) out.push(ofLink(l.handle, { free }));
    else out.push({ platform: 'external', service: l.service, label: l.label, url: l.url });
  }
  for (const { service, handle } of paid.findPaidHandles(c.bio)) {
    if (paid.SERVICES[service] && paid.SERVICES[service].trace && !out.some((e) => e.handle === handle && (e.service || 'OnlyFans') === service)) {
      out.push(paid.paidLink(service, handle, { free }));
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- lookup */
/**
 * @param {string} input name, performer name, handle or profile link
 * @param {{imageCheck?: boolean}} opts
 */
async function lookup(input, { imageCheck = true } = {}) {
  const started = Date.now();
  const deadline = started + DEADLINE_MS;
  const q = parseQuery(input);
  if (!q.raw) return { error: 'Type a name, a handle or a profile link' };
  const unsafe = checkText(q.raw);
  if (unsafe.level === 'block') return { error: 'That search is not allowed' };
  if (femaleCheck(q.raw).level === 'hard') return { error: 'PRISM only follows male creators' };
  if (takedowns.checkHandle(q.raw) || takedowns.checkUrl(q.raw)) return { error: 'This creator has requested a takedown / opt-out' };

  const pl = new Pool();
  const notes = [];
  const mediaHits = [];
  const webLinks = [];

  // 1 + 2: direct probes and searches in parallel
  const direct = directSpecs(q).map((spec) => async () => {
    const c = pl.add(spec, { source: 'direct', evidence: `handle “${String(spec.target).split('@')[0]}” on ${(registry.get(spec.platform) || {}).label || spec.platform}`, handleExact: true });
    if (!c) return false;
    const ok = await verify(c);
    if (!ok) pl.map.delete(keyOf(c)); // a guessed handle that does not exist is not a candidate
    return ok;
  });
  const searches = [
    () => searchPeople(q, pl, notes, deadline),
    () => searchWeb(q, pl, notes, mediaHits, webLinks).then((p) => { q.provider = p; }),
  ];
  await pool([...searches, ...direct], CONCURRENCY, deadline);

  // 3: bios and link-in-bio pages reveal the rest of the person's accounts
  let verified = pl.list().filter((c) => c.verified);
  const pages = pl.list().filter((c) => c.platform === 'linkinbio').slice(0, 4);
  await pool(pages.map((c) => () => verify(c)), 4, deadline);
  const expandFrom = pl.list().filter((c) => c.verified || c.platform === 'linkinbio');
  for (const c of expandFrom) {
    const fromLinks = [...(c.links || []), ...extractLinks(c.bio || '')];
    for (const l of fromLinks) {
      if (l.external) continue;
      if (l.platform === 'linkinbio') { pl.add(l, { source: 'bio-link', evidence: `link-in-bio on ${c.label}` }); continue; }
      pl.add(l, { source: 'bio-link', evidence: `linked from ${(registry.get(c.platform) || {}).label || c.platform} profile ${c.label}` });
    }
  }
  const toVerify = pl.list().filter((c) => !c.verified && !c.note && c.platform !== 'linkinbio').slice(0, MAX_VERIFY);
  await pool(toVerify.map((c) => () => verify(c)), CONCURRENCY, deadline);
  // one more hop: link-in-bio pages found in bios
  const pages2 = pl.list().filter((c) => c.platform === 'linkinbio' && !c.verified && !c.note).slice(0, 3);
  await pool(pages2.map((c) => () => verify(c)), 3, deadline);
  for (const c of pl.list().filter((x) => x.platform === 'linkinbio' && x.verified)) {
    for (const l of c.links || []) if (!l.external && l.platform !== 'linkinbio') pl.add(l, { source: 'bio-link', evidence: `listed on link-in-bio ${c.label}` });
  }
  const toVerify2 = pl.list().filter((c) => !c.verified && !c.note && c.platform !== 'linkinbio').slice(0, MAX_VERIFY);
  await pool(toVerify2.map((c) => () => verify(c)), CONCURRENCY, deadline);

  // 4: score, gate, annotate
  const hidden = { safety: 0, notMale: 0, unverified: 0 };
  const externals = [];
  if (q.externalSpec) {
    if (q.externalSpec.handle && q.externalSpec.service && paid.SERVICES[q.externalSpec.service] && paid.SERVICES[q.externalSpec.service].trace) {
      externals.push(paid.paidLink(q.externalSpec.service, q.externalSpec.handle));
    } else if (q.externalSpec.handle) {
      externals.push(ofLink(q.externalSpec.handle));
    }
  }
  const paidByCandidate = new Map();
  const paidCounts = new Map();
  for (const c of pl.list()) {
    const ext = externalLinksOf(c);
    paidByCandidate.set(c, ext);
    if (c.verified) {
      for (const l of ext) {
        if (l.handle) {
          const pk = `${l.service || 'OnlyFans'}:${l.handle}`;
          paidCounts.set(pk, (paidCounts.get(pk) || 0) + 1);
        }
      }
    }
  }
  const out = [];
  for (const c of pl.list()) {
    const cExt = paidByCandidate.get(c) || [];
    if (c.platform === 'linkinbio') { externals.push(...cExt); continue; }
    externals.push(...cExt);
    if (!c.verified) { hidden.unverified++; continue; }
    const text = [c.target, c.label, c.displayName, c.bio];
    if (checkText(...text).level === 'block') { hidden.safety++; continue; }
    if (femaleCheck(...text).level === 'hard') { hidden.notMale++; continue; }
    const sc = classify(text, { trusted: true });
    const handle = String(c.target).split('@')[0];
    const sim = Math.max(nameSimilarity(q.raw, handle, c.displayName), q.handles.length ? Math.max(...q.handles.map((h) => nameSimilarity(h, handle))) : 0);
    const paidMatch = cExt.some((l) => l.handle && (
      (q.externalSpec && q.externalSpec.handle === l.handle)
      || q.handles.some((h) => compact(h) === compact(l.handle))
      || (paidCounts.get(`${l.service || 'OnlyFans'}:${l.handle}`) || 0) >= 2
    ));
    const independent = c.sources.size;
    let conf = 0.12 + 0.5 * sim + (c.handleExact ? 0.08 : 0) + (c.sources.has('bio-link') || paidMatch ? 0.22 : 0) + (c.sources.has('web-search') ? 0.08 : 0) + (c.sources.has('people-search') ? 0.06 : 0)
      + (independent > 1 ? 0.06 * (independent - 1) : 0) + (c.sampleCount ? 0.07 : 0) + (c.followers >= 100 ? 0.03 : 0);
    if (sim < 0.4 && !c.sources.has('bio-link') && !paidMatch) conf = Math.min(conf, 0.4);
    conf = Math.max(0.05, Math.min(0.99, conf));
    const existing = repo.feeds.find(c.platform, c.kind, c.target);
    const blocked = repo.blocklist.has('creator', `${c.platform}:${String(c.target).toLowerCase()}`);
    out.push({
      platform: c.platform, kind: c.kind, target: c.target, label: c.label, url: c.url,
      displayName: c.displayName, bio: c.bio ? String(c.bio).slice(0, 240) : null, avatarUrl: c.avatarUrl, followers: c.followers,
      sampleCount: c.sampleCount, samples: c.samples, sample: c.samples[0] || null, evidence: c.evidence.slice(0, 5), male: sc.male,
      confidence: Math.round(conf * 100) / 100, tier: conf >= 0.7 ? 'strong' : conf >= 0.45 ? 'likely' : 'weak',
      status: blocked ? 'blocked' : existing ? 'following' : 'new', feedId: existing ? existing.id : null, creatorId: existing ? existing.creator_id : null,
    });
  }
  out.sort((a, b) => b.confidence - a.confidence || b.sampleCount - a.sampleCount);

  // the picture filter on avatars of the best candidates: a woman's face as the profile picture is not a male creator
  if (imageCheck && out.length && await imagefilter.available()) {
    for (const c of out.slice(0, 8)) {
      if (!c.avatarUrl || Date.now() > deadline + 8000) continue;
      const v = imagefilter.judge(await imagefilter.analyze(c.avatarUrl), 0.5);
      if (v.female) { c.excluded = 'profile picture shows a woman'; hidden.notMale++; }
    }
  }
  const visible = out.filter((c) => !c.excluded);

  const seenExt = new Set();
  const externalLinks = externals.filter((l) => { const k = l.url; if (seenExt.has(k)) return false; seenExt.add(k); return true; }).slice(0, 12);
  const searched = [...new Set(directSpecs(q).map((s) => s.platform))];
  const result = {
    query: q.raw,
    name: q.name,
    handles: q.handles,
    candidates: visible,
    accounts: visible,
    externalLinks,
    mediaHits: mediaHits.slice(0, 24),
    webLinks: webLinks.slice(0, 24),
    hidden,
    notes,
    searched,
    webSearch: q.provider || null,
    ms: Date.now() - started,
  };
  events.log('INFO', `Lookup "${q.raw}": ${visible.length} account(s) (${visible.filter((c) => c.tier === 'strong').length} strong) in ${result.ms} ms`);
  return result;
}

/* ---------------------------------------------------------------------- follow */
const tokenFor = (c) => {
  switch (c.platform) {
    case 'reddit': return `u/${c.target}`;
    case 'misskey': return `misskey:${c.target}`;
    case 'peertube': return `peertube:${c.target}`;
    case 'tumblr': return `tumblr:${c.target}`;
    case 'mastodon': return `@${c.target}`;
    default: return profileUrl(c.platform, c.kind, c.target) || c.target;
  }
};

/**
 * Follow the chosen accounts as ONE creator and start pulling their material in immediately (deeper than a
 * routine run). Every gate is re-applied here: the client's idea of "safe" is never trusted.
 * @param {{name: string, selections: Array<{platform, kind, target}>, externalLinks?: object[], bio?: string}} body
 */
function follow({ name, selections, externalLinks = [], bio, creatorId = null } = {}) {
  const targets = require('../services/targets');
  const accepted = []; const rejected = [];
  for (const s of (selections || []).slice(0, 30)) {
    if (!s || !s.platform || !s.target) continue;
    const adapter = registry.get(s.platform);
    const kind = s.kind || 'user';
    if (!adapter || !adapter.kinds.includes(kind) || (!['user', 'page'].includes(kind) && !(kind === 'channel' && s.platform === 'youtube'))) { rejected.push({ ...s, reason: 'unsupported' }); continue; } // a person's accounts, not communities
    if (femaleCheck(s.target, s.label).level === 'hard') { rejected.push({ ...s, reason: 'not male-focused' }); continue; }
    if (checkText(s.target, s.label).level === 'block') { rejected.push({ ...s, reason: 'safety' }); continue; }
    if (repo.blocklist.has('creator', `${s.platform}:${String(s.target).toLowerCase()}`)) { rejected.push({ ...s, reason: 'blocklisted' }); continue; }
    if (takedowns.checkHandle(s.target, s.platform)) { rejected.push({ ...s, reason: 'takedown' }); continue; }
    accepted.push({ platform: s.platform, kind, target: String(s.target), label: s.label });
  }
  if (!accepted.length) return { error: 'Nothing to follow', rejected };
  const cleanName = String(name || '').trim().slice(0, 80) || String(accepted[0].target).split('@')[0];
  if (femaleCheck(cleanName, bio).level === 'hard') return { error: 'PRISM only follows male creators', rejected };
  if (checkText(cleanName, bio).level === 'block') return { error: 'Rejected by the safety gate', rejected };

  let res;
  if (creatorId) { // "find more accounts" for a creator that already exists: attach to them instead of creating anyone
    const existing = repo.creators.get(creatorId);
    if (!existing || existing.status !== 'active') return { error: 'Creator not found or not active', rejected };
    const feeds = []; const conflicts = [];
    for (const a of accepted) {
      const r = targets.addSpec(registry.parseInput(tokenFor(a)) || a, { creatorId: existing.id });
      if (r.status === 'conflict') conflicts.push({ input: a.target, reason: r.reason, creatorId: r.creator.id });
      else if (r.feed) feeds.push(r.feed);
    }
    if (!feeds.length && !conflicts.length) return { error: 'Nothing to follow', rejected };
    res = { creator: repo.creators.detail(existing.id), feeds, conflicts };
  } else {
    res = targets.addCreator({ name: cleanName, bio, inputs: accepted.map(tokenFor).join('\n') });
  }
  if (res.error) return { ...res, rejected };
  const paid = require('../lib/paid');
  const ext = (externalLinks || []).filter((l) => l && /^https?:\/\//i.test(l.url || '')).slice(0, 12)
    .map((l) => {
      const svc = l.service || paid.serviceOf(l.url);
      const h = l.handle || (svc ? paid.paidHandle(svc, l.url) : null);
      return h && svc && paid.SERVICES[svc] && paid.SERVICES[svc].trace ? paid.paidLink(svc, h, { free: !!l.free }) : { platform: 'external', service: l.service, label: l.label, url: l.url };
    });
  require('./identity').addAlias(res.creator.id, cleanName, { kind: 'name', source: 'lookup' }); // the name he was looked up by
  if (ext.length) repo.creators.enrich(res.creator.id, { links: ext });
  for (const l of ext) if (l.handle) repo.onlyfans.claim(l.handle, res.creator.id, l.service || 'OnlyFans'); // their page: no need to trace it as a lead
  const feedIds = res.feeds.map((f) => f.id);
  let queued = 0;
  try { queued = require('./engine').enqueue(feedIds, { force: true, trigger: 'lookup', limit: 300 }); } catch { /* engine not running (tests) */ }
  repo.logAction('creator', res.creator.id, 'lookup-follow', `${feedIds.length} accounts`, 'admin');
  return { ok: true, creator: res.creator, feeds: res.feeds, conflicts: res.conflicts, rejected, queued: typeof queued === 'number' ? queued : feedIds.length };
}

/** One call: look the person up and follow every strong, new, verified match. */
async function findAndFollow(input, { minConfidence = 0.7 } = {}) {
  const found = await lookup(input);
  if (found.error) return found;
  const picks = found.candidates.filter((c) => c.status === 'new' && c.confidence >= minConfidence && (c.kind === 'user' || (c.kind === 'channel' && c.platform === 'youtube')));
  if (!picks.length) return { ...found, followed: null, note: 'No strong new match to follow automatically — review the candidates and pick the right accounts.' };
  const followed = follow({ name: found.name || input, selections: picks, externalLinks: found.externalLinks });
  return { ...found, followed };
}

module.exports = { lookup, run: lookup, follow, findAndFollow, searchWeb, parseQuery, nameSimilarity, directSpecs, dice };
