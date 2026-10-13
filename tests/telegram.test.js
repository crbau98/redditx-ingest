'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

let sharp; try { sharp = require('sharp'); } catch { /* optional */ }

/* ---- an S3 look-alike that VERIFIES the SigV4 signature of every request (path-style, in memory) ---- */
const ACCESS = 'AKIATESTTESTTEST'; const SECRET = 'secret/for+tests'; const BUCKET = 'prism-test';
function s3Server() {
  const sigv4 = require('../src/lib/sigv4');
  const objects = new Map(); const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const auth = String(req.headers.authorization || '');
      const signedHeaders = (/SignedHeaders=([^,]+)/.exec(auth) || [])[1] || '';
      const extra = {};
      for (const n of signedHeaders.split(';')) if (n !== 'host' && !n.startsWith('x-amz-')) extra[n] = req.headers[n];
      const check = sigv4.sign({ method: req.method, host: req.headers.host, path: u.pathname, headers: { ...extra, 'x-amz-date': req.headers['x-amz-date'] }, payloadHash: req.headers['x-amz-content-sha256'],
        region: 'auto', accessKeyId: ACCESS, secretAccessKey: SECRET, date: new Date(req.headers['x-amz-date'].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) });
      log.push(`${req.method} ${u.pathname}`);
      if (check.headers.authorization !== auth) { res.writeHead(403, { 'content-type': 'application/xml' }); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
      const key = decodeURIComponent(u.pathname);
      if (!key.startsWith(`/${BUCKET}/`)) { res.writeHead(404); return res.end(); }
      if (req.method === 'PUT') { objects.set(key, { body, type: req.headers['content-type'] }); res.writeHead(200); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      const o = objects.get(key);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range && req.method === 'GET') {
        const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), o.body.length - 1) : o.body.length - 1;
        res.writeHead(206, { 'content-type': o.type, 'content-range': `bytes ${start}-${end}/${o.body.length}`, 'content-length': end - start + 1 });
        return res.end(o.body.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length });
      res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, log, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

let s3; let config; let store; let net; let mt; let tg; let sync; let repo; let pipeline; let imagefilter;
before(async () => {
  s3 = await s3Server();
  prepareEnv({ MEDIA_STORE_ENDPOINT: s3.url, MEDIA_STORE_BUCKET: BUCKET, MEDIA_STORE_ACCESS_KEY_ID: ACCESS, MEDIA_STORE_SECRET_ACCESS_KEY: SECRET, MEDIA_STORE_PREFIX: 'p/', TELEGRAM_MAX_MB: '1' });
  config = require('../src/config'); store = require('../src/lib/objectstore'); net = require('../src/lib/net');
  mt = require('../src/lib/telegram-mtproto'); tg = require('../src/sources/telegram'); sync = require('../src/services/telegram-sync');
  repo = require('../src/db/repo'); pipeline = require('../src/engine/pipeline'); imagefilter = require('../src/lib/imagefilter');
});
after(async () => { mt._setFactory(null); imagefilter._reset(); await imagefilter.shutdown(); await s3.close(); });

