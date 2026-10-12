'use strict';
const express = require('express');
const config = require('../config');
const repo = require('../db/repo');
const registry = require('../sources');
const engine = require('../engine/engine');
const events = require('../engine/events');
const breaker = require('../engine/breaker');
const maintenance = require('../engine/maintenance');
const settingsStore = require('../settings');
const targets = require('../services/targets');
const portability = require('../services/portability');
const backup = require('../engine/backup');
const { adminAuth } = require('../middleware/auth');

const router = express.Router();
router.use(adminAuth);

const int = repo.clampInt;
const page = (req, max = 200) => ({ page: int(req.query.page, 0, 100000, 0), limit: int(req.query.limit, 1, max, 50) });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/* ---------------------------------------------------------------- overview */
router.get('/overview', (req, res) => {
  res.json({ ...repo.adminOverview(), engine: engine.status(), version: config.version, adminOpen: !config.adminKey });
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
  res.json(registry.describe().map((s) => ({ ...s, feeds: counts[s.platform] || { total: 0, enabled: 0, failing: 0 }, breaker: breakers[s.platform] || { state: 'closed', failures: 0 } })));
});

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
  const out = repo.creators.merge(keepId, mergeId);
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
    restore: () => report.media_id && repo.media.setState(report.media_id, 'published'),
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
    },
    instances: { mastodon: config.mastodonInstances, lemmy: config.lemmyInstances },
    security: { adminKeySet: !!config.adminKey, ageGateEnforced: config.ageGateEnforce },
  });
});
router.put('/settings', (req, res) => res.json({ values: settingsStore.update(req.body || {}) }));

/* ------------------------------------------------------------- maintenance */
router.post('/maintenance/sweep', async (req, res) => {
  try { res.json({ ok: true, ...(await maintenance.sweep({ probe: !!(req.body && req.body.probe) })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/maintenance/recompute', (req, res) => res.json({ ok: true, updated: repo.media.recomputeHot() }));

/* ------------------------------------------------- audit / duplicates / backups / portability */
router.get('/audit', (req, res) => res.json(repo.audit.list({ ...page(req), targetType: ['media', 'creator', 'report'].includes(req.query.type) ? req.query.type : undefined })));

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
