'use strict';
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let engine; let repo; let backfill; let budget; let registry; let settingsStore;
before(() => {
  prepareEnv({ SCHEDULER_ENABLED: 'true' });
  repo = require('../src/db/repo'); registry = require('../src/sources'); settingsStore = require('../src/settings');
  backfill = require('../src/engine/backfill'); budget = require('../src/services/budget'); engine = require('../src/engine/engine');
});
beforeEach(() => { repo.db.prepare('DELETE FROM feeds').run(); budget._reset(); engine._state.queue.length = 0; engine._state.running.clear(); engine._state.paused = false; });

const mk = (platform, target, extra = {}) => repo.feeds.upsert({ platform, kind: 'user', target, origin: 'admin', trusted: 1, runNow: true, ...extra }).feed;

test('lanes: never-read and prioritised feeds first, refresh next, backfill last', () => {
  const fresh = mk('coomer', 'a');
  const refresh = mk('coomer', 'b'); repo.db.prepare("UPDATE feeds SET last_success_at = datetime('now'), cursor = ? WHERE id = ?").run(JSON.stringify({ newestAt: 'x' }), refresh.id);
  const back = mk('coomer', 'c'); repo.db.prepare("UPDATE feeds SET last_success_at = datetime('now'), cursor = ? WHERE id = ?").run(JSON.stringify({ newestAt: 'x', bfNext: 'cur3' }), back.id);
  const urgent = mk('coomer', 'd', { priority: 5 }); repo.db.prepare("UPDATE feeds SET last_success_at = datetime('now') WHERE id = ?").run(urgent.id);
  const f = (id) => repo.feeds.get(id);
  assert.equal(backfill.laneOf(f(fresh.id)), 0);
  assert.equal(backfill.laneOf(f(urgent.id)), 0);
  assert.equal(backfill.laneOf(f(refresh.id)), 1);
  assert.equal(backfill.laneOf(f(back.id)), 2);
});

test('pending(): each adapter\'s resume marker counts, a finished backfill does not', () => {
  assert.equal(backfill.pending({ cursor: JSON.stringify({ bfNext: 'c' }) }), true);
  assert.equal(backfill.pending({ cursor: JSON.stringify({ bfNext: 'c', bfDone: true }) }), false);
  assert.equal(backfill.pending({ cursor: JSON.stringify({ bfPage: 4 }) }), true);
  assert.equal(backfill.pending({ cursor: JSON.stringify({ backfillPending: true }) }), true);
  assert.equal(backfill.pending({ cursor: JSON.stringify({ newestAt: 'x' }) }), false);
  assert.equal(backfill.pending({ cursor: null }), false);
});

test('slots: a platform runs up to its slot count; the next feed is taken by another platform, not blocked behind Coomer', () => {
  const cfg = settingsStore.get();
  for (let i = 0; i < 10; i++) mk('coomer', `c${i}`);
  const b = mk('bluesky', 'b0');
  const take = () => { const w = engine._nextWork(cfg); if (w) engine._state.running.set(w.feed.id, { platform: w.feed.platform }); return w; };
  const got = [take(), take(), take(), take()].filter(Boolean).map((w) => w.feed.platform);
  assert.equal(got.filter((p) => p === 'coomer').length, engine.slotsFor('coomer'), 'coomer capped at its slots');
  assert.ok(got.includes('bluesky'), 'bluesky is not hidden behind the coomer backlog');
  assert.equal(b.platform, 'bluesky');
});

test('backfill never takes a slot a due refresh feed of the same platform could use', () => {
  const cfg = settingsStore.get();
  const back = mk('bluesky', 'back'); repo.db.prepare("UPDATE feeds SET last_success_at = datetime('now','-2 days'), next_run_at = datetime('now','-1 days'), cursor = ? WHERE id = ?").run(JSON.stringify({ bfNext: 'c' }), back.id);
  const refresh = mk('bluesky', 'refresh'); repo.db.prepare("UPDATE feeds SET last_success_at = datetime('now','-2 days'), next_run_at = datetime('now','-1 minutes'), cursor = ? WHERE id = ?").run(JSON.stringify({ newestAt: 'x' }), refresh.id);
  const w = engine._nextWork(cfg);
  assert.equal(w.feed.id, refresh.id);
  assert.equal(w.lane, 1);
});

test('budgets: a capped platform stops starting runs; lane 0 is never stopped', () => {
  const cfg = { ...settingsStore.get(), platformDailyRuns: 'x=2', backfillRunsPerDay: 1 };
  assert.equal(budget.allow('x', 1, cfg), true);
  budget.charge('x', 1); budget.charge('x', 1);
  assert.equal(budget.allow('x', 1, cfg), false);
  assert.equal(budget.allow('x', 0, cfg), true, 'someone is waiting');
  assert.equal(budget.allow('bluesky', 2, cfg), true);
  budget.charge('bluesky', 2);
  assert.equal(budget.allow('bluesky', 2, cfg), false, 'backfill cap');
  assert.equal(budget.allow('bluesky', 1, cfg), true, 'routine refresh is unaffected by the backfill cap');
  assert.deepEqual(budget.parseCaps('x=2, telegram: 5'), { x: 2, telegram: 5 });
});

