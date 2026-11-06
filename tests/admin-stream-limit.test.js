'use strict';
/**
 * The admin brute-force guard allows 20 failed attempts in ten minutes. The live event stream never "finishes" (it ends when the
 * page is left), so before this fix every visit to a screen that listens to it counted as a failed attempt and 21 page changes
 * locked the owner out of the whole admin API. A stream that carries the right key skips the guard; wrong keys still count.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prepareEnv } = require('./helpers/mock');

let server; let port; let engine;
before(async () => {
  prepareEnv({ MEDIA_STORE: 'disk' });
  engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});
after(async () => { engine.shutdown(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

/** Open the stream, wait for the first bytes, then walk away like a browser leaving the page. */
const openAndLeave = (key) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/admin/stream', headers: key ? { 'x-admin-key': key } : {} }, (res) => {
    const status = res.statusCode;
    res.once('data', () => { req.destroy(); resolve(status); });
    res.once('end', () => resolve(status));
  });
  req.on('error', () => resolve(0));
});
const overview = (key) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port, path: '/api/admin/overview', headers: { 'x-admin-key': key } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
});

test('leaving the live stream 30 times does not lock the owner out', async () => {
  for (let i = 0; i < 30; i++) assert.equal(await openAndLeave('test-key'), 200, `stream ${i}`);
  assert.equal(await overview('test-key'), 200, 'the admin API still answers');
});

test('wrong keys on the stream still count against the guard, and lock it', async () => {
  const seen = new Set();
  for (let i = 0; i < 25; i++) seen.add(await openAndLeave('wrong-key'));
  assert.ok(seen.has(401), 'wrong keys are refused');
  assert.ok(seen.has(429), 'and after 20 of them the guard answers 429');
  assert.equal(await overview('test-key'), 429, 'the lock covers the whole admin API for this client, as before');
});
