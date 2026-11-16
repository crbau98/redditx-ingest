'use strict';
/**
 * Direct-from-CDN media in a real browser (see direct-media.test.js for the helper and server layers): a direct picture
 * loads straight from its CDN; a refused one falls back to the proxy once without the item being reported broken; with
 * DIRECT_MEDIA=0 nothing goes direct. Skipped where Playwright's Chromium is not installed.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const exe = (() => { try { return pw && pw.chromium.executablePath(); } catch { return ''; } })();
const haveBrowser = !!(pw && exe && fs.existsSync(exe));

describe('browser: direct loads and the proxy fallback', { skip: haveBrowser ? false : 'Playwright Chromium not installed' }, () => {
  let server; let base; let browser; let engine; let repo;
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  before(async () => {
    delete process.env.DIRECT_MEDIA;
    const dir = prepareEnv({ DEMO_ART: '1', AGE_GATE_ENFORCE: 'false' });
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: { ...process.env, DB_PATH: path.join(dir, 'test.db') }, stdio: 'ignore' });
    repo = require('../src/db/repo');
    // every picture lives on an external host: i.redd.it and cdn.bsky.app (direct), preview.redd.it (not probed: proxied)
    repo.db.exec("UPDATE media SET media_url = 'https://i.redd.it/' || id || '.jpg', preview_url = CASE WHEN rowid % 2 = 0 THEN 'https://cdn.bsky.app/img/feed_thumbnail/plain/' || id || '@jpeg' ELSE 'https://preview.redd.it/' || id || '.jpg' END, thumbnail_url = NULL, thumb_url = NULL WHERE media_type = 'image'");
    // creator avatars are plain <img> elements on a direct host: the case the global fallback listener exists for
    repo.db.exec("UPDATE creators SET avatar_url = 'https://i.redd.it/av-' || id || '.jpg'");
    engine = require('../src/engine/engine');
    server = require('../src/app').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await pw.chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); engine.shutdown(); await new Promise((r) => server.close(r)); });

  /** Open Explore with stubbed CDNs. `directStatus` is what i.redd.it answers; returns what happened. */
  async function run({ directStatus }) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addCookies([{ name: 'prism_age', value: '1', url: base }]);
    const page = await ctx.newPage();
    const seen = { direct: 0, proxyRedd: 0, proxyPreview: 0, broken: 0, csp: 0 };
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) seen.csp++; });
    page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/media\/[^/]+\/broken/.test(r.url())) seen.broken++; });
    await page.route(/^https:\/\/(i\.redd\.it|cdn\.bsky\.app)\//, (r) => {
      seen.direct++;
      return directStatus === 200 ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : r.fulfill({ status: directStatus, body: 'no' });
    });
    await page.route('**/api/proxy**', (r) => {
      const u = decodeURIComponent(new URL(r.request().url()).searchParams.get('url') || '');
      if (/i\.redd\.it|cdn\.bsky\.app/.test(u)) seen.proxyRedd++; else if (/preview\.redd\.it/.test(u)) seen.proxyPreview++;
      return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    });
    await page.goto(`${base}/#/explore`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card-media', { timeout: 15000 });
    await page.waitForTimeout(800);
    const gridDirect = await page.evaluate(() => [...document.images].filter((i) => (i.getAttribute('src') || '').startsWith('https://cdn.bsky.app/')).length);
    // open the first image: the viewer asks for the full file (i.redd.it) after its dwell
    await page.locator('.card-media').first().click();
    await page.waitForTimeout(1800);
    const viewerImg = await page.evaluate(() => { const i = document.querySelector('.lb-stage img, .lightbox img'); return i ? { src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 } : null; });
    await page.keyboard.press('Escape'); await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0));
    const brokenImgs = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && /redd\.it|bsky\.app/.test(i.getAttribute('src') || '')).length);
    const avatars = await page.evaluate(() => [...document.images].filter((i) => /redd\.it/.test(decodeURIComponent(i.getAttribute('src') || '')) && /av-/.test(decodeURIComponent(i.getAttribute('src') || ''))).length);
    const brokenBeforeReels = seen.broken; // the demo's videos are stand-ins that cannot play, so Reels reports those
    // Reels shows full-size photos as attached <img> elements on the direct host: the document-level fallback covers them
    await page.goto(`${base}/#/reels`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const reelsImgs = await page.evaluate(() => { const all = [...document.querySelectorAll('.reel img')].filter((i) => /redd\.it/.test(decodeURIComponent(i.getAttribute('src') || ''))); return { n: all.length, broken: all.filter((i) => i.complete && i.naturalWidth === 0).length }; });
    await ctx.close();
    return { ...seen, brokenBeforeReels, viewerImg, brokenImgs, avatars, reelsImgs, gridDirect };
  }

  test('a direct picture loads from its CDN: grid pictures from the unprobed host use the proxy, the full file does not', async () => {
    const r = await run({ directStatus: 200 });
    assert.ok(r.direct >= 1, `the full file came straight from i.redd.it (${JSON.stringify(r)})`);
    assert.ok(r.proxyPreview >= 1, 'preview.redd.it was not probed, so it still uses the proxy');
    assert.equal(r.proxyRedd, 0, 'nothing from i.redd.it went through the proxy');
    assert.ok(r.gridDirect >= 1, 'grid tiles on a probed host are <img> elements loading straight from the CDN');
    assert.equal(r.csp, 0, 'the CSP allowed every direct load');
    assert.equal(r.brokenBeforeReels, 0);
    assert.ok(r.avatars >= 1 && r.brokenImgs === 0, 'direct avatars loaded');
    assert.ok(r.viewerImg && r.viewerImg.ok, 'the viewer shows a picture');
  });

  test('a CDN that starts refusing falls back to the proxy once, shows the picture, and the item is not reported broken', async () => {
    const r = await run({ directStatus: 403 });
    assert.ok(r.direct >= 1, 'the direct load was tried first');
    assert.ok(r.proxyRedd >= 1, 'then the same file came through the proxy');
    assert.equal(r.brokenBeforeReels, 0, 'a refused hotlink is a fallback, never a broken item');
    assert.ok(r.viewerImg && r.viewerImg.ok, 'no broken tile: the viewer shows the proxied picture');
    assert.ok(r.avatars >= 1, 'avatars on a direct host are on the page');
    assert.equal(r.brokenImgs, 0, 'no <img> is left broken: each refused direct avatar was retried through the proxy');
    assert.ok(r.reelsImgs.n >= 1, 'Reels has direct-host photos attached to the page');
    assert.equal(r.reelsImgs.broken, 0, 'a refused direct photo in the page was retried through the proxy');
    assert.ok(r.proxyRedd <= r.direct + 1, 'one retry per failed direct load, not a loop');
  });

  test('with DIRECT_MEDIA=0 nothing goes direct', async () => {
    process.env.DIRECT_MEDIA = '0';
    const s = require('../src/app').createApp().listen(0);
    await new Promise((r) => s.once('listening', r));
    const old = base; base = `http://127.0.0.1:${s.address().port}`;
    try {
      const r = await run({ directStatus: 200 });
      assert.equal(r.direct, 0);
      assert.ok(r.proxyRedd >= 1, 'the full file came through the proxy');
      assert.ok(r.viewerImg && r.viewerImg.ok);
    } finally { base = old; delete process.env.DIRECT_MEDIA; await new Promise((r) => s.close(r)); }
  });
});
