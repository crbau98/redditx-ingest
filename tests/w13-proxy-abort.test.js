'use strict';
/** Crucible v4.22.1 P1: a viewer that leaves before the origin answers frees the upstream socket at once (not after the 15 s timeout). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let origin; let port; let engine; let backup; const open = new Set();
before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'false', ALLOW_PRIVATE_HOSTS: 'true' });
  const repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  origin = http.createServer((req, res) => {
    open.add(req.socket); req.socket.on('close', () => open.delete(req.socket));
    if (req.url === '/tiny.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.alloc(300, 1)); }
    setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write(Buffer.alloc(65536)); } }, 1500); // silent first
  });
  port = await new Promise((r) => origin.listen(0, '127.0.0.1', () => r(origin.address().port)));
  repo.hosts.add(`http://localhost:${port}/x.mp4`);
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); origin.closeAllConnections?.(); origin.close(); await new Promise((r) => server.close(r)); });

test('aborting before the origin sends headers closes the upstream connection within a second', async () => {
  const ctrls = [];
  for (let i = 0; i < 5; i++) {
    const ac = new AbortController(); ctrls.push(ac);
    fetch(`${base}/api/proxy?url=${encodeURIComponent(`http://localhost:${port}/slow${i}.mp4`)}`, { headers: { cookie: 'prism_age=1' }, signal: ac.signal }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(open.size >= 5, `origin saw the requests (${open.size})`);
  for (const ac of ctrls) ac.abort();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(open.size, 0, 'no origin connection left open after the viewers left');
  const t = Date.now();
  const r = await fetch(`${base}/api/proxy?url=${encodeURIComponent(`http://localhost:${port}/tiny.jpg`)}`, { headers: { cookie: 'prism_age=1' } });
  assert.equal(r.status, 200); await r.arrayBuffer();
  assert.ok(Date.now() - t < 1000);
});
