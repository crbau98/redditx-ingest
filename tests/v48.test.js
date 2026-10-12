'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv, JPEG, PNG_TINY } = require('./helpers/mock');

let server; let base; let mock; let repo; let engine; let backup; let health; let settings;
const hits = {};
const AGE = { cookie: 'prism_age=1' };
const ADMIN = { 'x-admin-key': 'test-key' };
const call = async (p, { method = 'GET', headers = AGE } = {}) => { const res = await fetch(`${base}${p}`, { method, headers }); return { status: res.status, json: await res.json().catch(() => null) }; };

before(async () => {
  const count = (k) => { hits[k] = (hits[k] || 0) + 1; };
  mock = await start({
    '/ok.jpg': () => { count('ok'); return { headers: { 'content-type': 'image/jpeg' }, body: JPEG }; },
    '/gone.jpg': () => { count('gone'); return { status: 404, body: 'not found' }; },
    '/gone2.jpg': () => { count('gone2'); return { status: 410, body: 'gone' }; },
    '/removed.png': () => { count('removed'); return { headers: { 'content-type': 'image/png' }, body: PNG_TINY }; },
    '/hotlink.jpg': () => { count('hotlink'); return { status: 403, body: 'forbidden' }; },
  });
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  health = require('../src/engine/health'); settings = require('../src/settings');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); health.stop(); await mock.close(); await new Promise((r) => server.close(r)); });

let n = 0;
const item = (path) => {
  n++;
  const id = repo.media.insert({ platform: 'reddit', source_id: `lh${n}`, source_key: `reddit:lh${n}:0`, post_key: `reddit:lh${n}`, title: `item ${n}`, media_type: 'image', media_url: `${mock.url}${path}?n=${n}`, hash: `v48h${n}` }, []);
  return id;
};
// Pretend the last check happened `ms` ago, so the one-hour confirmation window has passed.
const age = (id, ms) => repo.db.prepare('UPDATE media_health SET checked_at = ? WHERE media_id = ?').run(new Date(Date.now() - ms).toISOString(), id);
const state = (id) => repo.db.prepare('SELECT publish_state, review_reason FROM media WHERE id = ?').get(id);

describe('link health: a self-healing library', () => {
  test('classification: 404/410 and placeholders are gone; hotlink blocks, timeouts and 5xx are unknown', () => {
    assert.equal(health.classify({ ok: true }).verdict, 'ok');
    assert.equal(health.classify({ ok: false, reason: 'http 404' }).verdict, 'gone');
    assert.equal(health.classify({ ok: false, reason: 'http 410' }).verdict, 'gone');
    assert.equal(health.classify({ ok: false, reason: 'too small (503 B)' }).verdict, 'gone');
    for (const r of ['http 403', 'http 503', 'unreachable: Timeout', 'not media (text/html)', 'blocked host']) assert.equal(health.classify({ ok: false, reason: r }).verdict, 'unknown', r);
  });

  test('gone at source is hidden only after a second verdict at least an hour later', async () => {
    const id = item('/gone.jpg');
    let r = await health.check(id);
    assert.equal(r.verdict, 'gone'); assert.equal(r.hidden, false);
    r = await health.check(id); // again right away: does not confirm
    assert.equal(r.streak, 1); assert.equal(state(id).publish_state, 'published');
    age(id, health.CONFIRM_AFTER_MS + 1000);
    r = await health.check(id);
    assert.equal(r.hidden, true);
    assert.deepEqual(state(id), { publish_state: 'hidden', review_reason: 'Gone at source (http 404)' });
    const list = await call('/api/media?limit=100');
    assert.ok(!list.json.items.some((m) => m.id === id), 'gone items leave public feeds');
  });

  test('placeholders (imgur-style removed.png) count as gone; 410 too', async () => {
    const a = item('/removed.png'); const b = item('/gone2.jpg');
    for (const id of [a, b]) { await health.check(id); age(id, health.CONFIRM_AFTER_MS + 1000); await health.check(id); }
    assert.equal(state(a).publish_state, 'hidden'); assert.match(state(a).review_reason, /Gone at source/);
    assert.equal(state(b).review_reason, 'Gone at source (http 410)');
  });

  test('hotlink blocks never hide anything, however often they are seen or reported', async () => {
    const id = item('/hotlink.jpg');
    for (let i = 0; i < 4; i++) { const r = await health.check(id); assert.equal(r.verdict, 'unknown'); age(id, health.CONFIRM_AFTER_MS + 1000); }
    for (let i = 0; i < 5; i++) health.report(id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(state(id).publish_state, 'published');
  });

  test('an item that comes back is cleared: a later ok resets the streak and the reports', async () => {
    const id = item('/ok.jpg');
    health.report(id); await new Promise((r) => setTimeout(r, 200));
    const row = repo.db.prepare('SELECT * FROM media_health WHERE media_id = ?').get(id);
    assert.equal(row.verdict, 'ok'); assert.equal(row.reports, 0); assert.equal(row.gone_streak, 0);
    assert.equal(state(id).publish_state, 'published');
  });

  test('reports: verified asynchronously, at most once per 30 minutes per item, unless a confirmation is due', async () => {
    const id = item('/gone.jpg');
    const before = hits.gone || 0;
    assert.equal((await call(`/api/media/${id}/broken`, { method: 'POST' })).json.checking, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hits.gone, before + 1);
    const again = await call(`/api/media/${id}/broken`, { method: 'POST' });
    assert.equal(again.status, 202); assert.equal(again.json.checking, false, 'just checked: no second probe');
    age(id, health.CONFIRM_AFTER_MS + 1000);
    assert.equal((await call(`/api/media/${id}/broken`, { method: 'POST' })).json.checking, true, 'a pending confirmation is due');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(state(id).publish_state, 'hidden');
    // input checks and the age gate
    assert.equal((await call('/api/media/not-an-id/broken', { method: 'POST' })).status, 400);
    assert.equal((await call('/api/media/00000000-0000-0000-0000-000000000000/broken', { method: 'POST' })).status, 404);
    assert.equal((await call(`/api/media/${id}/broken`, { method: 'POST', headers: {} })).status, 403);
  });

  test('the background sweep checks never-checked items and pending confirmations first, within its budget', async () => {
    const fresh = [item('/ok.jpg'), item('/ok.jpg'), item('/ok.jpg')];
    const pending = item('/gone.jpg');
    await health.check(pending); age(pending, health.CONFIRM_AFTER_MS + 1000);
    const r = await health.sweep({ limit: 2 });
    assert.equal(r.checked, 2);
    assert.equal(state(pending).publish_state, 'hidden', 'the pending confirmation went first');
    const r2 = await health.sweep({ limit: 50 });
    assert.ok(r2.checked >= 2);
    for (const id of fresh) assert.equal(repo.db.prepare('SELECT verdict FROM media_health WHERE media_id = ?').get(id).verdict, 'ok');
  });

  test('the switch turns verification off; admin overview reports the numbers', async () => {
    settings.update({ linkHealth: false });
    const id = item('/gone.jpg');
    assert.equal(health.report(id).checking, false);
    settings.update({ linkHealth: true });
    const o = await call('/api/admin/overview', { headers: ADMIN });
    assert.ok(o.json.health.checked >= 5);
    assert.ok(o.json.health.gone7d >= 3);
  });
});
