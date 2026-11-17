'use strict';
/**
 * Wave 13 (Velocity): the first frame of a poster-less video costs a frame, not a clip.
 * A grid tile loads its clip with preload=metadata, copies the first decoded frame onto a small <canvas> and RELEASES the
 * <video> (which cancels the download and frees the decoder). Measured before the change on 100 poster-less clips
 * (1.9-2.3 MB each): 0.7-2.2 MB fetched per tile, ~7 range requests per tile, up to 40 live <video> elements and +450 MB of
 * browser memory over one long scroll. This file pins the behaviour in a real browser, with a real (tiny) WebM.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('source contracts', () => {
  const card = read('public', 'js', 'components', 'card.js');
  test('the frame is copied to a canvas and the video is released; nothing reads the pixels back', () => {
    assert.match(card, /drawImage\(v, 0, 0, c\.width, c\.height\)/);
    assert.match(card, /v\.removeAttribute\('src'\); try \{ v\.load\(\); \}/, 'removing the src cancels the transfer');
    assert.doesNotMatch(card, /getImageData\(|toDataURL\(|toBlob\(/, 'a cross-origin (bucket) frame can be drawn but never read');
  });
  test('at most three clips load at once, with a timeout, and a far tile gives its canvas back', () => {
    assert.match(card, /const FF_PARALLEL = 3; const FF_TIMEOUT_MS = 8000;/);
    assert.match(card, /ffLoading < FF_PARALLEL/);
    assert.match(card, /function dropFirstFrame\(media\)/);
    assert.match(card, /if \(media\._ff && media\._ffState\) \{ dropFirstFrame\(media\); if \(firstFrameIo\) firstFrameIo\.observe\(media\); \}/, 'the relief observer releases it and re-arms the mount');
    assert.match(card, /if \(media\._ff\) \{ if \(firstFrameIo\) firstFrameIo\.unobserve\(media\); dropFirstFrame\(media\); \}/, 'a released card cancels it');
    assert.match(card, /if \(reliefIo\) reliefIo\.observe\(media\); if \(firstFrameIo\)/, 'first-frame tiles are watched by the relief observer');
  });
  test('the canvas is laid out like the picture it replaces', () => {
    assert.match(read('public', 'css', 'app.css'), /\.card-media img, \.card-media video, \.card-media canvas\.card-ff \{ position: absolute;/);
  });
});

let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const exe = (() => { try { return pw && pw.chromium.executablePath(); } catch { return ''; } })();
const haveBrowser = !!(pw && exe && fs.existsSync(exe));

describe('browser: first frames in the grid', { skip: haveBrowser ? false : 'Playwright Chromium not installed' }, () => {
  const CLIP = fs.readFileSync(path.join(__dirname, 'fixtures', 'first-frame.webm'));
  let server; let base; let browser; let engine; let ids;

  before(async () => {
    delete process.env.DIRECT_MEDIA;
    const dir = prepareEnv({ DEMO_ART: '1', AGE_GATE_ENFORCE: 'false' });
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: { ...process.env, DB_PATH: path.join(dir, 'test.db') }, stdio: 'ignore' });
    const repo = require('../src/db/repo');
    // every video becomes a poster-less one on an external host; the first two clips are broken (404)
    ids = repo.db.prepare("SELECT id FROM media WHERE media_type = 'video' ORDER BY id").all().map((r) => r.id);
    const upd = repo.db.prepare("UPDATE media SET media_url = ?, preview_url = NULL, thumbnail_url = NULL, thumb_url = NULL, hls_url = NULL, width = 144, height = 256 WHERE id = ?");
    ids.forEach((id, i) => upd.run(`https://clips.example.test/${i < 2 ? 'broken' : 'ok'}/${id}.webm`, id));
    repo.db.prepare('INSERT OR IGNORE INTO media_hosts (host) VALUES (?)').run('clips.example.test');
    engine = require('../src/engine/engine');
    server = require('../src/app').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await pw.chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); engine.shutdown(); await new Promise((r) => server.close(r)); });

  async function openExplore(width = 390) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    await ctx.addCookies([{ name: 'prism_age', value: '1', url: base }]);
    await ctx.addInitScript(() => { // grid videos that hold a source at the same moment (the first-frame loader keeps its <video> detached, so count by src)
      window.__maxLoading = 0; const live = new Set(); const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src'); const ra = HTMLMediaElement.prototype.removeAttribute;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...d, set(v) { if (v && !this.closest('.reel, .lightbox, .lb-stage')) { live.add(this); window.__maxLoading = Math.max(window.__maxLoading, live.size); } d.set.call(this, v); } });
      HTMLMediaElement.prototype.removeAttribute = function (n) { if (n === 'src') live.delete(this); return ra.call(this, n); };
    });
    const page = await ctx.newPage();
    const seen = { requests: 0, clips: new Set(), maxInFlight: 0, csp: 0, errors: 0 }; const active = new Map(); // clip id -> requests in flight (one clip makes several range requests)
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) seen.csp++; });
    page.on('pageerror', () => { seen.errors++; });
    await page.route('**/api/proxy**', async (route) => {
      const u = decodeURIComponent(new URL(route.request().url()).searchParams.get('url') || '');
      if (!/clips\.example\.test/.test(u)) return route.fulfill({ status: 404, body: 'x' });
      const id = (/[0-9a-f-]{36}/.exec(u) || [u])[0]; seen.requests++; seen.clips.add(id);
      active.set(id, (active.get(id) || 0) + 1); seen.maxInFlight = Math.max(seen.maxInFlight, active.size);
      await new Promise((r) => setTimeout(r, 220)); // a slow origin, so loads overlap
      if (active.get(id) === 1) active.delete(id); else active.set(id, active.get(id) - 1);
      if (/\/broken\//.test(u)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Upstream error"}' });
      const m = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers().range || ''); // a media element seeks with Range requests
      if (m && (m[1] || m[2])) {
        const start = m[1] === '' ? Math.max(0, CLIP.length - Number(m[2])) : Number(m[1]); const end = m[1] === '' || m[2] === '' ? CLIP.length - 1 : Math.min(Number(m[2]), CLIP.length - 1);
        return route.fulfill({ status: 206, contentType: 'video/webm', body: CLIP.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${CLIP.length}` } });
      }
      return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'accept-ranges': 'bytes' } });
    });
    await page.goto(`${base}/#/explore`, { waitUntil: 'networkidle' });
    await page.waitForSelector('article.card', { timeout: 15000 });
    return { ctx, page, seen };
  }
  const state = (page) => page.evaluate(() => {
    const frames = [...document.querySelectorAll('canvas.card-ff')].map((c) => {
      let lum = -1; try { const t = document.createElement('canvas'); t.width = 8; t.height = 8; const g = t.getContext('2d'); g.drawImage(c, 0, 0, 8, 8); const d = g.getImageData(0, 0, 8, 8).data; let x = 0; for (let i = 0; i < d.length; i += 4) x += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; lum = Math.round(x / 64); } catch { lum = -1; }
      const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, lum, top: Math.round(r.top) };
    });
    return { frames, videos: document.querySelectorAll('.card-media video').length, ffVideos: document.querySelectorAll('video.card-ff').length };
  });

  test('a poster-less video shows its first frame on a canvas, and no <video> stays mounted in the grid', async () => {
    const { ctx, page, seen } = await openExplore();
    try {
      await page.waitForFunction(() => document.querySelectorAll('canvas.card-ff').length >= 3, null, { timeout: 15000 });
      await page.waitForTimeout(600);
      const s = await state(page);
      assert.ok(s.frames.length >= 3, `frames painted (${s.frames.length})`);
      assert.ok(s.frames.every((f) => f.w > 0 && f.h > 0), 'every canvas has a size');
      assert.ok(s.frames.every((f) => f.lum > 20), `the frame is the clip's bright first frame, not black (${s.frames.map((f) => f.lum)})`);
      assert.equal(s.videos, 0, 'the <video> that loaded each frame was released (no decoder, no download left running)');
      assert.equal(seen.csp, 0); assert.equal(seen.errors, 0);
    } finally { await ctx.close(); }
  });

  test('at most three clips load at once (a fast scroll that brings many tiles in does not open them all)', async () => {
    const { ctx, page, seen } = await openExplore();
    try {
      await page.waitForFunction(() => document.querySelectorAll('canvas.card-ff').length >= 3, null, { timeout: 15000 });
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 900); // many tiles enter the mount margin at once
      await page.waitForTimeout(5000);
      assert.ok(seen.clips.size >= 6, `many clips were requested (${seen.clips.size})`);
      const maxLoading = await page.evaluate(() => window.__maxLoading);
      assert.equal(maxLoading, 3, `the limit is reached and never exceeded (saw ${maxLoading} grid videos holding a source at once)`);
    } finally { await ctx.close(); }
  });

  test('a browser that decodes no frame for a detached video gets the <video> mounted in the tile instead (iOS Safari safety net)', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await ctx.addCookies([{ name: 'prism_age', value: '1', url: base }]);
    await ctx.addInitScript(() => { // such a browser: a detached element never reports loadeddata
      const add = HTMLMediaElement.prototype.addEventListener;
      HTMLMediaElement.prototype.addEventListener = function (type, ...rest) { if (type === 'loadeddata' && !this.isConnected) return undefined; return add.call(this, type, ...rest); };
    });
    const page = await ctx.newPage();
    await page.route('**/api/proxy**', (route) => {
      const m = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers().range || '');
      if (m && (m[1] || m[2])) { const start = Number(m[1] || 0); const end = m[2] ? Math.min(Number(m[2]), CLIP.length - 1) : CLIP.length - 1; return route.fulfill({ status: 206, contentType: 'video/webm', body: CLIP.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${CLIP.length}` } }); }
      return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'accept-ranges': 'bytes' } });
    });
    try {
      await page.goto(`${base}/#/explore`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.querySelectorAll('.card-media video.card-ff').length >= 1, null, { timeout: 15000 });
      const s = await state(page);
      assert.equal(s.frames.length, 0, 'no canvas: the browser decoded nothing for the detached element');
      assert.ok(s.ffVideos >= 1, 'the clip is mounted in the tile, so the browser paints its first frame itself');
      const shown = await page.evaluate(() => { const v = document.querySelector('.card-media video.card-ff'); return v ? { ready: v.readyState, t: +v.currentTime.toFixed(2) } : null; });
      assert.ok(shown && shown.ready >= 2, `and it has a frame (${JSON.stringify(shown)})`);
    } finally { await ctx.close(); }
  });

  test('a clip that fails keeps the tinted placeholder and the Video pill: no canvas, no video, no error', async () => {
    const { ctx, page, seen } = await openExplore();
    try {
      await page.waitForTimeout(2500);
      const broken = await page.evaluate((id) => { const c = document.querySelector(`article.card[data-id="${id}"]`); if (!c) return null; const m = c.querySelector('.card-media'); return { canvas: !!m.querySelector('canvas.card-ff'), video: !!m.querySelector('video'), ph: !!m.querySelector('.ph'), pill: !!m.querySelector('.pill') }; }, ids[0]);
      if (broken) assert.deepEqual(broken, { canvas: false, video: false, ph: true, pill: true });
      assert.equal(seen.errors, 0);
    } finally { await ctx.close(); }
  });

  test('a long scroll gives far tiles\' canvases back, and scrolling back paints them again', async () => {
    const { ctx, page } = await openExplore(390);
    try {
      await page.waitForFunction(() => document.querySelectorAll('canvas.card-ff').length >= 3, null, { timeout: 15000 });
      const painted = new Set(); // every tile that ever showed a frame
      const note = async () => { for (const id of await page.evaluate(() => [...document.querySelectorAll('article.card')].filter((c) => c.querySelector('canvas.card-ff')).map((c) => c.dataset.id))) painted.add(id); };
      for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(150); await note(); }
      await page.waitForTimeout(1500); await note();
      const bottom = await state(page);
      const alive = await page.evaluate(() => document.querySelectorAll('canvas.card-ff').length);
      assert.ok(painted.size >= 14, `many tiles were painted during the scroll (${painted.size})`);
      assert.ok(painted.size - alive >= 6, `canvases of tiles that scrolled far away were given back (${painted.size} painted, ${alive} alive)`);
      assert.equal(bottom.videos, 0, 'no <video> left over after the scroll');
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(2500);
      const top = await state(page);
      assert.ok(top.frames.length >= 3, `scrolling back mounts the tiles again (${top.frames.length})`);
    } finally { await ctx.close(); }
  });
});
