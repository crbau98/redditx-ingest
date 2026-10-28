'use strict';
const express = require('express');
const config = require('../config');
const repo = require('../db/repo');
const registry = require('../sources');
const engine = require('../engine/engine');
const events = require('../engine/events');
const breaker = require('../engine/breaker');
const maintenance = require('../engine/maintenance');
const imagefilter = require('../lib/imagefilter');
const physique = require('../engine/physique');
const settingsStore = require('../settings');
const targets = require('../services/targets');
const portability = require('../services/portability');
const backup = require('../engine/backup');
const discovery = require('../engine/discovery');
const lookup = require('../engine/lookup');
const identity = require('../engine/identity');
const { adminRateLimit, adminCredentialAuth } = require('../middleware/auth');

const router = express.Router();
router.use(adminRateLimit, adminCredentialAuth);

const int = repo.clampInt;
const page = (req, max = 200) => ({ page: int(req.query.page, 0, 100000, 0), limit: int(req.query.limit, 1, max, 50) });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ---------------------------------------------------------------- overview */
router.get('/overview', (req, res) => {
  res.json({ ...repo.adminOverview(), engine: engine.status(), health: require('../engine/health').stats(), imageFilter: { enabled: settingsStore.get().imageFilter, ...imagefilter.status(), sweep: maintenance.imageSweepProgress(), dedupe: maintenance.hashSweepProgress() }, physique: { ...physique.stats(settingsStore.get()), sweep: maintenance.physiqueSweepProgress() }, identity: identity.counts(), version: config.version, adminOpen: !config.adminKey });
});

router.get('/stream', (req, res) => {
  events.subscribe('admin', req, res);
  res.write(`data: ${JSON.stringify({ type: 'state', data: engine.status() })}\n\n`);
});

/* ------------------------------------------------------------------ engine */
router.get('/engine', (req, res) => res.json({ ...engine.status(), logs: events.getLogs(150) }));
router.get('/logs', (req, res) => res.json(events.getLogs(int(req.query.limit, 1, 600, 300))));
router.delete('/logs', (req, res) => { events.clearLogs(); res.json({ ok: true }); });

router.post('/engine/run', (req, res) => {
  const { platforms, feedIds, force } = req.body || {};
  let queued;
  if (Array.isArray(feedIds) && feedIds.length) queued = engine.enqueue(feedIds.filter((x) => typeof x === 'string'), { force: !!force });
  else queued = engine.enqueuePlatforms(Array.isArray(platforms) ? platforms : null, { force: !!force });
  res.json({ ok: true, queued });
});
router.post('/engine/stop', (req, res) => { engine.stopAll(); res.json({ ok: true }); });
router.post('/engine/pause', (req, res) => { engine.pause(); res.json({ ok: true }); });
router.post('/engine/resume', (req, res) => { engine.resume(); res.json({ ok: true }); });
router.post('/engine/breakers/reset', (req, res) => { breaker.reset(); res.json({ ok: true }); });

router.get('/runs', (req, res) => res.json(repo.runs.recent({ feedId: req.query.feedId, limit: int(req.query.limit, 1, 200, 60) })));

/* ----------------------------------------------------------------- sources */
router.get('/sources', (req, res) => {
  const counts = Object.fromEntries(repo.feeds.counts().map((c) => [c.platform, c]));
  const breakers = breaker.snapshot();
  const score = Object.fromEntries(repo.runs.scoreboard(7).map((r) => [r.platform, r]));
  res.json(registry.describe().map((s) => ({ ...s, feeds: counts[s.platform] || { total: 0, enabled: 0, failing: 0 }, breaker: breakers[s.platform] || { state: 'closed', failures: 0 }, score: score[s.platform] || null })));
});
/** Feed-level health: failing, stale, dead (ran often, added nothing in a month) and top feeds. */
router.get('/sources/health', (req, res) => res.json({ ...require('../engine/sourcehealth').report(), thumbnails: require('../engine/thumbs').progress() }));

/* ------------------------------------------------------------------- feeds */
router.get('/feeds', (req, res) => {
  const { platform, kind, status, q, creatorId, enabled } = req.query;
  res.json(repo.feeds.list({ platform, kind, status, q, creatorId, enabled, ...page(req, 500) }));
});

