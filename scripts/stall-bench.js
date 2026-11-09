'use strict';
/**
 * Stall bench: reproduce the server's main-thread stall suspects at prod scale, on whatever disk
 * this runs, and print the measured worst event-loop block for each. Written after the 2026-11-09
 * deploy showed ~3 s blocks on production (/api/health) that could not be reproduced from the code
 * alone: this isolates which SQLite-heavy background work actually blocks the loop, and how much
 * of it is disk latency (a local SSD hides what a network volume shows).
 *
 *   node scripts/stall-bench.js              # all scenarios, 400k rows
 *   LOOPPROBE_ROWS=50000 node scripts/stall-bench.js control leanBias
 *
 * Scenarios:
 *   control   small writes alone (the floor every other number is read against)
 *   leanBias  one maintenance.leanBiasSweep tick (4000 rows judged + biased, no model, no network)
 *   workerHot the trending refresh on the backup worker (as production runs it) while the main
 *             thread writes every 25 ms — measures how long a main write waits on the worker's
 *             write lock (busy_timeout)
 * Nothing outside the temp database is touched; the database is deleted again unless KEEP_DB=1.
 * Dev tool only; nothing in the app requires it.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

const ROWS = Number(process.env.LOOPPROBE_ROWS) || 400000;
const WORDS = [['gym shredded abs session', 1.3], ['new post today', null], ['bear dad bod heavy', 0.7]];

/**
 * A throwaway file database at the requested size: published rows, wide enough to be honest.
 * Returns the (singleton) repo plus a cleanup that removes the directory again.
 */
