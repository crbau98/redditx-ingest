'use strict';
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const repo = require('../db/repo');
const registry = require('../sources');
const events = require('../engine/events');
const age = require('../middleware/age');
const { publicAccounts } = require('../services/targets');
const { understand, buildVocabulary, PAID } = require('../lib/query');
const { search } = require('../engine/search');
const ai = require('../engine/ai');
const claude = require('../lib/claude');
const settingsStore = require('../settings');
const { creatorOnlyFans } = require('../lib/onlyfans');
const { creatorPaid } = require('../lib/paid');
const { normAlias } = require('../lib/alias');

const router = express.Router();

/* ------------------------------------------------------------ serialisation */
function publicMedia(m) {
  if (!m) return null;
  return {
    id: m.id, title: m.title, description: m.description, media_type: m.media_type,
    media_url: m.media_url, preview_url: m.preview_url, thumbnail_url: m.thumbnail_url,
    thumb_url: m.thumb_url || null, tint: m.tint || null,
    hls_url: m.hls_url, has_audio: m.has_audio, width: m.width, height: m.height, duration: m.duration,
    platform: m.platform, community: m.community, author: m.author, source_url: m.source_url,
    score: m.score, likes: m.likes, views: m.views, nsfw_level: m.nsfw_level, posted_at: m.posted_at,
    creator_id: m.creator_id, creator_handle: m.creator_handle, creator_name: m.creator_name, creator_avatar: m.creator_avatar,
    onlyfans: m.creator_links ? creatorOnlyFans({ links: m.creator_links }) : null,
    tags: m.tags || (m.tags_text ? m.tags_text.split(' ').filter(Boolean).slice(0, 10) : []),
    position: m.position, post_key: m.post_key,
    ...(m.reason ? { reason: m.reason } : {}),
    ...(m.similarity !== undefined ? { similarity: m.similarity } : {}),
  };
}

function publicCreator(c) {
  if (!c) return null;
  return {
    id: c.id, handle: c.handle, display_name: c.display_name, bio: c.bio, avatar_url: c.avatar_url, banner_url: c.banner_url,
    links: c.links, verified: c.verified, media_count: c.media_count, video_count: c.video_count, total_score: c.total_score,
    last_media_at: c.last_media_at, previews: c.previews, platforms: c.platforms, added_at: c.created_at,
    onlyfans: creatorOnlyFans(c), paid: creatorPaid(c),
  };
}

const SORTS = new Set(['recent', 'oldest', 'top', 'trending', 'random', 'relevance']);
function mediaFilters(q) {
  const str = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const sort = SORTS.has(q.sort) ? q.sort : undefined;
  return {
    page: repo.clampInt(q.page, 0, 100000, 0),
    limit: repo.clampInt(q.limit, 1, 120, 48),
    type: q.type === 'image' || q.type === 'video' ? q.type : undefined,
    platform: /^[a-z]{1,20}$/.test(q.platform || '') ? q.platform : undefined,
    community: str(q.community || q.subreddit),
    creator: /^[0-9a-f-]{36}$/i.test(q.creator || '') ? q.creator : undefined,
    tag: str(q.tag, 60),
    tagsAll: typeof q.tags === 'string' ? q.tags.split(',').map((t) => t.trim()).filter((t) => /^[\p{L}\p{N}-]{2,40}$/u.test(t)).slice(0, 6) : undefined,
    tagsAny: typeof q.anytags === 'string' ? q.anytags.split(',').map((t) => t.trim()).filter((t) => /^[\p{L}\p{N}-]{2,40}$/u.test(t)).slice(0, 12) : undefined,
    creators: typeof q.creators === 'string' ? q.creators.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100) : undefined,
    ids: typeof q.ids === 'string' ? q.ids.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100) : undefined,
    q: str(q.q, 100),
    sort, seed: q.seed,
    since: ['day', 'week', 'month', 'year'].includes(q.since) ? q.since : undefined,
    level: q.level === 'explicit' || q.level === 'suggestive' ? q.level : undefined,
    // "on Fansly": creators with a page on that paid platform; "athletic": measured lean or athletic
    paidHost: Object.prototype.hasOwnProperty.call(PAID, q.paid || '') ? PAID[q.paid].host : undefined,
    build: q.build === 'fit' ? 'fit' : undefined,
    // Infinite scroll only needs the total once; later pages skip the COUNT(*).
    noCount: q.nocount === '1' && repo.clampInt(q.page, 0, 100000, 0) > 0,
    // "new since" for saved searches: an ISO timestamp, normalised so it compares correctly as text
    after: typeof q.after === 'string' && !Number.isNaN(Date.parse(q.after)) ? new Date(q.after).toISOString() : undefined,
  };
}

