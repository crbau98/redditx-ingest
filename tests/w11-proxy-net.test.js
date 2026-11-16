'use strict';
/** Wave 11: the proxy allow-list holds on every redirect hop; the private-address list has no gaps. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prepareEnv, JPEG } = require('./helpers/mock');

let net; let repo; let server; let base; let upstreamListed; let upstreamOther; let engine; let backup;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'false', ALLOW_PRIVATE_HOSTS: 'true' }); // loopback servers stand in for CDNs
  net = require('../src/lib/net'); repo = require('../src/db/repo');
  engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  upstreamOther = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(JPEG); });
  const otherPort = await listen(upstreamOther);
  upstreamListed = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(JPEG); }
    if (req.url === '/to-unlisted') { res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/img.jpg` }); return res.end(); }
    if (req.url === '/to-listed') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  const listedPort = await listen(upstreamListed);
  repo.hosts.add(`http://localhost:${listedPort}/x.jpg`); // only "localhost" is on the allow-list; 127.0.0.1 is not
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  before.ports = { listedPort, otherPort };
});
after(async () => { engine.shutdown(); backup.stop(); upstreamListed.close(); upstreamOther.close(); await new Promise((r) => server.close(r)); });

const get = (u) => fetch(`${base}/api/proxy?url=${encodeURIComponent(u)}`, { headers: { cookie: 'prism_age=1' } });

describe('proxy allow-list on redirects', () => {
  test('a listed host that redirects to an unlisted host is refused (403)', async () => {
    const { listedPort, otherPort } = before.ports;
    const direct = await get(`http://127.0.0.1:${otherPort}/img.jpg`);
    assert.equal(direct.status, 403, 'the unlisted host is refused when asked directly');
    const hop = await get(`http://localhost:${listedPort}/to-unlisted`);
    assert.equal(hop.status, 403, 'and through a redirect');
    await hop.arrayBuffer();
  });
  test('listed -> listed redirects still work, and a plain listed image is served', async () => {
    const { listedPort } = before.ports;
    assert.equal((await get(`http://localhost:${listedPort}/ok`)).status, 200);
    const r = await get(`http://localhost:${listedPort}/to-listed`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    await r.arrayBuffer();
  });
  test('net.open: allowHop sees every hop target and can refuse it', async () => {
    const { listedPort, otherPort } = before.ports;
    const seen = [];
    await assert.rejects(() => net.open(`http://localhost:${listedPort}/to-unlisted`, { allowHop: (u) => { seen.push(u.hostname); return false; } }), (e) => e.code === 'EBLOCKED');
    assert.deepEqual(seen, ['127.0.0.1']);
    const ok = await net.open(`http://localhost:${listedPort}/to-listed`, { allowHop: () => true });
    assert.equal(ok.res.statusCode, 200); ok.res.resume();
    assert.ok(otherPort);
  });
});

describe('private-address list', () => {
  const prevAllow = () => {};
  test('IPv6 forms of loopback / private space and the special-use ranges are refused', () => {
    const cfg = require('../src/config');
    const was = cfg.allowPrivateHosts; cfg.allowPrivateHosts = false;
    try {
      for (const h of ['[::127.0.0.1]', '[::ffff:0:7f00:1]', '[2002:7f00:1::]', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]', '[fec0::1]', '192.88.99.1', 'localhost.', 'LOCALHOST..', 'a.localhost.', 'x.internal.', '[::1]', '127.0.0.1']) {
        assert.equal(net.isPrivateHost(new URL(`http://${h}/`).hostname), true, h);
      }
      for (const h of ['example.com', 'i.redd.it', '8.8.8.8', '[2606:4700:4700::1111]', 'example.com.']) assert.equal(net.isPrivateHost(new URL(`http://${h}/`).hostname), false, h);
    } finally { cfg.allowPrivateHosts = was; }
    void prevAllow;
  });
});
