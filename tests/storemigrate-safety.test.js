'use strict';
/**
 * Crucible's findings on fix/disk-guard 0fe92d1, one test per defect:
 *   1  DATA LOSS: size equality authorised a delete (a same-size, different-bytes bucket object; a rewrite that restores the mtime)
 *   2  a resume skipped everything and said "done" (the cursor file was unlinked in delete mode)
 *   3  kind() null in production made files already on the volume return 502
 *   4  RAILWAY_ENVIRONMENT counts as production      5  unknown disk size is "degraded", not "ok"
 *   6  a file unlinked between stat and open is read from the bucket instead      7  Telegram bytes are charged when downloaded
 */
const { test, before, after, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');
const { s3Server, ACCESS, SECRET, BUCKET } = require('./helpers/s3');

let s3; let config; let store; let guard; let mig; let net;
before(async () => {
  s3 = await s3Server();
  prepareEnv({ MEDIA_STORE_ENDPOINT: s3.url, MEDIA_STORE_BUCKET: BUCKET, MEDIA_STORE_ACCESS_KEY_ID: ACCESS, MEDIA_STORE_SECRET_ACCESS_KEY: SECRET, MEDIA_STORE_PREFIX: 'p/' });
  config = require('../src/config'); store = require('../src/lib/objectstore'); guard = require('../src/lib/diskguard');
  mig = require('../src/services/storemigrate'); net = require('../src/lib/net');
});
after(async () => { guard._reset(); await s3.close(); });

const root = () => path.join(config.dataDir, 'store');
const put = (key, body) => { const f = path.join(root(), ...key.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const present = (key) => fs.existsSync(path.join(root(), ...key.split('/')));
const bucket = (key) => s3.objects.get(`/${BUCKET}/p/${key}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const reset = () => { fs.rmSync(root(), { recursive: true, force: true }); s3.objects.clear(); s3.ctl.proof = 'full'; mig._reset(); };
beforeEach(reset);
after(reset);
const run = async (opts) => { mig.start(opts); await mig._wait(); return mig.status(); };

describe('1. size is never proof (data loss)', () => {
  for (const proof of ['full', 'etag', 'none']) {
    test(`M2: a bucket object with the same size and different bytes is a conflict: local kept, bucket untouched, nothing deleted (bucket reveals: ${proof})`, async () => {
      s3.ctl.proof = proof;
      const local = Buffer.alloc(64, 0x41); const wrong = Buffer.alloc(64, 0x5a);
      put('tg/9/9.jpg', local); s3.objects.set(`/${BUCKET}/p/tg/9/9.jpg`, { body: wrong, type: 'image/jpeg', sha256: null });
      const st = await run({ deleteLocal: true });
      assert.equal(st.deleted, 0); assert.equal(st.conflicts, 1); assert.equal(st.failed, 1); assert.equal(st.state, 'done-with-errors');
      assert.equal(present('tg/9/9.jpg'), true, 'the local file is the only correct copy');
      assert.deepEqual(bucket('tg/9/9.jpg').body, wrong, 'a bucket object we did not write is never overwritten');
      assert.match(st.errors[0], /conflict/);
    });
  }

  for (const proof of ['full', 'etag', 'none']) {
    test(`an identical object already in the bucket is proven by ${proof === 'full' ? 'its metadata or ETag' : proof === 'etag' ? 'its MD5 ETag' : 'reading it back'} and only then is the local copy deleted`, async () => {
      s3.ctl.proof = proof;
      const body = Buffer.alloc(300, 0x33);
      put('tg/1/same.jpg', body); s3.objects.set(`/${BUCKET}/p/tg/1/same.jpg`, { body, type: 'image/jpeg', sha256: null }); // written by someone else, no metadata of ours
      const st = await run({ deleteLocal: true });
      assert.equal(st.alreadyThere, 1); assert.equal(st.copied, 0); assert.equal(st.deleted, 1); assert.equal(st.state, 'done');
      if (proof === 'none') assert.equal(st.readBack, 1, 'neither metadata nor ETag: the object was read back and hashed');
      assert.equal(present('tg/1/same.jpg'), false);
    });
  }

  test('the upload carries the SHA-256 as object metadata', async () => {
    const body = Buffer.alloc(500, 0x44); put('tg/2/a.jpg', body);
    await run({ deleteLocal: false });
    assert.equal(bucket('tg/2/a.jpg').sha256, sha(body));
  });

  test('our own stale copy (metadata of ours that no longer matches) is replaced, not treated as a conflict', async () => {
    const body = Buffer.alloc(100, 0x55); put('tg/3/a.jpg', body);
    s3.objects.set(`/${BUCKET}/p/tg/3/a.jpg`, { body: Buffer.alloc(100, 0x11), type: 'image/jpeg', sha256: sha(Buffer.alloc(100, 0x11)) });
    const st = await run({ deleteLocal: true });
    assert.equal(st.copied, 1); assert.equal(st.deleted, 1); assert.equal(st.conflicts, 0);
    assert.deepEqual(bucket('tg/3/a.jpg').body, body);
  });

  test('M6: a same-size rewrite DURING the upload that restores the mtime is caught by the hash taken before and after: not deleted', async () => {
    const f = put('tg/6/7.jpg', Buffer.alloc(4096, 1)); const old = fs.statSync(f);
    const real = store.putS3;
    store.putS3 = async (...a) => { const r = await real(...a); fs.writeFileSync(f, Buffer.alloc(4096, 2)); fs.utimesSync(f, old.atime, old.mtime); return r; };
    let st;
    try { st = await run({ deleteLocal: true }); } finally { store.putS3 = real; }
    assert.equal(st.deleted, 0); assert.equal(st.changed, 1); assert.equal(fs.readFileSync(f)[0], 2, 'the new local content is still on the volume');
    assert.equal(bucket('tg/6/7.jpg').body[0], 1, 'the bucket holds the old content: the next pass replaces it');
    const again = await run({ deleteLocal: true, resume: false }); // the next pass: our metadata no longer matches, so the copy is replaced and verified
    assert.equal(again.deleted, 1); assert.equal(bucket('tg/6/7.jpg').body[0], 2);
  });

  test('a truncated upload (the bucket keeps one byte less) is never trusted, whatever the proof', async () => {
    s3.ctl.proof = 'none';
    put('tg/3/4.jpg', Buffer.alloc(500, 8));
    const real = store.putS3;
    store.putS3 = async (key, ...rest) => { const r = await real(key, ...rest); const o = bucket(key); o.body = o.body.subarray(0, o.body.length - 1); return r; };
    let st;
    try { st = await run({ deleteLocal: true }); } finally { store.putS3 = real; }
    assert.equal(st.deleted, 0); assert.equal(present('tg/3/4.jpg'), true); assert.equal(st.failed, 1);
  });
});

describe('2. resume and "done"', () => {
  test('files are walked in plain key order (a directory sorts as "name/")', () => {
    for (const k of ['a/b', 'a.b', 'a-b/c', 'a0', 'a/a/z', 'b']) put(k, Buffer.from('x'));
    const keys = [...store.localObjects()].map((o) => o.key);
    assert.deepEqual(keys, [...keys].sort());
    assert.deepEqual([...store.localObjects({ after: 'a.b' })].map((o) => o.key), keys.filter((k) => k > 'a.b'));
  });

  test('M10: stop in delete mode and resume: the unlinked cursor file does not matter, the rest is processed, the pass ends "done" with 0 local files', async () => {
    for (let i = 0; i < 20; i++) put(`tg/5/${String(i).padStart(2, '0')}.jpg`, Buffer.alloc(100, i + 1));
    const real = store.putS3;
    store.putS3 = async (...a) => { await new Promise((r) => setTimeout(r, 60)); return real(...a); };
    let st;
    try {
      mig.start({ deleteLocal: true }); await new Promise((r) => setTimeout(r, 300)); mig.stop(); await mig._wait(); st = mig.status();
    } finally { store.putS3 = real; }
    assert.equal(st.state, 'stopped'); assert.ok(st.deleted > 0 && st.deleted < 20, `stopped part-way: ${st.deleted} deleted`);
    assert.ok(st.cursor, 'a cursor was kept'); assert.equal(present(st.cursor), false, 'and its file is already deleted (the old resume looked for exactly this)');
    const left = [...store.localObjects()].length;
    mig._reset();
    const done = await run({ deleteLocal: true, resume: true });
    assert.equal(done.state, 'done'); assert.equal(done.remaining, 0); assert.equal([...store.localObjects()].length, 0);
    assert.ok(done.files >= left, `the resumed pass saw the ${left} files that were left (${done.files})`);
    assert.equal(s3.objects.size, 20, 'every file is in the bucket');
  });

  test('a pass is "incomplete", not "done", when the final check still finds local files (a file that appeared behind the cursor)', async () => {
    put('tg/z/last.jpg', Buffer.alloc(50, 1));
    const real = store.putS3; let planted = false;
    store.putS3 = async (...a) => { if (!planted) { planted = true; put('tg/a/early.jpg', Buffer.alloc(50, 2)); } return real(...a); }; // sorts before the cursor
    let st;
    try { st = await run({ deleteLocal: true }); } finally { store.putS3 = real; }
    assert.equal(st.state, 'incomplete'); assert.equal(st.remaining, 1); assert.equal(present('tg/a/early.jpg'), true);
    const next = await run({ deleteLocal: true, resume: false });
    assert.equal(next.state, 'done'); assert.equal(next.remaining, 0);
  });

  test('copy mode ends "done" only when no local file is missing from the bucket', async () => {
    put('tg/1/a.jpg', Buffer.alloc(80, 1));
    const real = store.putS3;
    store.putS3 = async (key, ...rest) => { const r = await real(key, ...rest); s3.objects.delete(`/${BUCKET}/p/${key}`); return r; }; // the bucket loses it right after
    let st;
    try { st = await run({ deleteLocal: false }); } finally { store.putS3 = real; }
    assert.notEqual(st.state, 'done'); assert.equal(st.failed, 1);
  });
});

describe('3. a wrong bucket configuration does not take stored media down', () => {
  const saved = {};
  before(() => { saved.store = { ...config.store }; saved.isProd = config.isProd; saved.isHosted = config.isHosted; });
  after(() => { Object.assign(config.store, saved.store); config.isProd = saved.isProd; config.isHosted = saved.isHosted; });

  test('kind() null in production: files already on the volume are still served (read-only, Range too); anything else reports the misconfiguration', async () => {
    put('tg/5/old.mp4', Buffer.from('0123456789abcdef'));
    Object.assign(config.store, { kind: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' }); config.isProd = true;
    assert.equal(store.kind(), null);
    assert.equal(await store.has('tg/5/old.mp4'), true); assert.equal(await store.has('tg/5/none.mp4'), false);
    const r = await net.open(store.urlFor('tg/5/old.mp4'), {});
    assert.equal(r.res.statusCode, 200);
    const chunks = []; for await (const c of r.res) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), '0123456789abcdef');
    const ranged = await net.open(store.urlFor('tg/5/old.mp4'), { headers: { range: 'bytes=4-7' } });
    assert.equal(ranged.res.statusCode, 206); const c2 = []; for await (const c of ranged.res) c2.push(c); assert.equal(Buffer.concat(c2).toString(), '4567');
    await assert.rejects(() => net.open(store.urlFor('tg/5/none.mp4'), {}), /No media store configured/);
    await assert.rejects(() => store.put('tg/5/new.mp4', Buffer.alloc(300)), /No media store configured/, 'but nothing new is ever written');
  });

  test('4. RAILWAY_ENVIRONMENT (config.isHosted) counts as production even when NODE_ENV was forgotten', () => {
    Object.assign(config.store, { kind: '', endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' });
    config.isProd = false; config.isHosted = false; assert.equal(store.kind(), 'disk');
    config.isHosted = true; assert.equal(store.kind(), null);
    const { spawnSync } = require('child_process');
    for (const [env, want] of [[{ RAILWAY_ENVIRONMENT: 'production' }, null], [{ RAILWAY_PROJECT_ID: 'x' }, null], [{}, 'disk']]) {
      const r = spawnSync(process.execPath, ['-e', "const s=require('./src/lib/objectstore'); console.log(JSON.stringify(s.kind()))"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, DB_PATH: path.join(config.dataDir, 'k.db'), ...env }, encoding: 'utf8' });
      assert.equal(JSON.parse(r.stdout.trim()), want, JSON.stringify(env) + ' ' + r.stderr);
    }
  });
});

describe('5. an unknown disk size is "degraded", not a silent ok', () => {
  test('/api/health and the admin overview say so; a known volume stays "ok"', async () => {
    const express = require('express');
    const app = express(); app.use(express.json()); app.use('/api', require('../src/routes/public'));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const get = async () => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/health`); return { code: r.status, body: await r.json() }; };
    try {
      guard._reset(); guard._setStatfs(() => { throw new Error('no statfs on this platform'); }); guard.refresh({ force: true });
      let h = await get();
      assert.equal(h.code, 200, 'the platform health check must not restart a working site over this');
      assert.equal(h.body.status, 'degraded'); assert.equal(h.body.disk.known, false); assert.match(h.body.warnings[0], /disk size unknown/);
      guard._reset(); guard._setStatfs(() => ({ bsize: 4096, blocks: 1e6, bfree: 8e5, bavail: 8e5 })); guard.refresh({ force: true });
      h = await get(); assert.equal(h.body.status, 'ok'); assert.equal(h.body.disk.known, true); assert.deepEqual(h.body.warnings, []);
      guard._setStatfs(() => ({ bsize: 4096, blocks: 1e6, bfree: 1e5, bavail: 1e5 })); guard.refresh({ force: true });
      h = await get(); assert.equal(h.body.disk.level, 'paused'); assert.match(h.body.warnings[0], /ingestion is paused/);
    } finally { srv.close(); guard._reset(); }
  });

  test('the admin console shows a banner for it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'admin', 'index.js'), 'utf8');
    assert.match(src, /Disk size unknown/); assert.match(src, /overview\.disk/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8'), /disk: require\('\.\.\/lib\/diskguard'\)\.status\(\)/);
  });
});

