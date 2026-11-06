'use strict';
/**
 * How the public read routes travel: a validator on every list (ETag, so a revalidation is a body-less 304), Brotli/gzip
 * compression, and nothing cacheable that the age gate refused. These behaviours come from Express and the compression
 * middleware; the tests pin them so a change to either (a new middleware, a cache header) cannot quietly lose them.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let backup;
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
  // enough rows that a list is past the 1 KB threshold under which the compression middleware leaves a body alone
  for (let i = 1; i <= 12; i++) {
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: `t${i}`, source_key: `reddit:t${i}:0`, post_key: `reddit:t${i}`, title: `Transport item ${i}`, media_type: 'image', media_url: `https://i.redd.it/t${i}.jpg`, preview_url: `https://i.redd.it/t${i}p.jpg`, hash: `transporth${i}`, score: 5 + i, width: 800, height: 1000 }, ['transporttag']);
  }
  repo.creators.refreshStats(c.id);
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });

describe('conditional GET on the public lists', () => {
  const LISTS = ['/api/media?limit=5', '/api/creators?limit=5', '/api/discover', '/api/stats', '/api/tags?limit=20', '/api/communities', '/api/platforms', '/api/topics', '/api/graph'];
  for (const url of LISTS) {
    test(`${url} carries an ETag and answers a matching If-None-Match with a body-less 304`, async () => {
      const first = await raw(url, AGE);
      assert.equal(first.status, 200);
      assert.ok(first.headers.etag, 'has a validator');
      const again = await raw(url, { ...AGE, 'if-none-match': first.headers.etag });
      assert.equal(again.status, 304);
      assert.equal(again.body.length, 0);
      const stale = await raw(url, { ...AGE, 'if-none-match': 'W/"stale"' });
      assert.equal(stale.status, 200);
      assert.ok(stale.body.length > 0);
    });
  }

  test('an answer and its 304 agree on the validator across encodings (the ETag is of the body, not of the encoding)', async () => {
    const plain = await raw('/api/media?limit=5', AGE);
    const br = await raw('/api/media?limit=5', { ...AGE, 'accept-encoding': 'br' });
    assert.equal(br.headers.etag, plain.headers.etag);
    assert.equal((await raw('/api/media?limit=5', { ...AGE, 'accept-encoding': 'br', 'if-none-match': plain.headers.etag })).status, 304);
  });

  test('the age gate refuses an unverified visitor even when they hold a validator, and a missing item is a 404', async () => {
    const ok = await raw('/api/media?limit=5', AGE);
    const gated = await raw('/api/media?limit=5', { 'if-none-match': ok.headers.etag }); // no age cookie
    assert.equal(gated.status, 403, 'a 304 must never be a way around the age gate');
    assert.equal((await raw('/api/media/00000000-0000-0000-0000-000000000000', AGE)).status, 404);
  });
});

describe('compression of the JSON lists', () => {
  test('Brotli when the client accepts it, gzip otherwise, identity when it accepts neither', async () => {
    const br = await raw('/api/media?limit=5', { ...AGE, 'accept-encoding': 'br, gzip' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(JSON.parse(zlib.brotliDecompressSync(br.body)).items.length, 5);
    assert.match(br.headers.vary || '', /Accept-Encoding/i);
    const gz = await raw('/api/media?limit=5', { ...AGE, 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(JSON.parse(zlib.gunzipSync(gz.body)).items.length, 5);
    const none = await raw('/api/media?limit=5', AGE);
    assert.equal(none.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(none.body).items.length, 5);
  });

  test('a list is a fraction of its JSON on the wire', async () => {
    const plain = await raw('/api/media?limit=12', AGE);
    const br = await raw('/api/media?limit=12', { ...AGE, 'accept-encoding': 'br' });
    assert.ok(br.body.length < plain.body.length / 3, `${br.body.length} B compressed vs ${plain.body.length} B`);
  });
});
