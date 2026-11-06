'use strict';
/**
 * POST /api/admin/media/bulk takes an optional `reasons` map ({ id: reason }): an undo sends a mixed batch back to the review queue,
 * each item under the hold reason it had, in ONE transaction (all of it applies or none of it). The old body (one `reason`) still works.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine;
const adm = async (body) => {
  const res = await fetch(`${base}/api/admin/media/bulk`, { method: 'POST', headers: { 'x-admin-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const item = (state = 'published') => {
  const id = crypto.randomUUID();
  repo.db.prepare(`INSERT INTO media (id, platform, source_key, post_key, media_type, media_url, hash, publish_state) VALUES (?, 'reddit', ?, ?, 'image', ?, ?, ?)`)
    .run(id, `k:${id}`, `k:${id}`, `https://i.example/${id}.jpg`, crypto.randomUUID().replace(/-/g, ''), state);
  return id;
};
const row = (id) => repo.db.prepare('SELECT publish_state, review_reason FROM media WHERE id = ?').get(id);

before(async () => {
  prepareEnv({ MEDIA_STORE: 'disk' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

test('a mixed batch goes back to review in one request, each under its own hold reason; items without one fall back to `reason`', async () => {
  const a = item(); const b = item(); const c = item();
  const out = await adm({ ids: [a, b, c], action: 'flag', reason: 'undo', reasons: { [a]: 'safety: age-claim', [b]: 'scope:unclear' } });
  assert.equal(out.status, 200); assert.equal(out.json.updated, 3);
  assert.deepEqual(row(a), { publish_state: 'review', review_reason: 'safety: age-claim' });
  assert.deepEqual(row(b), { publish_state: 'review', review_reason: 'scope:unclear' });
  assert.deepEqual(row(c), { publish_state: 'review', review_reason: 'undo' });
});

test('the old body (one reason for all) still works, and a non-string or oversized reason is ignored or cut', async () => {
  const a = item(); const b = item();
  assert.equal((await adm({ ids: [a], action: 'flag', reason: 'one reason' })).json.updated, 1);
  assert.equal(row(a).review_reason, 'one reason');
  await adm({ ids: [a, b], action: 'flag', reason: 'fallback', reasons: { [a]: 42, [b]: 'x'.repeat(500) } });
  assert.equal(row(a).review_reason, 'fallback', 'a non-string reason is ignored');
  assert.equal(row(b).review_reason.length, 200, 'an oversized reason is cut');
});

test('it is one transaction: a failure part-way leaves nothing half applied', async () => {
  const a = item(); const b = item();
  const targets = require('../src/services/targets'); const real = targets.moderate;
  let calls = 0;
  targets.moderate = (...args) => { if (++calls === 2) throw new Error('boom'); return real(...args); };
  try {
    const out = await adm({ ids: [a, b], action: 'flag', reasons: { [a]: 'safety: age-claim', [b]: 'scope:unclear' } });
    assert.ok(out.status >= 500, `the request failed (${out.status})`);
  } finally { targets.moderate = real; }
  assert.equal(row(a).publish_state, 'published', 'the first item was not left undone on its own');
  assert.equal(row(b).publish_state, 'published');
});