async function env(rows = ROWS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-stall-bench-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(dir, 'bench.db');
  process.env.ADMIN_KEY = 'bench';
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.MEDIA_CACHE_MB = '16';
  process.env.ALLOW_PRIVATE_HOSTS = 'true';
  const repo = require('../src/db/repo');
  const nowIso = new Date().toISOString();
  const ins = repo.db.prepare(`INSERT INTO media (id, creator_id, feed_id, platform, source_id, source_key, post_key, position, source_url, community, author, title, description,
    media_type, media_url, preview_url, thumbnail_url, hls_url, has_audio, width, height, duration, mime_type, score, nsfw_level, scope, publish_state, review_reason, posted_at, phash, physique, attribution_evidence, lean_bias, hash)
    VALUES (?, NULL, NULL, 'reddit', ?, ?, ?, 0, 'https://example.com/x', 'r/test', 'op', ?, 'some longer description text here', 'image', ?, NULL, NULL, NULL, 0, 800, 1200, NULL, 'image/jpeg', 10, 'explicit', 'in', 'published', NULL, ?, NULL, NULL, NULL, ?, ?)`);
  const tx = repo.db.transaction((from, to) => {
    for (let i = from; i < to; i++) {
      const [text] = WORDS[i % 3];
      ins.run(`m${i}`, `s${i}`, `reddit:s${i}:0`, `reddit:s${i}`, text, `https://example.com/${i}.jpg`, nowIso, null, `h${i}`);
    }
  });
  const t0 = performance.now();
  for (let from = 1; from <= rows; from += 5000) tx(from, Math.min(from + 5000, rows + 1));
  return {
    repo,
    rows,
    insertMs: Math.round(performance.now() - t0),
    cleanup: () => {
      try { require('../src/engine/engine').shutdown(); } catch { /* not started */ }
      if (process.env.KEEP_DB !== '1') { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    },
  };
}

function histogram() {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  return { h, stop: () => { h.disable(); return { max: Math.round((h.max || 0) / 1e6), p99: Math.round((h.percentile(99) || 0) / 1e6), mean: Math.round((h.mean || 0) / 1e6) }; } };
}

/** One small update every `ms` — what ingest and the sweeps do to the main thread all day. */
function startWriter(repo, ms = 25) {
  const upd = repo.db.prepare('UPDATE media SET likes = likes + 1 WHERE id = ?');
  const ids = repo.db.prepare('SELECT id FROM media ORDER BY seq LIMIT 2000').all().map((r) => r.id);
  let i = 0; let worst = 0; let fails = 0; let count = 0; let stop = false; let firstErr = null; let timer = null;
  const step = () => {
    if (stop) return;
    const t0 = performance.now();
    try { upd.run(ids[i % ids.length]); } catch (e) { fails++; if (!firstErr) firstErr = `${e.code} ${e.message}`; }
    const dt = performance.now() - t0;
    if (dt > worst) worst = dt;
    count++; i++;
    timer = setTimeout(step, ms);
  };
  step();
  return { stop: () => { stop = true; clearTimeout(timer); return { writes: count, worstMs: Math.round(worst), fails, firstErr }; } };
}

/**
 * Run one scenario against a freshly prepared database. Returns the measurements; `prepare.ms`
 * (bulk insert) and scenario wall time are reported too, as context, not verdicts.
 */
async function scenario(name, repo, opts = {}) {
  const hg = histogram();
  let out = { scenario: name };
  const t0 = performance.now();
  if (name === 'control') {
    const writer = startWriter(repo, opts.writeMs || 25);
    await new Promise((r) => setTimeout(r, opts.durationMs || 8000));
    out = { ...out, ...writer.stop() };
  } else if (name === 'leanBias') {
    const settings = require('../src/settings');
    settings.update({ leanPreference: true });
    const maintenance = require('../src/engine/maintenance');
    const r = await maintenance.leanBiasSweep({ limit: 4000, settings: settings.get() });
    out = { ...out, judged: r.judged, biased: r.biased };
  } else if (name === 'workerHot') {
    const settings = require('../src/settings');
    settings.update({ leanPreference: true });
    // the deploy moment: biases stored, hot not yet refreshed, so the worker rewrites every biased row
    repo.db.exec(`UPDATE media SET lean_bias = CASE WHEN title LIKE '%gym%' OR title LIKE '%shredded%' THEN 1.3 WHEN title LIKE '%bear%' OR title LIKE '%dad bod%' THEN 0.7 ELSE NULL END`);
    repo.db.exec(`UPDATE media SET hot = hot_score(score, likes, views, epoch_ms(posted_at), strftime('%s','now') * 1000) WHERE publish_state = 'published'`);
    const writer = startWriter(repo, 25);
    const { Worker } = require('worker_threads');
    // backup.hotScore() takes an inline no-op under NODE_ENV=test; production spawns this worker, so do the same
    const updated = await new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, '..', 'src', 'engine', 'backup-worker.js'), { workerData: { dbPath: process.env.DB_PATH, file: null, task: 'hot' } });
      w.on('message', (m) => (m && m.ok) ? resolve(m.updated) : reject(new Error((m && m.error) || 'worker failed')));
      w.on('error', reject);
      w.on('exit', (c) => { if (c !== 0) reject(new Error(`worker exited ${c}`)); });
    });
    const w = writer.stop();
    out = { ...out, updated, ...w };
  } else throw new Error(`unknown scenario: ${name}`);
  out.wallMs = Math.round(performance.now() - t0);
  out.loop = hg.stop();
  return out;
}

/** CLI: one CHILD PROCESS per scenario — repo holds its SQLite connection from first require, so
 * scenarios cannot share a process. Each child prepares, runs, prints one line, and cleans up. */
async function main(argv) {
  const names = argv.length ? argv : ['control', 'leanBias', 'workerHot'];
  const { spawnSync } = require('child_process');
  let bad = 0;
  for (const name of names) {
    const r = spawnSync(process.execPath, [__filename, name], {
      env: { ...process.env, LOOPPROBE_ONE: name },
      stdio: 'inherit',
    });
    if (r.status !== 0) bad++;
  }
  if (bad) throw new Error(`${bad} scenario(s) failed`);
}

if (process.env.LOOPPROBE_ONE && require.main === module) {
  (async () => {
    const { repo, cleanup, insertMs, rows } = await env(Number(process.env.LOOPPROBE_ROWS) || ROWS);
    try {
      const r = await scenario(process.env.LOOPPROBE_ONE, repo);
      const block = r.worstMs != null ? `worst main write ${r.worstMs} ms` : `wall ${r.wallMs} ms`;
      console.log(`${r.scenario.padEnd(10)} rows=${rows} insert=${insertMs} ms · ${block}, busyFails=${r.fails || 0} · loop max ${r.loop.max} ms / p99 ${r.loop.p99} ms${r.firstErr ? ` · firstErr=${r.firstErr}` : ''}`);
    } finally { cleanup(); }
  })().catch((e) => { console.error(e); process.exit(1); });
} else if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { env, scenario, startWriter };