describe('SigV4', () => {
  test('matches the AWS documentation vector (GET Object with Range)', () => {
    const r = require('../src/lib/sigv4').sign({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') });
    assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

describe('object store (S3 driver)', () => {
  test('put / has / ranged read through net.open / remove, with every request signed', async () => {
    assert.equal(store.kind(), 's3');
    const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const { url } = await store.put('tg/1/9.mp4', body, 'video/mp4');
    assert.equal(url, 'https://media.prism.invalid/tg/1/9.mp4');
    assert.ok(s3.objects.has(`/${BUCKET}/p/tg/1/9.mp4`), 'stored under the configured prefix');
    assert.equal(await store.has('tg/1/9.mp4'), true);
    assert.equal(await store.has('tg/1/nope.mp4'), false);
    const full = await net.fetchBuffer(url);
    assert.equal(full.status, 200); assert.equal(full.contentType, 'video/mp4'); assert.ok(full.buffer.equals(body));
    const { res } = await net.open(url, { headers: { range: 'bytes=10-19' } });
    assert.equal(res.statusCode, 206); assert.equal(res.headers['content-range'], 'bytes 10-19/5000');
    const part = await new Promise((r) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => r(Buffer.concat(c))); });
    assert.ok(part.equals(body.subarray(10, 20)));
    assert.equal(await store.remove('tg/1/9.mp4'), true);
    assert.equal(await store.has('tg/1/9.mp4'), false);
  });
  test('a file is streamed to the bucket; a wrong secret is reported, not swallowed', async () => {
    const f = path.join(os.tmpdir(), `prism-up-${process.pid}.bin`);
    fs.writeFileSync(f, Buffer.alloc(300000, 5));
    await store.put('tg/2/big.mp4', f, 'video/mp4');
    assert.equal(s3.objects.get(`/${BUCKET}/p/tg/2/big.mp4`).body.length, 300000);
    fs.unlinkSync(f);
    const good = config.store.secretAccessKey; config.store.secretAccessKey = 'wrong';
    await assert.rejects(() => store.put('tg/2/x.jpg', Buffer.from('abc'), 'image/jpeg'), /http 403/);
    config.store.secretAccessKey = good;
  });
  test('keys are validated (no traversal), foreign hosts are not store URLs', async () => {
    await assert.rejects(() => store.put('../etc/passwd', Buffer.from('x')), /invalid object key/);
    assert.equal(store.keyOf('https://media.prism.invalid/tg/1/2.jpg'), 'tg/1/2.jpg');
    assert.equal(store.keyOf('https://media.prism.invalid/tg/..%2Fx'), null);
    assert.equal(store.keyOf('https://example.com/tg/1/2.jpg'), null);
  });
  test('the media proxy serves store URLs', async () => {
    await store.put('tg/3/p.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 3)]), 'image/jpeg');
    const express = require('express');
    const app = express(); app.use('/api', require('../src/routes/proxy'));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/proxy?url=${encodeURIComponent(store.urlFor('tg/3/p.jpg'))}`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal((await r.arrayBuffer()).byteLength, 604);
    srv.closeAllConnections?.(); srv.close();
  });
});

describe('object store (disk driver)', () => {
  test('same contract, Range included', async () => {
    const saved = { ...config.store }; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-disk-')); const savedDir = config.dataDir;
    config.store.kind = 'disk'; config.dataDir = dir;
    try {
      assert.equal(store.kind(), 'disk');
      const body = Buffer.from('0123456789abcdef');
      await store.put('tg/9/1.mp4', body);
      assert.equal(await store.has('tg/9/1.mp4'), true);
      const { res } = await net.open(store.urlFor('tg/9/1.mp4'), { headers: { range: 'bytes=4-7' } });
      assert.equal(res.statusCode, 206); assert.equal(res.headers['content-range'], 'bytes 4-7/16');
      assert.equal((await new Promise((r) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => r(Buffer.concat(c).toString())); })), '4567');
      assert.equal((await net.open(store.urlFor('tg/9/none.mp4'))).res.statusCode, 404);
      assert.equal(await store.remove('tg/9/1.mp4'), true);
    } finally { Object.assign(config.store, saved); config.dataDir = savedDir; }
  });
});

/* ---- GramJS look-alike ---- */
const photoMsg = (id, text, extra = {}) => ({ id, message: text, date: 1700000000 + id, views: 400, forwards: 2, media: { className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: [{ className: 'PhotoSize', w: 320, h: 240 }, { className: 'PhotoSize', w: 1280, h: 960 }] } }, ...extra });
const videoMsg = (id, text, size = 5000) => ({ id, message: text, date: 1700000000 + id, views: 100, media: { className: 'MessageMediaDocument', document: { className: 'Document', mimeType: 'video/mp4', size, thumbs: [{ className: 'PhotoStrippedSize' }, { className: 'PhotoSize', w: 320, h: 180 }], attributes: [{ className: 'DocumentAttributeVideo', w: 1280, h: 720, duration: 12.4 }] } } });
const stickerMsg = (id) => ({ id, message: '', date: 1, media: { className: 'MessageMediaDocument', document: { className: 'Document', mimeType: 'image/webp', size: 100, attributes: [{ className: 'DocumentAttributeSticker' }] } } });

function fakeClient({ channels, messages }) {
  const downloads = []; const calls = { messages: [] };
  const c = {
    async connect() {}, async checkAuthorization() { return true; }, async disconnect() {},
    async getDialogs() { return channels.map((e) => ({ entity: e, title: e.title })); },
    async getEntity(ref) { const e = channels.find((x) => x.username === ref || String(x.id) === String(ref)); if (!e) throw Object.assign(new Error('x'), { errorMessage: 'USERNAME_NOT_OCCUPIED' }); return e; },
    async getMessages(entity, o = {}) {
      calls.messages.push(o);
      let list = (messages[String(entity.id)] || []).slice();
      if (o.minId) list = list.filter((m) => m.id > o.minId);
      if (o.offsetId) list = list.filter((m) => m.id < o.offsetId);
      list.sort((a, b) => (o.reverse ? a.id - b.id : b.id - a.id));
      return list.slice(0, o.limit || 100);
    },
    async downloadMedia(msg, o = {}) {
      downloads.push({ id: msg.id, thumb: !!o.thumb });
      const data = o.thumb ? Buffer.alloc(900, 9) : Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, msg.id % 200)]);
      if (o.outputFile) { fs.writeFileSync(o.outputFile, data); return o.outputFile; }
      return data;
    },
    async downloadProfilePhoto() { return Buffer.alloc(500, 4); },
    async invoke() { return { fullChat: { about: 'gym and bears. links: https://example.com/hub', participantsCount: 1234 } }; },
  };
  c.downloads = downloads; c.calls = calls;
  return c;
}
const chan = (id, username, title, extra = {}) => ({ className: 'Channel', id, username, title, broadcast: true, megagroup: false, participantsCount: 500, ...extra });

describe('describeMedia', () => {
  test('photos, videos, size cap, stickers, self-destructing media', () => {
    assert.deepEqual(mt.describeMedia(photoMsg(1, 'x')), { type: 'image', ext: 'jpg', mime: 'image/jpeg', size: 0, width: 1280, height: 960, duration: null, thumb: false });
    const v = mt.describeMedia(videoMsg(2, 'x'));
    assert.equal(v.type, 'video'); assert.equal(v.ext, 'mp4'); assert.equal(v.duration, 12); assert.equal(v.width, 1280); assert.equal(v.thumb, true);
    assert.match(mt.describeMedia(videoMsg(3, 'x', 5 * 1024 * 1024)).skip, /larger than 1 MB/);
    assert.equal(mt.describeMedia(stickerMsg(4)), null);
    assert.equal(mt.describeMedia({ id: 5, media: { className: 'MessageMediaPhoto', ttlSeconds: 10, photo: {} } }).skip, 'self-destructing');
    assert.equal(mt.describeMedia({ id: 6, message: 'text only' }), null);
  });
});

describe('joined channels: sync + ingestion', () => {
  const settings = { probeUnknownHosts: false, scopeMode: 'open', imageFilter: true, imageFilterThreshold: 50, dedupe: false };
  const MSGS = {
    '100': [photoMsg(1, 'leg day gains'), photoMsg(2, 'beach bros'), videoMsg(3, 'training clip'), stickerMsg(4), photoMsg(5, 'she is lovely')],
    '200': [photoMsg(10, 'private one')],
  };
  let client;
  before(() => {
    client = fakeClient({
      channels: [chan(100, 'gymbros', 'Gym Bros'), chan(200, null, 'Secret Club'), chan(300, 'sexygirls', 'Sexy Girls'), { className: 'User', id: 7 }],
      messages: MSGS,
    });
    mt._setFactory(async () => client);
  });

  test('sync follows joined channels (private ones by id), skips female-named ones, switches off channels you left', async () => {
    const r = await sync.sync();
    assert.equal(r.channels, 3); assert.equal(r.created, 2); assert.deepEqual(r.skippedFemale, ['Sexy Girls']);
    const feeds = repo.db.prepare("SELECT target, trusted, label FROM feeds WHERE platform = 'telegram' AND kind = 'channel' ORDER BY target").all();
    assert.deepEqual(feeds.map((f) => f.target), ['gymbros', 'id:200']);
    assert.equal(feeds[0].trusted, 1);
    assert.equal((await sync.sync()).created, 0, 'idempotent');
    client = fakeClient({ channels: [chan(100, 'gymbros', 'Gym Bros')], messages: MSGS }); mt._setFactory(async () => client);
    const left = await sync.sync();
    assert.equal(left.switchedOff, 1);
    assert.equal(repo.db.prepare("SELECT enabled FROM feeds WHERE target = 'id:200'").get().enabled, 0);
    client = fakeClient({ channels: [chan(100, 'gymbros', 'Gym Bros'), chan(200, null, 'Secret Club')], messages: MSGS }); mt._setFactory(async () => client);
  });

  test('first run reads the newest, later runs read only newer messages in order and back-fill history', async () => {
    const feed = repo.feeds.get(repo.db.prepare("SELECT id FROM feeds WHERE target = 'gymbros'").get().id);
    const ctx = (cursor) => ({ limit: 40, cursor, force: false, needProfile: true, aborted: () => false });
    const first = await tg.fetch(feed, ctx({}));
    assert.equal(first.via, 'mtproto');
    assert.deepEqual(first.items.map((i) => i.sourceId).sort(), ['gymbros/1', 'gymbros/2', 'gymbros/3', 'gymbros/5'], 'the sticker is not an item');
    assert.equal(first.cursor.newestId, 5); assert.equal(first.cursor.oldestId, 1); assert.equal(first.cursor.done, true);
    assert.equal(first.profile.displayName, 'Gym Bros'); assert.ok(first.profile.avatarUrl.startsWith('https://media.prism.invalid/tg/100/avatar'));
    assert.ok(first.profile.links.length, 'links from the description');
    // nothing is downloaded until the pipeline asks
    assert.equal(client.downloads.length, 0);

    MSGS['100'].push(photoMsg(6, 'new post one'), photoMsg(7, 'new post two'));
    const second = await tg.fetch(feed, ctx(first.cursor));
    assert.deepEqual(second.items.map((i) => i.sourceId), ['gymbros/6', 'gymbros/7']);
    assert.equal(second.cursor.newestId, 7);
    assert.equal(client.calls.messages.at(-1).reverse, true); assert.equal(client.calls.messages.at(-1).minId, 5);
  });

  test('a post is downloaded into the bucket only after the text gates accepted it, and removed again when rejected later', async () => {
    const feed = repo.feeds.get(repo.db.prepare("SELECT id FROM feeds WHERE target = 'gymbros'").get().id);
    const got = await tg.fetch(feed, { limit: 40, cursor: {}, force: true, aborted: () => false });
    const by = Object.fromEntries(got.items.map((i) => [i.sourceId, i]));
    client.downloads.length = 0;

    // female wording: excluded by the text gate => never downloaded
    const she = await pipeline.processItem(by['gymbros/5'], feed, tg, settings);
    assert.equal(she.outcome, 'excluded'); assert.equal(client.downloads.length, 0); assert.equal(await store.has('tg/100/5.jpg'), false);

    // accepted photo: stored (original + 'p/' prefix in the bucket), published, served from the store URL
    imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [{ gender: 'male', score: 0.9, confidence: 0.9 }] }));
    const ok = await pipeline.processItem(by['gymbros/1'], feed, tg, settings);
    assert.equal(ok.outcome, 'added', JSON.stringify(ok));
    assert.equal(await store.has('tg/100/1.jpg'), true);
    const row = repo.db.prepare("SELECT media_url, media_type, source_url, width, height, author FROM media WHERE source_id = 'gymbros/1'").get();
    assert.equal(row.media_url, 'https://media.prism.invalid/tg/100/1.jpg'); assert.equal(row.source_url, 'https://t.me/gymbros/1'); assert.equal(row.width, 1280);

    // video: file + poster stored
    const vid = await pipeline.processItem(by['gymbros/3'], feed, tg, settings);
    assert.equal(vid.outcome, 'added');
    assert.equal(await store.has('tg/100/3.mp4'), true); assert.equal(await store.has('tg/100/3-t.jpg'), true);
    const vrow = repo.db.prepare("SELECT media_type, preview_url, duration FROM media WHERE source_id = 'gymbros/3'").get();
    assert.equal(vrow.media_type, 'video'); assert.equal(vrow.preview_url, 'https://media.prism.invalid/tg/100/3-t.jpg'); assert.equal(vrow.duration, 12);

    // the picture filter finds a woman: excluded AND the stored copy is deleted again
    imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [{ gender: 'female', score: 0.95, confidence: 0.9 }] }));
    const w = await pipeline.processItem(by['gymbros/2'], feed, tg, settings);
    assert.equal(w.outcome, 'excluded'); assert.equal(w.reason, 'image:female-face');
    assert.equal(await store.has('tg/100/2.jpg'), false, 'rejected media does not stay in the bucket');

    // a video the picture filter rejects is judged on its thumbnail alone: the video itself is never downloaded or uploaded
    client.downloads.length = 0;
    const ch = { id: '100', username: 'gymbros', title: 'Gym Bros', target: 'gymbros', trusted: true };
    const v8 = tg.messageToItem(videoMsg(8, 'second clip'), mt.describeMedia(videoMsg(8, 'x')), ch);
    const wv = await pipeline.processItem(v8, feed, tg, settings);
    assert.equal(wv.outcome, 'excluded');
    assert.deepEqual(client.downloads, [{ id: 8, thumb: true }]);
    assert.equal(await store.has('tg/100/8.mp4'), false); assert.equal(await store.has('tg/100/8-t.jpg'), false);
    assert.equal(v8.localImage, null, 'the staged picture is released');

    // an accepted photo is downloaded once: the filter reads the same bytes that are then stored
    imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [{ gender: 'male', score: 0.9, confidence: 0.9 }] }));
    client.downloads.length = 0;
    const p9 = tg.messageToItem(photoMsg(9, 'pump day'), mt.describeMedia(photoMsg(9, 'x')), ch);
    assert.equal((await pipeline.processItem(p9, feed, tg, settings)).outcome, 'added');
    assert.deepEqual(client.downloads, [{ id: 9, thumb: false }]);
    assert.equal(await store.has('tg/100/9.jpg'), true);
    imagefilter._reset();
  });

  test('photos get a small preview next to the original (sharp)', { skip: !sharp && 'sharp not installed' }, async () => {
    const real = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#335577' } }).jpeg().toBuffer();
    const orig = client.downloadMedia; client.downloadMedia = async () => real;
    try {
      const feed = repo.feeds.get(repo.db.prepare("SELECT id FROM feeds WHERE target = 'gymbros'").get().id);
      const item = tg.messageToItem(photoMsg(77, 'gym selfie'), mt.describeMedia(photoMsg(77, 'x')), { id: '100', username: 'gymbros', title: 'Gym Bros', target: 'gymbros', trusted: true });
      await item.materialize(item);
      assert.equal(item.previewUrl, 'https://media.prism.invalid/tg/100/77-t.jpg');
      const t = await net.fetchBuffer(item.previewUrl);
      const meta = await sharp(t.buffer).metadata();
      assert.ok(meta.width <= 800 && t.buffer.length < real.length * 2);
      await item.discard();
      assert.equal(await store.has('tg/100/77.jpg'), false); assert.equal(await store.has('tg/100/77-t.jpg'), false);
      void feed;
    } finally { client.downloadMedia = orig; }
  });

  test('a private channel is read by id and its posts link to t.me/c', async () => {
    const feed = repo.feeds.get(repo.db.prepare("SELECT id FROM feeds WHERE target = 'id:200'").get().id);
    const got = await tg.fetch(feed, { limit: 40, cursor: {}, aborted: () => false });
    assert.equal(got.items[0].permalink, 'https://t.me/c/200/10'); assert.equal(got.items[0].author, 'c200'); assert.equal(got.items[0].authorName, 'Secret Club');
  });

  test('not configured / dead session: clear messages, not crashes', async () => {
    mt._setFactory(null);
    assert.equal(tg.isConfigured('channel').ok, false);
    assert.match(tg.isConfigured('channel').note, /TELEGRAM_API_ID/);
    assert.equal(tg.isConfigured('user').ok, true);
    const e = mt.wrap(Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' }));
    assert.equal(e.skip, true); assert.match(e.message, /telegram-login/);
    const f = mt.wrap(Object.assign(new Error('x'), { errorMessage: 'FLOOD_WAIT_30', seconds: 30 }));
    assert.equal(f.status, 429); assert.equal(f.retryAfter, 30000);
  });
});
