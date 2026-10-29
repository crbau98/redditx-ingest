'use strict';
/**
 * lib/guardproxy.js without a browser: plain requests and CONNECT tunnels through it, as Chromium sends them.
 * (tests/playwright.test.js covers it with a real browser where one is installed.)
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');
const http = require('http');
const { prepareEnv, start } = require('./helpers/mock');

prepareEnv();
const config = require('../src/config');
const guard = require('../src/lib/guardproxy');

let upstream; let proxy; let realLookup;
const auth = () => `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`;
const via = (url, { headers = { 'proxy-authorization': auth() } } = {}) => new Promise((resolve, reject) => {
  const p = new URL(proxy.server);
  const req = http.request({ host: p.hostname, port: p.port, path: url, headers }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject); req.end();
});
const tunnel = (target) => new Promise((resolve, reject) => {
  const p = new URL(proxy.server);
  const req = http.request({ host: p.hostname, port: p.port, method: 'CONNECT', path: target, headers: { 'proxy-authorization': auth() } });
  req.on('connect', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers }); });
  req.on('response', (res) => resolve({ status: res.statusCode, headers: res.headers }));
  req.on('error', reject); req.end();
});

before(async () => {
  upstream = await start({ '/x': () => ({ body: 'hello' }) });
  proxy = await guard.start();
  realLookup = dns.lookup;
  // dual.test: an IPv6 address first that nothing answers on, then the IPv4 one that works (dual-stack hosts, CI runners)
  dns.lookup = (host, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (host === 'dual.test') return done(null, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
    if (host === 'dead.test') return done(null, [{ address: '127.0.0.1', family: 4 }]);
    return realLookup(host, opts, cb);
  };
});
after(async () => { dns.lookup = realLookup; config.allowPrivateHosts = true; await guard.stop(); await upstream.close(); });

describe('guard proxy', () => {
  test('nobody without the per-process credential', async () => {
    const r = await via(`http://dual.test:${upstream.port}/x`, { headers: {} });
    assert.equal(r.status, 407);
  });

  test('a name whose first address does not answer: the next one is tried', async () => {
    const r = await via(`http://dual.test:${upstream.port}/x`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'hello');
    const t = await tunnel(`dual.test:${upstream.port}`);
    assert.equal(t.status, 200);
  });

  test('nothing answers: a marked 502, so the browser engine does not take it for the page', async () => {
    const closed = await start({}); const port = closed.port; await closed.close();
    const r = await via(`http://dead.test:${port}/x`);
    assert.equal(r.status, 502);
    assert.ok(r.headers['x-prism-unreachable'], JSON.stringify(r.headers));
    const t = await tunnel(`dead.test:${port}`);
    assert.equal(t.status, 502);
  });

  test('with private hosts refused: private addresses, names resolving to them and leak hosts get a marked 403', async () => {
    config.allowPrivateHosts = false;
    try {
      for (const url of [`http://127.0.0.1:${upstream.port}/x`, `http://dual.test:${upstream.port}/x`, 'http://169.254.169.254/latest/meta-data/', 'http://coomer.su/x']) {
        const r = await via(url);
        assert.equal(r.status, 403, url);
        assert.ok(r.headers['x-prism-refused'], url);
      }
      assert.equal((await tunnel(`127.0.0.1:${upstream.port}`)).status, 403);
      assert.equal((await tunnel('coomer.su:443')).status, 403);
      assert.ok(upstream.hits.every((h) => !h.includes('meta-data')));
    } finally { config.allowPrivateHosts = true; }
  });
});
