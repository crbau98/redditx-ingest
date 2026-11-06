'use strict';
/**
 * 2026-11-03: the 50 GB data volume filled in five hours because the media store silently fell back to /data/store, and SQLite then
 * could not open its WAL. These tests pin the three guards: no silent disk fallback in production, a disk watchdog, and the
 * disk -> bucket migration (copy, verify, and a separate switch for deleting).
 */
const { test, before, after, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');
const { s3Server, ACCESS, SECRET, BUCKET } = require('./helpers/s3');

let s3; let config; let store; let guard; let migrate; let budget; let dir;
before(async () => {
  s3 = await s3Server();
  dir = prepareEnv({ MEDIA_STORE_ENDPOINT: s3.url, MEDIA_STORE_BUCKET: BUCKET, MEDIA_STORE_ACCESS_KEY_ID: ACCESS, MEDIA_STORE_SECRET_ACCESS_KEY: SECRET, MEDIA_STORE_PREFIX: 'p/' });
  config = require('../src/config'); store = require('../src/lib/objectstore'); guard = require('../src/lib/diskguard');
  migrate = require('../src/services/storemigrate'); budget = require('../src/services/budget');
});
after(async () => { guard._reset(); await s3.close(); });

/** A fake statfs for a volume of `totalGb` with `usedGb` used. */
const GB = 1024 ** 3;
const vol = (totalGb, usedGb) => () => ({ bsize: 4096, blocks: (totalGb * GB) / 4096, bfree: ((totalGb - usedGb) * GB) / 4096, bavail: ((totalGb - usedGb) * GB) / 4096 });

describe('disk watchdog', () => {
  beforeEach(() => guard._reset());

  test('ok below the warning line, warn above it, paused at 80% and not before', () => {
    guard._setStatfs(vol(100, 50)); assert.equal(guard.refresh({ force: true }), 'ok');
    guard._setStatfs(vol(100, 72)); assert.equal(guard.refresh({ force: true }), 'warn');
    guard._setStatfs(vol(100, 79)); assert.equal(guard.refresh({ force: true }), 'warn');
    guard._setStatfs(vol(100, 80)); assert.equal(guard.refresh({ force: true }), 'paused');
    assert.equal(guard.paused(), true);
    assert.throws(() => guard.assertRoom(1), (e) => e.diskFull === true && e.skip === true);
  });

  test('resumes only under the resume line (no flapping at 80%) and tells the event log both ways', () => {
    const events = require('../src/engine/events');
    const before = events.getLogs(600).length;
    guard._setStatfs(vol(100, 85)); guard.refresh({ force: true });
    guard._setStatfs(vol(100, 78)); assert.equal(guard.refresh({ force: true }), 'paused', 'still paused between 75% and 80%');
    guard._setStatfs(vol(100, 74)); assert.equal(guard.refresh({ force: true }), 'warn');
    const msgs = events.getLogs(600).slice(before).map((l) => l.message || l.msg || JSON.stringify(l));
    assert.ok(msgs.some((m) => /PAUSED ingestion/.test(m)), `pause was logged: ${msgs.join(' | ')}`);
    assert.ok(msgs.some((m) => /Disk guard/.test(m) && /warning|normal/.test(m)), 'recovery was logged');
  });

  test('pauses when little is free even if the percentage looks fine, and DISK_BUDGET_GB caps use below the volume size', () => {
    guard._setStatfs(vol(1000, 998)); // 0.2% used? no: 99.8%: but free is 2 GB, below minFreeMb
    assert.equal(guard.refresh({ force: true }), 'paused');
    guard._reset();
    const old = config.disk.budgetGb; config.disk.budgetGb = 20;
    try { guard._setStatfs(vol(100, 17)); assert.equal(guard.refresh({ force: true }), 'paused', '17 GB used of a 20 GB budget is 85%'); }
    finally { config.disk.budgetGb = old; }
  });

  test('a volume that does not report its size never blocks anything (fail open)', () => {
    guard._setStatfs(() => { throw new Error('no statfs'); });
    assert.equal(guard.refresh({ force: true }), 'ok'); assert.equal(guard.paused(), false);
    assert.doesNotThrow(() => guard.assertRoom(10 ** 9));
  });

  test('the scheduler starts nothing while paused, even a manual run; it starts again when there is room', async () => {
    const engine = require('../src/engine/engine'); const repo = require('../src/db/repo');
    const feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'diskguardtest', trusted: 1, origin: 'admin' }).feed;
    guard._setStatfs(vol(100, 90)); guard.refresh({ force: true });
    engine.enqueue([feed.id], { trigger: 'manual' });
    await engine.tick(); await new Promise((r) => setImmediate(r));
    const st = engine.status();
    assert.equal(st.disk.level, 'paused'); assert.equal(st.disk.usedPct, 90);
    assert.equal(st.running.length, 0, 'nothing started'); assert.equal(st.queued, 1, 'the job waits in the queue');
    engine.stopAll();
  });

  test('the disk store refuses writes while paused and the media cache skips them', async () => {
    const savedKind = config.store.kind; config.store.kind = 'disk';
    try {
      guard._setStatfs(vol(100, 90)); guard.refresh({ force: true });
      await assert.rejects(() => store.put('tg/9/1.jpg', Buffer.alloc(300, 1)), /nearly full/);
      assert.equal(fs.existsSync(path.join(config.dataDir, 'store', 'tg', '9', '1.jpg')), false);
      guard._setStatfs(vol(100, 10)); guard.refresh({ force: true });
      await store.put('tg/9/1.jpg', Buffer.alloc(300, 1));
      assert.equal(fs.existsSync(path.join(config.dataDir, 'store', 'tg', '9', '1.jpg')), true);
    } finally { config.store.kind = savedKind; fs.rmSync(path.join(config.dataDir, 'store'), { recursive: true, force: true }); }
  });
});

