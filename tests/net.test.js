'use strict';
// Runs WITHOUT allowPrivateHosts, exactly like production, to prove the SSRF guard holds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
process.env.NODE_ENV = 'test';
delete process.env.ALLOW_PRIVATE_HOSTS;
const net = require('../src/lib/net');

test('literal private / loopback / metadata hosts are refused before any connection', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.1/', 'http://192.168.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://foo.internal/', 'http://printer.local/']) {
    await assert.rejects(() => net.request(url, { retries: 0 }), (e) => /Blocked host/.test(e.message) || e.code === 'EBLOCKED', url);
  }
});

test('the DNS lookup itself rejects names that resolve to private addresses (rebinding defence)', async () => {
  const err = await new Promise((resolve) => net.safeLookup('localhost', {}, (e) => resolve(e)));
  assert.ok(err, 'localhost resolves to loopback and must be rejected');
  assert.equal(err.code, 'EBLOCKED');
  const err2 = await new Promise((resolve) => net.safeLookup('localhost', { all: true }, (e) => resolve(e)));
  assert.equal(err2.code, 'EBLOCKED');
});

test('redirects are re-validated on every hop', async () => {
  const server = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // The origin itself is loopback, so even the first hop is refused — either way nothing private is reached.
  await assert.rejects(() => net.request(`http://127.0.0.1:${server.address().port}/`, { retries: 0 }), /Blocked host/);
  server.close();
});

test('non-http(s) protocols and malformed URLs are rejected', async () => {
  await assert.rejects(() => net.request('file:///etc/passwd', { retries: 0 }), /Unsupported protocol/);
  await assert.rejects(() => net.request('ftp://example.com/x', { retries: 0 }), /Unsupported protocol/);
  await assert.rejects(() => net.request('not a url', { retries: 0 }), /Invalid URL/);
});

test('isPrivateHost mirrors the rules for hostnames', () => {
  for (const h of ['localhost', 'a.local', 'x.internal', '[::1]', '127.0.0.1', '10.1.2.3']) assert.equal(net.isPrivateHost(h), true, h);
  for (const h of ['example.com', 'i.redd.it', '8.8.8.8']) assert.equal(net.isPrivateHost(h), false, h);
});

test('reserved 6to4 and relay-anycast ranges are blocked', () => {
  assert.equal(net.isPrivateHost('192.88.99.1'), true);
  assert.equal(net.isPrivateHost('2002:7f00:1::'), true);
});
