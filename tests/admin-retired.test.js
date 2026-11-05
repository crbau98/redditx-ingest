'use strict';
/**
 * Admin overview, "recently paused by the app": GET /api/admin/sources/retired lists the feeds auto-retire paused and that
 * are still paused, so the console can offer one tap to turn one back on. A feed the admin switched back on is not listed.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let sourcehealth;
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const adm = async (path, o = {}) => {
  const res = await fetch(`${base}/api/admin${path}`, { method: o.method || 'GET', headers: ADMIN, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
let n = 0;
// A feed that has never worked: auto-retire (sourcehealth.retireDead) pauses an app-made feed that ran 12+ times in the window and never
// added an item. (The old "failed N runs in a row" rule is gone: the engine disables those feeds itself.)
const feed = (origin, { runs = 14 } = {}) => {
  const f = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: `retiredui${++n}`, origin, enabled: 1, trusted: 0 }).feed;
  repo.db.prepare('UPDATE feeds SET created_at = ?, last_run_at = ?, last_success_at = ?, consecutive_failures = 0, last_error = NULL, items_total = 0 WHERE id = ?')
    .run(iso(120 * DAY), iso(3600000), iso(3600000), f.id);
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, 0, 0)');
  for (let i = 0; i < runs; i++) ins.run(require('crypto').randomUUID(), f.id, iso(i * DAY + 3600000), iso(i * DAY), 'empty');
  return f;
};

before(async () => {
  prepareEnv({ MEDIA_STORE: 'disk' });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  sourcehealth = require('../src/engine/sourcehealth');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

test('needs the admin key', async () => {
  const res = await fetch(`${base}/api/admin/sources/retired`);
  assert.equal(res.status, 401);
});

test('lists feeds paused by auto-retire, with the reason and the time, newest first', async () => {
  const a = feed('discovered');
  const b = feed('seed');
  const mine = feed('admin', { runs: 30 });
  const r = sourcehealth.retireDead({ max: 1000 });
  assert.ok(r.paused.some((p) => p.id === a.id) && r.paused.some((p) => p.id === b.id));

  const out = await adm('/sources/retired');
  assert.equal(out.status, 200);
  const ids = out.json.items.map((x) => x.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id), 'both paused feeds are listed');
  assert.ok(!ids.includes(mine.id), 'a feed a person made is never auto-retired, so never listed');
  const row = out.json.items.find((x) => x.id === a.id);
  assert.equal(row.platform, 'reddit');
  assert.match(row.why, /never added anything/);
  assert.ok(row.retired_at && !Number.isNaN(Date.parse(row.retired_at)));
  assert.equal(out.json.total, out.json.items.length);
});

test('a feed the admin switched back on drops off the list', async () => {
  const f = feed('discovered');
  sourcehealth.retireDead({ max: 1000 });
  assert.ok((await adm('/sources/retired')).json.items.some((x) => x.id === f.id));
  const on = await adm(`/feeds/${f.id}`, { method: 'PATCH', body: { enabled: true, resetErrors: true } });
  assert.equal(on.status, 200);
  assert.ok(!(await adm('/sources/retired')).json.items.some((x) => x.id === f.id), 'enabled again: not listed');
  assert.equal(repo.feeds.get(f.id).enabled, 1);
});

test('old retirements fall out of the window', async () => {
  const f = feed('discovered');
  sourcehealth.retireDead({ max: 1000 });
  repo.db.prepare("UPDATE moderation_actions SET created_at = ? WHERE target_type = 'feed' AND target_id = ? AND action = 'auto-retire'").run(iso(20 * DAY), f.id);
  assert.ok(!(await adm('/sources/retired')).json.items.some((x) => x.id === f.id), 'default window is 14 days');
  assert.ok((await adm('/sources/retired?days=30')).json.items.some((x) => x.id === f.id), 'a wider window finds it');
});
