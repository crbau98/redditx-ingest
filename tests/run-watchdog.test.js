'use strict';
/**
 * Run watchdog (Halyard: feeds stuck 'running' for an hour held their platform slot and wore their label into every
 * loop-block report until a restart). Every run has a hard deadline that covers whatever it awaits, and the engine tick
 * closes any run row still 'running' past it.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
let repo; let engine; let registry; let blockwatch; let realGet;
before(() => {
  repo = require('../src/db/repo'); engine = require('../src/engine/engine');
  registry = require('../src/sources'); blockwatch = require('../src/lib/blockwatch');
  realGet = registry.get;
});
after(() => { registry.get = realGet; engine.shutdown(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a run whose fetch never returns is closed as an error at its hard deadline and releases its slot and label', async () => {
  let fetches = 0;
  const hung = { platform: 'hangtest', kinds: ['user'], isConfigured: () => ({ ok: true }), fetch: () => { fetches++; return new Promise(() => {}); } };
  registry.get = (p) => (p === 'hangtest' ? hung : realGet(p));
  const feed = repo.feeds.upsert({ platform: 'hangtest', kind: 'user', target: 'stuck', runNow: false }).feed;
  const pending = engine.runFeed(feed, 'manual', { hardDeadlineMs: 150 });
  await wait(20);
  assert.equal(fetches, 1);
  assert.ok(engine._state.running.has(feed.id), 'running while the fetch waits');
  assert.ok(blockwatch.labels().includes(`feed hangtest:${feed.id}`));
  await wait(250);
  const run = repo.db.prepare('SELECT status, error FROM feed_runs WHERE feed_id = ? ORDER BY started_at DESC LIMIT 1').get(feed.id);
  assert.equal(run.status, 'error');
  assert.match(run.error, /hard deadline/);
  assert.equal(engine._state.running.has(feed.id), false, 'the slot is free');
  blockwatch._noteBlock(0);
  assert.ok(!blockwatch.labels().includes(`feed hangtest:${feed.id}`), 'the label is gone');
  const row = repo.feeds.get(feed.id);
  assert.equal(row.last_status, 'error');
  assert.match(row.last_error, /hard deadline/);
  void pending; // still waiting on the hung fetch; nothing more is recorded when it ends
});

test('a run that finishes in time is not touched by its deadline', async () => {
  const quick = { platform: 'quicktest', kinds: ['user'], isConfigured: () => ({ ok: true }), fetch: async () => ({ items: [] }) };
  registry.get = (p) => (p === 'quicktest' ? quick : realGet(p));
  const feed = repo.feeds.upsert({ platform: 'quicktest', kind: 'user', target: 'fine', runNow: false }).feed;
  const r = await engine.runFeed(feed, 'manual', { hardDeadlineMs: 150 });
  assert.equal(r.status, 'empty');
  await wait(250);
  const run = repo.db.prepare('SELECT status FROM feed_runs WHERE feed_id = ? ORDER BY started_at DESC LIMIT 1').get(feed.id);
  assert.equal(run.status, 'empty', 'not rewritten by a late deadline');
});

test('the watchdog sweep marks run rows still running after 15 minutes, and only those', () => {
  const feed = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'sweepme', runNow: false }).feed;
  const ins = repo.db.prepare("INSERT INTO feed_runs (id, feed_id, started_at, status) VALUES (?, ?, ?, 'running')");
  ins.run('stale-run', feed.id, new Date(Date.now() - 20 * 60_000).toISOString());
  ins.run('fresh-run', feed.id, new Date(Date.now() - 2 * 60_000).toISOString());
  assert.equal(repo.runs.timeoutStale(15 * 60_000), 1);
  const get = (id) => repo.db.prepare('SELECT status, error FROM feed_runs WHERE id = ?').get(id);
  assert.equal(get('stale-run').status, 'error');
  assert.match(get('stale-run').error, /watchdog/);
  assert.equal(get('fresh-run').status, 'running');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'engine', 'engine.js'), 'utf8');
  assert.match(src, /async function tick\(\) \{[\s\S]{0,400}repo\.runs\.timeoutStale\(RUN_HARD_MS\)/, 'the tick runs the sweep');
});
