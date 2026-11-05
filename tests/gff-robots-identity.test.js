'use strict';
// robots.txt is checked under the SAME identity the page is requested with (gff.js identity()). No network: the HTTP client
// is replaced before the adapter loads, and it serves a robots.txt that depends on the user agent it is asked with.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gff-robots-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const net = require('../src/lib/net');
const seenRobots = [];
const seenPages = [];
let robotsFor = () => 'User-agent: *\nAllow: /\n';
net.request = async (url, opts = {}) => {
  const ua = (opts.headers || {})['user-agent'] || null;
  if (/\/robots\.txt$/.test(url)) {
    seenRobots.push({ url, ua });
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(robotsFor(ua)) };
  }
  seenPages.push({ url, ua });
  return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html></html>') };
};

const settings = require('../src/settings');
const realGet = settings.get;
const withIdentity = (on) => { settings.get = () => ({ ...realGet(), gffBrowserAgent: on }); };
const gff = require('../src/sources/gff');
const { robotsAllows } = require('../src/sources/web');

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

test('browser identity on: the robots check and the page request carry the same user agent', () => {
  withIdentity(true);
  const id = gff._identity();
  assert.equal(id.userAgent, BROWSER);
  assert.equal(gff._pageHeaders()['user-agent'], id.userAgent, 'page request uses the identity');
  settings.get = realGet;
});

test('a robots.txt that disallows under PRISM\'s own agent but allows under the browser agent: the browser identity is the one obeyed', async () => {
  withIdentity(true);
  robotsFor = (ua) => (ua === BROWSER ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /performer/\n');
  const url = 'https://identity-allow.example.org/performer/alpha';
  assert.equal(await robotsAllows(url, gff._identity()), true, 'allowed under the identity the page is read with');
  const robotsReq = seenRobots.find((r) => r.url.startsWith('https://identity-allow.example.org/'));
  assert.equal(robotsReq.ua, BROWSER, 'robots was asked with the browser agent, not PRISM\'s own');
  settings.get = realGet;
});

test('a robots.txt that disallows under the browser agent skips the page, even if PRISM\'s own agent would be allowed', async () => {
  withIdentity(true);
  robotsFor = (ua) => (ua === BROWSER ? 'User-agent: *\nDisallow: /performer/\n' : 'User-agent: *\nAllow: /\n');
  const url = 'https://identity-deny.example.org/performer/beta';
  assert.equal(await robotsAllows(url, gff._identity()), false, 'the identity we use is disallowed: skip');
  settings.get = realGet;
});

test('browser identity off: robots and the page both use PRISM\'s own agent (no browser user agent on either)', async () => {
  withIdentity(false);
  robotsFor = () => 'User-agent: *\nAllow: /\n';
  const id = gff._identity();
  assert.equal(id.userAgent, null);
  assert.equal(gff._pageHeaders()['user-agent'], undefined, 'page request uses PRISM\'s default agent');
  const url = 'https://identity-off.example.org/performer/gamma';
  assert.equal(await robotsAllows(url, id), true);
  const robotsReq = seenRobots.find((r) => r.url.startsWith('https://identity-off.example.org/'));
  assert.equal(robotsReq.ua, null, 'robots carries no browser agent when the setting is off');
  settings.get = realGet;
});
