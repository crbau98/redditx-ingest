'use strict';
/**
 * Stored media from the bucket, in a real browser (see store-direct.test.js for the server layer). A seeded database whose
 * pictures live in a local S3 mock: Chromium follows /api/proxy's redirect to the presigned bucket URL under the page's real
 * Content-Security-Policy; with STORE_DIRECT=0 the same pictures are relayed by the proxy. Skipped where Chromium is missing.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');
const { s3Server, ACCESS, SECRET, BUCKET } = require('./helpers/s3');

let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const exe = (() => { try { return pw && pw.chromium.executablePath(); } catch { return ''; } })();
const haveBrowser = !!(pw && exe && fs.existsSync(exe));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('browser: stored media from the bucket', { skip: haveBrowser ? false : 'Playwright Chromium not installed' }, () => {
  let s3; let browser; let engine; let ids;
  const apps = [];
  before(async () => {
    delete process.env.DIRECT_MEDIA; delete process.env.STORE_DIRECT;
    s3 = await s3Server();
    const dir = prepareEnv({ DEMO_ART: '1', AGE_GATE_ENFORCE: 'false', MEDIA_STORE: '', MEDIA_STORE_ENDPOINT: s3.url, MEDIA_STORE_BUCKET: BUCKET, MEDIA_STORE_ACCESS_KEY_ID: ACCESS, MEDIA_STORE_SECRET_ACCESS_KEY: SECRET, MEDIA_STORE_PREFIX: 'p/' });
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: { ...process.env, DB_PATH: path.join(dir, 'test.db'), MEDIA_STORE: 'disk', MEDIA_STORE_ENDPOINT: '' }, stdio: 'ignore' });
    const repo = require('../src/db/repo');
    const store = require('../src/lib/objectstore');
    ids = repo.db.prepare("SELECT id FROM media WHERE media_type = 'image'").all().map((r) => r.id);
    for (const id of ids) await store.putS3(`b/${id}.png`, PNG, 'image/png');
    // every picture is a stored object: https://media.prism.invalid/b/<id>.png
    repo.db.exec("UPDATE media SET media_url = 'https://media.prism.invalid/b/' || id || '.png', preview_url = NULL, thumbnail_url = NULL, thumb_url = NULL WHERE media_type = 'image'");
    engine = require('../src/engine/engine');
    browser = await pw.chromium.launch();
  });
  after(async () => {
    if (browser) await browser.close();
    engine.shutdown();
    for (const s of apps) await new Promise((r) => s.close(r));
    await s3.close();
    delete process.env.STORE_DIRECT;
  });

  async function run({ sw = false } = {}) {
    const server = require('../src/app').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    apps.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: sw ? 'allow' : 'block' });
    await ctx.addCookies([{ name: 'prism_age', value: '1', url: base }]);
    const page = await ctx.newPage();
    const seen = { csp: 0, pageErrors: 0, redirects: 0, relayedImages: 0, swServed: 0 };
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) seen.csp++; });
    page.on('pageerror', () => { seen.pageErrors++; });
    page.on('response', (r) => {
      if (!/\/api\/proxy\?/.test(r.url())) return;
      if (r.fromServiceWorker()) seen.swServed++;
      if (r.status() === 307) seen.redirects++;
      else if (r.status() === 200 && /^image\//.test(r.headers()['content-type'] || '')) seen.relayedImages++;
    });
    if (sw) { // let the service worker take control first: it answers picture requests itself (fetch(req)), and that fetch follows the redirect under ITS Content-Security-Policy
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.reload({ waitUntil: 'networkidle' });
      // offline content on: the service worker answers every picture request with its own fetch(req), the case that follows the redirect under its policy
      await page.evaluate(() => navigator.serviceWorker.controller.postMessage({ type: 'prism-offline-content', on: true }));
      await page.waitForTimeout(400);
    }
    s3.log.length = 0;
    await page.goto(`${base}/#/explore`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card-media', { timeout: 15000 });
    await page.waitForTimeout(800);
    const tiles = await page.evaluate(() => [...document.images].filter((i) => (i.getAttribute('src') || '').includes('media.prism.invalid')));
    const loaded = await page.evaluate(() => [...document.images].filter((i) => (i.getAttribute('src') || '').includes('media.prism.invalid') && i.complete && i.naturalWidth > 0).length);
    const broken = await page.evaluate(() => [...document.images].filter((i) => (i.getAttribute('src') || '').includes('media.prism.invalid') && i.complete && i.naturalWidth === 0).length);
    await page.locator('.card-media').first().click();
    await page.waitForTimeout(1800);
    const viewer = await page.evaluate(() => { const i = document.querySelector('.lb-stage img, .lightbox img'); return i ? { ok: i.complete && i.naturalWidth > 0 } : null; });
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    const swControlled = sw ? await page.evaluate(() => !!navigator.serviceWorker.controller) : null;
    const swFetches = sw ? ctx.serviceWorkers().length : 0;
    await ctx.close();
    const presigned = s3.log.filter((l) => l.endsWith('presigned')).length;
    const signedHeader = s3.log.filter((l) => l.startsWith('GET ') && !l.endsWith('presigned')).length;
    return { ...seen, swControlled, swFetches, tiles: tiles.length, loaded, broken, viewer, presigned, signedHeader, base };
  }

  test('Chromium follows the redirect to the bucket: pictures load, nothing is relayed by PRISM, no CSP violation', async () => {
    delete process.env.STORE_DIRECT;
    const r = await run();
    assert.ok(r.tiles >= 3 && r.loaded >= 3, `store pictures are on the page and loaded (${JSON.stringify(r)})`);
    assert.equal(r.broken, 0, 'no broken tile');
    assert.equal(r.csp, 0, 'the CSP allowed the bucket (img-src)');
    assert.equal(r.pageErrors, 0);
    assert.ok(r.redirects >= 3, 'the proxy answered with redirects');
    assert.equal(r.relayedImages, 0, 'no picture byte went through the proxy');
    assert.ok(r.presigned >= 3, 'the bucket saw the browser\'s presigned GETs');
    assert.equal(r.signedHeader, 0, 'PRISM did not fetch from the bucket on the browser\'s behalf');
    assert.ok(r.viewer && r.viewer.ok, 'the viewer shows the stored picture');
  });

  test('with the service worker in control, its own fetch follows the redirect too (no CSP violation, no broken tile)', async () => {
    delete process.env.STORE_DIRECT;
    const r = await run({ sw: true });
    assert.equal(r.swControlled, true, 'the page really was controlled by the service worker');
    assert.ok(r.loaded >= 3 && r.broken === 0, JSON.stringify(r));
    assert.equal(r.csp, 0, 'the service worker\'s fetch of the redirect target is allowed (connect-src)');
    assert.ok(r.swServed >= 3, `the service worker answered the picture requests itself (${r.swServed})`);
    assert.ok(r.presigned >= 3, 'the pictures came from the bucket');
  });

  test('STORE_DIRECT=0: the same pictures are relayed by the proxy, none are redirected', async () => {
    process.env.STORE_DIRECT = '0';
    try {
      const r = await run();
      assert.ok(r.loaded >= 3 && r.broken === 0);
      assert.equal(r.redirects, 0);
      assert.ok(r.relayedImages >= 3, 'the proxy relayed the pictures');
      assert.equal(r.presigned, 0, 'the browser never talked to the bucket');
      assert.ok(r.signedHeader >= 3, 'PRISM read them from the bucket itself');
      assert.equal(r.csp, 0);
    } finally { delete process.env.STORE_DIRECT; }
  });
});
