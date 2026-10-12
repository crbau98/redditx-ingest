'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/mock');

process.env.INTERNAL_HOSTS = 'localhost, Metrics.Internal';
const net = require('../src/lib/net');
let a; let b;

before(async () => {
  b = await start({ '/secret': () => ({ body: 'internal secret' }) });
  a = await start({
    '/ok': () => ({ body: 'search ok' }),
    '/redirect': () => ({ status: 302, headers: { location: `http://localhost:${b.port}/secret` } }),
  });
});
after(async () => { await a.close(); await b.close(); });

test('isPrivateHost: INTERNAL_HOSTS is an explicit per-call allowance, never a global exemption', () => {
  assert.equal(net.isPrivateHost('localhost'), true);
  assert.equal(net.isPrivateHost('localhost', { allowInternal: true }), false);
  assert.equal(net.isPrivateHost('metrics.internal', { allowInternal: true }), false, 'case-insensitive; beats the .internal suffix rule');
  assert.equal(net.isPrivateHost('metrics.internal'), true);
  assert.equal(net.isPrivateHost('evil.example.internal', { allowInternal: true }), true, 'only exact vouched names');
  assert.equal(net.isPrivateHost('127.0.0.1', { allowInternal: true }), true);
  assert.equal(net.isPrivateHost('10.0.0.5', { allowInternal: true }), true);
});

test('a request reaches an internal host only when the caller passes allowInternal', async () => {
  await assert.rejects(() => net.request(`http://localhost:${a.port}/ok`, { retries: 0 }), (e) => e.code === 'EBLOCKED');
  const r = await net.request(`http://localhost:${a.port}/ok`, { retries: 0, allowInternal: true });
  assert.equal(String(r.body), 'search ok');
});

test('a redirect from an allowed internal call can NEVER reach an internal host (content-controlled redirects stay SSRF-guarded)', async () => {
  await assert.rejects(() => net.request(`http://localhost:${a.port}/redirect`, { retries: 0, allowInternal: true }), (e) => e.code === 'EBLOCKED' || /Blocked/.test(e.message));
});
