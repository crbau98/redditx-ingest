'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodenet = require('net');
const { start } = require('./helpers/mock');

let socks; let web; const seen = [];
const VOUCHED = 'vouchedsearxngexample.onion';

before(async () => {
  web = await start({ '/search': () => ({ json: { results: [{ url: 'https://x.com/jax', title: 'Jax on X', content: 'gay model' }] } }) });
  // a tiny SOCKS5 server (RFC 1928, no auth): records the destination NAME it was asked for, then tunnels to the local web mock
  socks = nodenet.createServer((c) => {
    let stage = 0; let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 3) return;
        c.write(Buffer.from([0x05, 0x00])); buf = buf.subarray(3); stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        const len = buf[4];
        if (buf.length < 7 + len) return;
        const host = buf.subarray(5, 5 + len).toString(); const port = buf.readUInt16BE(5 + len);
        seen.push({ host, port, atyp: buf[3] });
        stage = 2;
        if (host.startsWith('dead')) return c.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        const up = nodenet.connect({ host: '127.0.0.1', port: web.port }, () => {
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.destroy());
      }
    });
  });
  await new Promise((r) => socks.listen(0, '127.0.0.1', r));
  process.env.NODE_ENV = 'test'; // (ALLOW_PRIVATE_HOSTS stays unset: the guards must hold)
  process.env.TOR_PROXY = `socks5h://127.0.0.1:${socks.address().port}`;
  process.env.SEARXNG_URL = `http://${VOUCHED}`;
  process.env.DB_PATH = require('path').join(require('os').tmpdir(), `tor-test-${process.pid}.db`);
});
after(async () => { await new Promise((r) => socks.close(r)); await web.close(); });

test('the vouched onion SearXNG is reached through Tor, with the NAME handed to the proxy (remote DNS)', async () => {
  const net = require('../src/lib/net');
  const r = await net.fetchJSON(`http://${VOUCHED}/search?q=x&format=json`, { allowInternal: true, retries: 0 });
  assert.equal(r.results[0].url, 'https://x.com/jax');
  assert.deepEqual(seen.at(-1), { host: VOUCHED, port: 80, atyp: 0x03 });
});

test('web search works end to end over the onion route', async () => {
  const websearch = require('../src/lib/websearch');
  const out = await websearch.PROVIDERS.searxng.search('jax stone');
  assert.equal(out[0].title, 'Jax on X');
});

test('every other onion name stays blocked: no grant, wrong host, or a redirect target', async () => {
  const net = require('../src/lib/net');
  await assert.rejects(() => net.request(`http://${VOUCHED}/search`, { retries: 0 }), (e) => e.code === 'EBLOCKED', 'without the explicit grant');
  await assert.rejects(() => net.request('http://someotheronionexample.onion/', { retries: 0, allowInternal: true }), (e) => e.code === 'EBLOCKED', 'a different onion, even with the grant');
  assert.equal(net.isPrivateHost('anything.onion'), true);
  assert.equal(net.isPrivateHost(VOUCHED, { allowInternal: true }), false);
  assert.ok(!seen.some((s) => s.host === 'someotheronionexample.onion'), 'the proxy never saw the blocked names');
});

test('onion failures are explained (SOCKS reply 4 = the service did not answer); https onion is refused', async () => {
  const net = require('../src/lib/net');
  await assert.rejects(() => net.socks5Connect(process.env.TOR_PROXY, 'dead1234567890.onion', 80, 5000), (e) => /host unreachable/.test(e.message));
  await assert.rejects(() => net.request(`https://${VOUCHED}/search`, { retries: 0, allowInternal: true }), (e) => /http:\/\//.test(e.message));
});
