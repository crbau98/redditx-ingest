'use strict';
/** Wave 11 (Crucible item 5): one proxied response relays at most PROXY_MAX_MB. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let upstream; let engine; let backup; let port;
const SIZE = 3 * 1048576;
before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'false', ALLOW_PRIVATE_HOSTS: 'true' });
  const repo = require('../src/db/repo');
  engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  upstream = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': SIZE }); res.end(Buffer.alloc(SIZE, 1)); });
  port = await new Promise((r) => upstream.listen(0, '127.0.0.1', () => r(upstream.address().port)));
  repo.hosts.add(`http://localhost:${port}/v.mp4`);
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { delete process.env.PROXY_MAX_MB; engine.shutdown(); backup.stop(); upstream.close(); await new Promise((r) => server.close(r)); });

const pull = async () => {
  try {
    const r = await fetch(`${base}/api/proxy?url=${encodeURIComponent(`http://localhost:${port}/v.mp4`)}`, { headers: { cookie: 'prism_age=1' } });
    return (await r.arrayBuffer()).byteLength;
  } catch { return -1; } // cut mid-body
};

test('under the cap the whole video is relayed; over it the relay is cut', async () => {
  delete process.env.PROXY_MAX_MB;
  assert.equal(await pull(), SIZE);
  process.env.PROXY_MAX_MB = '1';
  const got = await pull();
  assert.ok(got < SIZE, `cut short (got ${got})`);
});