router.post('/feeds', (req, res) => {
  const b = req.body || {};
  const spec = b.input ? registry.parseInput(b.input, { platform: b.platform }) : (b.platform && b.kind && b.target ? { platform: b.platform, kind: b.kind, target: String(b.target).trim() } : null);
  if (!spec) return bad(res, 'Provide an `input` (link or handle) or platform + kind + target');
  const adapter = registry.get(spec.platform);
  if (!adapter || !adapter.kinds.includes(spec.kind)) return bad(res, `${spec.platform} does not support ${spec.kind} feeds`);
  const r = targets.addSpec(spec, { trusted: b.trusted, origin: 'admin' });
  if (r.status === 'invalid' || r.status === 'conflict') return bad(res, r.reason, r.status === 'conflict' ? 409 : 400);
  if (r.feed) { if (b.intervalMin) repo.feeds.update(r.feed.id, { intervalMin: b.intervalMin }); if (b.run !== false) engine.enqueue([r.feed.id]); }
  res.status(r.status === 'created' ? 201 : 200).json(r);
});

router.post('/feeds/import', (req, res) => {
  const text = req.body && req.body.text;
  if (!text || typeof text !== 'string') return bad(res, 'text is required');
  const out = targets.importTargets(text.slice(0, 200000), { hint: { platform: req.body.platform } });
  if (out.feeds.length) engine.enqueue(out.feeds.map((f) => f.id), { front: false });
  res.json(out);
});

router.patch('/feeds/:id', (req, res) => {
  if (!repo.feeds.get(req.params.id)) return bad(res, 'Not found', 404);
  const b = req.body || {};
  // logged, so automatic pauses (e.g. the body filter) never undo an admin's own switch later
  const was = repo.feeds.get(req.params.id);
  if (b.enabled !== undefined && !!b.enabled !== !!was.enabled) repo.logAction('feed', was.id, b.enabled ? 'enable' : 'disable', 'admin', 'admin');
  res.json(repo.feeds.update(req.params.id, { label: b.label, enabled: b.enabled, trusted: b.trusted, intervalMin: b.intervalMin, priority: b.priority, resetErrors: !!b.resetErrors, runNow: !!b.runNow }));
});

router.delete('/feeds/:id', (req, res) => {
  if (!repo.feeds.remove(req.params.id)) return bad(res, 'Not found', 404);
  res.json({ ok: true });
});

router.post('/feeds/:id/run', (req, res) => {
  if (!repo.feeds.get(req.params.id)) return bad(res, 'Not found', 404);
  res.json({ ok: true, queued: engine.enqueue([req.params.id], { force: !!(req.body && req.body.force) }) });
});

/* ---------------------------------------------------------------- creators */
router.get('/creators', (req, res) => {
  const r = repo.creators.list({ ...page(req, 200), q: req.query.q, sort: req.query.sort || 'recent', admin: true, minMedia: 0 });
  res.json(r);
});

router.get('/creators/:id', (req, res) => {
  const c = repo.creators.detail(req.params.id);
  if (!c) return bad(res, 'Not found', 404);
  res.json({ ...c, feeds: repo.feeds.list({ creatorId: c.id, limit: 100 }).items });
});

router.post('/creators', (req, res) => {
  const out = targets.addCreator({ name: req.body && req.body.name, inputs: req.body && req.body.inputs, bio: req.body && req.body.bio });
  if (out.error) return bad(res, out.error);
  if (out.feeds.length) engine.enqueue(out.feeds.map((f) => f.id), { trigger: 'manual' });
  res.status(201).json(out);
});

router.patch('/creators/:id', (req, res) => {
  if (!repo.creators.get(req.params.id)) return bad(res, 'Not found', 404);
  res.json(repo.creators.update(req.params.id, req.body || {}));
});

router.post('/creators/merge', (req, res) => {
  const { keepId, mergeId } = req.body || {};
  if (!keepId || !mergeId) return bad(res, 'keepId and mergeId required');
  const out = identity.mergeCreators(keepId, mergeId, { actor: 'admin' });
  if (!out) return bad(res, 'One or both creators not found', 404);
  res.json(out);
});

router.post('/creators/:id/block', (req, res) => {
  const out = repo.creators.block(req.params.id, (req.body && req.body.reason) || 'admin', 'admin');
  if (!out) return bad(res, 'Not found', 404);
  res.json(out);
});
router.post('/creators/:id/restore', (req, res) => {
  if (!repo.creators.get(req.params.id)) return bad(res, 'Not found', 404);
  res.json(repo.creators.update(req.params.id, { status: 'active' }));
});