// Stale-while-revalidate: the first call computes; after that an expired value is still served
// while a refresh runs on the next tick, so no visitor ever waits for a rebuild (topics, graph…).
// Tests get exact values (synchronous refresh).
const SWR = !config.isTest;
const warmers = [];
/** The hot list-query shapes: first execution pays SQLite statement prep (~0.4 s), so boot runs them. */
const prep = [
  () => repo.media.list({ sort: 'recent', limit: 48 }),
  () => repo.media.list({ sort: 'trending', limit: 48 }),
  () => repo.media.list({ sort: 'foryou', limit: 48 }),
  () => repo.media.list({ platform: 'reddit', limit: 48 }),
  () => repo.media.list({ tag: 'gay', limit: 48 }),
  () => repo.creators.list({ sort: 'media', limit: 48 }),
  () => repo.media.tags(120, 1),
  () => repo.media.communities(100),
];
const ttl = (ms, fn) => {
  let at = 0; let val; let pending = false;
  const refresh = () => { try { val = fn(); at = Date.now(); } finally { pending = false; } };
  const get = () => {
    if (at && Date.now() - at <= ms) return val;
    if (!at || !SWR) { refresh(); return val; }
    if (!pending) { pending = true; setImmediate(refresh); }
    return val;
  };
  warmers.push(get);
  return get;
};
/** Fill every cache once, one per tick, so the first visitors after a deploy never pay for it. */
function warm() {
  // Statement prep is the expensive part of SQLite's first run of a query shape (~0.4 s here):
  // touching the hot list queries once at boot keeps the first page load fast for real users.
  const queue = [...prep, ...warmers, () => repo.library()];
  const next = () => { const g = queue.shift(); if (!g) return; try { g(); } catch (e) { console.error('[warm]', e.message); } setImmediate(next); };
  setImmediate(next);
}

/** The statement-prep half runs immediately: it is microseconds of work per query and must not
 * wait for the cache warmers — a real page load in the first second pays for a cold statement. */
function warmPrep() {
  const queue = [...prep];
  const next = () => { const g = queue.shift(); if (!g) return; try { g(); } catch (e) { console.error('[warm]', e.message); } setImmediate(next); };
  setImmediate(next);
}
// Autocomplete fires per keystroke (three queries: creators, tags, communities). A 10-second
// per-query cache absorbs the burst while typing; the cap keeps one-off queries from growing it.
const suggestCache = new Map();
const SUGGEST_TTL_MS = 10000;
const SUGGEST_CACHE_MAX = 200;
function suggestCached(query, limit = 6) {
  const key = `${String(query || '').slice(0, 40)}|${limit}`;
  const hit = suggestCache.get(key);
  if (hit && Date.now() - hit.at <= SUGGEST_TTL_MS) return hit.val;
  const val = repo.suggest(query, limit);
  suggestCache.set(key, { at: Date.now(), val });
  if (suggestCache.size > SUGGEST_CACHE_MAX) suggestCache.delete(suggestCache.keys().next().value);
  return val;
}
const discoverCached = ttl(30000, () => {
  const d = repo.discover();
  return {
    ...d,
    trending: d.trending.map(publicMedia), freshVideos: d.freshVideos.map(publicMedia),
    topCreators: d.topCreators.map(publicCreator), newCreators: d.newCreators.map(publicCreator),
    rising: d.rising.map((c) => ({ ...publicCreator(c), week_count: c.week_count })),
  };
});
const graphCached = ttl(5 * 60000, () => {
  const g = repo.creators.graph({ limit: 160 });
  return { nodes: g.nodes.map((n) => ({ id: n.id, handle: n.handle, display_name: n.display_name, avatar_url: n.avatar_url, media_count: n.media_count, last_media_at: n.last_media_at, preview: n.preview, group: n.group })), links: g.links };
});
const vocabCached = ttl(60000, () => buildVocabulary(repo.tagIntel.vocabulary()));
const topicsCached = ttl(10 * 60000, () => repo.tagIntel.topics());
const tagsCached = ttl(60000, () => repo.media.tags(120, 1));
const communitiesCached = ttl(60000, () => repo.media.communities(100));

