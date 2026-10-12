'use strict';
/**
 * Front-end performance audit: load, feed scrolling and Reels, measured in Chromium.
 *
 *     DEMO_ART=1 DB_PATH=./data/demo.db node scripts/seed-demo.js
 *     DEMO_ART=1 DB_PATH=./data/demo.db ADMIN_KEY=dev PORT=3999 node server.js &
 *     NODE_PATH=$(npm root -g) node scripts/perf-audit.js http://localhost:3999 [runs] > perf.json
 *
 * Needs Playwright (not a dependency of the app: install it globally or with `npm i --no-save playwright`).
 * Conditions: phone viewport (390×844 @2x, touch), 4× CPU slowdown, and for the load test a
 * 150 ms RTT / 12 Mbps link. The GPU tier is reported as 'high' (the path real phones take), so
 * the effects the app trims on software rendering are included in what is measured.
 * Each scenario runs `runs` times (default 3) in a fresh context; the median is reported.
 */
const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:3999';
const RUNS = Number(process.argv[3] || 3);
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = (n, d = 1) => (n === null || n === undefined ? n : Math.round(n * 10 ** d) / 10 ** d);

// Report a hardware GPU so the app takes its normal ('high') rendering path in headless Chromium.
const FAKE_GPU = () => {
  const patch = (proto) => {
    const orig = proto.getParameter;
    proto.getParameter = function (p) { if (p === 0x9246) return 'ANGLE (Apple, Apple M1, OpenGL 4.1)'; return orig.call(this, p); };
  };
  try { patch(WebGLRenderingContext.prototype); } catch { /* ignore */ }
};

// Frame and long-task probes, installed before any app code runs.
const PROBES = () => {
  window.__perf = { longTasks: [], cls: 0, lcp: 0, fcp: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* ignore */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch { /* ignore */ }
  try { new PerformanceObserver((l) => { const e = l.getEntries(); window.__perf.lcp = e[e.length - 1].startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* ignore */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch { /* ignore */ }
  window.__frames = null;
  window.__recordFrames = () => { const f = []; window.__frames = f; let last = performance.now(); const tick = (t) => { if (window.__frames !== f) return; f.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); };
  window.__stopFrames = () => { const f = window.__frames || []; window.__frames = null; return f.slice(1); };
};

function frameStats(frames) {
  const total = frames.reduce((a, b) => a + b, 0);
  const s = [...frames].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))] || 0;
  // a frame "drops" when it takes longer than 1.5 vsyncs at 60 Hz
  const dropped = frames.reduce((n, f) => n + Math.max(0, Math.round(f / 16.67) - 1), 0);
  return { frames: frames.length, fps: round(frames.length / (total / 1000)), p50: round(p(0.5)), p95: round(p(0.95)), worst: round(s[s.length - 1] || 0), droppedPct: round((dropped / (frames.length + dropped)) * 100) };
}

/** Sum main-thread and raster work from a Chromium trace, in ms. */
function traceWork(buf) {
  const events = JSON.parse(buf.toString()).traceEvents || [];
  const sum = {};
  const names = { 'UpdateLayoutTree': 'style', 'Layout': 'layout', 'Paint': 'paint', 'PrePaint': 'paint', 'RasterTask': 'raster', 'Layerize': 'composite', 'UpdateLayer': 'composite', 'CompositeLayers': 'composite', 'FunctionCall': 'script', 'EvaluateScript': 'script', 'v8.compile': 'script', 'TimerFire': 'script', 'FireAnimationFrame': 'script', 'EventDispatch': 'script', 'Decode Image': 'decode', 'ImageDecodeTask': 'decode' };
  for (const e of events) {
    const k = names[e.name];
    if (!k || e.ph !== 'X' || typeof e.dur !== 'number') continue;
    sum[k] = (sum[k] || 0) + e.dur / 1000;
  }
  for (const k of Object.keys(sum)) sum[k] = round(sum[k]);
  return sum;
}

async function newPage(browser, { throttleNet = false } = {}) {
  const ctx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
  await ctx.addInitScript(FAKE_GPU);
  await ctx.addInitScript(PROBES);
  // pass the age gate without the dialog, as a returning visitor would
  await ctx.request.post(`${BASE}/api/age/confirm`).catch(() => {});
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (throttleNet) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (12 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 });
  }
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  return { ctx, page, cdp };
}

async function loadTest(browser, path) {
  const { ctx, page } = await newPage(browser, { throttleNet: true });
  const bytes = { script: 0, stylesheet: 0, image: 0, font: 0, media: 0, fetch: 0, document: 0, other: 0 };
  let requests = 0;
  page.on('requestfinished', async (req) => {
    requests++;
    try { const s = await req.sizes(); const t = req.resourceType(); const k = t === 'xhr' ? 'fetch' : (t in bytes ? t : 'other'); bytes[k] += s.responseBodySize + s.responseHeadersSize; } catch { /* ignore */ }
  });
  const t0 = Date.now();
  await page.goto(`${BASE}/${path}`, { waitUntil: 'load' });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(4000);
  const p = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const tbt = window.__perf.longTasks.reduce((a, t) => a + Math.max(0, t.dur - 50), 0);
    return { fcp: window.__perf.fcp, lcp: window.__perf.lcp, cls: window.__perf.cls, tbt, dcl: nav.domContentLoadedEventEnd, longTasks: window.__perf.longTasks.length, dom: document.getElementsByTagName('*').length };
  });
  await ctx.close();
  const kb = {}; for (const [k, v] of Object.entries(bytes)) kb[k] = round(v / 1024);
  return { fcp: round(p.fcp), lcp: round(p.lcp), dcl: round(p.dcl), load: loadMs, tbt: round(p.tbt), cls: round(p.cls, 3), requests, kb, totalKb: round(Object.values(bytes).reduce((a, b) => a + b, 0) / 1024), domNodes: p.dom };
}

