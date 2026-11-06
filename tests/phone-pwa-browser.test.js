'use strict';
/**
 * The phone and install behaviours, in a real Chromium with touch emulation (Playwright) on the offline demo library:
 * the filter bar that hides on scroll-down, swipes in the viewer, the offline pill and an offline cold start through
 * the service worker, the install entry in the phone menu, the keyboard hiding the tab bar, Reels' top row fitting a
 * 360px screen. Skipped where Playwright or its Chromium is missing (E2E_REQUIRED=1 makes that a failure, as in CI).
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
if (!pw || !exe || !fs.existsSync(exe)) {
  test('phone/PWA browser tests need Playwright and its Chromium (npx playwright install chromium)', { skip: process.env.E2E_REQUIRED !== '1' }, () => assert.fail('Playwright Chromium is not installed'));
  return;
}

let server; let base; let browser; let engine;
before(async () => {
  const dir = prepareEnv({ DEMO_ART: '1', AGE_GATE_ENFORCE: 'true' });
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: { ...process.env, DB_PATH: path.join(dir, 'test.db') }, stdio: 'ignore' });
  engine = require('../src/engine/engine');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch();
});
after(async () => { if (browser) await browser.close(); engine.shutdown(); await new Promise((r) => server.close(r)); });

const PHONE = { width: 390, height: 844 };
async function visit(t, { viewport = PHONE, hash = '', serviceWorkers = 'block', phone = true } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, serviceWorkers });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  t.after(async () => { await ctx.close(); });
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: /18 or older/ }).click();
  await page.locator('main .card').first().waitFor();
  if (hash) { await page.goto(`${base}/#${hash}`); await page.waitForTimeout(600); }
  return { ctx, page, problems };
}
/** A finger: touchStart at `from`, moves in `steps`, touchEnd at `to` (CDP, so the page sees real touch pointer events). */
async function swipe(page, from, to, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const at = (x, y) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(...from) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps) });
    await page.waitForTimeout(12);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const mediaIds = (page) => page.evaluate(() => fetch('/api/media?limit=6').then((r) => r.json()).then((j) => j.items.map((i) => i.id)));
const scrollTo = async (page, y) => { for (let cur = await page.evaluate(() => scrollY); cur !== y;) { cur = cur < y ? Math.min(y, cur + 60) : Math.max(y, cur - 60); await page.evaluate((v) => window.scrollTo(0, v), cur); await page.waitForTimeout(25); } await page.waitForTimeout(350); };

