'use strict';
/**
 * The real thing: a real browser4-cli and a real Chrome/Chromium against a JavaScript-built fixture site
 * (tests/helpers/spa-site.js). Opt-in, because it needs both installed:
 *
 *   npm i -g browser4-cli && browser4-cli install
 *   BROWSER4_LIVE=1 node --test tests/browser4.live.test.js
 *   DISPLAY=:0 BROWSER4_LIVE=1 ...        (with a display the window is shown - a headed run)
 *
 * Note for Chrome 156+: Browser4 4.15.1 rejects the `File-Path-Style` field newer Chrome adds to /json/version
 * ("createDevTools" errors). Use Chrome/Chromium <= 153 until Browser4 ships a fix.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv, start } = require('./helpers/mock');

if (process.env.BROWSER4_LIVE !== '1') {
  test('live Browser4 tests are opt-in: set BROWSER4_LIVE=1', { skip: true }, () => {});
  return;
}

prepareEnv({ BROWSER4_ENABLED: '1', BROWSER4_SESSION: 'prism-live-test', BROWSER4_HEADED: process.env.DISPLAY ? '1' : '0', BROWSER4_TIMEOUT_MS: '60000' });
const { startSite } = require('./helpers/spa-site');
const repo = require('../src/db/repo');
const registry = require('../src/sources');
const settingsStore = require('../src/settings');
const engine = require('../src/engine/engine');
const expand = require('../src/engine/expand');
const browser4 = require('../src/lib/browser4');

let site;
const web = (target) => ({ platform: 'web', kind: 'page', target, origin: 'admin' });

before(async () => {
  const st = await browser4.status();
  assert.ok(st.ok, `browser4-cli is not usable: ${st.reason}`);
  site = await startSite();
});
after(async () => { await browser4.close(); await site.close(); });

describe('real Browser4 against a JavaScript-built site', { timeout: 300000 }, () => {
  test('a plain download sees an empty shell; the browser sees the whole gallery', async () => {
    settingsStore.update({ browser4Mode: 'off' });
    const plain = await registry.get('web').fetch(web(`${site.url}/gallery`), {});
    assert.equal(plain.items.length, 0, 'the HTML holds no pictures at all');

    settingsStore.update({ browser4Mode: 'fallback', browser4Scrolls: 8, browser4Pages: 3 });
    const r = await registry.get('web').fetch(web(`${site.url}/gallery`), {});
    assert.equal(r.via, 'browser4');
    assert.equal(new Set(r.items.map((i) => i.mediaUrl)).size, 24, '18 from infinite scroll + 6 from the JS-built "next" page');
    assert.ok(r.items.some((i) => /\/img\/10[0-5]\.jpg$/.test(i.mediaUrl)), 'the second page was followed');
    assert.deepEqual(r.notes, []);
  });

  test('the engine ingests what the browser read, through the normal pipeline', async () => {
    settingsStore.update({ browser4Mode: 'fallback' });
    const { feed } = repo.feeds.upsert({ platform: 'web', kind: 'page', target: `${site.url}/gallery`, trusted: 1, origin: 'admin' });
    const r = await engine.runFeed(feed.id, 'manual', { force: true });
    assert.equal(r.status, 'ok', r.error);
    assert.equal(r.via, 'browser4');
    assert.equal(r.fetched, 24);
    assert.equal(r.added + r.dupes + r.skipped + r.blocked, 24, 'every item got a verdict');
    assert.ok(r.added > 0, `some items were published (skipped: ${r.skipped}, blocked: ${r.blocked})`);
    assert.ok(repo.media.list({ limit: 100 }).total >= r.added);
  });

  test('expansion finds links that only exist after the JavaScript ran, and leaves the noise', async () => {
    const r = await expand.run(`${site.url}/`, { depth: 1, limit: 10 });
    const targets = repo.feeds.list({ platform: 'web', limit: 100 }).items.map((f) => f.target.replace(site.url, ''));
    for (const p of ['/gallery', '/set/alpha', '/set/beta']) assert.ok(targets.includes(p), `${p} is a feed now`);
    assert.equal(r.created + r.skipped.existing, 3, 'three content links on the page (the engine test above already made /gallery)');
    assert.ok(!targets.includes('/login'), 'login is not a page of content');
    assert.ok(targets.includes('/'), 'the starting page is a feed too');
    for (const u of r.urls) assert.equal(repo.feeds.find('web', 'page', u).origin, 'expand');
  });

  test('a bot-challenge page is recognised and left alone', async () => {
    await assert.rejects(browser4.renderPages(`${site.url}/challenge`, { scrolls: 0 }), (e) => e.skip === true && e.challenge === true);
  });

  // A local remote-debugging Chromium stands in for Bright Data's Browser API: the real mechanism (attach over CDP, one page per
  // connection, scroll, read, detach, repeat) with a real browser - but not Bright Data's own service, which needs an account.
  test('the remote Browser API path works against a real remote browser: a fresh attach per page, 24 media over two pages', async (t) => {
    const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
    const bin = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable'].find((b) => b && fs.existsSync(b));
    if (!bin) return t.skip('no Chrome/Chromium binary found (set CHROME_BIN)');
    const config = require('../src/config');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-chrome-'));
    const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
    try {
      let ws = null;
      for (let i = 0; i < 60 && !ws; i++) {
        try { const [port, p] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n'); ws = `ws://127.0.0.1:${port}${p}`; } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      assert.ok(ws, 'the remote browser exposed its DevTools endpoint');
      config.brightdata.browserWss = ws;
      const r = await browser4.renderPages(`${site.url}/gallery`, { remote: true, scrolls: 8, pages: 3 });
      assert.equal(r.via, 'brightdata-browser');
      assert.equal(r.pages.length, 2, 'the JS-built "next page" link was followed, on a second connection');
      const media = new Set(r.pages.flatMap((p) => [...p.html.matchAll(/\/img\/(\d+)\.jpg/g)].map((m) => m[1])));
      assert.equal(media.size, 24);
    } finally {
      config.brightdata.browserWss = '';
      proc.kill('SIGKILL');
    }
  });

  // Last: it registers browser-level routes that would also block the 127.0.0.1 fixture the tests above use.
  test('the browser aborts a redirect hop and sub-requests aimed at a private address BEFORE they are sent', async () => {
    const config = require('../src/config');
    const internal = await start({ '/secret': () => ({ body: 'internal service' }), '/sub.png': () => ({ body: 'x' }), '/xhr': () => ({ body: 'x' }) });
    const pub = await start({
      '/redirect': () => ({ status: 302, headers: { location: `${internal.url}/secret` } }),
      '/page': () => ({ headers: { 'content-type': 'text/html' }, body: `<html><body>page<img src="${internal.url}/sub.png"><script>fetch('${internal.url}/xhr').catch(() => {})</script></body></html>` }),
    });
    const target = (p) => `http://localhost:${pub.port}${p}`; // "public-looking" name; the internal service is the literal 127.0.0.1
    const reached = () => internal.hits.filter((h) => !/favicon/.test(h)).length;
    try {
      // CONTROL: with no browser-level block the very same page DOES reach the internal service (so the test can fail)
      config.browser4.blockPrivate = false;
      await browser4.renderPages(target('/redirect'), { scrolls: 0 });
      await browser4.renderPages(target('/page'), { scrolls: 0 });
      assert.ok(internal.hits.some((h) => h.includes('/secret')) && internal.hits.some((h) => h.includes('/sub.png')) && internal.hits.some((h) => h.includes('/xhr')), `control must reach it: ${internal.hits}`);

      // BLOCKED: only the 127.* pattern is used here (the real list also covers localhost, which this fixture needs)
      config.browser4.blockPrivate = true; config.browser4.blockPatterns = ['*://127.*'];
      const before = reached();
      await assert.rejects(browser4.renderPages(target('/redirect'), { scrolls: 0 }), 'the redirect hop is aborted, so the navigation fails');
      assert.equal(reached(), before, 'the redirect never reached the internal service');
      const r = await browser4.renderPages(target('/page'), { scrolls: 0 });
      assert.equal(r.pages.length, 1, 'the public page itself still loads');
      assert.equal(reached(), before, 'its image and XHR to the internal service were never sent');
    } finally {
      config.browser4.blockPrivate = false; delete config.browser4.blockPatterns;
      await browser4._unblock();
      await internal.close(); await pub.close();
    }
  });
});
