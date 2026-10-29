'use strict';
/**
 * The Playwright engine (lib/playwright.js) and its guard proxy (lib/guardproxy.js), with a REAL Chromium against the
 * JavaScript-built fixture site. Skipped where Playwright or its Chromium is not installed (CI runs it in the e2e job:
 * `npx playwright install --with-deps chromium`).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');
const { prepareEnv, start } = require('./helpers/mock');

prepareEnv({ PLAYWRIGHT_ENABLED: '1', RENDER_ENGINE: 'playwright', PLAYWRIGHT_TIMEOUT_MS: '30000' });
const playwright = require('../src/lib/playwright');
const ready = playwright.available();
if (!ready.ok) {
  test(`Playwright engine tests need Playwright and its Chromium (${ready.reason})`, { skip: process.env.E2E_REQUIRED !== '1' }, () => assert.fail(ready.reason));
  return;
}

const config = require('../src/config');
const repo = require('../src/db/repo');
const registry = require('../src/sources');
const settingsStore = require('../src/settings');
const engine = require('../src/engine/engine');
const expand = require('../src/engine/expand');
const render = require('../src/lib/render');
const guard = require('../src/lib/guardproxy');
const { startSite } = require('./helpers/spa-site');

let site;
const web = (target) => ({ platform: 'web', kind: 'page', target, origin: 'admin' });

before(async () => { site = await startSite(); });
after(async () => { await playwright.close(); await guard.stop(); await site.close(); engine.shutdown(); });

describe('Playwright reads JavaScript-built pages', { timeout: 240000 }, () => {
  test('the facade picks Playwright; status reports both engines', async () => {
    assert.equal(render.engineName(), 'playwright');
    const st = await render.status();
    assert.equal(st.engine, 'playwright');
    assert.equal(st.playwright.ok, true);
    assert.equal(st.browser4.enabled, false);
  });

  test('a plain download sees an empty shell; Playwright sees the whole gallery over two pages', async () => {
    settingsStore.update({ browser4Mode: 'off' });
    const plain = await registry.get('web').fetch(web(`${site.url}/gallery`), {});
    assert.equal(plain.items.length, 0);
    settingsStore.update({ browser4Mode: 'fallback', browser4Scrolls: 8, browser4Pages: 3 });
    const r = await registry.get('web').fetch(web(`${site.url}/gallery`), {});
    assert.equal(r.via, 'playwright');
    assert.equal(new Set(r.items.map((i) => i.mediaUrl)).size, 24, '18 from infinite scroll + 6 from the JS-built next page');
    assert.ok(r.info.some((s) => /^Playwright read 2 pages/.test(s)), r.info.join(' | '));
  });

  test('the engine ingests what Playwright read, through the normal pipeline', async () => {
    const { feed } = repo.feeds.upsert({ platform: 'web', kind: 'page', target: `${site.url}/gallery`, trusted: 1, origin: 'admin' });
    const r = await engine.runFeed(feed.id, 'manual', { force: true });
    assert.equal(r.status, 'ok', r.error);
    assert.equal(r.via, 'playwright');
    assert.equal(r.fetched, 24);
  });

  test('expansion works on Playwright too: JS-built links become feeds, noise is left', async () => {
    const r = await expand.run(`${site.url}/`, { depth: 1, limit: 10 });
    const targets = repo.feeds.list({ platform: 'web', limit: 100 }).items.map((f) => f.target.replace(site.url, ''));
    for (const p of ['/set/alpha', '/set/beta']) assert.ok(targets.includes(p), `${p} is a feed`);
    assert.ok(!targets.includes('/login'));
    assert.ok(r.created >= 2);
  });

  test('a bot-challenge page ends the render', async () => {
    await assert.rejects(render.renderPages(`${site.url}/challenge`, { scrolls: 0 }), (e) => e.skip === true && e.challenge === true);
  });
});

describe('the guard proxy: nothing private is reached, by any route', { timeout: 120000 }, () => {
  let internal; let pub;
  const reached = () => internal.hits.filter((h) => !/favicon/.test(h));
  before(async () => {
    internal = await start({ '/secret': () => ({ body: 'internal' }), '/img.png': () => ({ body: 'x' }), '/xhr': () => ({ body: 'x' }), '/ws': () => ({ body: 'x' }) });
    const ip = `http://127.0.0.1:${internal.port}`;
    pub = await start({
      '/redirect': () => ({ status: 302, headers: { location: `${ip}/secret` } }),
      '/page': () => ({ headers: { 'content-type': 'text/html' }, body: `<html><body>public page
        <img src="${ip}/img.png"><img src="http://sneaky.example:${internal.port}/img.png">
        <script>fetch('${ip}/xhr').catch(()=>{}); new Worker(URL.createObjectURL(new Blob(["fetch('${ip}/xhr?worker').catch(()=>{})"])));
        try { new WebSocket('ws://127.0.0.1:${internal.port}/ws'); } catch (e) {}</script></body></html>` }),
      '/to-leak': () => ({ status: 302, headers: { location: 'https://coomer.su/onlyfans/user/x' } }),
    });
  });
  after(async () => { config.allowPrivateHosts = true; delete config.playwright.testAllowHosts; await internal.close(); await pub.close(); });

  // Production rules: private hosts refused. The fixture page itself is reached as "localhost" (allowed for the test only),
  // everything aimed at 127.0.0.1 or at a name that resolves there must be refused.
  const blocking = async (fn) => {
    const realLookup = dns.lookup;
    dns.lookup = (host, opts, cb) => (host === 'sneaky.example' ? (typeof opts === 'function' ? opts : cb)(null, [{ address: '127.0.0.1', family: 4 }]) : realLookup(host, opts, cb));
    config.allowPrivateHosts = false; config.playwright.testAllowHosts = ['localhost'];
    try { return await fn(); } finally { config.allowPrivateHosts = true; delete config.playwright.testAllowHosts; dns.lookup = realLookup; }
  };

  test('CONTROL: with private hosts allowed, the same page DOES reach the internal service (so the test can fail)', async () => {
    const before = reached().length;
    await render.renderPages(`http://localhost:${pub.port}/page`, { scrolls: 0 });
    assert.ok(reached().length > before, `control reached it: ${reached()}`);
  });

  test('a redirect hop into the private network is refused before it is sent', async () => {
    const before = reached().length;
    await blocking(() => assert.rejects(render.renderPages(`http://localhost:${pub.port}/redirect`, { scrolls: 0 }), (e) => e.skip === true && /led to a refused address \(127\.0\.0\.1/.test(e.message)));
    assert.equal(reached().length, before, `nothing reached it: ${reached().slice(before)}`);
  });

  test('images, fetch(), a worker\'s fetch, WebSockets and a NAME that resolves to 127.0.0.1: none are sent', async () => {
    const before = reached().length;
    const since = Date.now();
    const r = await blocking(() => render.renderPages(`http://localhost:${pub.port}/page`, { scrolls: 0 }));
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(r.pages.length, 1, 'the public page itself loads');
    assert.equal(reached().length, before, `nothing reached it: ${reached().slice(before)}`);
    const refused = guard.refusedSince(since).map((b) => b.host);
    assert.ok(refused.includes('127.0.0.1'), refused.join(','));
    assert.ok(refused.includes('sneaky.example'), `the name was resolved and refused: ${refused.join(',')}`);
  });

  test('a redirect hop to a leak site is refused (Browser4 only notices these afterwards)', async () => {
    const since = Date.now();
    await assert.rejects(render.renderPages(`http://localhost:${pub.port}/to-leak`, { scrolls: 0 }));
    assert.ok(guard.refusedSince(since).some((b) => b.host === 'coomer.su' && b.reason === 'leak site'));
  });

  test('the proxy serves nobody without its per-process credential', async () => {
    const { server } = await guard.start();
    const res = await new Promise((resolve) => require('http').get(`${server.replace('http://', 'http://')}/`, { headers: {}, path: `http://localhost:${pub.port}/page`, host: '127.0.0.1', port: new URL(server).port }, resolve).on('error', () => resolve({ statusCode: 0 })));
    assert.equal(res.statusCode, 407);
  });
});
