'use strict';
/**
 * Latency and event-loop stalls of the public read routes, measured against a COPY of the database.
 *
 *     DB_PATH=/path/to/copy.db node scripts/route-bench.js [warmRequests=30]
 *
 * Mounts the public router on a throwaway Express app (no engine, no sources). For each route it sends
 * one cold request, then `warmRequests` requests with varied parameters (so response caches do not
 * answer them), and reports p50/p95 plus the largest gap between 20 ms timer ticks while that route ran.
 * "hot-refresh" is the 10-minute trending/score refresh (repo.media.recomputeHotChunked), timed the same way.
 * It waits until the library snapshot is ready first; the cold library fill is measured by library-bench.js.
 * Prints one JSON object on stdout.
 */
const http = require('http');
const { performance } = require('perf_hooks');
const express = require('express');

if (!process.env.DB_PATH) { console.error('set DB_PATH to a copy of the database'); process.exit(2); }
const WARM = Number(process.argv[2] || 30);

const app = express();
app.use('/api', require('../src/routes/public'));
let server; let base;
const listening = new Promise((resolve) => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
const get = (path) => new Promise((resolve, reject) => {
  const t = performance.now();
  http.get(`${base}${path}`, { headers: { cookie: 'prism_age=1' } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t, body }));
  }).on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : null; };

const PREFIXES = ['mu', 'gy', 'be', 'bea', 'bear', 'jo', 'mus', 'tw', 'sw', 'ta', 'ab', 'sh', 'ma', 'mi', 'lo', 'gr', 'co', 'ra'];
const TAGS = ['muscle', 'gym', 'beach', 'bear', 'twink', 'jock', 'beard', 'swim', 'tattoo', 'selfie', 'abs', 'outdoors'];

(async () => {
  await listening;
  const repo = require('../src/db/repo');
  const creators = repo.db.prepare("SELECT id FROM creators WHERE status = 'active' AND media_count > 0 ORDER BY media_count DESC LIMIT 200").all().map((r) => r.id);
  const media = repo.db.prepare("SELECT id FROM media WHERE publish_state = 'published' ORDER BY score DESC LIMIT 200").all().map((r) => r.id);
  // wait for the library snapshot (worker mode: empty until the first build)
  const waitStart = Date.now();
  while ((await get(`/api/creators/${creators[0]}/similar?limit=12`)).body === '[]' && Date.now() - waitStart < 180000) await sleep(200);
  const libraryReadyAfterMs = Date.now() - waitStart;

  const ROUTES = [
    ['discover', () => '/api/discover'],
    ['explore-recent', (i) => `/api/media?sort=recent&limit=36&page=${i % 5}`],
    ['explore-trending', (i) => `/api/media?sort=trending&limit=36&page=${i % 5}`],
    ['home-recommend', (i) => `/api/recommend?limit=18&seed=${1000 + i}`],
    ['graph', () => '/api/graph'],
    ['stats', () => '/api/stats'],
    ['topics', () => '/api/topics'],
    ['tags', () => '/api/tags?limit=100'],
    ['creator-similar', (i) => `/api/creators/${creators[i % creators.length]}/similar?limit=12`],
    ['media-related', (i) => `/api/media/${media[i % media.length]}/related?limit=12`],
    ['media-similar', (i) => `/api/media/${media[i % media.length]}/similar?limit=12`],
    ['suggest', (i) => `/api/suggest?q=${PREFIXES[i % PREFIXES.length]}${i >= PREFIXES.length ? i : ''}`],
    ['tags-related', (i) => `/api/tags/related?tags=${TAGS[i % TAGS.length]},${TAGS[(i + 3) % TAGS.length]}&limit=12`],
  ];

  const out = { dbBytes: require('fs').statSync(process.env.DB_PATH).size, mediaRows: repo.db.prepare('SELECT COUNT(*) AS n FROM media').get().n, libraryReadyAfterMs, routes: {} };
  for (const [name, path] of ROUTES) {
    const ticks = []; let last = Date.now();
    const ticker = setInterval(() => { const now = Date.now(); ticks.push(now - last); last = now; }, 20);
    const cold = await get(path(0));
    const warm = [];
    for (let i = 1; i <= WARM; i++) { const r = await get(path(i)); warm.push(r.ms); if (r.status !== 200) out.routes[name] = { status: r.status }; }
    clearInterval(ticker);
    out.routes[name] = { status: cold.status, coldMs: Math.round(cold.ms), p50: pct(warm, 0.5), p95: pct(warm, 0.95), maxLoopGapMs: Math.max(...ticks), n: warm.length };
    process.stderr.write(`${name} done\n`);
  }

  {
    const ticks = []; let last = Date.now();
    const ticker = setInterval(() => { const now = Date.now(); ticks.push(now - last); last = now; }, 20);
    const t = performance.now();
    await repo.media.recomputeHotChunked();
    const ms = performance.now() - t;
    clearInterval(ticker);
    out.routes['hot-refresh'] = { ms: Math.round(ms), maxLoopGapMs: Math.max(...ticks) };
  }

  console.log(JSON.stringify(out, null, 2));
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
