'use strict';
/** Wave 11 minor items: 9 engagement dedupe, 10 lockout, 12 handles + merge + push, 14 public health, 15 SSE caps. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prepareEnv } = require('./helpers/mock');

let repo; let server; let base; let engine; let backup;
const H = { cookie: 'prism_age=1', 'content-type': 'application/json' };
const ADMIN = { 'x-admin-key': 'test-key' };
before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'false' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body || {}) });
let n = 0;
const mkMedia = () => { n++; return repo.media.insert({ platform: 'reddit', source_id: `w11m${n}`, source_key: `reddit:w11m${n}:0`, post_key: `reddit:w11m${n}`, media_type: 'image', media_url: `https://i.redd.it/w11m${n}.jpg`, hash: `w11mh${n}`, posted_at: new Date().toISOString() }, []); };

describe('item 9: one like and one view per address and item', () => {
  test('repeated views from one address count once', async () => {
    const id = mkMedia();
    const before0 = repo.media.get(id).views;
    for (let i = 0; i < 20; i++) assert.equal((await post(`/api/media/${id}/view`)).status, 200);
    assert.equal(repo.media.get(id).views, before0 + 1);
  });
  test('likes count once; an un-like undoes only a like this address made; then it can like again', async () => {
    const id = mkMedia();
    const likes = () => repo.media.get(id).likes;
    const start = likes();
    await post(`/api/media/${id}/like`, { delta: -1 }); assert.equal(likes(), start, 'cannot un-like what it never liked');
    for (let i = 0; i < 10; i++) await post(`/api/media/${id}/like`, { delta: 1 });
    assert.equal(likes(), start + 1);
    for (let i = 0; i < 5; i++) await post(`/api/media/${id}/like`, { delta: -1 });
    assert.equal(likes(), start);
    await post(`/api/media/${id}/like`, { delta: 1 }); assert.equal(likes(), start + 1);
  });
  test('another item is counted separately', async () => {
    const a = mkMedia(); const b = mkMedia();
    await post(`/api/media/${a}/view`); await post(`/api/media/${b}/view`);
    assert.equal(repo.media.get(a).views, 1); assert.equal(repo.media.get(b).views, 1);
  });
});

describe('item 10: the lockout does not refuse the correct key', () => {
  test('after the failed-attempt budget is spent, wrong keys are 429 but the right key still works', async () => {
    let last;
    for (let i = 0; i < 25; i++) last = await fetch(`${base}/api/admin/overview`, { headers: { 'x-admin-key': `wrong-${i}` } });
    assert.equal(last.status, 429, 'the wrong key is locked out');
    const ok = await fetch(`${base}/api/admin/overview`, { headers: ADMIN });
    assert.equal(ok.status, 200, 'the correct key is not');
    assert.equal((await fetch(`${base}/api/admin/overview`, { headers: { 'x-admin-key': 'wrong-again' } })).status, 429);
  });
});

describe('item 12: handles are cleaned; merge repairs push subscriptions; old rows can be cleaned', () => {
  test('create() strips trailing space and zero-width characters', () => {
    const a = repo.creators.create({ handle: 'Zed​', origin: 'admin' });
    const b = repo.creators.create({ handle: '  Zed ', origin: 'admin' });
    assert.equal(a.handle, 'Zed'); assert.equal(b.handle, 'Zed');
    const { cleanHandle } = require('../src/lib/creator-names');
    assert.equal(cleanHandle('A‍⁠l﻿ice­ '), 'Alice');
    assert.equal(cleanHandle('Café'), 'Café', 'NFC');
    assert.equal(repo.creators.update(a.id, { handle: ' Zed2​ ' }).handle, 'Zed2');
  });
  test('merge points push subscriptions at the kept creator, once', () => {
    const keep = repo.creators.create({ handle: 'pushkeep', origin: 'admin' });
    const gone = repo.creators.create({ handle: 'pushgone', origin: 'admin' });
    const other = repo.creators.create({ handle: 'pushother', origin: 'admin' });
    const ins = repo.db.prepare("INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, creator_ids) VALUES (?, ?, 'p', 'a', ?)");
    ins.run('w11ps1', 'https://push.test/1', JSON.stringify([gone.id, other.id]));
    ins.run('w11ps2', 'https://push.test/2', JSON.stringify([keep.id, gone.id]));
    ins.run('w11ps3', 'https://push.test/3', JSON.stringify([other.id]));
    repo.creators.merge(keep.id, gone.id);
    const ids = (id) => JSON.parse(repo.db.prepare('SELECT creator_ids FROM push_subscriptions WHERE id = ?').get(id).creator_ids);
    assert.deepEqual(ids('w11ps1'), [keep.id, other.id]);
    assert.deepEqual(ids('w11ps2'), [keep.id], 'no duplicate when both were followed');
    assert.deepEqual(ids('w11ps3'), [other.id]);
  });
  test('normalizeHandles cleans old rows (dry run first); the same-handle list then groups them', async () => {
    const ins = repo.db.prepare("INSERT INTO creators (id, handle, display_name) VALUES (?, ?, ?)");
    ins.run('w11-c1', 'Dupe​', 'Dupe'); ins.run('w11-c2', 'dupe ', 'dupe'); ins.run('w11-c3', 'DUPE', 'DUPE');
    const dry = repo.creators.normalizeHandles({ dryRun: true });
    assert.ok(dry.changed >= 2);
    assert.equal(repo.db.prepare("SELECT handle FROM creators WHERE id = 'w11-c1'").get().handle, 'Dupe​', 'a dry run changes nothing');
    const r = await fetch(`${base}/api/admin/creators/normalize-handles`, { method: 'POST', headers: { ...H, ...ADMIN }, body: '{}' });
    assert.equal(r.status, 200); assert.ok((await r.json()).changed >= 2);
    const groups = await (await fetch(`${base}/api/admin/creators/same-handle`, { headers: ADMIN })).json();
    const g = groups.groups.find((x) => x.handle === 'dupe');
    assert.ok(g && g.creators.length === 3, 'all three are one group: nothing was merged, the admin decides');
  });
});

describe('item 14: the public health endpoint leaves out feed ids, job text and profile files', () => {
  test('public carries no job/SQL/profile names; the admin route does', async () => {
    const bw = require('../src/lib/blockwatch');
    bw.start();
    const feedId = '123e4567-e89b-12d3-a456-426614174000';
    const leave = bw.enter(`feed web:${feedId}`);
    bw._noteSlice('sql: SELECT secret FROM media WHERE feed_id = ?', 4000);
    const rec = bw._noteBlock(4500);
    assert.ok(rec && rec.job.includes('sql:'));
    leave();
    const pub = await (await fetch(`${base}/api/health`)).json();
    const text = JSON.stringify(pub);
    assert.ok(!text.includes(feedId) && !text.includes('SELECT') && !/cpuprofile/.test(text) && !('profiles' in pub));
    assert.equal(pub.block.ms, 4500);
    assert.ok(pub.warnings.some((w) => /event loop blocked 4500 ms$/.test(w)), JSON.stringify(pub.warnings));
    // the window was consumed by the public read: record again for the admin read
    bw._noteSlice('sql: SELECT secret FROM media WHERE feed_id = ?', 4000); bw._noteBlock(4500);
    const adm = await (await fetch(`${base}/api/admin/health`, { headers: ADMIN })).json();
    assert.match(adm.block.job, /sql: SELECT secret/); assert.ok(Array.isArray(adm.profiles));
    assert.ok([401, 429].includes((await fetch(`${base}/api/admin/health`)).status), 'no key: refused (401, or 429 once the lockout budget is spent)');
    bw.stop(); bw.reset();
  });
});

describe('item 15: open live streams are capped per address and in total', () => {
  const open = () => new Promise((resolve) => {
    const req = http.get(`${base}/api/stream`, (res) => resolve({ res, req }));
    req.on('error', () => resolve({ res: { statusCode: 0, resume() {} }, req }));
  });
  test('per-address cap answers 429; closing a stream frees a slot', async () => {
    const events = require('../src/engine/events');
    const cap = events._streamCaps.public.perIp;
    const open1 = [];
    for (let i = 0; i < cap; i++) { const c = await open(); assert.equal(c.res.statusCode, 200, `stream ${i + 1}`); open1.push(c); }
    const over = await open();
    assert.equal(over.res.statusCode, 429); over.res.resume();
    assert.ok(over.res.headers['retry-after']);
    open1[0].req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const again = await open(); assert.equal(again.res.statusCode, 200);
    for (const c of [...open1.slice(1), again]) c.req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events._streamCount('public', '::ffff:127.0.0.1') + events._streamCount('public', '127.0.0.1'), 0, 'counters return to zero');
  });
  test('the total cap holds across addresses', () => {
    const events = require('../src/engine/events');
    const saved = events._streamCaps.public.total; events._streamCaps.public.total = 0;
    let status = null; const res = { set() {}, status(s) { status = s; return this; }, json() { return this; } };
    events.subscribe('public', { ip: '203.0.113.9', on() {} }, res);
    events._streamCaps.public.total = saved;
    assert.equal(status, 429);
  });
});
