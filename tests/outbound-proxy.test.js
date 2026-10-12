'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dns = require('dns');

let proxy; const connects = [];
const realLookup = dns.lookup;

before(async () => {
  proxy = http.createServer();
  proxy.on('connect', (req, socket) => { connects.push(req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); }); // a proxy that refuses: we only care whether it was asked
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  process.env.OUTBOUND_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  dns.lookup = (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const table = { 'rebind.example': [{ address: '10.0.0.5', family: 4 }], 'public.example': [{ address: '93.184.216.34', family: 4 }], 'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.9', family: 4 }] };
    if (table[host]) return setImmediate(() => cb(null, opts && opts.all ? table[host] : table[host][0].address, 4));
    return setImmediate(() => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })));
  };
});
after(async () => { dns.lookup = realLookup; await new Promise((r) => proxy.close(r)); });

test('with OUTBOUND_PROXY, destinations are validated locally BEFORE the CONNECT: private answers never reach the proxy', async () => {
  const net = require('../src/lib/net');
  for (const host of ['rebind.example', 'mixed.example']) {
    await assert.rejects(() => net.request(`https://${host}/x`, { retries: 0 }), (e) => e.code === 'EBLOCKED' && /private/.test(e.message), host);
  }
  assert.deepEqual(connects, [], 'the proxy was never asked to tunnel to a private destination');
});

test('unresolvable names are refused (cannot be validated) unless the operator trusts the proxy DNS; public names are tunnelled', async () => {
  const net = require('../src/lib/net');
  await assert.rejects(() => net.request('https://unknown.example/x', { retries: 0 }), (e) => e.code === 'EBLOCKED' && /cannot validate/.test(e.message));
  assert.ok(!connects.some((c) => c.startsWith('unknown.example')));
  await assert.rejects(() => net.request('https://public.example/x', { retries: 0 }), (e) => /proxy refused CONNECT/.test(e.message));
  assert.ok(connects.includes('public.example:443'), 'a validated public host is handed to the proxy by NAME (so hostname-based proxy policy keeps working)');
});
