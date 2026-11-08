'use strict';
/**
 * Push alerts: the public key, subscription lifecycle, creator filtering, and the summary job.
 * The sender itself is replaced, so no network or real browser is involved.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let push; let webpush; let creator; let other;

const AGE = { cookie: 'prism_age=1' };
const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...AGE, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};

const sub = (endpoint = 'https://push.example/sub/1') => ({
  endpoint,
  keys: { p256dh: 'BOrU9n0fake-p256dh-key', auth: 'fake-auth-secret' },
});

before(async () => {
  prepareEnv({ PUSH_ENABLED: 'true' });
  repo = require('../src/db/repo');
  push = require('../src/engine/push');
  webpush = require('../src/lib/webpush');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  creator = repo.creators.create({ handle: 'push_creator', displayName: 'Push Creator' });
  other = repo.creators.create({ handle: 'other_creator', displayName: 'Other Creator' });
});

after(async () => { await new Promise((r) => server.close(r)); });

test('the public key endpoint answers without a subscription', async () => {
  const r = await call('/api/push/key');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true);
  assert.ok(r.json.publicKey && r.json.publicKey.length > 20);
});

test('subscribe validates the subscription and stores one row per endpoint', async () => {
  const bad = await call('/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'http://insecure' } } });
  assert.equal(bad.status, 400);

  const first = await call('/api/push/subscribe', { method: 'POST', body: { subscription: sub(), creators: [creator.id, other.id, 'missing'] } });
  assert.equal(first.status, 201);
  assert.equal(first.json.creators, 2);

  const again = await call('/api/push/subscribe', { method: 'POST', body: { subscription: sub(), creators: [other.id] } });
  assert.equal(again.status, 201);
  const rows = repo.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all(sub().endpoint);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].creator_ids), [other.id]);
});

test('the creator list can be changed and the subscription removed', async () => {
  const r = await call('/api/push/creators', { method: 'POST', body: { endpoint: sub().endpoint, creators: [creator.id] } });
  assert.equal(r.status, 200);
  const row = repo.db.prepare('SELECT creator_ids FROM push_subscriptions WHERE endpoint = ?').get(sub().endpoint);
  assert.deepEqual(JSON.parse(row.creator_ids), [creator.id]);

  const gone = await call('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub().endpoint } });
  assert.equal(gone.status, 200);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('a tick sends one summary and advances the cursor; an unrelated creator is ignored', async () => {
  const sent = [];
  const original = webpush.send;
  webpush.send = async (row, payload) => { sent.push({ row, payload }); return { ok: true }; };
  try {
    await call('/api/push/subscribe', { method: 'POST', body: { subscription: sub('https://push.example/sub/tick'), creators: [creator.id] } });
    const row = repo.db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get('https://push.example/sub/tick');
    repo.db.prepare('UPDATE push_subscriptions SET last_checked_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', row.id);

    repo.media.insert({
      creator_id: creator.id, platform: 'reddit', source_id: 'push1', source_key: 'reddit:push1:0', post_key: 'reddit:push1',
      author: 'someone_else', title: 'A new post', media_type: 'image', media_url: 'https://media.example/push.jpg',
      hash: 'pushhash1', source_url: 'https://example.com/push1', posted_at: new Date().toISOString(),
    }, []);
    repo.media.insert({
      creator_id: other.id, platform: 'reddit', source_id: 'push2', source_key: 'reddit:push2:0', post_key: 'reddit:push2',
      author: 'other', title: 'Not watched', media_type: 'image', media_url: 'https://media.example/other.jpg',
      hash: 'pushhash2', source_url: 'https://example.com/push2', posted_at: new Date().toISOString(),
    }, []);

    const result = await push.tick({ now: new Date().toISOString() });
    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.title, /Push Creator/);
    assert.ok(sent[0].payload.url.includes(creator.id));
    assert.ok(!JSON.stringify(sent[0].payload).includes('Not watched'));

    const after = repo.db.prepare('SELECT last_checked_at FROM push_subscriptions WHERE id = ?').get(row.id);
    assert.notEqual(after.last_checked_at, '2000-01-01T00:00:00.000Z');
  } finally { webpush.send = original; }
});

test('a gone endpoint is disabled instead of retried forever', async () => {
  const original = webpush.send;
  webpush.send = async () => ({ ok: false, gone: true, reason: 'endpoint gone (410)' });
  try {
    await call('/api/push/subscribe', { method: 'POST', body: { subscription: sub('https://push.example/sub/gone'), creators: [creator.id] } });
    const row = repo.db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get('https://push.example/sub/gone');
    repo.db.prepare('UPDATE push_subscriptions SET last_checked_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', row.id);
    repo.media.insert({
      creator_id: creator.id, platform: 'reddit', source_id: 'push3', source_key: 'reddit:push3:0', post_key: 'reddit:push3',
      author: 'someone_else', title: 'Another post', media_type: 'image', media_url: 'https://media.example/push3.jpg',
      hash: 'pushhash3', source_url: 'https://example.com/push3', posted_at: new Date().toISOString(),
    }, []);
    await push.tick({ now: new Date().toISOString() });
    const after = repo.db.prepare('SELECT enabled, last_error FROM push_subscriptions WHERE id = ?').get(row.id);
    assert.equal(after.enabled, 0);
    assert.match(after.last_error, /410/);
  } finally { webpush.send = original; }
});
