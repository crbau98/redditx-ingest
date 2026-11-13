'use strict';
const repo = require('../../db/repo');
const targets = require('../../services/targets');
const physique = require('../../engine/physique');
const settingsStore = require('../../settings');
const events = require('../../engine/events');

function registerModeration(router, { int, page, bad }) {
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
  if (req.body && req.body.creator_id !== undefined && req.body.creator_id && !repo.creators.get(req.body.creator_id)) return bad(res, 'creator not found', 404);
  res.json(repo.media.update(req.params.id, req.body || {}));
});

// Name the creator of a Telegram post held as attribution:telegram-ambiguous, and publish it (that review reason only).
router.post('/media/:id/assign', (req, res) => {
  const { creatorId } = req.body || {};
  if (!creatorId) return bad(res, 'creatorId required');
  const out = targets.assignAmbiguous(req.params.id, creatorId, 'admin');
  if (out && out.error) return bad(res, out.error, out.status);
  res.json(out);
});
router.post('/media/:id/moderate', (req, res) => {
  const { action, reason } = req.body || {};
  const out = targets.moderate(req.params.id, action, reason);
  if (out === null) return bad(res, 'Not found', 404);
  if (out === undefined) return bad(res, 'Unknown action. Use approve, hide, flag, reject or block');
  res.json(out);
});

router.post('/media/bulk', (req, res) => {
  const { ids, action, reason, reasons } = req.body || {};
  if (!Array.isArray(ids) || !action) return bad(res, 'ids array and action required');
  // `reasons` (optional): { id: reason } for items that each carry their own (an undo puts every item back under the hold reason it
  // had), so a mixed batch is still ONE transaction: all of it applies or none of it. Others fall back to `reason`.
  const own = (id) => (reasons && typeof reasons === 'object' && typeof reasons[id] === 'string' && reasons[id].slice(0, 200)) || null;
  let updated = 0;
  repo.db.transaction(() => { for (const id of ids.slice(0, 500)) if (targets.moderate(String(id), action, own(String(id)) || reason || 'bulk')) updated++; })();
  res.json({ ok: true, updated });
});

router.get('/moderation/queue', (req, res) => {
  // kind = safety|scope|other; reason = exact review_reason. Reason wins when both are set.
  const kind = ['safety', 'scope', 'other'].includes(req.query.kind) ? req.query.kind : undefined;
  const reason = typeof req.query.reason === 'string' ? req.query.reason.trim().slice(0, 200) : '';
  const r = repo.media.list({
    admin: true, state: 'review', sort: 'ingested', ...page(req),
    ...(reason ? { reviewReason: reason } : kind ? { reviewKind: kind } : {}),
  });
  res.json({ ...r, kind: kind || null, reason: reason || null, reasons: repo.media.reviewReasonCounts() });
});

// One chunk of a hold: every waiting row with this exact reason, not a prefix and not another state.
// Block stays on the per-item action. The caller repeats until `remaining` is 0. Same 500 cap as /media/bulk.
const REVIEW_REASON_CHUNK = 500;
router.post('/moderation/by-reason', (req, res) => {
  const body = req.body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const action = body.action;
  if (!reason || reason.length > 200 || !['approve', 'hide', 'reject'].includes(action)) {
    return bad(res, 'reason (1–200 characters) and action (approve, hide or reject) required');
  }
  const creators = new Set();
  const ids = [];
  repo.db.transaction(() => {
    for (const row of repo.media.reviewIdsByReason(reason, REVIEW_REASON_CHUNK)) {
      const cur = repo.media.get(row.id);
      // The list and the write share this transaction. Skip a row that left this hold since the read.
      if (!cur || cur.publish_state !== 'review' || cur.review_reason !== reason) continue;
      const out = targets.moderate(row.id, action, reason, 'admin', { deferStats: true });
      if (!out) continue;
      ids.push(row.id);
      if (row.creator_id) creators.add(row.creator_id);
    }
  })();
  for (const id of creators) repo.creators.refreshStats(id);
  res.json({ ok: true, updated: ids.length, remaining: repo.media.countReviewReason(reason), ids });
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

router.get('/audit', (req, res) => res.json(repo.audit.list({ ...page(req), targetType: ['media', 'creator', 'report', 'takedown', 'setting', 'feed', 'candidate'].includes(req.query.type) ? req.query.type : undefined })));
}

module.exports = { registerModeration };
