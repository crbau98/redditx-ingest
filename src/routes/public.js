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
const { understand, buildVocabulary } = require('../lib/query');

const router = express.Router();

/* ------------------------------------------------------------ serialisation */
function publicMedia(m) {
  if (!m) return null;
  return {
    id: m.id, title: m.title, description: m.description, media_type: m.media_type,
    media_url: m.media_url, preview_url: m.preview_url, thumbnail_url: m.thumbnail_url,
    hls_url: m.hls_url, has_audio: m.has_audio, width: m.width, height: m.height, duration: m.duration,
    platform: m.platform, community: m.community, author: m.author, source_url: m.source_url,
    score: m.score, likes: m.likes, views: m.views, nsfw_level: m.nsfw_level, posted_at: m.posted_at,
    creator_id: m.creator_id, creator_handle: m.creator_handle, creator_name: m.creator_name, creator_avatar: m.creator_avatar,
    tags: m.tags || (m.tags_text ? m.tags_text.split(' ').filter(Boolean).slice(0, 10) : []),
    position: m.position, post_key: m.post_key,
  };
}

function publicCreator(c) {
  if (!c) return null;
  return {
    id: c.id, handle: c.handle, display_name: c.display_name, bio: c.bio, avatar_url: c.avatar_url, banner_url: c.banner_url,
    links: c.links, verified: c.verified, media_count: c.media_count, video_count: c.video_count, total_score: c.total_score,
    last_media_at: c.last_media_at, previews: c.previews, platforms: c.platforms,
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
    platform: /^[a-z]{2,20}$/.test(q.platform || '') ? q.platform : undefined,
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
    // Infinite scroll only needs the total once; later pages skip the COUNT(*).
    noCount: q.nocount === '1' && repo.clampInt(q.page, 0, 100000, 0) > 0,
    // "new since" for saved searches: an ISO timestamp, normalised so it compares correctly as text
    after: typeof q.after === 'string' && !Number.isNaN(Date.parse(q.after)) ? new Date(q.after).toISOString() : undefined,
  };
}

const ttl = (ms, fn) => { let at = 0; let val; return () => { if (Date.now() - at > ms) { val = fn(); at = Date.now(); } return val; }; };
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
router.get('/health', (req, res) => {
  let dbOk = true;
  try { repo.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', version: config.version, uptime: Math.round(process.uptime()), db: dbOk, timestamp: new Date().toISOString() });
});

router.get('/meta', (req, res) => {
  res.json({
    name: 'PRISM', version: config.version,
    ageGate: { enforce: config.ageGateEnforce, verified: age.isVerified(req) },
    platforms: registry.list().filter((a) => !['web', 'linkinbio'].includes(a.platform)).map((a) => ({ platform: a.platform, label: a.label, color: a.color })),
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
    if (creator && kind === 'underage') repo.creators.update(creator.id, { status: 'hidden' });
    repo.logAction('report', id, 'auto-hide', kind, 'system');
  }
  events.admin('report', { id, kind });
  res.status(201).json({ ok: true, id });
});

/* -------------------------------------------------------- age-gated content */
router.use(['/discover', '/stats', '/suggest', '/recommend', '/graph', '/understand', '/topics', '/media', '/creators', '/tags', '/communities', '/subreddits', '/platforms', '/stream'], age.requireAge);

router.get('/discover', (req, res) => res.json(discoverCached()));
router.get('/stats', (req, res) => res.json(repo.publicStats()));

router.get('/media', (req, res) => {
  const r = repo.media.list(mediaFilters(req.query));
  res.json({ ...r, items: r.items.map(publicMedia) });
});

router.get('/media/:id', (req, res) => {
  const m = repo.media.getFull(req.params.id);
  if (!m || m.publish_state !== 'published' || m.scope === 'excluded') return res.status(404).json({ error: 'Not found' });
  res.json(publicMedia(m));
});

router.get('/media/:id/related', (req, res) => {
  const m = repo.media.get(req.params.id);
  if (!m || m.publish_state !== 'published') return res.status(404).json({ error: 'Not found' });
  res.json(repo.media.related(req.params.id, repo.clampInt(req.query.limit, 1, 40, 12)).map(publicMedia));
});

const engagementLimiter = rateLimit({ windowMs: 60 * 1000, max: 90, standardHeaders: true, legacyHeaders: false, message: { error: 'Slow down' } });
router.post('/media/:id/view', engagementLimiter, (req, res) => { repo.media.bumpView(req.params.id); res.json({ ok: true }); });
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
    platform: /^[a-z]{2,20}$/.test(req.query.platform || '') ? req.query.platform : undefined,
  });
  res.json({ ...r, items: r.items.map(publicCreator) });
});

