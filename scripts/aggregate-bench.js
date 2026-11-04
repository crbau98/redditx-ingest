'use strict';
/**
 * Latency of the library-wide aggregate endpoints, measured without starting the ingestion engine.
 *
 *     DB_PATH=/path/to/copy.db node scripts/aggregate-bench.js [windowSeconds]
 *
 * Mounts only the public router on a throwaway Express app (no engine, no sources, no writes) and
 * reports, per endpoint: the first (cold) request, then p50/p95 of warm requests. It also measures
 * event-loop delay over a window with a request every 1.5 s, which is what every other user waits
 * behind when an aggregate is computed on the request path. Point DB_PATH at a COPY of the database.
 */
const http = require('http');
const { monitorEventLoopDelay } = require('perf_hooks');
const express = require('express');

if (!process.env.DB_PATH) { console.error('set DB_PATH to a copy of the database'); process.exit(2); }
const WINDOW_S = Number(process.argv[2] || 40);
const ENDPOINTS = ['/api/discover', '/api/stats', '/api/tags?limit=100', '/api/communities', '/api/platforms', '/api/graph', '/api/topics', '/api/media?limit=36', '/api/creators?limit=48'];

const app = express();
app.use('/api', require('../src/routes/public'));
let server; let base;
const listening = new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });

const get = (path) => new Promise((resolve, reject) => {
  const t = process.hrtime.bigint();
  http.get(`${base}${path}`, { headers: { cookie: 'prism_age=1' } }, (res) => {
    let bytes = 0;
    res.on('data', (c) => { bytes += c.length; });
    res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t) / 1e6, bytes }));
  }).on('error', reject);
});
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await listening;
  const out = { endpoints: {}, eventLoop: null };
  for (const ep of ENDPOINTS) {
    const cold = await get(ep);
    await sleep(300);
    const warm = [];
    for (let i = 0; i < 12; i++) { warm.push((await get(ep)).ms); }
    out.endpoints[ep] = { status: cold.status, bytes: cold.bytes, coldMs: Math.round(cold.ms), warmP50Ms: Math.round(pct(warm, 0.5)), warmP95Ms: Math.round(pct(warm, 0.95)) };
  }
  // Event-loop delay while a request runs every 1.5 s across the endpoints (aggregates expiring mid-window).
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const end = Date.now() + WINDOW_S * 1000;
  let i = 0; const lat = [];
  while (Date.now() < end) {
    const ep = ENDPOINTS[i++ % ENDPOINTS.length];
    lat.push((await get(ep)).ms);
    await sleep(1500);
  }
  h.disable();
  out.eventLoop = { windowS: WINDOW_S, p99Ms: Math.round(h.percentile(99) / 1e6), maxMs: Math.round(h.max / 1e6), requestP95Ms: Math.round(pct(lat, 0.95)), requests: lat.length };
  console.log(JSON.stringify(out, null, 2));
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
