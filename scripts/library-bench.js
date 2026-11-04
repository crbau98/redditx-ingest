'use strict';
/**
 * Event-loop stall while the library snapshot is built, measured against a COPY of the database.
 *
 *     DB_PATH=/path/to/copy.db node scripts/library-bench.js
 *
 * Mounts the public router on a throwaway Express app (no engine, no sources, no writes). It then:
 *   1. probes GET /api/health every 50 ms while the library is cold, so the gap between probes is the stall;
 *   2. requests a similar-creators list (the first request that needs the library) and polls it until
 *      it returns results, which is when the library is ready to serve;
 *   3. reports the probe latencies and the event-loop delay during that window, then warm latencies.
 * Prints one JSON object on stdout.
 */
const http = require('http');
const { monitorEventLoopDelay } = require('perf_hooks');
const express = require('express');

if (!process.env.DB_PATH) { console.error('set DB_PATH to a copy of the database'); process.exit(2); }

const app = express();
app.use('/api', require('../src/routes/public'));
let server; let base;
const listening = new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });

const get = (path) => new Promise((resolve, reject) => {
  const t = process.hrtime.bigint();
  http.get(`${base}${path}`, { headers: { cookie: 'prism_age=1' } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t) / 1e6, body }));
  }).on('error', reject);
});
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await listening;
  const repo = require('../src/db/repo');
  const size = require('fs').statSync(process.env.DB_PATH).size;
  const row = repo.db.prepare("SELECT id, media_count FROM creators WHERE status = 'active' AND media_count > 0 ORDER BY media_count DESC LIMIT 1").get();
  const mediaRows = repo.db.prepare('SELECT COUNT(*) AS n FROM media').get().n;
  const sim = `/api/creators/${row.id}/similar?limit=12`;
  const out = { dbBytes: size, mediaRows, creatorMedia: row.media_count, idle: null, cold: null, warm: null };

  // 1. idle baseline: probes with nothing else running
  const idle = monitorEventLoopDelay({ resolution: 10 }); idle.enable();
  const idleProbe = [];
  for (let i = 0; i < 20; i++) { idleProbe.push((await get('/api/health')).ms); await sleep(50); }
  idle.disable();
  out.idle = { healthP50: pct(idleProbe, 0.5), healthMax: pct(idleProbe, 1), loopMaxMs: Math.round(idle.max / 1e6) };

  // 2. cold: a 20 ms timer records the largest gap between ticks (the stall every other user waits behind),
  // health probes run alongside, and the similar-creators request is repeated until it returns results.
  const ticks = []; let last = Date.now(); let running = true;
  const ticker = setInterval(() => { const now = Date.now(); ticks.push(now - last); last = now; }, 20);
  const probes = [];
  const probing = (async () => { while (running) { const r = await get('/api/health').catch(() => null); if (r) probes.push({ ms: r.ms, status: r.status }); await sleep(50); } })();
  const t0 = Date.now();
  const first = await get(sim);
  const firstBody = JSON.parse(first.body || '[]').length;
  let readyMs = firstBody ? Date.now() - t0 : null; let polls = 1;
  while (readyMs === null && Date.now() - t0 < 180000) {
    polls++;
    const r = await get(sim);
    if (JSON.parse(r.body || '[]').length) readyMs = Date.now() - t0; else await sleep(100);
  }
  await sleep(300); running = false; clearInterval(ticker); await probing;
  out.cold = {
    firstRequestMs: Math.round(first.ms),
    firstRequestResults: firstBody,
    readyMs,
    polls,
    loopMaxGapMs: Math.max(...ticks),
    loopGapsOver100ms: ticks.filter((t) => t > 100).length,
    healthProbes: probes.length,
    healthP50: pct(probes.map((p) => p.ms), 0.5),
    healthMax: pct(probes.map((p) => p.ms), 1),
    healthNon200: probes.filter((p) => p.status !== 200).length,
  };

  // 3. warm: the same request once the library is in memory
  const warmMs = [];
  for (let i = 0; i < 30; i++) warmMs.push((await get(sim)).ms);
  out.warm = { similarP50: pct(warmMs, 0.5), similarP95: pct(warmMs, 0.95) };

  console.log(JSON.stringify(out, null, 2));
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