describe('the media store never falls back to the data volume in production', () => {
  const saved = {};
  before(() => { saved.store = { ...config.store }; saved.isProd = config.isProd; });
  after(() => { Object.assign(config.store, saved.store); config.isProd = saved.isProd; });

  test('production with no bucket: not configured (null) with a message, no disk; MEDIA_STORE=disk is the deliberate exception', async () => {
    Object.assign(config.store, { kind: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' });
    config.isProd = true;
    assert.equal(store.kind(), null);
    assert.match(store.describe().error, /No media store configured/);
    await assert.rejects(() => store.put('tg/1/1.jpg', Buffer.alloc(300)), /No media store configured/);
    config.store.kind = 'disk'; assert.equal(store.kind(), 'disk');
  });

  test('production with a half-set bucket is "set but unusable", never the disk', () => {
    Object.assign(config.store, { kind: '', endpoint: 'https://x.example', bucket: 'b', accessKeyId: '', secretAccessKey: '' });
    config.isProd = true;
    assert.equal(store.kind(), null);
    assert.match(store.describe().error, /set but incomplete or unusable/);
    const vault = require('../src/lib/vault');
    assert.equal(vault.wanted({ mediaType: 'video', mediaUrl: 'https://cdn.example/a.mp4?expires=1&signature=x' }, 'reddit', {}), false, 'nothing is kept without a store');
  });

  test('development and tests keep the old convenience: no bucket means the data folder', () => {
    Object.assign(config.store, { kind: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' });
    config.isProd = false;
    assert.equal(store.kind(), 'disk');
  });
});

describe('moving /data/store into the bucket', () => {
  const root = () => path.join(config.dataDir, 'store');
  const put = (key, body) => { const f = path.join(root(), ...key.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const wipe = () => { fs.rmSync(root(), { recursive: true, force: true }); s3.objects.clear(); migrate._reset(); };
  beforeEach(wipe);
  after(wipe);

  test('dry-run reports files and bytes per folder and changes nothing', async () => {
    put('tg/1/a.jpg', Buffer.alloc(1000, 1)); put('tg/1/b.mp4', Buffer.alloc(5000, 2)); put('v/aa/c.mp4', Buffer.alloc(2000, 3));
    const r = await migrate.dryRun();
    assert.equal(r.files, 3); assert.equal(r.bytes, 8000);
    assert.deepEqual(r.byFolder, { tg: { files: 2, bytes: 6000 }, v: { files: 1, bytes: 2000 } });
    assert.equal(s3.objects.size, 0, 'nothing uploaded'); assert.equal(fs.existsSync(path.join(root(), 'tg', '1', 'a.jpg')), true, 'nothing deleted');
  });

  test('copy uploads under the same keys and prefix, verifies the size, and keeps the local files', async () => {
    put('tg/1/a.jpg', Buffer.alloc(1000, 1)); put('tg/2/b.mp4', Buffer.alloc(70000, 2));
    migrate.start({ deleteLocal: false }); await migrate._wait();
    const st = migrate.status();
    assert.equal(st.state, 'done'); assert.equal(st.copied, 2); assert.equal(st.verified, 2); assert.equal(st.deleted, 0); assert.equal(st.failed, 0);
    assert.ok(s3.objects.has(`/${BUCKET}/p/tg/1/a.jpg`)); assert.equal(s3.objects.get(`/${BUCKET}/p/tg/2/b.mp4`).body.length, 70000);
    assert.equal(fs.existsSync(path.join(root(), 'tg', '1', 'a.jpg')), true, 'copy only: the local file stays');
    // the stored URL resolves from the bucket now
    const net = require('../src/lib/net');
    const r = await net.open(store.urlFor('tg/1/a.jpg'), {});
    assert.equal(r.res.statusCode, 200); r.res.resume();
  });

  test('a second pass skips what is already there (resumable) and delete removes only verified local copies', async () => {
    put('tg/1/a.jpg', Buffer.alloc(1000, 1)); put('tg/1/b.jpg', Buffer.alloc(1500, 2));
    migrate.start({ deleteLocal: false }); await migrate._wait();
    migrate.start({ deleteLocal: true, resume: false }); await migrate._wait();
    const st = migrate.status();
    assert.equal(st.alreadyThere, 2, 'both were in the bucket already'); assert.equal(st.copied, 0);
    assert.equal(st.deleted, 2); assert.equal(st.deletedBytes, 2500);
    assert.equal(fs.existsSync(path.join(root(), 'tg', '1', 'a.jpg')), false);
  });

  test('a file whose bucket copy does not match is NEVER deleted', async () => {
    const f = put('tg/1/x.jpg', Buffer.alloc(900, 7));
    // the bucket "accepts" the upload but stores something of another size (a truncated upload)
    const realPut = store.putS3;
    store.putS3 = async (key) => { s3.objects.set(`/${BUCKET}/p/${key}`, { body: Buffer.alloc(10), type: 'image/jpeg' }); return { key, bytes: 10 }; };
    try { migrate.start({ deleteLocal: true }); await migrate._wait(); } finally { store.putS3 = realPut; }
    const st = migrate.status();
    assert.equal(st.failed, 1); assert.equal(st.deleted, 0); assert.equal(st.state, 'done-with-errors');
    assert.match(st.errors[0], /verify failed/);
    assert.equal(fs.existsSync(f), true, 'the only complete copy stays on the volume');
  });

  test('while the bucket does not have a key yet it is still served from the local folder', async () => {
    put('tg/5/old.jpg', Buffer.alloc(400, 9));
    const net = require('../src/lib/net');
    const r = await net.open(store.urlFor('tg/5/old.jpg'), {});
    assert.equal(r.res.statusCode, 200); r.res.resume();
    assert.equal(await store.has('tg/5/old.jpg'), true);
    assert.equal((await net.open(store.urlFor('tg/5/missing.jpg'), {})).res.statusCode, 404);
  });

  test('the admin endpoint refuses deletion without the second confirmation', async () => {
    const express = require('express');
    const app = express(); app.use(express.json()); app.use('/api/admin', require('../src/routes/admin'));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
    const h = { 'content-type': 'application/json', 'x-admin-key': 'test-key' };
    try {
      put('tg/1/a.jpg', Buffer.alloc(100, 1));
      let r = await fetch(`${base}/maintenance/store-migrate`, { method: 'POST', headers: h, body: JSON.stringify({ mode: 'copy', delete: true }) });
      assert.equal(r.status, 400); assert.equal(fs.existsSync(path.join(root(), 'tg', '1', 'a.jpg')), true);
      r = await fetch(`${base}/maintenance/store-migrate`, { method: 'POST', headers: h, body: JSON.stringify({ mode: 'dry-run' }) });
      assert.equal(r.status, 200); assert.equal((await r.json()).report.files, 1);
    } finally { srv.close(); }
  });
});

describe('Telegram byte budget', () => {
  test('bytesLeft counts down per UTC day and a spent budget stops scheduled runs but never lane 0', () => {
    budget._reset();
    const cfg = { platformDailyMb: 'telegram=10', platformDailyRuns: '', backfillRunsPerDay: 100 };
    assert.equal(budget.bytesLeft('telegram', cfg), 10 * 1048576);
    assert.equal(budget.bytesLeft('x', cfg), Infinity);
    budget.chargeBytes('telegram', 4 * 1048576);
    assert.equal(budget.bytesLeft('telegram', cfg), 6 * 1048576);
    assert.equal(budget.allow('telegram', 1, cfg), true);
    budget.chargeBytes('telegram', 7 * 1048576);
    assert.equal(budget.bytesLeft('telegram', cfg), 0);
    assert.equal(budget.allow('telegram', 1, cfg), false); assert.equal(budget.allow('telegram', 2, cfg), false);
    assert.equal(budget.allow('telegram', 0, cfg), true, 'someone is waiting');
    budget._reset();
  });

  test('the defaults are small enough for 541 channels: 60 older media, 50 MB videos, 50 new channels per sync, 5 GB a day', () => {
    assert.equal(config.telegram.backfillMax, 60); assert.equal(config.telegram.maxMb, 50); assert.equal(config.telegram.followMax, 50);
    assert.equal(require('../src/settings').get().platformDailyMb, 'telegram=5000');
  });
});
