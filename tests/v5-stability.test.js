'use strict';
/**
 * Stability: inputs that used to throw inside a socket callback (an uncaught exception takes the whole server down) now
 * fail just the one request, and the health check reports memory and event-loop delay.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let net;
before(async () => {
  prepareEnv();
  net = require('../src/lib/net');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('a malformed redirect Location rejects the request instead of crashing the process', async () => {
  const up = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://[not-a-host/x' }); res.end(); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  let crashed = null;
  const onCrash = (e) => { crashed = e; };
  process.once('uncaughtException', onCrash);
  try {
    await assert.rejects(() => net.open(`http://127.0.0.1:${up.address().port}/`), /Invalid redirect/);
    await new Promise((r) => setImmediate(r));
    assert.equal(crashed, null);
  } finally { process.removeListener('uncaughtException', onCrash); up.close(); }
});

test('health reports memory and event-loop delay', async () => {
  const res = await fetch(`${base}/api/health`);
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.ok(j.memMb.rss > 0 && j.memMb.heap > 0);
  assert.ok(Number.isFinite(j.loop.p99Ms) && Number.isFinite(j.loop.maxMs));
});