describe('phone behaviours', { timeout: 240000 }, () => {
  test('the sticky filter bar hides while scrolling down and returns on the first scroll up (phone); desktop never hides it', async (t) => {
    const { page } = await visit(t, { hash: '/explore' });
    const bar = page.locator('.filterbar');
    await bar.waitFor();
    assert.equal(await bar.evaluate((el) => el.classList.contains('bar-hidden')), false, 'visible at the top');
    await scrollTo(page, 700);
    assert.equal(await bar.evaluate((el) => el.classList.contains('bar-hidden')), true, 'hidden after scrolling down');
    assert.equal(await bar.evaluate((el) => getComputedStyle(el).visibility), 'hidden', 'and out of the tab order');
    await scrollTo(page, 640);
    assert.equal(await bar.evaluate((el) => el.classList.contains('bar-hidden')), false, 'back after scrolling up 60px');
    await scrollTo(page, 0);
    const desk = await visit(t, { viewport: { width: 1280, height: 800 }, hash: '/explore', phone: false });
    await scrollTo(desk.page, 700);
    assert.equal(await desk.page.locator('.filterbar').evaluate((el) => el.classList.contains('bar-hidden')), false, 'desktop keeps it');
  });

  test('viewer: swipe left goes to the next item, swipe down closes it', async (t) => {
    const { page } = await visit(t);
    const ids = await mediaIds(page);
    await page.goto(`${base}/#/explore?m=${ids[0]}`);
    await page.locator('.lb').waitFor();
    const current = () => page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('m'));
    assert.equal(await current(), ids[0]);
    const startId = await current();
    await swipe(page, [320, 420], [60, 420]);
    await page.waitForFunction((id) => new URLSearchParams(location.hash.split('?')[1] || '').get('m') !== id, startId, { timeout: 4000 });
    assert.notEqual(await current(), startId, 'swipe left moved on');
    await swipe(page, [200, 300], [200, 700], 12);
    await page.waitForFunction(() => !new URLSearchParams(location.hash.split('?')[1] || '').get('m'), null, { timeout: 4000 });
    assert.equal(await page.locator('.lb').count(), 0, 'swipe down closed the viewer');
  });

  test('a plain vertical swipe on the grid still scrolls the page (no touch-action blocks it)', async (t) => {
    const { page } = await visit(t, { hash: '/explore' });
    const before = await page.evaluate(() => scrollY);
    await swipe(page, [200, 600], [200, 200]); // a plain vertical swipe on the grid scrolls the page
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => scrollY) > before, 'touch scrolling works on the grid');
  });

  test('offline: the pill shows and goes, text fields are 16px, the tab bar yields to the keyboard', async (t) => {
    const { page, ctx } = await visit(t);
    await ctx.setOffline(true);
    await page.locator('.offline-pill').waitFor({ timeout: 4000 });
    assert.match(await page.locator('.offline-pill').innerText(), /offline — showing saved/);
    await ctx.setOffline(false);
    await page.locator('.offline-pill').waitFor({ state: 'detached', timeout: 4000 });
    assert.equal(await page.locator('#global-search').evaluate((el) => getComputedStyle(el).fontSize), '16px', 'iOS will not zoom the page on focus');
    await page.locator('#global-search').focus();
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('typing')), true);
    assert.equal(await page.locator('.bottomnav').evaluate((el) => getComputedStyle(el).display), 'none', 'tab bar hidden while typing');
    await page.locator('#global-search').blur();
    await page.waitForTimeout(100);
    assert.notEqual(await page.locator('.bottomnav').evaluate((el) => getComputedStyle(el).display), 'none');
  });

  test('the phone menu offers Install when the browser allows it, and runs the browser prompt', async (t) => {
    const { page } = await visit(t);
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = () => { window.__prompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
    });
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /Install app/ }).click();
    await page.waitForFunction(() => window.__prompted === true, null, { timeout: 3000 });
    await page.getByRole('button', { name: 'More' }).click();
    assert.equal(await page.getByRole('button', { name: /Install app/ }).count(), 0, 'offered once: the prompt event is spent');
  });

  test('Reels: the top row fits a 360px screen (nothing cut off at the right) and the display dialog is sentence case', async (t) => {
    const { page } = await visit(t, { viewport: { width: 360, height: 740 }, hash: '/reels' });
    await page.locator('.reels-top').waitFor();
    const over = await page.evaluate(() => [...document.querySelectorAll('.reels-top > *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 0.5; }).map((e) => e.className));
    assert.deepEqual(over, [], `reels-top children past the right edge: ${over}`);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.reels-top .select').length && getComputedStyle(document.querySelector('.reels-top .select')).display), 'none', 'the duplicate order select is hidden at <=480px');
    await page.goto(`${base}/#/`);
    await page.getByRole('button', { name: 'Display settings' }).first().click();
    const tt = await page.locator('.display-row label.row').first().evaluate((el) => getComputedStyle(el).textTransform);
    assert.equal(tt, 'none');
  });

  test('every public tab fits a 360px screen without sideways scrolling', async (t) => {
    const { page } = await visit(t, { viewport: { width: 360, height: 740 } });
    for (const route of ['/', '/browse', '/creators', '/explore', '/reels', '/find', '/saved', '/following']) {
      await page.goto(`${base}/#${route}`); await page.waitForTimeout(700);
      assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth) <= 0, `${route} overflows`);
    }
  });
});

describe('installed app: service worker', { timeout: 120000 }, () => {
  test('with "Keep what I browse for offline use" on, the app starts offline from the worker (shell + the reads it already showed); off by default', async (t) => {
    const { page, ctx } = await visit(t, { serviceWorkers: 'allow', hash: '/' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // now controlled by the worker
    await page.locator('main .card').first().waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 5000 });
    const before = await page.evaluate(async () => (await caches.keys()).sort());
    assert.ok(before.some((k) => /^prism-shell-v\d+$/.test(k)), `shell cached: ${before}`);
    assert.ok(!before.includes('prism-api-v1') && !before.includes('prism-img-v1'), `no content cached by default: ${before}`);
    // the person switches it on (Display > "Keep what I browse for offline use"), then browses
    await page.evaluate(() => { localStorage.setItem('prism.offlineContent', JSON.stringify(true)); navigator.serviceWorker.controller.postMessage({ type: 'prism-offline-content', on: true }); });
    await page.reload();
    await page.locator('main .card').first().waitFor();
    await page.reload(); // second visit: the reads of the first are in the cache now
    await page.locator('main .card').first().waitFor();
    const caches = await page.evaluate(async () => (await caches.keys()).sort());
    assert.ok(caches.includes('prism-api-v1'), `caches: ${caches}`);
    await ctx.setOffline(true);
    await page.reload();
    await page.locator('.offline-pill').waitFor({ timeout: 8000 });
    await page.locator('main .card').first().waitFor({ timeout: 8000 });
    assert.ok(await page.locator('main .card').count() > 0, 'library shown from the saved reads');
    await ctx.setOffline(false);
  });
});