/* --------------------------------------------------------------- identity */
// Same-creator queue (engine/identity): pairs of creators whose own profiles point at each other.
router.get('/identities', (req, res) => res.json({ ...identity.queue({ status: req.query.status, ...page(req, 100) }), counts: identity.counts() }));
router.post('/identities/scan', (req, res) => res.json({ ok: true, ...identity.scan() }));
router.post('/identities/:id', (req, res) => {
  const id = int(req.params.id, 1, Number.MAX_SAFE_INTEGER, 0);
  const { action, keepId } = req.body || {};
  if (action === 'merge') { const out = identity.merge(id, { keepId, actor: 'admin' }); return out ? res.json({ ok: true, creator: out }) : bad(res, 'Not found or already decided', 404); }
  if (action === 'reject') return identity.reject(id, 'admin') ? res.json({ ok: true }) : bad(res, 'Not found or already decided', 404);
  return bad(res, 'action must be merge or reject');
});
router.get('/creators/:id/aliases', (req, res) => {
  if (!repo.creators.get(req.params.id)) return bad(res, 'Not found', 404);
  res.json(identity.aliasesOf(req.params.id));
});
router.post('/creators/:id/aliases', (req, res) => {
  const alias = String((req.body && req.body.alias) || '').trim();
  if (!repo.creators.get(req.params.id)) return bad(res, 'Not found', 404);
  if (!alias) return bad(res, 'alias required');
  identity.addAlias(req.params.id, alias, { kind: req.body.kind === 'name' ? 'name' : 'handle', source: 'admin' });
  res.json(identity.aliasesOf(req.params.id));
});
router.delete('/creators/:id/aliases/:alias', (req, res) => {
  identity.removeAlias(req.params.id, req.params.alias);
  res.json(identity.aliasesOf(req.params.id));
});

/* ------------------------------------------------------------------- media */
router.get('/media', (req, res) => {
  const { state, platform, scope, q, creator, sort, type } = req.query;
  const r = repo.media.list({
    admin: true, state: state || 'all', platform, scope, q, creator, type, sort: sort || 'ingested', ...page(req, 200),
  });
  res.json({ ...r, items: r.items.map((m) => ({ ...m })) });
});

router.patch('/media/:id', (req, res) => {
  if (!repo.media.get(req.params.id)) return bad(res, 'Not found', 404);
  res.json(repo.media.update(req.params.id, req.body || {}));
});

router.post('/media/:id/moderate', (req, res) => {
  const { action, reason } = req.body || {};
  const out = targets.moderate(req.params.id, action, reason);
  if (out === null) return bad(res, 'Not found', 404);
  if (out === undefined) return bad(res, 'Unknown action. Use approve, hide, flag, reject or block');
  res.json(out);
});

router.post('/media/bulk', (req, res) => {
  const { ids, action, reason } = req.body || {};
  if (!Array.isArray(ids) || !action) return bad(res, 'ids array and action required');
  let updated = 0;
  repo.db.transaction(() => { for (const id of ids.slice(0, 500)) if (targets.moderate(String(id), action, reason || 'bulk')) updated++; })();
  res.json({ ok: true, updated });
});

router.get('/moderation/queue', (req, res) => {
  const r = repo.media.list({ admin: true, state: 'review', sort: 'ingested', ...page(req) });
  res.json(r);
});

