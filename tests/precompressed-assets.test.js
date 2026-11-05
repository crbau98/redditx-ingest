'use strict';
/**
 * The app shell, the stylesheet bundle and the scripts of the current version are kept compressed (Brotli quality 11, gzip)
 * in memory and served with a Content-Length (src/lib/assets.js).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { prepareEnv } = require('./helpers/mock');
const fs = require('fs');
const path = require('path');

const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');

let server; let base; let app; let repo; let engine; let backup; let mediaId;
const AGE = { cookie: 'prism_age=1' };
/** A GET with exact control of Accept-Encoding that returns the raw (still encoded) body. */
const raw = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(`${base}${p}`, { headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  const c = repo.creators.create({ handle: 'transport_creator', displayName: 'Transport' });
  mediaId = repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: 't1', source_key: 'reddit:t1:0', post_key: 'reddit:t1', title: 'Transport item', media_type: 'image', media_url: 'https://i.redd.it/t1.jpg', preview_url: 'https://i.redd.it/t1p.jpg', hash: 'transporth1', score: 5, width: 800, height: 1000 }, ['transporttag']);
  repo.creators.refreshStats(c.id);
  app = require('../src/app').createApp();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });


describe('pre-compressed app shell and scripts', () => {
  let ver; let html;
  before(async () => {
    await app.locals.warmAssets(); // what a production boot does in the background
    html = (await raw('/')).body.toString();
    ver = html.match(/src="\/v\/([0-9a-f]{10})\/js\/main\.js"/)[1];
  });

  test('acceptedEncoding prefers br, honours q=0 and wildcards', () => {
    const { acceptedEncoding } = require('../src/lib/assets');
    assert.equal(acceptedEncoding('gzip, deflate, br'), 'br');
    assert.equal(acceptedEncoding('gzip'), 'gzip');
    assert.equal(acceptedEncoding('br;q=0, gzip'), 'gzip');
    assert.equal(acceptedEncoding('identity'), null);
    assert.equal(acceptedEncoding(undefined), null);
    assert.equal(acceptedEncoding('*'), 'br');
    assert.equal(acceptedEncoding('deflate, *;q=0'), null);
  });

  test('the versioned script is served from memory, Brotli quality 11, with a Content-Length and immutable caching', async () => {
    const url = `/v/${ver}/js/main.js`;
    const r = await raw(url, { 'accept-encoding': 'br, gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['content-length'], String(r.body.length));
    assert.match(r.headers['cache-control'], /immutable/);
    assert.match(r.headers['content-type'], /javascript/);
    assert.match(r.headers.vary, /Accept-Encoding/i);
    const source = fs.readFileSync(path.join(PUBLIC_JS, 'main.js'));
    assert.equal(zlib.brotliDecompressSync(r.body).toString(), source.toString());
    // smaller than what the on-the-fly middleware (Brotli quality 4) would send
    const q4 = zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    assert.ok(r.body.length < q4.length, `quality 11 (${r.body.length} B) should beat quality 4 (${q4.length} B)`);
    const gz = await raw(url, { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.body).toString(), source.toString());
  });

  test('a client that accepts no encoding still gets the plain file; HEAD works', async () => {
    const r = await raw(`/v/${ver}/js/main.js`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.match(r.body.toString(), /from '\.\/dom\.js'/);
    const head = await new Promise((resolve) => http.request(`${base}/v/${ver}/js/main.js`, { method: 'HEAD', headers: { 'accept-encoding': 'br' } }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).end());
    assert.equal(head.statusCode, 200);
  });

  test('the stylesheet bundle and the shell are pre-compressed too; the shell revalidates by ETag', async () => {
    const css = await raw(`/v/${ver}/css/bundle.css`, { 'accept-encoding': 'br' });
    assert.equal(css.headers['content-encoding'], 'br');
    assert.match(css.headers['cache-control'], /immutable/);
    assert.ok(zlib.brotliDecompressSync(css.body).toString().includes('.appbar'));
    const shell = await raw('/', { 'accept-encoding': 'br' });
    assert.equal(shell.headers['content-encoding'], 'br');
    assert.equal(shell.headers['cache-control'], 'no-cache');
    assert.equal(zlib.brotliDecompressSync(shell.body).toString(), html);
    const again = await raw('/', { 'accept-encoding': 'br', 'if-none-match': shell.headers.etag });
    assert.equal(again.status, 304);
    // the ETag names the encoding, so a gzip client never gets a validator that matches the Brotli bytes
    const gz = await raw('/', { 'accept-encoding': 'gzip' });
    assert.notEqual(gz.headers.etag, shell.headers.etag);
    assert.equal(zlib.gunzipSync(gz.body).toString(), html);
  });

  test('a file the store has not seen takes the ordinary path once, and is served compressed after', async () => {
    const express = require('express');
    const assets = require('../src/lib/assets');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'prism-lazy-'));
    fs.mkdirSync(path.join(dir, 'js'));
    const source = `export const a = ${JSON.stringify('x'.repeat(2000))};\n`;
    fs.writeFileSync(path.join(dir, 'js', 'lazy.js'), source);
    const store = assets.createCompressedStore();
    const mini = express();
    mini.use('/v/:ver', require('express-rate-limit')({ windowMs: 60 * 1000, max: 1000 }), assets.compressedStatic(dir, store, () => 'v1'));
    mini.use((req, res) => res.status(200).set('X-Path', 'ordinary').send('ordinary'));
    const srv = mini.listen(0); await new Promise((r) => srv.once('listening', r));
    const get = (p) => new Promise((resolve) => http.get(`http://127.0.0.1:${srv.address().port}${p}`, { headers: { 'accept-encoding': 'br' } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(c) })); }));
    try {
      const first = await get('/v/v1/js/lazy.js');
      assert.equal(first.headers['x-path'], 'ordinary');
      await store.settled();
      const second = await get('/v/v1/js/lazy.js');
      assert.equal(second.headers['content-encoding'], 'br');
      assert.equal(zlib.brotliDecompressSync(second.body).toString(), source);
      assert.equal((await get('/v/v2/js/lazy.js')).headers['x-path'], 'ordinary', 'not the current version');
      assert.equal((await get('/v/v1/js/missing.js')).headers['x-path'], 'ordinary', 'no such file');
    } finally { await new Promise((r) => srv.close(r)); }
  });

  test('another version and a path outside js/ and css/ are not answered from the store', async () => {
    const old = await raw('/v/0000000000/js/dom.js', { 'accept-encoding': 'br' });
    assert.equal(old.status, 200);
    assert.equal(old.headers['cache-control'], 'no-cache');
    const escape = await raw(`/v/${ver}/js/..%2f..%2fpackage.json`, { 'accept-encoding': 'identity' });
    assert.ok(!escape.body.toString().includes('"name": "prism"'), 'never reads outside public/js and public/css');
    const other = await raw(`/v/${ver}/favicon.svg`, { 'accept-encoding': 'br' });
    assert.equal(other.status, 200); // the ordinary static path
  });
});

test('the route that reads files for the compressed store is rate-limited in the real app (CodeQL js/missing-rate-limiting)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(app, /const assetLimiter = rateLimit\(/);
  assert.match(app, /app\.use\('\/v\/:ver', assetLimiter, assets\.compressedStatic\(/);
});
