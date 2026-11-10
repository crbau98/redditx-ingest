'use strict';
/**
 * POST /api/admin/moderation/by-reason clears every waiting row with one exact hold reason,
 * one chunk at a time. It does not touch another reason, another state, or a lookalike prefix.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine;
const adm = async (path, body) => {
  const res = await fetch(`${base}/api/admin${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-admin-key': 'test-key', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const item = (reason, state = 'review', creatorId = null) => {
  const id = crypto.randomUUID();
  repo.db.prepare(`INSERT INTO media (id, creator_id, platform, source_key, post_key, media_type, media_url, hash, publish_state, review_reason)
    VALUES (?, ?, 'reddit', ?, ?, 'image', ?, ?, ?, ?)`)
    .run(id, creatorId, `k:${id}`, `k:${id}`, `https://i.example/${id}.jpg`, crypto.randomUUID().replace(/-/g, ''), state, reason);
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

test('the review-reason index is partial, so a hold lookup does not scan the library', () => {
  const sql = repo.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ix_media_review_reason'").get();
  assert.ok(sql, 'index exists');
  assert.match(sql.sql, /WHERE publish_state = 'review'/);
});

test('one chunk hides every waiting row with that exact reason, and leaves every other row alone', async () => {
  const reason = 'scope:unclear-exact';
  const a = item(reason); const b = item(reason);
  const other = item('safety: age-claim');
  const published = item(reason, 'published');
  const hidden = item(reason, 'hidden');
  const prefix = item('scope:unclear-exact-extra');
  const out = await adm('/moderation/by-reason', { reason, action: 'hide' });
  assert.equal(out.status, 200);
  assert.equal(out.json.updated, 2);
  assert.equal(out.json.remaining, 0);
  assert.deepEqual(out.json.ids.sort(), [a, b].sort());
  assert.deepEqual(row(a), { publish_state: 'hidden', review_reason: reason });
  assert.deepEqual(row(b), { publish_state: 'hidden', review_reason: reason });
  assert.equal(row(other).publish_state, 'review');
  assert.equal(row(published).publish_state, 'published');
  assert.equal(row(hidden).publish_state, 'hidden');
  assert.equal(row(prefix).publish_state, 'review', 'a longer reason is not a match');
});

test('a pattern character is an exact reason, not a wildcard', async () => {
  const id = item('scope:unclear-wild');
  const out = await adm('/moderation/by-reason', { reason: 'scope:%', action: 'reject' });
  assert.equal(out.status, 200);
  assert.equal(out.json.updated, 0);
  assert.equal(row(id).publish_state, 'review');
});

test('block and an empty reason are refused, and the row stays waiting', async () => {
  const id = item('scope:unclear-keep');
  assert.equal((await adm('/moderation/by-reason', { reason: 'scope:unclear-keep', action: 'block' })).status, 400);
  assert.equal((await adm('/moderation/by-reason', { reason: '  ', action: 'hide' })).status, 400);
  assert.equal((await adm('/moderation/by-reason', { action: 'approve' })).status, 400);
  assert.equal(row(id).publish_state, 'review');
});

test('approving a hold publishes those rows and recounts the creator once for the whole chunk', async () => {
  const creator = crypto.randomUUID();
  repo.db.prepare("INSERT INTO creators (id, handle, display_name, scope, origin) VALUES (?, ?, ?, 'in', 'test')").run(creator, creator, creator);
  const reason = 'scope:unclear-count';
  item(reason, 'review', creator);
  item(reason, 'review', creator);
  const out = await adm('/moderation/by-reason', { reason, action: 'approve' });
  assert.equal(out.json.updated, 2);
  assert.equal(out.json.remaining, 0);
  const count = repo.db.prepare('SELECT media_count FROM creators WHERE id = ?').get(creator).media_count;
  assert.equal(count, 2, 'both published rows are in the creator total');
});

test('a hold bigger than one chunk leaves the rest waiting, and the queue lists that reason', async () => {
  const reason = 'scope:unclear-chunk';
  const insert = repo.db.transaction(() => { for (let i = 0; i < 501; i++) item(reason); });
  insert();
  const first = await adm('/moderation/by-reason', { reason, action: 'hide' });
  assert.equal(first.json.updated, 500);
  assert.equal(first.json.remaining, 1);
  const q = await adm('/moderation/queue');
  const listed = q.json.reasons.find((r) => r.reason === reason);
  assert.ok(listed, 'the queue reports holds by reason');
  assert.equal(listed.n, 1);
  const second = await adm('/moderation/by-reason', { reason, action: 'hide' });
  assert.equal(second.json.updated, 1);
  assert.equal(second.json.remaining, 0);
});

test('the review queue pages past the newest slice of a mixed backlog', async () => {
  const insert = repo.db.transaction(() => {
    for (let i = 0; i < 65; i++) item(i % 2 ? 'scope:unclear-page' : 'safety: age-claim');
  });
  insert();
  const first = await adm('/moderation/queue?limit=60&page=0');
  const second = await adm('/moderation/queue?limit=60&page=1');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.json.page, 0);
  assert.equal(first.json.limit, 60);
  assert.equal(first.json.items.length, 60);
  assert.ok(first.json.total >= 65);
  assert.equal(second.json.page, 1);
  assert.ok(second.json.items.length >= 5);
  const firstIds = new Set(first.json.items.map((m) => m.id));
  assert.ok(second.json.items.every((m) => !firstIds.has(m.id)), 'page 1 is not a repeat of page 0');
});

test('the review queue filters by hold kind or one named reason', async () => {
  item('safety: age-claim');
  item('safety: age-claim');
  item('scope:unclear');
  item('physique:heavy');
  const safety = await adm('/moderation/queue?kind=safety');
  assert.equal(safety.status, 200);
  assert.equal(safety.json.kind, 'safety');
  assert.ok(safety.json.items.length >= 2);
  assert.ok(safety.json.items.every((m) => String(m.review_reason).startsWith('safety:')));
  const named = await adm('/moderation/queue?reason=' + encodeURIComponent('scope:unclear'));
  assert.equal(named.status, 200);
  assert.equal(named.json.reason, 'scope:unclear');
  assert.ok(named.json.items.length >= 1);
  assert.ok(named.json.items.every((m) => m.review_reason === 'scope:unclear'));
  const other = await adm('/moderation/queue?kind=other');
  assert.equal(other.status, 200);
  assert.ok(other.json.items.some((m) => m.review_reason === 'physique:heavy'));
  assert.ok(other.json.items.every((m) => !String(m.review_reason || '').startsWith('safety:') && m.review_reason !== 'scope:unclear' && m.review_reason !== 'scope'));
});
