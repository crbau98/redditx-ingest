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

describe('6. the challenge browser never runs as root, and keeps its sandbox where it can', () => {
  const { _launchPlan: plan } = require('../src/lib/chrome');
  const chrome = (o = {}) => ({ ...config.chrome, uid: 10001, gid: 10001, sandbox: 'auto', ...o });
  test('PRISM as root with a browser user: Chromium drops to it, sandbox on', () => {
    const p = plan({ uid: 0, chrome: chrome(), env: { PATH: '/usr/bin', ADMIN_KEY: 'secret', OXYLABS_PASSWORD: 'x' }, home: '/tmp/p' });
    assert.deepEqual(p.asUser, { uid: 10001, gid: 10001 });
    assert.equal(p.root, false);
    assert.equal(p.noSandbox, false);
    assert.equal(p.env.HOME, '/tmp/p', 'the browser user gets its profile dir as HOME');
    assert.ok(!('ADMIN_KEY' in p.env) && !('OXYLABS_PASSWORD' in p.env), 'the renderer inherits no secrets');
  });
  test('auto: after the sandbox failed once, it runs without it (still as the browser user)', () => {
    const p = plan({ uid: 0, chrome: chrome(), env: {}, home: '/tmp/p', sandboxFailed: true });
    assert.equal(p.noSandbox, true);
    assert.deepEqual(p.asUser, { uid: 10001, gid: 10001 });
  });
  test('CHROME_SANDBOX=on never falls back; =off always runs without it', () => {
    assert.equal(plan({ uid: 0, chrome: chrome({ sandbox: 'on' }), env: {}, sandboxFailed: true }).noSandbox, false);
    assert.equal(plan({ uid: 0, chrome: chrome({ sandbox: 'off' }), env: {} }).noSandbox, true);
  });
  test('root with no browser user configured: the old behaviour (root, --no-sandbox), so nothing breaks', () => {
    const p = plan({ uid: 0, chrome: chrome({ uid: -1 }), env: {} });
    assert.equal(p.asUser, null); assert.equal(p.root, true); assert.equal(p.noSandbox, true);
  });
  test('an unprivileged PRISM (a developer machine): no user switch, sandbox on', () => {
    const p = plan({ uid: 501, chrome: chrome(), env: {} });
    assert.equal(p.asUser, null); assert.equal(p.noSandbox, false);
    assert.equal(plan({ uid: 501, chrome: chrome(), env: { HOME: '/Users/me' }, home: '/tmp/p' }).env.HOME, '/Users/me', 'its own HOME is kept');
  });
  test('the Docker image creates the browser user and points CHROME_UID / CHROME_GID at it', () => {
    const df = require('fs').readFileSync(require('path').join(__dirname, '..', 'Dockerfile'), 'utf8');
    assert.match(df, /adduser -S -D -H -u 10001 -G chrome chrome/);
    assert.match(df, /ENV CHROME_UID=10001/);
    assert.match(df, /ENV CHROME_GID=10001/);
  });
});

describe('6b. auto drops the sandbox only for a sandbox failure', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const chrome = require('../src/lib/chrome');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-chrome-'));
  const log = path.join(dir, 'calls');
  // A stand-in browser that fails at start: it records its arguments and prints what it is told to.
  const fake = (stderr) => {
    const bin = path.join(dir, `chrome-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> ${log}\necho "${stderr}" >&2\nexit 1\n`, { mode: 0o755 });
    return bin;
  };
  const saved = { path: config.chrome.path, sandbox: config.chrome.sandbox };
  const run = async (stderr) => {
    fs.rmSync(log, { force: true }); chrome._resetSandbox();
    config.chrome.path = fake(stderr); config.chrome.sandbox = 'auto';
    await assert.rejects(chrome._launch());
    return { calls: fs.readFileSync(log, 'utf8').trim().split('\n'), status: await chrome.status() };
  };
  after(() => { Object.assign(config.chrome, saved); chrome._resetSandbox(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('the error text decides', () => {
    for (const t of ['[1:1:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel or see https://chromium.googlesource.com/...',
      'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
      '[FATAL:credentials.cc(127)] Check failed: . : Operation not permitted']) assert.equal(chrome._isSandboxFailure({ chromeStderr: t }), true, t);
    for (const t of ['', 'error while loading shared libraries: libnss3.so', 'Segmentation fault', 'Chrome did not open its DevTools port']) assert.equal(chrome._isSandboxFailure({ chromeStderr: t }), false, t);
    assert.equal(chrome._isSandboxFailure(new Error('timeout')), false);
  });

  test('a sandbox failure: retried at once without the sandbox, and later launches skip it', async (t) => {
    if (process.getuid && process.getuid() === 0) { t.skip('runs as root: the sandbox is off anyway'); return; }
    const r = await run('[1:1:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox!');
    assert.equal(r.calls.length, 2, 'two attempts');
    assert.ok(!/--no-sandbox/.test(r.calls[0]), 'first with the sandbox');
    assert.match(r.calls[1], /--no-sandbox/, 'then without');
    assert.equal(r.status.sandbox, false, 'remembered for the process');
  });

  test('any other failure (crash, missing library): no retry, the sandbox stays on for the next launch', async (t) => {
    if (process.getuid && process.getuid() === 0) { t.skip('runs as root: the sandbox is off anyway'); return; }
    const r = await run('error while loading shared libraries: libnss3.so: cannot open shared object file');
    assert.equal(r.calls.length, 1, 'one attempt');
    assert.ok(!/--no-sandbox/.test(r.calls[0]));
    assert.equal(r.status.sandbox, null, 'nothing remembered');
  });
});

describe('7. memory watchdog thresholds', () => {
  const memwatch = require('../src/engine/memwatch');
  test('the soft limit is capped at 3 GB on a big container; the hard one stays proportional; env still wins', () => {
    const old = { s: process.env.MEM_SOFT_MB, h: process.env.MEM_HARD_MB };
    try {
      delete process.env.MEM_SOFT_MB; delete process.env.MEM_HARD_MB;
      const l = memwatch.limits();
      assert.equal(l.soft, Math.min(Math.round(l.total * 0.5), 3072 * 1048576));
      assert.equal(l.hard, Math.round(l.total * 0.68));
      process.env.MEM_SOFT_MB = '5000';
      assert.equal(memwatch.limits().soft, 5000 * 1048576);
    } finally { for (const [k, v] of [['MEM_SOFT_MB', old.s], ['MEM_HARD_MB', old.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
});