describe('6. a file migrated away while it is being opened is read from the bucket', () => {
  test('stat says the local file exists, it is unlinked before open: the read falls back to the bucket (no 404/502)', async () => {
    const body = Buffer.alloc(1000, 0x61);
    const f = put('tg/8/race.jpg', body);
    const realOpen = fs.openSync; let fired = false;
    fs.openSync = function (file, ...rest) {
      if (!fired && String(file) === f) { fired = true; fs.unlinkSync(f); s3.objects.set(`/${BUCKET}/p/tg/8/race.jpg`, { body, type: 'image/jpeg', sha256: sha(body) }); } // the migration finishes right here
      return realOpen.call(fs, file, ...rest);
    };
    try {
      const r = await net.open(store.urlFor('tg/8/race.jpg'), {});
      assert.equal(r.res.statusCode, 200); const chunks = []; for await (const c of r.res) chunks.push(c);
      assert.equal(Buffer.concat(chunks).length, 1000); assert.equal(fired, true);
    } finally { fs.openSync = realOpen; }
  });

  test('a file unlinked while it is being streamed finishes streaming (the descriptor stays valid)', async () => {
    const body = Buffer.alloc(3 * 1024 * 1024, 0x62); const f = put('tg/8/big.mp4', body);
    const r = await net.open(store.urlFor('tg/8/big.mp4'), {});
    fs.unlinkSync(f);
    let n = 0; for await (const c of r.res) n += c.length;
    assert.equal(n, body.length);
  });
});