router.get('/creators/:id', (req, res) => {
  const c = repo.creators.detail(req.params.id);
  if (!c || c.status !== 'active' || c.scope === 'excluded') return res.status(404).json({ error: 'Not found' });
  res.json({ ...publicCreator(c), accounts: publicAccounts(c.id), topTags: c.topTags });
});

router.get('/creators/:id/media', (req, res) => {
  const c = repo.creators.get(req.params.id);
  if (!c || c.status !== 'active') return res.status(404).json({ error: 'Not found' });
  const r = repo.media.list({ ...mediaFilters(req.query), creator: c.id });
  res.json({ ...r, items: r.items.map(publicMedia) });
});

router.get('/suggest', (req, res) => res.json(repo.suggest(typeof req.query.q === 'string' ? req.query.q : '', 6)));

router.get('/creators/:id/similar', (req, res) => {
  const c = repo.creators.get(req.params.id);
  if (!c || c.status !== 'active') return res.status(404).json({ error: 'Not found' });
  res.json(repo.creators.similar(c.id, repo.clampInt(req.query.limit, 1, 24, 12)).map(publicCreator));
});

const csv = (v, re, max) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter((x) => re.test(x)).slice(0, max) : []);
const UUID = /^[0-9a-f-]{36}$/i;
router.get('/recommend', (req, res) => {
  const q = req.query;
  const video = q.video !== undefined && q.video !== '' && Number.isFinite(Number(q.video)) ? Math.min(1, Math.max(0, Number(q.video))) : null;
  const r = repo.media.recommend({
    tags: csv(q.tags, /^[\p{L}\p{N}-]{2,40}$/u, 20), creators: csv(q.creators, UUID, 40), platforms: csv(q.platforms, /^[a-z]{2,20}$/, 8),
    video, exclude: csv(q.exclude, UUID, 200), seed: repo.clampInt(q.seed, 0, 2147483647, 1), type: q.type === 'image' || q.type === 'video' ? q.type : undefined,
    page: repo.clampInt(q.page, 0, 1000, 0), limit: repo.clampInt(q.limit, 1, 60, 36),
  });
  // Nothing to go on yet (new visitor): fall back to what is trending, so the rail is never empty.
  if (!r.personalized) {
    const t = repo.media.list({ sort: 'trending', page: r.page, limit: r.limit, type: q.type === 'image' || q.type === 'video' ? q.type : undefined });
    return res.json({ ...t, items: t.items.map(publicMedia), personalized: false });
  }
  res.json({ ...r, items: r.items.map(publicMedia) });
});

router.get('/graph', (req, res) => res.json(graphCached()));

/** Plain-language search → structured filters (see src/lib/query.js). */
router.get('/understand', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const u = understand(q, vocabCached());
  const query = {
    type: u.type, sort: u.sort, since: u.since, platform: u.platform, community: u.community,
    tags: u.tags.length ? u.tags.join(',') : undefined, creator: u.creator ? u.creator.id : undefined, q: u.text || undefined,
  };
  res.json({
    understood: u.understood, query, chips: u.chips.map((c) => ({ key: c.key, value: c.key === 'creator' ? c.value.id : c.value, label: c.label })),
    creator: u.creator ? { id: u.creator.id, handle: u.creator.handle, display_name: u.creator.display_name } : null,
    text: u.text, corrections: u.corrections,
  });
});

router.get('/tags/related', (req, res) => {
  const names = typeof req.query.tags === 'string' ? req.query.tags.split(',').slice(0, 4) : [];
  res.json(repo.tagIntel.related(names, repo.clampInt(req.query.limit, 1, 30, 12)));
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

module.exports = router;
module.exports.publicMedia = publicMedia;
module.exports.publicCreator = publicCreator;