test('a run that stopped inside the history comes back after the backfill gap, and each later run resumes exactly where the stored cursor says', async () => {
  const a = registry.get('redgifs');
  const real = a.fetch;
  let call = 0; const seen = [];
  a.fetch = async (feed, ctx) => {
    call++; const from = (ctx.cursor && ctx.cursor.pos) || 0;
    seen.push(from);
    return { items: [], via: 'test', cursor: { pos: from + 3 }, backfillPending: from + 3 < 9 };
  };
  try {
    const f = mk('redgifs', 'zed');
    await engine.runFeed(f.id, 'schedule');
    let row = repo.feeds.get(f.id);
    assert.equal(JSON.parse(row.cursor).backfillPending, true);
    const wait = new Date(row.next_run_at).getTime() - Date.now();
    assert.ok(wait > 0 && wait <= settingsStore.get().backfillGapMin * 60000 + 1000, `next slice soon (${Math.round(wait / 1000)}s)`);
    // "restart": nothing but the stored cursor carries over
    await engine.runFeed(f.id, 'schedule'); await engine.runFeed(f.id, 'schedule'); await engine.runFeed(f.id, 'schedule');
    assert.deepEqual(seen, [0, 3, 6, 9], 'each run resumed where the stored cursor said');
    row = repo.feeds.get(f.id);
    assert.ok(!JSON.parse(row.cursor).backfillPending);
    assert.ok(new Date(row.next_run_at).getTime() - Date.now() > settingsStore.get().backfillGapMin * 60000, 'done: back to the normal poll interval');
  } finally { a.fetch = real; }
});

/* ------------------------------------------------------------------ review fixes */
const aged = (id, { successAgoMin = 600, dueAgoMin = 1, cursor = { newestAt: 'x' }, failures = 0 } = {}) => repo.db.prepare("UPDATE feeds SET last_success_at = datetime('now', ?), next_run_at = datetime('now', ?), cursor = ?, consecutive_failures = ?, created_at = datetime('now','-30 days') WHERE id = ?")
  .run(`-${successAgoMin} minutes`, `-${dueAgoMin} minutes`, JSON.stringify(cursor), failures, id);

test('fairness: with 7 platforms each holding 100 due feeds, every platform gets a near-equal share of 400 picks', () => {
  const cfg = settingsStore.get();
  const plats = ['reddit', 'coomer', 'bluesky', 'gff', 'web', 'mastodon', 'lemmy'];
  for (const p of plats) for (let i = 0; i < 100; i++) aged(mk(p, `${p}${i}`).id, { dueAgoMin: 5 + i });
  const got = {};
  for (let i = 0; i < 400; i++) { const w = engine._nextWork(cfg); assert.ok(w, `pick ${i}`); got[w.feed.platform] = (got[w.feed.platform] || 0) + 1; repo.db.prepare("UPDATE feeds SET next_run_at = datetime('now','+1 day') WHERE id = ?").run(w.feed.id); }
  for (const p of plats) assert.ok(got[p] >= 400 / 7 - 6 && got[p] <= 400 / 7 + 6, `${p} got ${got[p]} of 400: ${JSON.stringify(got)}`);
});

test('a refresh feed due 30 s ago beats a backlog of 80 older backfill feeds on the same platform', () => {
  const cfg = settingsStore.get();
  for (let i = 0; i < 80; i++) aged(mk('bluesky', `bf${i}`).id, { dueAgoMin: 2000 + i, cursor: { newestAt: 'x', bfNext: 'c' } });
  const fresh = mk('bluesky', 'refresh'); aged(fresh.id, { dueAgoMin: 0.5 });
  const w = engine._nextWork(cfg);
  assert.equal(w.feed.id, fresh.id); assert.equal(w.lane, 1);
});

test('lane 0 is user-priority or genuinely new: 541 old never-succeeded feeds and feeds that keep failing do not get it', () => {
  const cfg = settingsStore.get();
  const old = mk('telegram', 'old'); repo.db.prepare("UPDATE feeds SET created_at = datetime('now','-10 days') WHERE id = ?").run(old.id);
  const failing = mk('telegram', 'failing'); repo.db.prepare("UPDATE feeds SET consecutive_failures = 3 WHERE id = ?").run(failing.id);
  const fresh = mk('telegram', 'fresh');
  const prio = mk('telegram', 'prio', { priority: 3 });
  const f = (x) => backfill.laneOf(repo.feeds.get(x.id), cfg);
  assert.equal(f(old), 1); assert.equal(f(failing), 1); assert.equal(f(fresh), 0); assert.equal(f(prio), 0);
  budget._reset();
  const cap = { ...cfg, platformDailyRuns: 'telegram=1' };
  budget.charge('telegram', 1);
  assert.equal(budget.allow('telegram', backfill.laneOf(repo.feeds.get(old.id), cap), cap), false, 'an old unread feed is subject to the budget');
});

test('image-filter concurrency has its own cap, whatever the number of feed slots', async () => {
  const imagefilter = require('../src/lib/imagefilter');
  settingsStore.update({ imageFilterConcurrency: 3 });
  let now = 0; let peak = 0;
  imagefilter._setAnalyzer(async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 15)); now--; return { status: 'ok', faces: [], hash: null }; });
  try {
    await Promise.all(Array.from({ length: 24 }, (_, i) => imagefilter.checkItem({ sourceId: `s${i}`, localImage: Buffer.from([1, 2, 3, 4]), mediaType: 'image' }, { faces: false })));
    assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
    assert.equal(imagefilter.gate().active, 0);
  } finally { imagefilter._reset(); settingsStore.update({ imageFilterConcurrency: 4 }); }
});
