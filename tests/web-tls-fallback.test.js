'use strict';
// A host that accepts the TCP connection and then refuses the TLS handshake (metamoldz.com answers "tlsv1 alert
// internal error" to every client) is read once over plain HTTP instead. No network: net.request is stubbed, and the
// https attempt fails with the same EPROTO the host really sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'web-tls-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const TARGET = 'https://tls-refused.example.net/performer/someone';
const PLAIN = 'http://tls-refused.example.net/performer/someone';
const PAGE = '<html><head><title>Someone — gay performer</title></head><body>'
  + '<video src="https://tls-refused.example.net/clip.mp4" poster="https://tls-refused.example.net/clip.jpg"></video>'
  + '</body></html>';
const calls = [];

const net = require('../src/lib/net');
net.request = async (url) => {
  calls.push(String(url));
  // robots.txt: a 404 means "no rules".
  if (/\/robots\.txt$/.test(url)) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') };
  if (/^https:/i.test(url)) {
    const e = new Error('write EPROTO 00000000:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error');
    e.code = 'EPROTO';
    e.url = String(url);
    throw e;
  }
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(PAGE), url: String(url) };
};

const settings = require('../src/settings');
const realGet = settings.get;
settings.get = () => ({ ...realGet(), browser4Mode: 'off', challengeBrowser: 'off', jinaReader: 'off' });

const web = require('../src/sources/web');

test('a refused TLS handshake falls back to plain HTTP once', async () => {
  calls.length = 0;
  const out = await web.webAdapter.fetch(
    { platform: 'web', kind: 'page', target: TARGET },
    { cursor: {}, limit: 5, aborted: () => false },
  );
  assert.equal(calls.filter((u) => u === TARGET).length, 1, 'the https URL is tried first, exactly once');
  assert.ok(calls.includes(PLAIN), 'the same page is retried over http');
  assert.ok(out.items.some((i) => /clip\.mp4$/.test(i.mediaUrl)), 'the page behind the plain request yields its media');
  // The page links its own file over https, which the same host refuses: it is stored over http.
  assert.ok(out.items.every((i) => /^http:\/\//.test(i.mediaUrl)), 'same-host media is stored over http too');
  assert.match((out.info || []).join(' '), /refuses the TLS handshake/);
});

test('a timeout is not retried over http', async () => {
  net.request = async (url) => {
    if (/\/robots\.txt$/.test(url)) return { status: 404, headers: {}, body: Buffer.from('') };
    const e = new Error('Timeout (response)'); e.code = 'ETIMEDOUT'; e.url = String(url); throw e;
  };
  calls.length = 0;
  await assert.rejects(
    web.webAdapter.fetch({ platform: 'web', kind: 'page', target: TARGET }, { cursor: {}, limit: 5, aborted: () => false }),
  );
  assert.ok(!calls.includes(PLAIN), 'no downgrade for a timeout');
});

test.after(() => { settings.get = realGet; });
