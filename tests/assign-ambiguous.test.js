'use strict';
/** Phase E: an admin names the creator of a Telegram post held as attribution:telegram-ambiguous. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let db; let server; let base; let engine;
before(async () => {
  repo = require('../src/db/repo'); db = repo.db; engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

const post = (path, body, headers = { 'x-admin-key': 'test-key', 'content-type': 'application/json' }) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
let n = 0;
const held = (extra = {}) => { n++; return repo.media.insert({ platform: 'telegram', source_id: `tg${n}`, source_key: `telegram:tg${n}:0`, post_key: `telegram:tg${n}`, author: 'somechannel', media_type: 'image', media_url: `https://example.com/tg${n}.jpg`, hash: `tgh${n}`,
  publish_state: 'review', review_reason: 'attribution:telegram-ambiguous', attribution_evidence: JSON.stringify({ forwardFrom: { handle: 'origchan' }, channel: 'somechannel' }), ...extra }, []); };

test('assigning publishes the row to the named creator, keeps its evidence, recounts and audits', async () => {
  const c = repo.creators.create({ handle: 'tg_creator', displayName: 'TG Creator' });
  const id = held();
  const evidenceBefore = db.prepare('SELECT attribution_evidence FROM media WHERE id = ?').get(id).attribution_evidence;
  const res = await post(`/media/${id}/assign`, { creatorId: c.id });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT creator_id, publish_state, attribution_evidence FROM media WHERE id = ?').get(id);
  assert.equal(row.creator_id, c.id);
  assert.equal(row.publish_state, 'published');
  assert.equal(row.attribution_evidence, evidenceBefore, 'the forward evidence is kept as it was');
  assert.equal(repo.creators.get(c.id).media_count, 1, 'recounted');
  const actions = db.prepare("SELECT action FROM moderation_actions WHERE target_type = 'media' AND target_id = ? ORDER BY id").all(id).map((r) => r.action);
  assert.deepEqual(actions, ['approve', 'assign']);
});

test('other review reasons, published rows, unknown or blocked creators are refused; the row is unchanged', async () => {
  const c = repo.creators.create({ handle: 'tg_creator2', displayName: 'TG 2' });
  const safety = held({ review_reason: 'safety:age-words' });
  const r1 = await post(`/media/${safety}/assign`, { creatorId: c.id });
  assert.equal(r1.status, 409);
  assert.equal(db.prepare('SELECT publish_state, creator_id FROM media WHERE id = ?').get(safety).publish_state, 'review');
  const pub = held({ publish_state: 'published', review_reason: null });
  assert.equal((await post(`/media/${pub}/assign`, { creatorId: c.id })).status, 409);
  const amb = held();
  assert.equal((await post(`/media/${amb}/assign`, { creatorId: 'no-such' })).status, 404);
  const blocked = repo.creators.create({ handle: 'tg_blocked', displayName: 'Blocked' });
  db.prepare("UPDATE creators SET status = 'blocked' WHERE id = ?").run(blocked.id);
  assert.equal((await post(`/media/${amb}/assign`, { creatorId: blocked.id })).status, 409);
  assert.deepEqual(db.prepare('SELECT publish_state, creator_id FROM media WHERE id = ?').get(amb), { publish_state: 'review', creator_id: null });
  assert.equal((await post('/media/nope/assign', { creatorId: c.id })).status, 404);
  assert.equal((await post(`/media/${amb}/assign`, {})).status, 400);
  assert.equal((await post(`/media/${amb}/assign`, { creatorId: c.id }, { 'content-type': 'application/json' })).status, 401);
});
