'use strict';
/** Wave 11 (Halyard): duplicate-only backoff, slower dry backfill, and feed-target validation. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let engine; let targets;
before(() => { repo = require('../src/db/repo'); engine = require('../src/engine/engine'); targets = require('../src/services/targets'); });
after(() => { engine.shutdown(); });

const DAY = 86400000;
let n = 0;
function seed(feedId, list) { // [{ daysAgo, fetched, added }]
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of list) { n++; const at = new Date(Date.now() - r.daysAgo * DAY).toISOString(); ins.run(`w11${n}`, feedId, at, at, r.fetched ? 'ok' : 'empty', r.fetched, r.added || 0); }
}
const feed = (target) => repo.feeds.upsert({ platform: 'web', kind: 'page', target, runNow: false }).feed;

test('a feed that fetches items but adds none for 7 days (5+ runs) backs off 2 days', () => {
  const f = feed('https://dupes.example/a');
  seed(f.id, [1, 2, 3, 4, 5, 6].map((d) => ({ daysAgo: d, fetched: 12, added: 0 })));
  const next = Date.parse(engine.idleNextRun(f, 12, Date.now(), 0));
  assert.ok(next - Date.now() > 1.7 * DAY && next - Date.now() < 2.3 * DAY);
});

test('duplicate backoff is not applied when this run added, any run added, too few runs, or the caller omits the added count', () => {
  const f = feed('https://dupes.example/b');
  seed(f.id, [1, 2, 3, 4, 5].map((d) => ({ daysAgo: d, fetched: 8, added: 0 })));
  assert.equal(engine.idleNextRun(f, 8, Date.now(), 2), null, 'this run added items');
  assert.equal(engine.idleNextRun(f, 8), null, 'added count unknown: old behaviour');
  const woke = feed('https://dupes.example/c');
  seed(woke.id, [{ daysAgo: 1, fetched: 8, added: 0 }, { daysAgo: 2, fetched: 8, added: 1 }, { daysAgo: 3, fetched: 8, added: 0 }, { daysAgo: 4, fetched: 8, added: 0 }, { daysAgo: 5, fetched: 8, added: 0 }]);
  assert.equal(engine.idleNextRun(woke, 8, Date.now(), 0), null, 'one add in 7 days keeps the pace');
  const young = feed('https://dupes.example/d');
  seed(young.id, [{ daysAgo: 1, fetched: 8, added: 0 }, { daysAgo: 2, fetched: 8, added: 0 }]);
  assert.equal(engine.idleNextRun(young, 8, Date.now(), 0), null, 'too few runs');
});

test('the yield scoreboard reports added items', () => {
  const f = feed('https://dupes.example/e');
  seed(f.id, [{ daysAgo: 1, fetched: 5, added: 2 }, { daysAgo: 2, fetched: 5, added: 1 }]);
  assert.deepEqual(repo.runs.yieldSince(f.id, new Date(Date.now() - 7 * DAY).toISOString()), { runs: 2, fetched: 10, added: 3 });
});

test('feed creation refuses empty and invalid handles and PeerTube targets', () => {
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: '.bsky.social' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: '  ' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: 'not valid_name' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'user', target: 'flixcdn' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'user', target: `${'n2jlodrlmmvkmtgxzgvmztmwyzbhzdcxytg1mdvlnmu'}@ic-nss.flix` }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'channel', target: 'onlyfans@@bad' }).status, 'invalid');
});

test('valid Bluesky and PeerTube targets are still created', () => {
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: 'validperson.bsky.social' }, { origin: 'admin' }).status, 'created');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'user', target: 'someone@tube.example.org' }, { origin: 'admin' }).status, 'created');
});

test('an empty backfill slice keeps the normal gap (only fetched-but-stored slices wait 4x, BACKFILL_DRY_GAP_FACTOR)', async () => {
  const registry = require('../src/sources'); const settingsStore = require('../src/settings');
  const real = registry.get;
  let added = false;
  const stub = { platform: 'w11bf', kinds: ['user'], isConfigured: () => ({ ok: true }), fetch: async () => ({ items: [{ id: 'w11-' + Math.random(), mediaType: 'image', mediaUrl: 'https://x.invalid/a.jpg' }].slice(0, added ? 1 : 0), via: 't', cursor: { pos: 1 }, backfillPending: true }) };
  registry.get = (p) => (p === 'w11bf' ? stub : real(p));
  try {
    const f = repo.feeds.upsert({ platform: 'w11bf', kind: 'user', target: 'bfuser', runNow: false }).feed;
    // fetched > 0 but nothing added: the engine counts stored items as dupes
    const gap = settingsStore.get().backfillGapMin * 60000;
    repo.db.prepare("INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES ('w11-x', ?, datetime('now','-1 day'), datetime('now','-1 day'), 'ok', 3, 0)").run(f.id);
    await engine.runFeed(f.id, 'schedule');
    const wait = new Date(repo.feeds.get(f.id).next_run_at).getTime() - Date.now();
    assert.ok(wait > 0 && wait <= gap + 1000, 'an empty slice keeps the normal gap');
  } finally { registry.get = real; }
});

// ------------------------------------------------------------------ round 2: redgifs, coomer pacing, floors, yield route
const mkFeed = (platform, kind, target, extra = {}) => { const f = repo.feeds.upsert({ platform, kind, target, runNow: false }).feed; if (extra.interval) repo.db.prepare('UPDATE feeds SET interval_min = ? WHERE id = ?').run(extra.interval, f.id); return repo.feeds.get(f.id); };
function productive(feedId, daysAgoList) {
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const d of daysAgoList) { n++; const at = new Date(Date.now() - d * DAY).toISOString(); ins.run(`w11p${n}`, feedId, at, at, 'ok', 5, 2); }
}

test('RedGIFs backfill is capped per day by its own setting; live polling and other platforms are not', () => {
  const budget = require('../src/services/budget'); const settingsStore = require('../src/settings');
  const cfg = { ...settingsStore.get(), redgifsBackfillRunsPerDay: 2, backfillRunsPerDay: 4000, platformDailyRuns: '' };
  assert.equal(settingsStore.get().redgifsBackfillRunsPerDay, 300, 'default');
  assert.equal(budget.allow('redgifs', 2, cfg), true);
  budget.charge('redgifs', 2); budget.charge('redgifs', 2);
  assert.equal(budget.allow('redgifs', 2, cfg), false, 'redgifs backfill stops at its cap');
  assert.equal(budget.allow('redgifs', 1, cfg), true, 'live polling still runs');
  assert.equal(budget.allow('bluesky', 2, cfg), true, 'another platform keeps the generic cap');
});

test('a RedGIFs backfill closes itself after BACKFILL_DRY_STOP slices that added nothing', async () => {
  const registry = require('../src/sources'); const real = registry.get;
  const rg = real('redgifs'); const realFetch = rg.fetch;
  let slice = 0;
  rg.fetch = async () => { slice++; return { items: [], via: 't', cursor: { bfPage: slice + 1 }, backfillPending: true }; };
  try {
    const f = mkFeed('redgifs', 'user', 'drystopper');
    for (let i = 0; i < engine.BACKFILL_DRY_STOP; i++) await engine.runFeed(f.id, 'schedule');
    const cur = JSON.parse(repo.feeds.get(f.id).cursor);
    assert.equal(cur.bfDone, true); assert.equal(cur.backfillPending, false); assert.equal(cur.bfStopped, 'dry');
    assert.equal(require('../src/engine/backfill').pending({ cursor: cur }), false);
  } finally { rg.fetch = realFetch; }
});

test('coomer pacing: slow poster waits half the median gap (clamped to base..2 days); fast poster stays at base', () => {
  const slow = mkFeed('coomer', 'user', 'onlyfans/slowposter', { interval: 240 });
  productive(slow.id, [3, 9, 15, 21]); // gaps of 6 days -> half = 3 days -> clamped to 2
  let d = Date.parse(engine.paceNextRun(slow, 0)) - Date.now();
  assert.ok(d > 1.7 * DAY && d < 2.3 * DAY, 'clamped to 2 days');
  const mid = mkFeed('coomer', 'user', 'onlyfans/midposter', { interval: 240 });
  productive(mid.id, [1, 2, 3, 4]); // 1-day gaps -> half a day
  d = Date.parse(engine.paceNextRun(mid, 0)) - Date.now();
  assert.ok(d > 0.4 * DAY && d < 0.6 * DAY, 'about half a day');
  const fast = mkFeed('coomer', 'user', 'onlyfans/fastposter', { interval: 240 });
  productive(fast.id, [0.05, 0.1, 0.15, 0.2]); // gaps of 1.2 h -> half is under the 4 h base
  d = Date.parse(engine.paceNextRun(fast, 0)) - Date.now();
  assert.ok(d > 3.5 * 3600000 && d < 4.5 * 3600000, 'never below the base interval');
});

test('pacing leaves productive runs, other platforms and thin history alone; a week of empty runs goes to 2 days', () => {
  const f = mkFeed('coomer', 'user', 'onlyfans/paceskip');
  assert.equal(engine.paceNextRun(f, 3), null, 'this run added items: tempo decides');
  assert.equal(engine.paceNextRun(mkFeed('bluesky', 'user', 'paceskip.bsky.social'), 0), null, 'not a paced platform');
  assert.equal(engine.paceNextRun(f, 0), null, 'no runs yet: nothing to judge');
  seed(f.id, [1, 2, 3, 4, 5].map((dd) => ({ daysAgo: dd, fetched: 0 })));
  const d = Date.parse(engine.paceNextRun(f, 0)) - Date.now();
  assert.ok(d > 1.7 * DAY && d < 2.3 * DAY, 'five empty runs in a week: 2 days');
  const recent = mkFeed('coomer', 'user', 'onlyfans/pacerecent');
  seed(recent.id, [{ daysAgo: 1, fetched: 4, added: 1 }, { daysAgo: 2, fetched: 0 }, { daysAgo: 3, fetched: 0 }, { daysAgo: 4, fetched: 0 }, { daysAgo: 5, fetched: 0 }]);
  assert.equal(engine.paceNextRun(recent, 0), null, 'one add this week and too few points: normal tempo');
});

test('gff and link-in-bio feeds are polled no more often than their platform floor', () => {
  const g = mkFeed('gff', 'user', 'https://justthegays.tv/performer/floor-test', { interval: 360 });
  const dg = Date.parse(engine.computeNextRun(g, 0)) - Date.now();
  assert.ok(dg > 2.6 * DAY, `gff at least ~3 days (${dg / DAY})`);
  const l = mkFeed('linkinbio', 'page', 'https://linktr.ee/floor-test', { interval: 720 });
  assert.ok(Date.parse(engine.computeNextRun(l, 0)) - Date.now() > 6.3 * DAY, 'linkinbio about 7 days');
  const w = mkFeed('web', 'page', 'https://floor.example/x', { interval: 720 });
  assert.ok(Date.parse(engine.computeNextRun(w, 0)) - Date.now() < 1 * DAY, 'other platforms unchanged');
  assert.deepEqual(engine.PLATFORM_MIN_INTERVAL_MIN, { gff: 4320, linkinbio: 10080 });
});

test('GET /api/admin/feeds/yield: per-feed runs, fetched, added; read-only, admin-only, bounded', async () => {
  const { createApp } = require('../src/app');
  const server = createApp().listen(0); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    const f = mkFeed('web', 'page', 'https://yield.example/page');
    seed(f.id, [{ daysAgo: 1, fetched: 10, added: 4 }, { daysAgo: 2, fetched: 6, added: 0 }, { daysAgo: 20, fetched: 99, added: 99 }]);
    const res = await fetch(`${base}/feeds/yield?days=7&platform=web&limit=500`, { headers: { 'x-admin-key': 'test-key' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const row = body.items.find((i) => i.id === f.id);
    assert.ok(row, 'feed listed');
    assert.deepEqual([row.runs, row.fetched, row.added, row.platform], [2, 16, 4, 'web'], 'the 20-day-old run is outside the window');
    assert.equal(body.days, 7);
    assert.equal((await fetch(`${base}/feeds/yield`)).status, 401);
    const small = await (await fetch(`${base}/feeds/yield?limit=1`, { headers: { 'x-admin-key': 'test-key' } })).json();
    assert.ok(small.items.length <= 1, 'limit bounds the result');
    const plan = repo.db.prepare("EXPLAIN QUERY PLAN SELECT feed_id, COUNT(*) FROM feed_runs WHERE started_at >= ? AND status != 'running' GROUP BY feed_id").all('2020-01-01').map((r) => r.detail).join(' | ');
    assert.match(plan, /ix_runs_started|ix_runs_feed/, 'the range scan uses an index');
  } finally { await new Promise((r) => server.close(r)); }
});