/* ------------------------------------------------------------------- open */
// Event-loop delay: when the server stalls (a long synchronous job), pages time out even though nothing crashed.
const loopDelay = require('perf_hooks').monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
router.get('/health', (req, res) => {
  let dbOk = true;
  try { repo.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  const mem = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576);
  const loop = { p99Ms: Math.round(loopDelay.percentile(99) / 1e6), maxMs: Math.round(loopDelay.max / 1e6) };
  loopDelay.reset();
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', version: config.version, uptime: Math.round(process.uptime()), db: dbOk, memMb: { rss: mb(mem.rss), heap: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external), arrayBuffers: mb(mem.arrayBuffers) }, loop, timestamp: new Date().toISOString() });
});

router.get('/meta', (req, res) => {
  res.json({
    name: 'PRISM', version: config.version,
    ageGate: { enforce: config.ageGateEnforce, verified: age.isVerified(req) },
    platforms: registry.list().filter((a) => !['web', 'linkinbio'].includes(a.platform)).map((a) => ({ platform: a.platform, label: a.label, color: a.color })),
    ai: { search: claude.configured() && settingsStore.get().aiSearch },
  });
});

router.post('/age/confirm', age.confirm);

const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many reports from this address, try again later' } });
const REPORT_KINDS = new Set(['takedown', 'copyright', 'underage', 'nonconsensual', 'other']);
const AUTO_HIDE_KINDS = new Set(['underage', 'nonconsensual']);

// Takedowns must always be possible, so this is deliberately outside the age gate.
router.post('/report', reportLimiter, (req, res) => {
  const { mediaId, creatorId, kind, reason, contact } = req.body || {};
  if (!REPORT_KINDS.has(kind)) return res.status(400).json({ error: 'kind must be one of: takedown, copyright, underage, nonconsensual, other' });
  if (!mediaId && !creatorId) return res.status(400).json({ error: 'mediaId or creatorId is required' });
  const media = mediaId ? repo.media.get(String(mediaId)) : null;
  if (mediaId && !media) return res.status(404).json({ error: 'Media not found' });
  const creator = creatorId ? repo.creators.get(String(creatorId)) : null;
  if (creatorId && !creator) return res.status(404).json({ error: 'Creator not found' });

  const reporterHash = crypto.createHash('sha256').update(`${req.ip}|${new Date().toISOString().slice(0, 10)}`).digest('hex').slice(0, 24);
  const id = repo.reports.create({ mediaId: media && media.id, creatorId: (creator && creator.id) || (media && media.creator_id), kind, reason, contact, reporterHash });
  // Safety reports act immediately; a human reviews afterwards.
  if (AUTO_HIDE_KINDS.has(kind)) {
    if (media) repo.media.setState(media.id, 'hidden', `reported:${kind}`);
    if (creator && kind === 'underage') { repo.creators.update(creator.id, { status: 'hidden' }); repo.logAction('creator', creator.id, 'report-hide', kind, 'system'); }
    repo.logAction('report', id, 'auto-hide', kind, 'system');
  }
  events.admin('report', { id, kind });
  res.status(201).json({ ok: true, id });
});

/* -------------------------------------------------------- age-gated content */
router.use(['/discover', '/stats', '/suggest', '/search', '/recommend', '/graph', '/understand', '/topics', '/media', '/creators', '/tags', '/communities', '/subreddits', '/platforms', '/stream', '/lookup'], age.requireAge);

router.get('/discover', (req, res) => res.json(discoverCached()));
router.get('/stats', (req, res) => res.json(repo.publicStats()));

router.get('/media', (req, res) => {
  const r = repo.media.list(mediaFilters(req.query));
  res.json({ ...r, items: r.items.map(publicMedia) });
});

router.get('/media/:id', (req, res) => {
  const m = repo.media.getFull(req.params.id);
  if (!m || m.publish_state !== 'published' || m.scope === 'excluded') return res.status(404).json({ error: 'Not found' });
  const out = publicMedia(m);
  const also = repo.media.altSources(m.id);
  if (also.length) out.also = also; // the same picture posted elsewhere
  res.json(out);
});

router.get('/media/:id/related', (req, res) => {
  const m = repo.media.get(req.params.id);
  if (!m || m.publish_state !== 'published') return res.status(404).json({ error: 'Not found' });
  res.json(repo.media.related(req.params.id, repo.clampInt(req.query.limit, 1, 40, 12)).map(publicMedia));
});

