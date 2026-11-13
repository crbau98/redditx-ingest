'use strict';
const repo = require('../../db/repo');
const registry = require('../../sources');
const engine = require('../../engine/engine');
const targets = require('../../services/targets');

function registerFeeds(router, { int, page, bad, errorKind }) {
/* ------------------------------------------------------------------- feeds */
// Read-only: account feeds attached to a creator by discovery or a deep pull although their own handle is not his.
// Nothing is changed; clean each row up with POST /feeds/:id/media/reassign (the row carries the call).
// Read-only scoreboard: feeds whose runs over the last ?days (default 7, at least 5 runs) fetched nothing. The engine already
// checks these every 3 days instead of on their interval; nothing is disabled or deleted.
router.get('/feeds/idle', (req, res) => {
  const days = int(req.query.days, 1, 90, 7);
  const p = page(req, 500);
  res.json({ days, minRuns: 5, page: p.page, limit: p.limit, ...repo.runs.idleFeeds(new Date(Date.now() - days * 86400000).toISOString(), { minRuns: 5, limit: p.limit, offset: p.page * p.limit }) });
});
router.get('/feeds/foreign', (req, res) => res.json(require('../../engine/deepsearch').foreignFeeds({ limit: req.query.limit, offset: req.query.offset })));
router.get('/feeds', (req, res) => {
  const { platform, kind, status, q, creatorId, enabled } = req.query;
  const out = repo.feeds.list({ platform, kind, status, q, creatorId, enabled, ...page(req, 500) });
  res.json({ ...out, items: out.items.map((f) => ({ ...f, last_error_kind: errorKind(f.last_error) })) });
});

router.post('/feeds', (req, res) => {
  const b = req.body || {};
  const spec = b.input ? registry.parseInput(b.input, { platform: b.platform }) : (b.platform && b.kind && b.target ? { platform: b.platform, kind: b.kind, target: String(b.target).trim() } : null);
  if (!spec) return bad(res, 'Provide an `input` (link or handle) or platform + kind + target');
  const adapter = registry.get(spec.platform);
  if (!adapter || !adapter.kinds.includes(spec.kind)) return bad(res, `${spec.platform} does not support ${spec.kind} feeds`);
  // creatorId: attach the new feed to a creator you already follow (editorial pages, own-site hubs).
  const creatorId = b.creatorId != null ? String(b.creatorId) : null;
  if (creatorId && !repo.creators.get(creatorId)) return bad(res, 'creatorId not found', 404);
  const r = targets.addSpec(spec, { trusted: b.trusted, origin: 'admin', creatorId });
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

// Subreddit taste: every Reddit community feed scored by what it produced for this library, with pause/re-enable
// suggestions. Read-only: applying a suggestion is the admin's own PATCH /feeds/:id { enabled } below.
router.get('/subreddits', (req, res) => res.json(require('../../engine/subreddit-taste').report()));

router.patch('/feeds/:id', (req, res) => {
  if (!repo.feeds.get(req.params.id)) return bad(res, 'Not found', 404);
  const b = req.body || {};
  // logged, so automatic pauses (e.g. the body filter) never undo an admin's own switch later
  const was = repo.feeds.get(req.params.id);
  if (b.enabled !== undefined && !!b.enabled !== !!was.enabled) repo.logAction('feed', was.id, b.enabled ? 'enable' : 'disable', 'admin', 'admin');
  // creatorId: re-attach the feed to another creator (empty string clears). A page that was
  // named after its site belongs to the man in it, not to the magazine.
  if (b.creatorId !== undefined) {
    const cid = b.creatorId ? String(b.creatorId) : null;
    if (cid && !repo.creators.get(cid)) return bad(res, 'creatorId not found', 404);
    repo.db.prepare('UPDATE feeds SET creator_id = ? WHERE id = ?').run(cid, req.params.id);
  }
  res.json(repo.feeds.update(req.params.id, { label: b.label, enabled: b.enabled, trusted: b.trusted, intervalMin: b.intervalMin, priority: b.priority, resetErrors: !!b.resetErrors, runNow: !!b.runNow }));
});

// Move every item this feed brought in to another creator, or unassign them ({ creatorId: null | '' }): cleanup after a
// feed was attached to the wrong man. Only this feed's items; affected creators are recounted; the action is audited.
router.post('/feeds/:id/media/reassign', (req, res) => {
  const b = req.body || {};
  if (!('creatorId' in b)) return bad(res, 'creatorId required (a creator id, or null / "" to unassign)');
  const out = repo.media.reassignFeed(req.params.id, b.creatorId, { actor: 'admin' });
  if (!out) return bad(res, 'Feed or creator not found', 404);
  res.json(out);
});

router.delete('/feeds/:id', (req, res) => {
  if (!repo.feeds.remove(req.params.id)) return bad(res, 'Not found', 404);
  res.json({ ok: true });
});

router.post('/feeds/:id/run', (req, res) => {
  if (!repo.feeds.get(req.params.id)) return bad(res, 'Not found', 404);
  res.json({ ok: true, queued: engine.enqueue([req.params.id], { force: !!(req.body && req.body.force) }) });
});
}

module.exports = { registerFeeds };