async function feedScroll(browser) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/#/explore`, { waitUntil: 'load' });
  await page.waitForSelector('.card img');
  // Page in the whole feed first (a long session), then measure from the top.
  for (let i = 0; i < 60; i++) {
    const end = await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); return /reached the end/.test(document.querySelector('.loadmore').textContent); });
    if (end) break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(2500);
  // Idle cost: an untouched feed should not keep repainting.
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  await page.waitForTimeout(3000);
  const idle = traceWork(await browser.stopTracing());
  await page.evaluate(() => window.__perf.longTasks.splice(0));
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  await page.evaluate(() => window.__recordFrames());
  // Steady fling through the whole feed at 2000 px/s, scripted frame by frame.
  await page.evaluate(() => new Promise((resolve) => {
    const y0 = window.scrollY; const dist = document.documentElement.scrollHeight - innerHeight - y0; const ms = dist / 2; const start = performance.now();
    const step = (t) => { const k = Math.min(1, (t - start) / ms); window.scrollTo(0, y0 + dist * k); if (k < 1) requestAnimationFrame(step); else resolve(); };
    requestAnimationFrame(step);
  }));
  const frames = await page.evaluate(() => window.__stopFrames());
  const work = traceWork(await browser.stopTracing());
  const lt = await page.evaluate(() => ({ n: window.__perf.longTasks.length, total: window.__perf.longTasks.reduce((a, t) => a + t.dur, 0), dom: document.getElementsByTagName('*').length, cards: document.querySelectorAll('.card').length, y: window.scrollY }));
  await ctx.close();
  return { ...frameStats(frames), longTasks: lt.n, longTaskMs: round(lt.total), work, idleWork3s: idle, domNodes: lt.dom, cards: lt.cards, scrolledTo: Math.round(lt.y) };
}

async function reelsTest(browser) {
  const { ctx, page } = await newPage(browser);
  let videoBytes = 0; let videoReqs = 0;
  page.on('requestfinished', async (req) => { if (req.resourceType() === 'media' || /\.webm|\.mp4|\/api\/(proxy|hls)/.test(req.url())) { videoReqs++; try { videoBytes += (await req.sizes()).responseBodySize; } catch { /* ignore */ } } });
  const t0 = Date.now();
  await page.goto(`${BASE}/#/reels`, { waitUntil: 'load' });
  await page.waitForFunction(() => { const v = [...document.querySelectorAll('.reel video')].find((x) => !x.paused && x.readyState >= 3); return !!v; }, null, { timeout: 20000 });
  const firstPlay = Date.now() - t0;
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__perf.longTasks.splice(0));
  const swipes = [];
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  await page.evaluate(() => window.__recordFrames());
  for (let i = 0; i < 8; i++) {
    // time from the swipe to the next video presenting frames
    const ms = await page.evaluate(() => new Promise((resolve) => {
      const track = document.querySelector('.reels-track');
      const cur = Math.round(track.scrollTop / track.clientHeight);
      const next = track.children[cur + 1];
      if (!next) { resolve(null); return; }
      const t = performance.now();
      const done = () => resolve(performance.now() - t);
      const check = () => {
        const v = next.querySelector('video');
        if (v && !v.paused && v.readyState >= 3 && v.currentTime > 0) { if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(done); else done(); return; }
        if (performance.now() - t > 8000) { resolve(8000); return; }
        requestAnimationFrame(check);
      };
      track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      requestAnimationFrame(check);
    }));
    swipes.push(ms);
    await page.waitForTimeout(900);
  }
  const frames = await page.evaluate(() => window.__stopFrames());
  const work = traceWork(await browser.stopTracing());
  const lt = await page.evaluate(() => ({ n: window.__perf.longTasks.length, total: window.__perf.longTasks.reduce((a, t) => a + t.dur, 0), videos: document.querySelectorAll('.reel video').length, withSrc: [...document.querySelectorAll('.reel video')].filter((v) => v.currentSrc).length }));
  await ctx.close();
  const ok = swipes.filter((x) => x !== null);
  return { firstPlay, swipeToPlayMedian: round(median(ok)), swipeToPlayWorst: round(Math.max(...ok)), ...frameStats(frames), longTasks: lt.n, longTaskMs: round(lt.total), work, videoRequests: videoReqs, videoKb: round(videoBytes / 1024), videoElements: lt.videos, videosWithSource: lt.withSrc };
}

function medianOf(results) {
  const out = {};
  for (const k of Object.keys(results[0])) {
    const v = results[0][k];
    if (typeof v === 'number') out[k] = median(results.map((r) => r[k]));
    else if (v && typeof v === 'object') out[k] = medianOf(results.map((r) => r[k] || {}));
    else out[k] = v;
  }
  return out;
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-gpu-rasterization'] });
  const runs = { loadHome: [], loadExplore: [], loadReels: [], feed: [], reels: [] };
  for (let i = 0; i < RUNS; i++) {
    runs.loadHome.push(await loadTest(browser, '#/'));
    runs.loadExplore.push(await loadTest(browser, '#/explore'));
    runs.loadReels.push(await loadTest(browser, '#/reels'));
    runs.feed.push(await feedScroll(browser));
    runs.reels.push(await reelsTest(browser));
    console.error(`run ${i + 1}/${RUNS} done`);
  }
  await browser.close();
  const out = {};
  for (const [k, v] of Object.entries(runs)) out[k] = medianOf(v);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
