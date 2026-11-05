'use strict';
/**
 * End-to-end latency and event-loop stalls of the PUBLIC read routes on a scaled database (scripts/seed-scale.js,
 * or a COPY of a real one), against the real server process (server.js: engine, warm-up, background jobs and all).
 *
 *     DB_PATH=/tmp/scale.db node scripts/scale-bench.js [--runs 30] [--settle 80] [--burst 20] [--out result.json] [--only video,creators] [--views 4]
 *
 *   1. spawns `node --require scripts/loop-probe.js server.js` on a free port (scheduler off, no network needed);
 *   2. COLD: as soon as /api/health answers, one request to each route, in order (what the first visitors pay);
 *   3. waits --settle seconds (so the one-off boot work and the first background ticks are over), then WARM:
 *      --runs requests per route with varied parameters (page, seed, handle) on one keep-alive connection,
 *      reporting p50 / p95 / max;
 *   4. BURST: --burst seconds of 6 concurrent clients cycling through every route;
 *   5. prints a JSON report, including the event-loop delay (max / p99, from the in-process probe) for the boot
 *      window, the warm window and the burst, plus every stall over 100 ms with the time it happened.
 *
 * The server is killed at the end; the database file is only read and written the way the server normally does,
 * so run it on a copy you can throw away.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
if (!process.env.DB_PATH) { console.error('set DB_PATH to a scaled database (scripts/seed-scale.js) or a copy of a real one'); process.exit(2); }
const RUNS = Number(opt('runs', 30));
const SETTLE_S = Number(opt('settle', 80));
const BURST_S = Number(opt('burst', 20));
const OUT = opt('out', null);
const VIEWS = Number(opt('views', 0)); // viewers' POST /api/media/:id/view per second, running through the warm and burst phases (each is a write on the server's connection)
const ONLY = opt('only', null); // comma-separated substrings of route names: bench just those
const ROOT = path.join(__dirname, '..');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : null; };

(async () => {
  const port = await freePort();
  const probeOut = path.join(os.tmpdir(), `prism-loop-${process.pid}.jsonl`);
  try { fs.unlinkSync(probeOut); } catch { /* none */ }
  // The API has a per-IP limiter (400 requests / minute): spread the requests over loopback addresses 127.0.1.1-250 so the
  // limiter does not answer instead of the routes. One keep-alive agent per address.
  const agents = new Map(); let hits = 0;
  const agentFor = (n) => { if (!agents.has(n)) agents.set(n, new http.Agent({ keepAlive: true, maxSockets: 4, localAddress: `127.0.1.${1 + (n % 250)}` })); return agents.get(n); };
  const get = (p) => new Promise((resolve) => {
    const t = performance.now();
    const agent = agentFor(Math.floor(hits++ / 150));
    const req = http.get({ host: '127.0.0.1', port, path: p, agent, headers: { cookie: 'prism_age=1' } }, (res) => {
      let n = 0; const chunks = [];
      res.on('data', (c) => { n += c.length; chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t, bytes: n, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (e) => resolve({ status: 0, ms: performance.now() - t, error: e.code || e.message, bytes: 0, body: '' }));
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
  });

  const bootAt = Date.now();
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'loop-probe.js'), path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    // VISUAL_EMBED_PER_MIN=1: the background embedder still ticks every minute (its query is part of what is measured), but with no
    // network every picture "fails" at once, and a burst of 40 failure rows would invalidate the cached totals in the middle of a
    // route's run. (Override with VISUAL_EMBED_PER_MIN=40 to see that too.)
    env: { VISUAL_EMBED_PER_MIN: '1', ...process.env, PORT: String(port), ADMIN_KEY: 'dev', NODE_ENV: 'development', PROBE_OUT: probeOut, SCHEDULER_ENABLED: 'false', HOST: '127.0.0.1' },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', kill);

  // first health answer
  let firstHealthMs = null;
  for (;;) { const r = await get('/api/health'); if (r.status === 200) { firstHealthMs = Date.now() - bootAt; break; } if (Date.now() - bootAt > 180000) { console.error('server did not answer /api/health\n', log.slice(-2000)); kill(); process.exit(1); } await sleep(100); }
  const t0 = Date.now(); // the probe's clock starts with the process; offsets below are relative to bootAt

  // fixtures taken from the same database (read-only here)
  const Database = require('better-sqlite3');
  const ro = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
  const topCreators = ro.prepare("SELECT id, handle FROM creators WHERE status = 'active' AND media_count > 0 ORDER BY media_count DESC LIMIT 60").all();
  const midCreators = ro.prepare("SELECT id FROM creators WHERE status = 'active' AND media_count BETWEEN 5 AND 40 LIMIT 60").all().map((r) => r.id);
  const viewIds = ro.prepare("SELECT id FROM media WHERE publish_state = 'published' LIMIT 300").all().map((r) => r.id);
  const ofCreators = ro.prepare("SELECT id FROM creators WHERE status = 'active' AND media_count > 3 AND links GLOB '*onlyfans.com/[A-Za-z0-9]*' LIMIT 40").all().map((r) => r.id);
  const communities = ro.prepare("SELECT community FROM media WHERE community IS NOT NULL GROUP BY community ORDER BY COUNT(*) DESC LIMIT 30").all().map((r) => r.community);
  ro.close();
  const tags = ['gay', 'gym', 'muscle', 'beach', 'selfie', 'tag-010', 'tag-050', 'tag-120', 'outdoors', 'tattoo', 'beard', 'travel'];
  const prefixes = ['cre', 'creator_0', 'creator_00', 'cr', 'ea', 'x', 'creator_01', 'cre_', 'c', 'creator_1'];
  const I = (a, i) => a[i % a.length];

  const R = [
    ['health', () => '/api/health'],
    ['meta', () => '/api/meta'],
    ['discover', () => '/api/discover'],
    ['platforms', () => '/api/platforms'],
    ['communities', () => '/api/communities'],
    ['tags', (i) => `/api/tags?limit=${I([100, 60, 36], i)}`],
    ['recommend (no taste)', (i) => `/api/recommend?limit=18&seed=${1000 + i}`],
    // a visitor's taste is stable, the home page asks with a fresh seed on every visit: 8 different visitors, a new seed each time
    ['recommend (taste)', (i) => `/api/recommend?limit=18&seed=${1000 + i}&tags=${I(tags, i % 8)}:3,${I(tags, (i % 8) + 3)}:1.5&creators=${I(topCreators, i % 8).id}:2`],
    ['media default feed p0', (i) => `/api/media?limit=${I([36, 48], i)}`],
    ['media default feed p1+ (nocount)', (i) => `/api/media?limit=36&page=${1 + (i % 6)}&nocount=1`],
    ['media sort=recent', (i) => `/api/media?sort=recent&limit=36&page=${i % 4}`],
    ['media sort=trending', (i) => `/api/media?sort=trending&limit=36&page=${i % 4}`],
    ['media sort=top', (i) => `/api/media?sort=top&limit=36&page=${i % 4}`],
    ['media sort=oldest', (i) => `/api/media?sort=oldest&limit=36&page=${i % 4}`],
    ['media sort=random', (i) => `/api/media?sort=random&seed=${i + 1}&limit=36&page=${i % 3}`],
    ['media type=video', (i) => `/api/media?type=video&limit=36&page=${i % 3}`],
    ['media type=image sort=top', (i) => `/api/media?type=image&sort=top&limit=36&page=${i % 3}`],
    ['media platform=reddit', (i) => `/api/media?platform=reddit&limit=36&page=${i % 3}`],
    ['media platform=bluesky sort=trending', (i) => `/api/media?platform=${I(['bluesky', 'mastodon', 'x', 'redgifs'], i)}&sort=trending&limit=36`],
    ['media creator=<top>', (i) => `/api/media?creator=${I(topCreators, i).id}&limit=36&page=${i % 3}`],
    ['media creator=<mid>', (i) => `/api/media?creator=${I(midCreators, i)}&limit=36`],
    ['media tag=<broad>', (i) => `/api/media?tag=gay&limit=36&sort=${I(['recent', 'trending', 'top'], i)}&page=${i % 3}`],
    ['media tags=a,b (all)', (i) => `/api/media?tags=${I(tags, i)},${I(tags, i + 1)}&limit=36&sort=${I(['recent', 'top'], i)}`],
    ['media tags rare', (i) => `/api/media?tags=tag-${String(100 + (i % 200)).padStart(3, '0')}&limit=36`],
    ['media community', (i) => `/api/media?community=${I(communities, i)}&limit=36&page=${i % 3}`],
    ['media paid=onlyfans', (i) => `/api/media?paid=onlyfans&limit=36&sort=${I(['recent', 'trending', 'top'], i)}&page=${i % 3}`],
    ['media paid=onlyfans type=video', (i) => `/api/media?paid=onlyfans&type=video&sort=recent&limit=36&page=${i % 3}`],
    ['media since=week sort=top', (i) => `/api/media?since=${I(['week', 'month', 'day'], i)}&sort=top&limit=36`],
    ['media q=text', (i) => `/api/media?q=${encodeURIComponent(I(['post 1', 'post 20', 'gym', 'beach', 'creator_00'], i))}&limit=36`],
    ['creators sort=media', (i) => `/api/creators?sort=media&limit=36&page=${i % 5}`],
    ['creators sort=score', (i) => `/api/creators?sort=score&limit=36&page=${i % 5}`],
    ['creators sort=recent', (i) => `/api/creators?sort=recent&limit=36&page=${i % 5}`],
    ['creators sort=new', (i) => `/api/creators?sort=new&limit=36&page=${i % 5}`],
    ['creators sort=name', (i) => `/api/creators?sort=name&limit=36&page=${i % 5}`],
    ['creators paid=onlyfans', (i) => `/api/creators?paid=onlyfans&sort=${I(['media', 'score', 'recent'], i)}&limit=36&page=${i % 3}`],
    ['creators onlyfans=1', (i) => `/api/creators?onlyfans=1&limit=36&page=${i % 3}`],
    ['creators q=prefix', (i) => `/api/creators?q=${I(prefixes, i)}&limit=36`],
    ['creators platform=reddit', (i) => `/api/creators?platform=${I(['reddit', 'bluesky', 'x'], i)}&limit=36&page=${i % 3}`],
    ['creators fresh=7', (i) => `/api/creators?fresh=7&sort=recent&limit=36&page=${i % 3}`],
    ['suggest', (i) => `/api/suggest?q=${I(prefixes, i)}`],
    ['stats', () => '/api/stats'],
  ];

  if (ONLY) { const keep = ONLY.split(','); for (let i = R.length - 1; i >= 0; i--) if (!keep.some((k) => R[i][0].includes(k))) R.splice(i, 1); }
  let viewing = true; let viewsSent = 0;
  const post = (p) => new Promise((resolve) => { const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: agentFor(Math.floor(hits++ / 150) + 500), headers: { cookie: 'prism_age=1', 'content-length': 0 } }, (res) => { res.resume(); res.on('end', resolve); }); req.on('error', resolve); req.end(); });
  const viewer = async () => { for (let i = 0; viewing && VIEWS > 0; i++) { await post(`/api/media/${viewIds[i % viewIds.length]}/view`); viewsSent++; await sleep(1000 / VIEWS); } };
  const report = { dbBytes: fs.statSync(process.env.DB_PATH).size, runs: RUNS, settleS: SETTLE_S, burstS: BURST_S, firstHealthMs, cold: {}, warm: {}, burst: {} };

  // ---- cold: one request each, in order, straight after the first health answer
  for (const [name, mk] of R) {
    const r = await get(mk(0));
    report.cold[name] = { ms: Math.round(r.ms), status: r.status, bytes: r.bytes };
  }
  const coldEnd = Date.now() - bootAt;
  await sleep(Math.max(0, SETTLE_S * 1000 - (Date.now() - t0)));

  // ---- warm: varied parameters, one keep-alive connection, sequential
  const warmStart = Date.now() - bootAt;
  const viewerDone = viewer();
  for (const [name, mk] of R) {
    const ms = []; let bad = 0; let bytes = 0;
    for (let i = 1; i <= RUNS; i++) { const r = await get(mk(i)); ms.push(r.ms); bytes = Math.max(bytes, r.bytes); if (r.status !== 200) bad++; }
    report.warm[name] = { p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: pct(ms, 1), bad, maxBytes: bytes };
    process.stderr.write(`warm ${name}: p50 ${report.warm[name].p50} p95 ${report.warm[name].p95}\n`);
  }
  const warmEnd = Date.now() - bootAt;

  // ---- burst: concurrent clients across every route
  const burstStart = Date.now() - bootAt;
  const lat = []; let n = 0;
  const until = Date.now() + BURST_S * 1000;
  await Promise.all(Array.from({ length: 6 }, async (_, w) => {
    let i = w * 7;
    while (Date.now() < until) { const [, mk] = R[i % R.length]; const r = await get(mk(100 + i)); lat.push(r.ms); n++; i++; }
  }));
  const burstEnd = Date.now() - bootAt;
  viewing = false; await viewerDone; report.viewsSent = viewsSent;
  report.burst = { requests: n, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: pct(lat, 1) };

  // ---- event loop, from the in-process probe (offsets: seconds since the server process started ≈ since bootAt)
  const lines = fs.existsSync(probeOut) ? fs.readFileSync(probeOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const win = (a, b) => {
    const rows = lines.filter((l) => l.max !== undefined && l.t >= a / 1000 && l.t <= b / 1000);
    return { maxMs: Math.max(0, ...rows.map((r) => r.max)), p99MaxMs: Math.max(0, ...rows.map((r) => r.p99)), seconds: rows.length };
  };
  report.eventLoop = {
    boot_to_cold_end: win(0, coldEnd), cold_requests: win(firstHealthMs, coldEnd), settle: win(coldEnd, warmStart), warm: win(warmStart, warmEnd), burst: win(burstStart, burstEnd),
    stalls: lines.filter((l) => l.stall !== undefined).map((l) => ({ atS: l.at, ms: l.stall })),
  };
  const bad = Object.entries(report.cold).filter(([, v]) => v.status !== 200).map(([k, v]) => `${k}:${v.status}`);
  if (bad.length) report.coldNon200 = bad;
  kill();
  if (process.env.BENCH_LOG) fs.writeFileSync(process.env.BENCH_LOG, log); // the server's own stdout/stderr, for diagnosis
  const json = JSON.stringify(report, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  console.log(json);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
