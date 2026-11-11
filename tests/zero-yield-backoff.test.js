'use strict';
/**
 * Zero-yield backoff (Halyard: link-in-bio, PeerTube, empty Coomer/Bluesky polls dominated run volume with 0 items).
 * A feed whose runs over 7 days (at least 5) fetched nothing is checked every 3 days; one fetched item restores it.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let engine; let registry; let realGet; let server; let base;
before(async () => {
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); registry = require('../src/sources'); realGet = registry.get;
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { registry.get = realGet; engine.shutdown(); await new Promise((r) => server.close(r)); });

const DAY = 86400000;
let n = 0;
function seedRuns(feedId, list) { // [{ daysAgo, fetched, status }]
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of list) { n++; const at = new Date(Date.now() - r.daysAgo * DAY).toISOString(); ins.run(`zy${n}`, feedId, at, at, r.status || (r.fetched ? 'ok' : 'empty'), r.fetched); }
}
const feed = (target, platform = 'linkinbio') => repo.feeds.upsert({ platform, kind: platform === 'linkinbio' ? 'page' : 'user', target, runNow: false }).feed;

test('the scoreboard counts runs and fetched items inside the window only', () => {
  const f = feed('https://linktr.ee/scoreboard');
  seedRuns(f.id, [{ daysAgo: 1, fetched: 0 }, { daysAgo: 2, fetched: 0 }, { daysAgo: 9, fetched: 12 }]);
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  assert.deepEqual(repo.runs.yieldSince(f.id, since), { runs: 2, fetched: 0 }, 'the 9-day-old productive run is outside the 7 days');
  assert.deepEqual(repo.runs.yieldSince(f.id, new Date(Date.now() - 10 * DAY).toISOString()), { runs: 3, fetched: 12 });
});

test('a feed with 5+ empty runs over 7 days backs off to 3 days; a recent item or too few runs keeps its pace', () => {
  const idle = feed('https://linktr.ee/idle');
  seedRuns(idle.id, [1, 2, 3, 4, 5, 6].map((d) => ({ daysAgo: d, fetched: 0 })));
  const next = Date.parse(engine.idleNextRun(idle, 0));
  assert.ok(next - Date.now() > 2.6 * DAY && next - Date.now() < 3.4 * DAY, 'about three days');
  assert.equal(engine.idleNextRun(idle, 4), null, 'this run fetched something: normal pace');

  const woke = feed('https://linktr.ee/woke');
  seedRuns(woke.id, [{ daysAgo: 1, fetched: 0 }, { daysAgo: 2, fetched: 3 }, { daysAgo: 3, fetched: 0 }, { daysAgo: 4, fetched: 0 }, { daysAgo: 5, fetched: 0 }]);
  assert.equal(engine.idleNextRun(woke, 0), null, 'one item in 7 days: no backoff');

  const young = feed('https://linktr.ee/young');
  seedRuns(young.id, [{ daysAgo: 1, fetched: 0 }, { daysAgo: 2, fetched: 0 }]);
  assert.equal(engine.idleNextRun(young, 0), null, 'too few runs to judge');

  require('../src/settings').update({ adaptiveScheduling: false });
  try { assert.equal(engine.idleNextRun(idle, 0), null, 'the adaptive-scheduling switch turns it off'); }
  finally { require('../src/settings').update({ adaptiveScheduling: true }); }
});

test('an empty run of an idle feed is scheduled 3 days out; nothing is disabled', async () => {
  const empty = { platform: 'idletest', kinds: ['user'], isConfigured: () => ({ ok: true }), fetch: async () => ({ items: [] }) };
  registry.get = (p) => (p === 'idletest' ? empty : realGet(p));
  const f = feed('quietaccount', 'idletest');
  seedRuns(f.id, [1, 2, 3, 4, 5].map((d) => ({ daysAgo: d, fetched: 0 })));
  const before7 = repo.runs.yieldSince(f.id, new Date(Date.now() - 7 * DAY).toISOString());
  const r = await engine.runFeed(f, 'schedule');
  assert.equal(r.status, 'empty');
  const after7 = repo.runs.yieldSince(f.id, new Date(Date.now() - 7 * DAY).toISOString());
  assert.deepEqual([before7, after7], [{ runs: 5, fetched: 0 }, { runs: 6, fetched: 0 }]);
  const row = repo.feeds.get(f.id);
  assert.equal(row.enabled, 1, 'still enabled');
  assert.ok(Date.parse(row.next_run_at) - Date.now() > 2.6 * DAY);
});

test('admins see the idle list; it is read-only and admin-only', async () => {
  const res = await fetch(`${base}/feeds/idle`, { headers: { 'x-admin-key': 'test-key' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const targets = body.items.map((i) => i.target);
  assert.ok(targets.includes('https://linktr.ee/idle'));
  assert.ok(targets.includes('quietaccount'));
  assert.ok(!targets.includes('https://linktr.ee/woke') && !targets.includes('https://linktr.ee/young'));
  const row = body.items.find((i) => i.target === 'https://linktr.ee/idle');
  assert.equal(row.runs, 6); assert.equal(row.enabled, true);
  assert.equal(body.days, 7); assert.equal(body.minRuns, 5);
  assert.equal((await fetch(`${base}/feeds/idle`)).status, 401);
});
