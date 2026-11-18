'use strict';
/**
 * Wave 14: a post whose full-size file is gone still shows its best remaining still.
 * Reproduced from prod: a Reddit post whose i.redd.it original answers 404 with a 130x60 "not found" PNG while its
 * cf.preview.redd.it preview (stored as preview_url) loads fine. The viewer used to replace the working preview with
 * "This image is no longer available at its source." (and Reels the same). Now the file is an upgrade over the stills:
 * when it fails (error, 404, the stub) the preview stays, with a small "Preview quality" hint in the viewer, and the
 * message is for a post where every candidate failed.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { prepareEnv } = require('./helpers/mock');

const JS = path.join(__dirname, '..', 'public', 'js');

describe('fallbackStills: the order to fall back through', () => {
  let img;
  before(async () => { img = await import(pathToFileURL(path.join(JS, 'images.js')).href); });
  const it = { media_type: 'image', media_url: 'https://i.redd.it/a.jpg', preview_url: 'https://cf.preview.redd.it/a.jpg?width=640&s=x', thumbnail_url: 'https://b.thumbs.redditmedia.com/t.jpg', thumb_url: '/s/t.webp' };
  test('best still first, our thumbnail next, the file last; duplicates and gaps removed', () => {
    assert.deepEqual(img.fallbackStills(it), [it.preview_url, it.thumbnail_url, it.thumb_url, it.media_url]);
    assert.deepEqual(img.fallbackStills({ ...it, preview_url: null, thumbnail_url: it.preview_url }), [it.preview_url, it.thumb_url, it.media_url]);
    assert.deepEqual(img.fallbackStills({ ...it, thumb_url: null, thumbnail_url: null }), [it.preview_url, it.media_url]);
    assert.deepEqual(img.fallbackStills({ ...it, preview_url: it.media_url }), [it.media_url, it.thumbnail_url, it.thumb_url]);
    assert.deepEqual(img.fallbackStills({ ...it, media_type: 'video' }), [it.preview_url, it.thumbnail_url, it.thumb_url], 'a video file is not a still');
    assert.deepEqual(img.fallbackStills(null), []);
  });
  test('fallback_url (the stored full-size rendition) comes before the preview; a duplicate of the file is dropped; videos ignore it', () => {
    const full = 'https://preview.redd.it/a.jpeg?auto=webp&s=full';
    assert.deepEqual(img.fallbackStills({ ...it, fallback_url: full }), [full, it.preview_url, it.thumbnail_url, it.thumb_url, it.media_url]);
    assert.deepEqual(img.fallbackStills({ ...it, fallback_url: it.media_url }), [it.media_url, it.preview_url, it.thumbnail_url, it.thumb_url], 'same URL as the file: once');
    assert.deepEqual(img.fallbackStills({ ...it, fallback_url: null }), img.fallbackStills(it));
    assert.ok(!img.stillChain({ media_type: 'video', media_url: 'https://x/v.mp4', fallback_url: full }).includes(full), 'no still for a video from a rendition field');
  });
  test('a grid tile whose small stills are all dead tries the full-size rendition before the file', () => {
    const full = 'https://preview.redd.it/a.jpeg?auto=webp&s=full';
    assert.deepEqual(img.stillChain({ ...it, fallback_url: full }), [it.thumb_url, it.preview_url, it.thumbnail_url, full, it.media_url]);
    assert.deepEqual(img.stillChain(it), [it.thumb_url, it.preview_url, it.thumbnail_url, it.media_url], 'without it nothing changes');
  });
  test('a signed preview URL is used exactly as stored, never rewritten to another width', () => {
    assert.equal(img.fallbackStills(it)[0], it.preview_url);
  });
  test('coomer profile banners and icons are not stills', () => {
    const banner = 'https://img.coomer.st/banners/onlyfans/bigggwild';
    const icon = 'https://img.coomer.st/icons/onlyfans/bigggwild';
    const real = 'https://img.coomer.st/thumbnail/data/ab/cd/x.jpg';
    assert.equal(img.isProfileChromeUrl(banner), true);
    assert.equal(img.isProfileChromeUrl(icon), true);
    assert.equal(img.isProfileChromeUrl(real), false);
    assert.deepEqual(img.stillChain({ ...it, preview_url: banner, thumbnail_url: icon, thumb_url: null, media_type: 'video' }), []);
    assert.deepEqual(img.stillChain({ ...it, preview_url: banner, thumbnail_url: real, thumb_url: null }), [real, it.media_url]);
    assert.deepEqual(img.cardImage({ ...it, preview_url: banner, thumb_url: null, media_type: 'video' }, { proxy: (u) => u, isVideo: true }), { src: null, fallback: null });
  });
});

describe('source contracts', () => {
  const read = (...p) => fs.readFileSync(path.join(JS, ...p), 'utf8');
  test('the viewer and Reels load the file as an upgrade, and step through every still before giving up', () => {
    for (const f of [['components', 'lightbox.js'], ['views', 'reels.js']]) {
      const s = read(...f);
      assert.match(s, /fallbackStills\(/, f.join('/'));
      assert.match(s, /loadImage\(/, `${f.join('/')}: the file loads through the shared loader (error and stub are both failures)`);
      assert.match(s, /failed\.add\(/, `${f.join('/')}: a failed candidate is remembered`);
      assert.doesNotMatch(s, /full\.onload = \(\) =>/, `${f.join('/')}: no bare Image() whose stub counts as success`);
    }
    assert.match(read('dom.js'), /isMissingStub\(src, im\.naturalWidth, im\.naturalHeight\)\) fail\(\)/, 'the stub is a failure in loadImage');
  });
});

let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const exe = (() => { try { return pw && pw.chromium.executablePath(); } catch { return ''; } })();
const haveBrowser = !!(pw && exe && fs.existsSync(exe));

function png(w, h, shade) { // a grey picture of the given size
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, shade)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('browser: the file is gone, the preview stays', { skip: haveBrowser ? false : 'Playwright Chromium not installed' }, () => {
  const PREVIEW = png(200, 300, 150); const FULL = png(400, 600, 120); const STUB = png(130, 60, 200); const THUMB = png(120, 180, 90);
  let server; let base; let browser; let engine; let repo; let ids;

  before(async () => {
    delete process.env.DIRECT_MEDIA;
    const dir = prepareEnv({ DEMO_ART: '1', AGE_GATE_ENFORCE: 'false' });
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: { ...process.env, DB_PATH: path.join(dir, 'test.db') }, stdio: 'ignore' });
    repo = require('../src/db/repo');
    if (!repo.db.prepare('PRAGMA table_info(media)').all().some((c) => c.name === 'fallback_url')) repo.db.exec('ALTER TABLE media ADD COLUMN fallback_url TEXT'); // migration v39 (w14-ingest-halyard) adds it for real
    ids = repo.db.prepare("SELECT id FROM media WHERE media_type = 'image' ORDER BY id").all().map((r) => r.id);
    engine = require('../src/engine/engine');
    server = require('../src/app').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await pw.chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); engine.shutdown(); await new Promise((r) => server.close(r)); });

  /** What every picture host answers: i.redd.it/<id>-stub.jpg = the 404 + 130x60 PNG; -gone = plain 404; preview = 200 (or 404 for -nopreview). */
  async function newPage(width = 390, theme = 'dark') {
    const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 800 : 844 }, serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('prism.theme', JSON.stringify(t)); } catch { /* ignore */ } }, theme);
    await ctx.addCookies([{ name: 'prism_age', value: '1', url: base }]);
    const page = await ctx.newPage();
    const seen = { broken: 0, csp: 0 };
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) seen.csp++; });
    page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/media\/[^/]+\/broken/.test(r.url())) seen.broken++; });
    await page.route(/^https:\/\/(i\.redd\.it|cf\.preview\.redd\.it|preview\.redd\.it)\//, (r) => {
      const u = r.request().url();
      if (/i\.redd\.it\/.*-stub/.test(u)) return r.fulfill({ status: 404, contentType: 'image/png', body: STUB });
      if (/i\.redd\.it/.test(u)) return r.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
      if (/nopreview/.test(u)) return r.fulfill({ status: 403, contentType: 'text/html', body: '<html>no</html>' });
      return r.fulfill({ status: 200, contentType: 'image/png', body: /-full/.test(u) ? FULL : PREVIEW });
    });
    await page.route('**/api/proxy**', (r) => { // the proxy's own answer for the same hosts: the 404 as JSON, previews fine
      const u = decodeURIComponent(new URL(r.request().url()).searchParams.get('url') || '');
      if (/i\.redd\.it/.test(u) || /nopreview/.test(u)) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Upstream error"}' });
      if (/thumb-ok/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: THUMB });
      if (/-full/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: FULL });
      return r.fulfill({ status: 200, contentType: 'image/png', body: PREVIEW });
    });
    return { ctx, page, seen };
  }
  const setItem = (id, fields) => { const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', '); repo.db.prepare(`UPDATE media SET ${sets} WHERE id = @id`).run({ id, ...fields }); };
  /** Wait for the viewer to show a picture or the message, then give the full-file attempt (after a 700 ms dwell) time to finish. */
  const settle = async (page, { hint = false } = {}) => {
    await page.waitForFunction(() => { const i = document.querySelector('.lb-stage img'); return (i && i.complete && i.naturalWidth > 0) || document.querySelector('.lb-stage .lb-loading'); }, null, { timeout: 40000 });
    if (hint) await page.waitForSelector('.lb-quality', { timeout: 40000 });
    else await page.waitForTimeout(2200);
  };
  const viewer = (page) => page.evaluate(() => { const i = document.querySelector('.lb-stage img'); return { img: i ? { ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth } : null, gone: !!document.querySelector('.lb-stage .lb-loading'), hint: (document.querySelector('.lb-quality') || {}).textContent || null }; });

  test('viewer: the original is the host\'s 404 stub, the preview loads: the preview stays, with the hint, and nothing is reported broken', async () => {
    const id = ids[0];
    setItem(id, { media_url: `https://i.redd.it/${id}-stub.jpg`, preview_url: `https://cf.preview.redd.it/${id}.jpeg?width=640&s=abc`, thumbnail_url: null, thumb_url: null });
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/explore?m=${id}`, { waitUntil: 'networkidle' });
      await settle(page, { hint: true }); // the full file is tried after a 700 ms dwell, fails, and the hint appears
      const v = await viewer(page);
      assert.deepEqual(v.img, { ok: true, w: 200 }, `the preview is on screen (${JSON.stringify(v)})`);
      assert.equal(v.gone, false, 'no "no longer available"');
      assert.equal(v.hint, 'Preview quality', 'a small hint says this is the best copy left');
      assert.equal(seen.broken, 0, 'the post is not reported broken');
      assert.equal(seen.csp, 0);
      if (process.env.W14_SHOTS) await page.screenshot({ path: path.join(process.env.W14_SHOTS, 'viewer-390-dark.png') });
    } finally { await ctx.close(); }
  });

  test('viewer shots (optional: W14_SHOTS=dir)', { skip: !process.env.W14_SHOTS }, async () => {
    const id = ids[0];
    for (const [w, theme] of [[360, 'light'], [1280, 'dark'], [1280, 'light']]) {
      const { ctx, page } = await newPage(w, theme);
      try { await page.goto(`${base}/#/explore?m=${id}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(2600); await page.screenshot({ path: path.join(process.env.W14_SHOTS, `viewer-${w}-${theme}.png`) }); } finally { await ctx.close(); }
    }
  });

  test('viewer: the original is a plain 404 and there is only our thumbnail: the thumbnail stays', async () => {
    const id = ids[1];
    setItem(id, { media_url: `https://i.redd.it/${id}-gone.jpg`, preview_url: null, thumbnail_url: null, thumb_url: `https://cdn.example.test/${id}/thumb-ok.png` });
    repo.db.prepare('INSERT OR IGNORE INTO media_hosts (host) VALUES (?)').run('cdn.example.test');
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/explore?m=${id}`, { waitUntil: 'networkidle' });
      await settle(page);
      const v = await viewer(page);
      assert.equal(v.gone, false, JSON.stringify(v));
      assert.deepEqual(v.img, { ok: true, w: 120 }, 'our thumbnail is on screen');
      assert.equal(seen.broken, 0);
    } finally { await ctx.close(); }
  });

  test('viewer: the preview fails and the original is the stub: every candidate failed, so the message is shown and the post is reported', async () => {
    const id = ids[2];
    setItem(id, { media_url: `https://i.redd.it/${id}-stub.jpg`, preview_url: `https://cf.preview.redd.it/${id}-nopreview.jpeg?width=640&s=abc`, thumbnail_url: null, thumb_url: null });
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/explore?m=${id}`, { waitUntil: 'networkidle' });
      await settle(page);
      const v = await viewer(page);
      assert.equal(v.gone, true, `the message appears only now (${JSON.stringify(v)})`);
      assert.equal(seen.broken, 1, 'reported exactly once');
    } finally { await ctx.close(); }
  });

  test('viewer: the preview fails but the original works: the original is shown', async () => {
    const id = ids[3];
    setItem(id, { media_url: `https://cdn.example.test/${id}/full.png`, preview_url: `https://cf.preview.redd.it/${id}-nopreview.jpeg?width=640&s=abc`, thumbnail_url: null, thumb_url: null });
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/explore?m=${id}`, { waitUntil: 'networkidle' });
      await settle(page);
      const v = await viewer(page);
      assert.equal(v.gone, false, JSON.stringify(v));
      assert.equal(v.img && v.img.ok, true);
      assert.equal(seen.broken, 0);
    } finally { await ctx.close(); }
  });

  test('viewer: the original is the stub and fallback_url is stored: the full-size rendition is shown (not the small preview), no hint, not reported', async () => {
    const id = ids[4];
    setItem(id, { media_url: `https://i.redd.it/${id}-stub.jpg`, preview_url: `https://cf.preview.redd.it/${id}.jpeg?width=640&s=abc`, fallback_url: `https://preview.redd.it/${id}-full.jpeg?auto=webp&s=full`, thumbnail_url: null, thumb_url: null });
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/explore?m=${id}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => { const i = document.querySelector('.lb-stage img'); return i && i.complete && i.naturalWidth === 400; }, null, { timeout: 40000 });
      const v = await viewer(page);
      assert.equal(v.hint, null, 'nothing to apologise for: this is the full-size picture');
      assert.equal(v.gone, false);
      assert.equal(seen.broken, 0);
    } finally { await ctx.close(); }
  });

  test('viewer: the original is the stub and the stored rendition is dead too: the preview stays, with the hint', async () => {
    const id = ids[5];
    setItem(id, { media_url: `https://i.redd.it/${id}-stub.jpg`, preview_url: `https://cf.preview.redd.it/${id}.jpeg?width=640&s=abc`, fallback_url: `https://preview.redd.it/${id}-nopreview-full.jpeg?s=z`, thumbnail_url: null, thumb_url: null });
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/explore?m=${id}`, { waitUntil: 'networkidle' });
      await settle(page, { hint: true });
      const v = await viewer(page);
      assert.deepEqual(v.img, { ok: true, w: 200 });
      assert.equal(v.hint, 'Preview quality');
      assert.equal(seen.broken, 0);
    } finally { await ctx.close(); }
  });

  test('the public API passes fallback_url to the client (http/https only)', async () => {
    const id = ids[6]; const good = 'https://preview.redd.it/x.jpeg?auto=webp&s=abc';
    setItem(id, { fallback_url: good });
    const get = async (i) => (await fetch(`${base}/api/media/${i}`, { headers: { cookie: 'prism_age=1' } })).json();
    assert.equal((await get(id)).fallback_url, good);
    setItem(id, { fallback_url: 'javascript:alert(1)' });
    assert.equal((await get(id)).fallback_url, null, 'a non-http URL is dropped');
    setItem(id, { fallback_url: null });
    assert.equal((await get(id)).fallback_url, null);
  });

  test('grid: the tile shows the preview when the original is the stub, and is not reported broken', async () => {
    const id = ids[0];
    setItem(id, { posted_at: new Date().toISOString() }); // newest first: it is in the first screen of Explore
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/explore`, { waitUntil: 'networkidle' });
      await page.waitForFunction((i) => { const c = document.querySelector(`article.card[data-id="${i}"] .card-media img`); return c && c.complete && c.naturalWidth > 0; }, id, { timeout: 40000 });
      const tile = await page.evaluate((i) => { const c = document.querySelector(`article.card[data-id="${i}"] .card-media img`); return c ? { ok: c.complete && c.naturalWidth > 0, w: c.naturalWidth } : null; }, id);
      assert.deepEqual(tile, { ok: true, w: 200 });
      await page.waitForTimeout(800);
      assert.equal(seen.broken, 0, 'no tile reported broken');
    } finally { await ctx.close(); }
  });

  test('Reels: a photo whose original is the stub keeps its preview (no "no longer available" slide)', async () => {
    for (const id of ids) setItem(id, { media_url: `https://i.redd.it/${id}-stub.jpg`, preview_url: `https://cf.preview.redd.it/${id}.jpeg?width=640&s=abc`, thumbnail_url: null, thumb_url: null });
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/reels?type=image`, { waitUntil: 'networkidle' }); // Reels defaults to videos; this is its Photos filter
      const seenWidths = new Set(); let gone = 0; let photos = 0;
      const look = () => page.evaluate(() => { const im = [...document.querySelectorAll('.reel img')].filter((x) => /api\/proxy|redd\.it/.test(x.getAttribute('src') || '')).find((x) => { const r = x.getBoundingClientRect(); return r.top > -40 && r.top < innerHeight / 2; }); return { photo: !!im, w: im && im.complete ? im.naturalWidth : null, gone: document.querySelectorAll('.reel-gone').length }; });
      for (let i = 0; i < 12 && photos < 4; i++) {
        await page.waitForTimeout(350);
        let s = await look();
        if (s.photo) { photos++; await page.waitForTimeout(1500); s = await look(); if (s.w) seenWidths.add(s.w); }
        gone = Math.max(gone, s.gone);
        await page.keyboard.press('ArrowDown');
      }
      assert.ok(photos >= 3, `photo slides were reached (${photos})`);
      assert.ok(seenWidths.has(200), `photo slides show the preview (${[...seenWidths]})`);
      assert.equal(gone, 0, 'no slide says "no longer available"');
      assert.equal(seen.broken, 0, 'nothing reported broken');
    } finally { await ctx.close(); }
  });

  test('Reels: with fallback_url stored, a photo whose original is the stub shows the full-size rendition', async () => {
    for (const id of ids) setItem(id, { media_url: `https://i.redd.it/${id}-stub.jpg`, preview_url: `https://cf.preview.redd.it/${id}.jpeg?width=640&s=abc`, fallback_url: `https://preview.redd.it/${id}-full.jpeg?s=full`, thumbnail_url: null, thumb_url: null });
    const { ctx, page, seen } = await newPage();
    try {
      await page.goto(`${base}/#/reels?type=image`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => [...document.querySelectorAll('.reel img')].some((x) => /api\/proxy|redd\.it/.test(x.getAttribute('src') || '') && x.complete && x.naturalWidth === 400), null, { timeout: 40000 });
      assert.equal(await page.evaluate(() => document.querySelectorAll('.reel-gone').length), 0);
      assert.equal(seen.broken, 0);
    } finally { await ctx.close(); }
  });
});
