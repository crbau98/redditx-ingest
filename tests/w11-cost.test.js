'use strict';
/**
 * Wave 11: Railway cost (memory, CPU, egress visibility).
 *   1. SQLite cache / mmap per connection are env-tunable with lean defaults, leanest on the read-only worker.
 *   2. One picture-model worker by default; the pool is released when idle and comes back on the next picture.
 *   3. The model sweeps run on a duty cycle so the pool can be released between cycles.
 *   4. Chrome / Playwright close sooner when idle.
 *   5. The media proxy counts the bytes it sends, by day, kind and cache result, shown in GET /api/admin/engine.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { start, prepareEnv, JPEG } = require('./helpers/mock');

prepareEnv();
const config = require('../src/config');

describe('1. SQLite memory per connection', () => {
  const withEnv = (vars, fn) => {
    const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  };
  test('defaults: main 64 MB cache + 256 MB mmap, read-only worker 16 MB cache + no mmap', () => {
    withEnv({ PRISM_DB_READONLY: undefined, SQLITE_CACHE_MB: undefined, SQLITE_MMAP_MB: undefined }, () => assert.deepEqual(config.sqliteMemory, { cacheMb: 64, mmapMb: 256 }));
    withEnv({ PRISM_DB_READONLY: '1', SQLITE_WORKER_CACHE_MB: undefined, SQLITE_WORKER_MMAP_MB: undefined }, () => assert.deepEqual(config.sqliteMemory, { cacheMb: 16, mmapMb: 0 }));
  });
  test('env vars override each connection; junk falls back to the default', () => {
    withEnv({ PRISM_DB_READONLY: undefined, SQLITE_CACHE_MB: '32', SQLITE_MMAP_MB: '0' }, () => assert.deepEqual(config.sqliteMemory, { cacheMb: 32, mmapMb: 0 }));
    withEnv({ PRISM_DB_READONLY: '1', SQLITE_WORKER_CACHE_MB: '8', SQLITE_WORKER_MMAP_MB: 'lots' }, () => assert.deepEqual(config.sqliteMemory, { cacheMb: 8, mmapMb: 0 }));
  });
  test('the open connection carries them', () => {
    const { db } = require('../src/db/repo');
    assert.equal(db.pragma('cache_size', { simple: true }), -64 * 1024);
    assert.equal(db.pragma('mmap_size', { simple: true }), 256 * 1024 * 1024);
  });
});

describe('2-3. picture model: one worker, released when idle, sweeps on a duty cycle', () => {
  const imagefilter = require('../src/lib/imagefilter');
  after(async () => { await imagefilter.shutdown(); });

  test('one worker by default; IMAGE_WORKERS still overrides', () => {
    const old = process.env.IMAGE_WORKERS;
    try {
      delete process.env.IMAGE_WORKERS; assert.equal(imagefilter._workerCount(), 1);
      process.env.IMAGE_WORKERS = '3'; assert.equal(imagefilter._workerCount(), 3);
      process.env.IMAGE_WORKERS = '0'; assert.equal(imagefilter._workerCount(), 0);
    } finally { if (old === undefined) delete process.env.IMAGE_WORKERS; else process.env.IMAGE_WORKERS = old; }
  });

  test('an idle pool is stopped, and the next request starts it again', { timeout: 120000 }, async (t) => {
    if (!(await imagefilter.available())) { t.skip('picture model not installed here'); return; }
    assert.equal(imagefilter.status().workers, 1);
    assert.equal(imagefilter._idleCheck(Date.now(), 60_000), false, 'just used: kept');
    const releases = imagefilter.status().idleReleases;
    assert.equal(imagefilter._idleCheck(Date.now() + 10 * 60_000, 60_000), true, 'quiet past the limit: released');
    assert.equal(imagefilter.status().ready, false);
    assert.equal(imagefilter.status().idleReleases, releases + 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(imagefilter.status().workers, 0, 'the worker thread is gone');
    assert.equal(await imagefilter.available(), true, 'and comes back on demand');
    assert.equal(imagefilter.status().workers, 1);
    assert.equal(imagefilter._idleCheck(Date.now() + 10 * 60_000, 0), false, '0 = never release');
  });

  test('the model sweeps run modelSweepOnMinutes, then rest modelSweepOffMinutes', () => {
    const { modelSweepOpen } = require('../src/lib/duty');
    const at = (min) => min * 60000;
    const s = { modelSweepOnMinutes: 10, modelSweepOffMinutes: 20 };
    assert.equal(modelSweepOpen(at(0), s), true);
    assert.equal(modelSweepOpen(at(9), s), true);
    assert.equal(modelSweepOpen(at(10), s), false);
    assert.equal(modelSweepOpen(at(29), s), false);
    assert.equal(modelSweepOpen(at(30), s), true);
    assert.equal(modelSweepOpen(at(15), { modelSweepOnMinutes: 10, modelSweepOffMinutes: 0 }), true, 'off = 0: always on');
    const defaults = require('../src/settings').SCHEMA;
    assert.equal(defaults.modelSweepOnMinutes.default, 10);
    assert.equal(defaults.modelSweepOffMinutes.default, 20);
  });
});

describe('4. headless browsers close sooner', () => {
  test('Chrome and Playwright close after 90 s idle by default', () => {
    assert.equal(config.chrome.idleMs, 90000);
    assert.equal(config.playwright.idleMs, 90000);
  });
  test('a Playwright render arms the idle close', async () => {
    const pw = require('../src/lib/playwright');
    const timers = []; const real = global.setTimeout;
    global.setTimeout = (fn, ms, ...a) => { timers.push(ms); return real(fn, 0, ...a); };
    try { await pw.renderPages('https://example.org/').catch(() => {}); } finally { global.setTimeout = real; }
    assert.ok(timers.includes(90000), `armed: ${timers.join(',')}`);
  });
});

describe('5. proxy egress counters', () => {
  let upstream; let server; let base; let repo;
  before(async () => {
    upstream = await start({
      '/m/a.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }),
      '/v/list.m3u8': () => ({ headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: '#EXTM3U\n#EXT-X-VERSION:3\nseg0.ts\n' }),
    });
    repo = require('../src/db/repo');
    repo.hosts.add(`${upstream.url}/`);
    require('../src/lib/egress')._reset();
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server.close(); await upstream.close(); });
  const get = (p, headers = {}) => new Promise((ok, fail) => http.get(`${base}${p}`, { headers: { cookie: 'prism_age=1', ...headers } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', fail));

  test('image MISS then HIT, and an HLS playlist, are counted by kind and cache; admin/engine shows them', async () => {
    const img = `/api/proxy?url=${encodeURIComponent(`${upstream.url}/m/a.jpg`)}`;
    const first = await get(img);
    assert.equal(first.status, 200); assert.equal(first.headers['x-cache'], 'MISS');
    await new Promise((r) => setTimeout(r, 50)); // the cache write lands after the response
    const second = await get(img);
    assert.equal(second.headers['x-cache'], 'HIT');
    const pl = await get(`/api/hls?url=${encodeURIComponent(`${upstream.url}/v/list.m3u8`)}`);
    assert.equal(pl.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    const today = require('../src/lib/egress').summary().today;
    assert.ok(today, 'today has a row');
    assert.ok(today.image.miss >= JPEG.length, `image miss bytes ${today.image.miss}`);
    assert.ok(today.image.hit >= JPEG.length, `image hit bytes ${today.image.hit}`);
    assert.equal(today.image.requests, 2);
    assert.ok(today.hls.miss > 0 && today.hls.requests === 1);
    assert.equal(today.total, today.hit + today.miss);
    const eng = await get('/api/admin/engine', { 'x-admin-key': 'test-key' });
    assert.equal(eng.status, 200);
    assert.equal(JSON.parse(eng.body).egress.today.image.requests, 2);
  });

  test('a refused request (unknown host) is not counted as media', async () => {
    const before = require('../src/lib/egress').summary().today;
    const r = await get(`/api/proxy?url=${encodeURIComponent('https://unknown.example.invalid/a.jpg')}`);
    assert.equal(r.status, 403);
    const after2 = require('../src/lib/egress').summary().today;
    assert.equal(after2.image.requests, before.image.requests);
  });

  test('counts survive a save and reload', () => {
    const eg = require('../src/lib/egress');
    eg.record('video', 'miss', 1000);
    eg.save();
    const saved = JSON.parse(repo.settings.get('proxy_egress'));
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(saved[day].video.miss.bytes >= 1000);
  });
});