/* ----------------------------------------------------------------- reports */
router.get('/reports', (req, res) => res.json(repo.reports.list({ status: ['open', 'resolved', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open', ...page(req) })));

router.post('/reports/:id/resolve', (req, res) => {
  const report = repo.reports.get(req.params.id);
  if (!report) return bad(res, 'Not found', 404);
  const { action, note } = req.body || {};
  const apply = {
    remove: () => report.media_id && repo.media.block(report.media_id, `report:${report.kind}`),
    block_creator: () => report.creator_id && repo.creators.block(report.creator_id, `report:${report.kind}`),
    restore: () => report.media_id && physique.publish(report.media_id, settingsStore.get()), // the body verdict still applies
    dismiss: () => null,
  };
  if (!apply[action]) return bad(res, 'action must be remove, block_creator, restore or dismiss');
  apply[action]();
  repo.reports.resolve(report.id, action === 'dismiss' || action === 'restore' ? 'dismissed' : 'resolved', `${action}${note ? `: ${note}` : ''}`, 'admin');
  res.json({ ok: true });
});

/* --------------------------------------------------------------- blocklist */
router.get('/blocklist', (req, res) => res.json(repo.blocklist.list(int(req.query.page, 0, 10000, 0), int(req.query.limit, 1, 500, 100))));
router.post('/blocklist', (req, res) => {
  const { type, value, reason } = req.body || {};
  if (!['source_key', 'hash', 'creator', 'post'].includes(type) || !value) return bad(res, 'type (source_key|hash|creator|post) and value required');
  res.status(201).json({ ok: true, added: repo.blocklist.add(type, String(value).trim(), reason) });
});
router.delete('/blocklist/:id', (req, res) => (repo.blocklist.remove(parseInt(req.params.id, 10)) ? res.json({ ok: true }) : bad(res, 'Not found', 404)));

/* ---------------------------------------------------------------- settings */
router.get('/settings', (req, res) => {
  const c = config.creds;
  res.json({
    values: settingsStore.get(),
    schema: settingsStore.describe(),
    credentials: {
      reddit: !!(c.redditClientId && c.redditClientSecret), x: !!c.xBearer, bluesky: !!(c.bskyIdentifier && c.bskyPassword), mastodon: !!c.mastodonToken,
      brave: !!c.braveKey, telegram: !!c.telegramBot, telegramValid: require('../lib/telegram-bot').configured(),
    },
    instances: { mastodon: config.mastodonInstances, lemmy: config.lemmyInstances },
    security: { adminKeySet: !!config.adminKey, ageGateEnforced: config.ageGateEnforce },
  });
});
const PHYSIQUE_KEYS = ['physiqueFilter', 'physiqueThreshold', 'physiqueCreatorShare'];
router.put('/settings', (req, res) => {
  const before = settingsStore.get();
  const values = settingsStore.update(req.body || {});
  // The body filter hides, it never deletes: a new threshold (or switching it off) re-applies to the stored library at once.
  if (PHYSIQUE_KEYS.some((k) => values[k] !== before[k])) {
    const applied = physique.reapply(values);
    if (values.physiqueFilter && !before.physiqueFilter) physique.textSweep(values, { force: true }).catch((e) => events.log('WARN', `Body filter: ${e.message}`));
    return res.json({ values, physique: applied });
  }
  res.json({ values });
});

/* --------------------------------------------------------------- discovery */
router.get('/discovery', (req, res) => {
  const status = ['pending', 'followed', 'linked', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({
    ...discovery.status(),
    candidates: repo.candidates.list({ status, ...page(req, 200), q: typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined, platform: /^[a-z]{1,20}$/.test(req.query.platform || '') ? req.query.platform : undefined, sort: ['score', 'recent', 'new'].includes(req.query.sort) ? req.query.sort : 'score' }),
  });
});
router.post('/discovery/run', (req, res) => {
  const st = discovery.status();
  if (st.running) return res.status(409).json({ error: 'Discovery is already running' });
  discovery.run({ trigger: 'manual' }).catch(() => {});
  res.status(202).json({ ok: true, started: true });
});
router.post('/discovery/candidates/:id', (req, res) => {
  const action = req.body && req.body.action;
  const c = repo.candidates.get(req.params.id);
  if (!c) return bad(res, 'Not found', 404);
  if (action === 'follow') { const r = discovery.follow(c, { actor: 'admin' }); return r.ok ? res.json(r) : bad(res, r.reason || 'Could not follow'); }
  if (action === 'reject' || action === 'block') return res.json(discovery.reject(c.id, { block: action === 'block', reason: action === 'block' ? 'blocked from discovery' : 'rejected by admin' }));
  if (action === 'reset') return res.json(repo.candidates.update(c.id, { status: 'pending', reason: null, decided_at: null }));
  return bad(res, 'action must be follow, reject, block or reset');
});
router.post('/discovery/candidates', (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !['follow', 'reject'].includes(action)) return bad(res, 'ids[] and action (follow|reject) required');
  const out = { ok: 0, failed: 0 };
  for (const id of ids.slice(0, 200)) {
    const r = action === 'follow' ? discovery.follow(String(id), { actor: 'admin' }) : discovery.reject(String(id));
    if (r && (r.ok || r.status === 'rejected')) out.ok++; else out.failed++;
  }
  res.json(out);
});

/* ---------------------------------------------------------- Paid-page leads */
// Paid pages named in posts, bios and search results (OnlyFans, Fansly, JustFor.Fans); PRISM traces each
// to the person's free public accounts. The paid hosts themselves are never read.
const paidLib = require('../lib/paid');
router.get('/discovery/onlyfans', (req, res) => {
  const status = ['pending', 'searching', 'found', 'claimed', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const service = ['OnlyFans', 'Fansly', 'JustFor.Fans', 'all'].includes(req.query.service) ? req.query.service : 'all';
  res.json({ counts: repo.onlyfans.counts(), ...repo.onlyfans.list({ status, service, ...page(req, 200), q: typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined }) });
});
/** Paste paid-page links or handles (one per line): each becomes a lead the next discovery run traces. */
router.post('/discovery/onlyfans', (req, res) => {
  const { normal } = require('../lib/onlyfans');
  const lines = String((req.body && req.body.handles) || '').split(/[\n,\s]+/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const out = { added: 0, claimed: 0, invalid: [] };
  for (const line of lines) {
    const svc = paidLib.serviceOf(line);
    const service = svc && paidLib.SERVICES[svc].trace ? svc : 'OnlyFans';
    const handle = svc && paidLib.SERVICES[svc].trace ? paidLib.paidHandle(service, line) : (/onlyfans\.com/i.test(line) ? paidLib.ofHandle(line) : normal(line));
    if (!handle) { out.invalid.push(line.slice(0, 80)); continue; }
    const owner = repo.onlyfans.ownerOf(handle, service);
    if (owner) { repo.onlyfans.claim(handle, owner.id, service); out.claimed++; continue; }
    const lead = repo.onlyfans.note(handle, { service, origin: 'admin' });
    if (lead.status === 'rejected' || lead.status === 'searching') repo.onlyfans.update(handle, { service, status: 'pending', reason: null, attempts: 0 });
    out.added++;
  }
  res.json(out);
});
router.post('/discovery/onlyfans/:handle', (req, res) => {
  const service = ['OnlyFans', 'Fansly', 'JustFor.Fans'].includes(req.body && req.body.service) ? req.body.service : 'OnlyFans';
  const lead = repo.onlyfans.get(req.params.handle, service);
  if (!lead) return bad(res, 'Not found', 404);
  const action = req.body && req.body.action;
  if (action === 'retry') return res.json(repo.onlyfans.update(lead.handle, { service, status: 'pending', reason: null, attempts: 0 }));
  if (action === 'reject') return res.json(repo.onlyfans.update(lead.handle, { service, status: 'rejected', reason: 'rejected by admin', checked_at: new Date().toISOString() }));
  return bad(res, 'action must be retry or reject');
});

/* ------------------------------------------------------------ creator lookup */
// Find a person by name, performer name, handle or link across platforms (read-only), then follow the chosen accounts.
router.post('/lookup', async (req, res) => {
  try {
    const q = String((req.body && req.body.query) || '').trim();
    if (!q) return res.status(400).json({ error: 'Type a name, a handle or a profile link' });
    const out = await lookup.lookup(q);
    res.status(out.error ? 400 : 200).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/lookup/follow', (req, res) => {
  try {
    const b = req.body || {};
    const out = lookup.follow({ name: b.name, selections: Array.isArray(b.selections) ? b.selections : [], externalLinks: Array.isArray(b.externalLinks) ? b.externalLinks : [], bio: b.bio, creatorId: typeof b.creatorId === 'string' ? b.creatorId : null });
    res.status(out.error ? 400 : 200).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// One step: look up and follow every strong, new match.
router.post('/lookup/auto', async (req, res) => {
  try {
    const q = String((req.body && req.body.query) || '').trim();
    if (!q) return res.status(400).json({ error: 'Type a name, a handle or a profile link' });
    const out = await lookup.findAndFollow(q, { minConfidence: Math.min(Math.max(Number(req.body.minConfidence) || 0.7, 0.4), 0.95) });
    res.status(out.error ? 400 : 200).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------------------------------------- maintenance */
router.post('/maintenance/sweep', async (req, res) => {
  try { res.json({ ok: true, ...(await maintenance.sweep({ probe: !!(req.body && req.body.probe) })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/maintenance/image-filter', async (req, res) => {
  const s = settingsStore.get();
  res.json({ enabled: s.imageFilter, threshold: s.imageFilterThreshold, sweep: { enabled: s.imageSweep, perMinute: s.imageSweepPerTick, ...maintenance.imageSweepProgress() }, physique: { ...physique.stats(s), sweep: maintenance.physiqueSweepProgress() }, dedupe: { enabled: s.dedupe, distance: s.dedupeDistance, ...maintenance.hashSweepProgress() }, thumbnails: { enabled: s.thumbnails, perMinute: s.thumbnailsPerMinute, ...require('../engine/thumbs').progress() }, model: { available: await imagefilter.available(), ...imagefilter.status() } });
});
router.post('/maintenance/physique-sweep', async (req, res) => {
  try {
    const n = Math.min(Math.max(parseInt(req.body && req.body.limit, 10) || 50, 1), 300);
    res.json({ ok: true, ...(await maintenance.physiqueSweep({ limit: n })), ...maintenance.physiqueSweepProgress() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/maintenance/image-sweep', async (req, res) => {
  try {
    const n = Math.min(Math.max(parseInt(req.body && req.body.limit, 10) || 50, 1), 300);
    res.json({ ok: true, ...(await maintenance.imageSweep({ limit: n })), ...maintenance.imageSweepProgress() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ---------------------------------------------------------------- telegram (joined channels) */
router.get('/telegram', (req, res) => {
  const sync = require('../services/telegram-sync');
  res.json({ ...sync.status(), store: require('../lib/objectstore').describe() });
});
router.post('/telegram/sync', async (req, res) => {
  try { res.json({ ok: true, ...(await require('../services/telegram-sync').sync()) }); }
  catch (e) { res.status(e.status || (e.skip ? 400 : 500)).json({ error: e.message }); }
});
router.post('/maintenance/recompute', (req, res) => res.json({ ok: true, updated: repo.media.recomputeHot() }));

/* ------------------------------------------------- audit / duplicates / backups / portability */
router.get('/takedowns', (req, res) => {
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  res.json(repo.takedowns.list({ ...page(req), kind }));
});
router.post('/takedowns', (req, res) => {
  try {
    const { kind, value, reason } = req.body || {};
    const out = repo.takedowns.add({ kind, value, reason, actor: 'admin' });
    events.admin('takedown', { id: out.takedown && out.takedown.id, kind: out.takedown && out.takedown.kind, value: out.takedown && out.takedown.value });
    res.status(201).json({ ok: true, ...out });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});
router.delete('/takedowns/:id', (req, res) => {
  const removed = repo.takedowns.remove(req.params.id, 'admin');
  if (!removed) return res.status(404).json({ error: 'Takedown not found' });
  res.json({ ok: true });
});

router.get('/audit', (req, res) => res.json(repo.audit.list({ ...page(req), targetType: ['media', 'creator', 'report', 'takedown'].includes(req.query.type) ? req.query.type : undefined })));

router.get('/creators-duplicates', (req, res) => res.json(repo.creators.duplicates().slice(0, 100)));

router.get('/backups', (req, res) => res.json({ items: backup.list(), enabled: settingsStore.get().backupEnabled, keep: settingsStore.get().backupKeep }));
router.post('/backups', (req, res) => {
  try { res.status(201).json({ ok: true, ...backup.run() }); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/export', (req, res) => {
  res.set({ 'Content-Disposition': `attachment; filename="prism-config-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
  res.json(portability.exportConfig());
});
router.post('/import', (req, res) => {
  try { res.json({ ok: true, ...portability.importConfig(req.body) }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/* ------------------------------------------------- legacy v3 endpoint aliases */
router.post('/ingest/start', (req, res) => res.json({ ok: true, queued: engine.enqueuePlatforms(req.body && req.body.sources, {}) }));
router.post('/ingest/stop', (req, res) => { engine.stopAll(); res.json({ ok: true }); });
router.post('/ingest/pause', (req, res) => { engine.pause(); res.json({ ok: true }); });
router.post('/ingest/resume', (req, res) => { engine.resume(); res.json({ ok: true }); });
router.get('/ingest/status', (req, res) => res.json({ ...engine.status(), logs: events.getLogs(80) }));
router.get('/ingest/logs', (req, res) => res.json(events.getLogs(600)));
router.post('/ingest/sweep', async (req, res) => res.json({ ok: true, ...(await maintenance.sweep({ probe: !!(req.body && req.body.probeImgur) })) }));

module.exports = router;
