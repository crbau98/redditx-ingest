#!/usr/bin/env node
'use strict';
/**
 * Scheduler throughput probe. Real engine + real scheduler + real SQLite, with each adapter's network call replaced by a sleep of
 * a measured per-feed duration (Coomer 2 s, GFF 1 s, Bluesky/RedGIFs 0.7 s: the measured 13-91 s / 7-13 s / 6-9 s scaled down 10x so
 * the probe takes minutes, not hours). Measures how long the scheduler needs to drain one sweep of N due feeds, feeds per hour,
 * and peak RSS. Run it on two checkouts for a before/after on the same feed set.
 *   node scripts/bench-scheduler.js [--coomer 60] [--bluesky 60] [--gff 30] [--redgifs 20] [--tick 5]
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-bench-')), 'bench.db');
process.env.SCHEDULER_ENABLED = 'true';
const repo = require('../src/db/repo');
const registry = require('../src/sources');
const settingsStore = require('../src/settings');
const engine = require('../src/engine/engine');

const MIX = { coomer: [opt('coomer', 60), 2000], bluesky: [opt('bluesky', 60), 700], gff: [opt('gff', 30), 1000], redgifs: [opt('redgifs', 20), 700] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let inflight = 0; let peakInflight = 0;
const perPlatformPeak = {}; const cur = {};
for (const a of registry.list()) {
  if (!MIX[a.platform]) continue;
  a.fetch = async (feed) => {
    inflight++; peakInflight = Math.max(peakInflight, inflight);
    cur[a.platform] = (cur[a.platform] || 0) + 1; perPlatformPeak[a.platform] = Math.max(perPlatformPeak[a.platform] || 0, cur[a.platform]);
    await sleep(MIX[a.platform][1]);
    inflight--; cur[a.platform]--;
    return { items: [], via: 'bench' };
  };
  a.isConfigured = () => ({ ok: true });
}
(async () => {
  repo.settings.set('seed_version', '999');
  settingsStore.update ? settingsStore.update({ tickSeconds: opt('tick', 5) }) : repo.settings.set('tickSeconds', String(opt('tick', 5)));
  let total = 0;
  for (const [platform, [n]] of Object.entries(MIX)) for (let i = 0; i < n; i++) { repo.feeds.upsert({ platform, kind: platform === 'gff' ? 'user' : 'user', target: `bench-${platform}-${i}`, origin: 'admin', trusted: 1, runNow: true }); total++; }
  let peakRss = 0; const mem = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200);
  const t0 = Date.now();
  engine.start();
  const done = () => repo.db.prepare("SELECT COUNT(*) n FROM feeds WHERE origin = 'admin' AND last_run_at IS NOT NULL").get().n;
  while (done() < total && Date.now() - t0 < 40 * 60 * 1000) await sleep(500);
  const sec = (Date.now() - t0) / 1000;
  clearInterval(mem); engine.shutdown();
  console.log(JSON.stringify({ feeds: total, drainedSec: Math.round(sec), feedsPerHour: Math.round(total / sec * 3600), peakConcurrent: peakInflight, peakPerPlatform: perPlatformPeak, peakRssMB: Math.round(peakRss / 1048576) }));
  process.exit(0);
})();
