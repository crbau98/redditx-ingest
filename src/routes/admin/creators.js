'use strict';
const repo = require('../../db/repo');
const engine = require('../../engine/engine');
const targets = require('../../services/targets');
const identity = require('../../engine/identity');
const lookup = require('../../engine/lookup');

function registerCreators(router, { int, page, bad }) {
/* ---------------------------------------------------------------- creators */
router.get('/creators', (req, res) => {
  const r = repo.creators.list({ ...page(req, 200), q: req.query.q, sort: req.query.sort || 'recent', admin: true, minMedia: 0 });
  res.json(r);
});

// Creators that share a handle (read-only list) and the admin's "different people" verdict for one pair. Merging uses
// POST /creators/merge with the keepId the list names (the row with more posts). Nothing here merges on its own.
router.get('/creators/same-handle', (req, res) => res.json(identity.sameHandleGroups({ limit: int(req.query.limit, 1, 1000, 200) })));
router.post('/creators/same-handle/dismiss', (req, res) => {
  const { aId, bId } = req.body || {};
  if (!aId || !bId) return bad(res, 'aId and bId required');
  return identity.dismissSameHandle(String(aId), String(bId), 'admin') ? res.json({ ok: true }) : bad(res, 'Not a same-handle pair, or already decided', 404);
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
/* ------------------------------------------------------------- deep pull */
// Sweep the whole web for this creator now (text + video + image + reverse-image), in the background.
router.post('/creators/:id/pull', (req, res) => {
  const out = require('../../engine/deepsearch').kick(req.params.id, { trigger: 'manual', force: req.body?.force !== false });
  res.status(out.error ? 404 : 200).json(out);
});
router.get('/creators/:id/pull', (req, res) => res.json(require('../../engine/deepsearch').status(req.params.id)));

/* ------------------------------------------------------------ creator lookup */
// Find a person by name, performer name, handle or link across platforms (read-only), then follow the chosen accounts.
router.post('/lookup', async (req, res) => {
  try {
    const q = String((req.body && req.body.query) || '').trim();
    if (!q) return res.status(400).json({ error: 'Type a name, a handle or a profile link' });
    const out = await lookup.lookup(q);
    // The search resolved to a creator we already follow: sweep the web for everything else of his.
    try { require('../../engine/deepsearch').fromLookup(out, q); } catch { /* the pull reports its own errors */ }
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
router.get('/creators-duplicates', (req, res) => res.json(repo.creators.duplicates().slice(0, 100)));
}

module.exports = { registerCreators };
