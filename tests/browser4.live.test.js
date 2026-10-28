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
const { prepareEnv } = require('./helpers/mock');

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
});