/**
 * "More like this" by look: visually similar posts from every source (src/engine/visual.js). Until this item has a
 * vector (new posts are embedded within minutes) the answer comes from shared tags and creators instead; `basis` says which.
 */
router.get('/media/:id/similar', (req, res) => {
  const m = repo.media.get(req.params.id);
  if (!m || m.publish_state !== 'published') return res.status(404).json({ error: 'Not found' });
  const limit = repo.clampInt(req.query.limit, 1, 40, 12);
  const look = require('../engine/visual').similar(m.id, limit);
  if (look && look.length) return res.json({ basis: 'look', items: look.map(publicMedia) });
  res.json({ basis: 'tags', items: repo.media.related(m.id, limit).map(publicMedia) });
});

const engagementLimiter = rateLimit({ windowMs: 60 * 1000, max: 90, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down' } });
router.post('/media/:id/view', engagementLimiter, (req, res) => { repo.media.bumpView(req.params.id); res.json({ ok: true }); });
// A viewer's browser could not load this item: verify it at the source (never hides on its own).
router.post('/media/:id/broken', engagementLimiter, (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Bad id' });
  const r = require('../engine/health').report(req.params.id);
  res.status(r.ok ? 202 : 404).json(r);
});
router.post('/media/:id/like', engagementLimiter, (req, res) => {
  const delta = req.body && req.body.delta === -1 ? -1 : 1;
  repo.media.bumpLike(req.params.id, delta);
  res.json({ ok: true });
});

router.get('/creators', (req, res) => {
  const r = repo.creators.list({
    page: repo.clampInt(req.query.page, 0, 100000, 0), limit: repo.clampInt(req.query.limit, 1, 100, 36),
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : undefined,
    sort: ['media', 'score', 'recent', 'new', 'name'].includes(req.query.sort) ? req.query.sort : 'media',
    platform: /^[a-z]{1,20}$/.test(req.query.platform || '') ? req.query.platform : undefined,
    freshDays: repo.clampInt(req.query.fresh, 0, 3650, 0) || undefined,
    onlyfans: req.query.onlyfans === '1',
    paidHost: Object.prototype.hasOwnProperty.call(PAID, req.query.paid || '') ? PAID[req.query.paid].host : undefined,
  });
  res.json({ ...r, items: r.items.map(publicCreator) });
});

router.get('/creators/:id', (req, res) => {
  const c = repo.creators.detail(req.params.id);
  if (!c || c.status !== 'active' || c.scope === 'excluded') return res.status(404).json({ error: 'Not found' });
  res.json({ ...publicCreator(c), accounts: publicAccounts(c.id), topTags: c.topTags, aliases: otherNames(c) });
});

/** Names he goes by elsewhere, for "Also goes by": plain strings, minus the name and handle already on the page.
 *  detail() has already left out names only claimed in a bio. */
function otherNames(c) {
  const shown = new Set([normAlias(c.handle || ''), normAlias(c.display_name || '')]);
  const seen = new Set();
  return (c.aliases || []).map((a) => a.alias).filter((a) => {
    const k = normAlias(a || '');
    if (!k || shown.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

router.get('/creators/:id/media', (req, res) => {
  const c = repo.creators.get(req.params.id);
  if (!c || c.status !== 'active') return res.status(404).json({ error: 'Not found' });
  const r = repo.media.list({ ...mediaFilters(req.query), creator: c.id });
  res.json({ ...r, items: r.items.map(publicMedia) });
});

router.get('/suggest', (req, res) => res.json(suggestCached(typeof req.query.q === 'string' ? req.query.q : '', 6)));

router.get('/creators/:id/similar', (req, res) => {
  const c = repo.creators.get(req.params.id);
  if (!c || c.status !== 'active') return res.status(404).json({ error: 'Not found' });
  // "Guys with a similar look": by what his pictures look like (src/engine/visual.js), falling back to posting style (tags)
  if (req.query.by === 'look' && req.query.onlyfans !== '1') {
    const limit = repo.clampInt(req.query.limit, 1, 24, 12);
    const near = require('../engine/visual').similarCreators(c.id, limit * 2);
    if (near && near.length) {
      const score = new Map(near);
      const ids = near.map(([id]) => id);
      const cards = repo.db.prepare(`${repo.SELECT_CREATOR_CARD} WHERE c.id IN (${ids.map(() => '?').join(',')}) AND c.status = 'active' AND c.scope != 'excluded' AND c.media_count > 0`)
        .all(...ids).map(repo.serializeCreator).sort((a, b) => score.get(b.id) - score.get(a.id));
      if (cards.length) return res.json(cards.slice(0, limit).map((x) => ({ ...publicCreator(x), similarity: Math.round(Math.max(0, score.get(x.id)) * 1000) / 1000 })));
    }
  }
  res.json(repo.creators.similar(c.id, repo.clampInt(req.query.limit, 1, 24, 12), { onlyfans: req.query.onlyfans === '1' }).map(publicCreator));
});

const recs = require('../engine/recommend');
router.get('/recommend', (req, res) => {
  const t = recs.tasteFromQuery(req.query, repo);
  const r = recs.recommend(t);
  // Nothing to go on yet (new visitor): fall back to what is trending, so the rail is never empty.
  // Whatever was marked "Not interested" stays out of the fallback too.
  if (!r.personalized) {
    const tr = repo.media.list({ sort: 'trending', page: t.page, limit: t.limit, type: t.type, notCreators: [...t.avoidCreators], notTags: [...t.avoidTags] });
    return res.json({ ...tr, items: tr.items.map(publicMedia), personalized: false });
  }
  res.json({ ...r, items: r.items.map(publicMedia) });
});

/** Creators you might like, from the same taste profile (exclude = creators already followed). */
router.get('/recommend/creators', (req, res) => {
  const t = recs.tasteFromQuery(req.query, repo);
  res.json(recs.creatorsForYou(t, repo.clampInt(req.query.limit, 1, 30, 12)).map((c) => ({ ...publicCreator(c), reason: c.reason })));
});

router.get('/graph', (req, res) => res.json(graphCached()));

/** /api/understand's answer for an understood query. */
function understoodPayload(u) {
  const query = {
    type: u.type, sort: u.sort, since: u.since, platform: u.platform, community: u.community, paid: u.paid, build: u.build,
    tags: u.tags.length ? u.tags.join(',') : undefined, creator: u.creator ? u.creator.id : undefined, q: u.text || undefined,
  };
  return {
    understood: u.understood, query, chips: u.chips.map((c) => ({ key: c.key, value: c.key === 'creator' ? c.value.id : c.value, label: c.label })),
    creator: u.creator ? { id: u.creator.id, handle: u.creator.handle, display_name: u.creator.display_name } : null,
    text: u.text, corrections: u.corrections,
  };
}

/** Plain-language search → structured filters (see src/lib/query.js). */
router.get('/understand', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(understoodPayload(understand(q, vocabCached())));
});

// Each AI reading is one paid API request (answers are cached, and lib/claude enforces a daily budget on top). Over the
// limit, the rules' reading is answered instead: a search box never shows a 429.
const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: false, legacyHeaders: false, handler: (req, res, next) => { req.aiLimited = true; next(); } });

/**
 * The same, read by Claude (engine/ai.js) for a search the rules left words over in. Answers {ai: null} when Claude is
 * off, unavailable, or adds nothing over the rules; otherwise the understood query plus {ai: {rewritten, note}}.
 */
router.get('/understand/ai', aiLimiter, async (req, res, next) => { try {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const vocab = vocabCached();
  const rules = understand(q, vocab);
  if (!q.trim() || !rules.text || req.aiLimited) return res.json({ ...understoodPayload(rules), ai: null });
  const r = await ai.readSearch(q, vocab);
  if (!r || !r.rewritten || !r.u.understood) return res.json({ ...understoodPayload(rules), ai: r ? { rewritten: '', note: r.note } : null });
  res.json({ ...understoodPayload(r.u), ai: { rewritten: r.rewritten, note: r.note } });
} catch (e) { next(e); } });

/**
 * One search box: Creators, Posts and Tags for the understood query (see src/engine/search.js). With ai=1, a search the
 * rules left words over in is read by Claude first, and its reading is used when it finds anything.
 */
const aiSearchLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: false, legacyHeaders: false, skip: (req) => req.query.ai !== '1', handler: (req, res, next) => { req.aiLimited = true; next(); } });
router.get('/search', aiSearchLimiter, async (req, res, next) => { try {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  if (!q.trim()) return res.json({ understood: false, query: {}, relaxed: false, chips: [], corrections: [], creators: [], tags: [], posts: { items: [], total: 0, page: 0, limit: 0 }, ai: null });
  const opts = {
    page: repo.clampInt(req.query.page, 0, 1000, 0), limit: repo.clampInt(req.query.limit, 1, 60, 24),
    type: req.query.type === 'image' || req.query.type === 'video' ? req.query.type : undefined,
    sort: SORTS.has(req.query.sort) ? req.query.sort : undefined,
  };
  const vocab = vocabCached();
  let r = search(q, vocab, opts);
  let aiInfo = null;
  if (req.query.ai === '1' && !req.aiLimited && understand(q, vocab).text) {
    const read = await ai.readSearch(q, vocab).catch(() => null);
    if (read && read.rewritten) {
      const alt = search(read.rewritten, vocab, opts);
      if (alt.posts.items.length || alt.creators.length) { r = alt; aiInfo = { rewritten: read.rewritten, note: read.note }; }
    }
  }
  res.json({
    ...r,
    ai: aiInfo,
    creators: r.creators.map((c) => ({ ...publicCreator(c), match: c.match })),
    posts: { ...r.posts, items: r.posts.items.map(publicMedia) },
  });
} catch (e) { next(e); } });

router.get('/tags/related', (req, res) => {
  const names = typeof req.query.tags === 'string' ? req.query.tags.split(',').slice(0, 4) : [];
  res.json(repo.tagIntel.related(names, repo.clampInt(req.query.limit, 1, 30, 12), { all: req.query.mode !== 'any' }));
});

router.get('/topics', (req, res) => res.json(topicsCached()));

router.get('/creators/:id/activity', (req, res) => {
  const c = repo.creators.get(req.params.id);
  if (!c || c.status !== 'active' || c.scope === 'excluded') return res.status(404).json({ error: 'Not found' });
  res.json(repo.creators.activity(c.id));
});

router.get('/tags', (req, res) => res.json(tagsCached().slice(0, repo.clampInt(req.query.limit, 1, 200, 100))));
router.get('/communities', (req, res) => res.json(communitiesCached()));
router.get('/subreddits', (req, res) => res.json(communitiesCached().filter((c) => c.platform === 'reddit').map((c) => c.name)));
router.get('/platforms', (req, res) => res.json(repo.media.platforms()));

router.get('/stream', (req, res) => events.subscribe('public', req, res));

/* -------------------------------------------------------- public lookup */
// Visitor Find-a-creator: same verified engine as Admin → Creators, behind the
// age gate and tightly rate-limited. Writes go through lookup.follow(), which
// re-applies every safety / scope / image gate. Actor is logged as visitor.
const lookupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many lookups from this address, try again later' } });
const lookupFollowLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many follows from this address, try again later' } });

router.post('/lookup', lookupLimiter, async (req, res) => {
  try {
    const q = String((req.body && (req.body.query || req.body.q)) || '').trim().slice(0, 200);
    if (!q) return res.status(400).json({ error: 'Type a name, a handle or a profile link' });
    const out = await require('../engine/lookup').lookup(q);
    res.status(out.error ? 400 : 200).json(out);
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
});

router.post('/lookup/follow', lookupFollowLimiter, (req, res) => {
  try {
    const b = req.body || {};
    const out = require('../engine/lookup').follow({
      name: typeof b.name === 'string' ? b.name.slice(0, 200) : '',
      selections: Array.isArray(b.selections) ? b.selections.slice(0, 20) : [],
      externalLinks: Array.isArray(b.externalLinks) ? b.externalLinks.slice(0, 20) : [],
      bio: typeof b.bio === 'string' ? b.bio.slice(0, 2000) : undefined,
    });
    if (!out.error) repo.logAction('creator', out.creator && out.creator.id, 'lookup-follow', `${(out.feeds || []).length} accounts`, 'visitor');
    res.status(out.error ? 400 : 200).json(out);
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
});

router.post('/lookup/auto', lookupFollowLimiter, async (req, res) => {
  try {
    const q = String((req.body && (req.body.query || req.body.q)) || '').trim().slice(0, 200);
    if (!q) return res.status(400).json({ error: 'Type a name, a handle or a profile link' });
    const out = await require('../engine/lookup').findAndFollow(q, { minConfidence: 0.7 });
    if (!out.error && out.creator) repo.logAction('creator', out.creator.id, 'lookup-follow', 'auto', 'visitor');
    res.status(out.error ? 400 : 200).json(out);
  } catch (e) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) }); }
});

module.exports = router;
module.exports.publicMedia = publicMedia;
module.exports.warm = warm;
module.exports.warmPrep = warmPrep;
module.exports.publicCreator = publicCreator;
module.exports.suggestCached = suggestCached;
module.exports.suggestCache = suggestCache;
