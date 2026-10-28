'use strict';
/**
 * Browser4 policy: what a real browser is never sent to. Private hosts are BLOCKED here (as in production): a browser does
 * not go through lib/net.js, so lib/browser4.js has to apply the same SSRF rules itself, before AND after navigation.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

const b4dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-b4-policy-'));
const fake = path.join(__dirname, 'helpers', 'fake-browser4.js');
prepareEnv({ ALLOW_PRIVATE_HOSTS: 'false', BROWSER4_ENABLED: '1', BROWSER4_CLI: fake, FAKE_B4_DIR: b4dir, BROWSER4_TIMEOUT_MS: '10000' });

const config = require('../src/config');
const repo = require('../src/db/repo');
const browser4 = require('../src/lib/browser4');
const { createApp } = require('../src/app');

const setRoutes = (routes) => { fs.writeFileSync(path.join(b4dir, 'routes.json'), JSON.stringify(routes)); fs.rmSync(path.join(b4dir, 'calls.jsonl'), { force: true }); };
const calls = () => (fs.existsSync(path.join(b4dir, 'calls.jsonl')) ? fs.readFileSync(path.join(b4dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const refuses = async (url, re) => assert.rejects(browser4.assertAllowed(url), (e) => e.skip === true && re.test(e.message), url);

describe('assertAllowed', () => {
  test('refuses everything that is not a public http(s) page', async () => {
    await refuses('file:///etc/passwd', /only http\(s\)/);
    await refuses('ftp://example.com/x', /only http\(s\)/);
    await refuses('javascript:alert(1)', /only http\(s\)/);
    await refuses('chrome://settings', /only http\(s\)/);
    await refuses('not a url', /not a valid URL/);
    await refuses('https://user:secret@example.com/', /credentials/);
  });

  test('refuses private, loopback, link-local and metadata addresses', async () => {
    for (const u of ['http://localhost/', 'http://app.localhost/', 'http://127.0.0.1:8080/', 'http://[::1]/', 'http://10.0.0.5/', 'http://192.168.1.1/',
      'http://172.16.0.9/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:7f00:1]/', 'http://printer.local/', 'http://db.internal/', 'http://abcdefghij.onion/']) {
      await refuses(u, /private|internal|resolves/);
    }
  });

  test('refuses decimal / hex / octal spellings of loopback (WHATWG URL normalises them)', async () => {
    await refuses('http://2130706433/', /private|internal/);
    await refuses('http://0x7f.0.0.1/', /private|internal/);
    await refuses('http://0177.0.0.1/', /private|internal/);
  });

  test('refuses leak sites, paywalled hosts and takedowns, even on a public address', async () => {
    await refuses('https://coomer.su/onlyfans/user/x', /leak/);
    await refuses('https://gayforfans.com/video/1', /leak/);
    await refuses('https://onlyfans.com/someone', /paywalled/);
    await refuses('https://www.fansly.com/someone', /paywalled/);
    repo.takedowns.add({ kind: 'domain', value: 'opted-out.example', reason: 'creator asked' });
    await refuses('http://opted-out.example/gallery', /takedown/);
  });

  test('lets a public address through (literal IPs need no DNS)', async () => {
    assert.equal(await browser4.assertAllowed('http://93.184.216.34/gallery?p=1'), 'http://93.184.216.34/gallery?p=1');
  });
});

describe('renderPages', () => {
  beforeEach(() => browser4._reset());

  test('is a no-op "skip" when Browser4 is switched off', async () => {
    config.browser4.enabled = false;
    try {
      assert.equal(browser4.enabled(), false);
      await assert.rejects(browser4.renderPages('http://93.184.216.34/'), (e) => e.skip === true && /not enabled/.test(e.message));
      assert.equal((await browser4.available()).ok, false);
      assert.deepEqual(calls(), [], 'no process is started when disabled');
    } finally { config.browser4.enabled = true; }
  });

  test('checks where the browser ENDED UP: a redirect into the private network is refused', async () => {
    const url = 'http://93.184.216.34/gallery';
    setRoutes({ [url]: { html: '<html><body>secret</body></html>', final: 'http://169.254.169.254/latest/meta-data/' } });
    await assert.rejects(browser4.renderPages(url, { scrolls: 0 }), (e) => e.skip === true && /private/.test(e.message));
  });

  test('a redirect to a leak site is refused too', async () => {
    const url = 'http://93.184.216.34/out';
    setRoutes({ [url]: { html: '<html></html>', final: 'https://coomer.su/x' } });
    await assert.rejects(browser4.renderPages(url, { scrolls: 0 }), (e) => e.skip === true && /leak/.test(e.message));
  });

  test('a bot-challenge page ends the render - nothing is retried or worked around', async () => {
    const url = 'http://93.184.216.34/challenged';
    setRoutes({ [url]: { html: '<html>Just a moment...</html>', challenge: true } });
    await assert.rejects(browser4.renderPages(url, { scrolls: 3 }), (e) => e.skip === true && e.challenge === true);
    const cmds = calls().map((c) => c.cmd);
    assert.ok(!cmds.includes('eval'), 'the page is never scrolled or read after a challenge');
    assert.equal(cmds.filter((c) => c === 'goto').length, 1, 'no second attempt');
  });

  test('a follow-up page that the policy refuses is not visited', async () => {
    const a = 'http://93.184.216.34/gallery'; const next = 'http://93.184.216.34/gallery?page=2';
    setRoutes({ [a]: { html: '<html></html>', next }, [next]: { html: '<html>two</html>' } });
    const r = await browser4.renderPages(a, { scrolls: 0, pages: 3, allowUrl: async () => false });
    assert.equal(r.pages.length, 1);
    assert.match(r.notes.join(' '), /not allowed/);
    assert.equal(calls().filter((c) => c.cmd === 'goto').length, 1);
  });
});

describe('admin expand endpoint refuses what the policy refuses', () => {
  let srv; let base;
  before(async () => { srv = createApp().listen(0); await new Promise((r) => srv.once('listening', r)); base = `http://127.0.0.1:${srv.address().port}`; });
  after(async () => { await new Promise((r) => srv.close(r)); });
  const post = async (body) => { const r = await fetch(`${base}/api/admin/browser4/expand`, { method: 'POST', headers: { 'x-admin-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

  test('bad input, private targets and leak sites are rejected before anything starts', async () => {
    setRoutes({}); // start from an empty call log
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ url: 'file:///etc/passwd' })).status, 400);
    const priv = await post({ url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(priv.status, 400); assert.match(priv.json.error, /private/);
    const leak = await post({ url: 'https://coomer.su/x/y' });
    assert.equal(leak.status, 400); assert.match(leak.json.error, /leak/);
    assert.deepEqual(calls(), [], 'no browser was started for any of them');
  });

  test('409 when Browser4 is not enabled on this server', async () => {
    config.browser4.enabled = false;
    try { assert.equal((await post({ url: 'http://93.184.216.34/' })).status, 409); } finally { config.browser4.enabled = true; }
  });
});
