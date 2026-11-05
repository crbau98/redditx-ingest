'use strict';
/**
 * Ingestion failures made legible: every failing feed carries WHY (blocked / not found / rate limited / parse / ...), the
 * report counts runs by cause per platform, and the feeds the engine switched off are listed with their reason.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let repo; let sourcehealth; let engine; let server; let base;
const HOUR = 3600000; const DAY = 24 * HOUR;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ADMIN = { 'x-admin-key': 'test-key' };
let n = 0;

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  sourcehealth = require('../src/engine/sourcehealth');
  engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

function feed(platform, { enabled = 1, fails = 0, lastError = null, lastStatus = null } = {}) {
  const f = repo.feeds.upsert({ platform, kind: 'user', target: `h${++n}`, origin: 'discovered', enabled }).feed;
  repo.db.prepare('UPDATE feeds SET enabled = ?, consecutive_failures = ?, last_error = ?, last_status = ?, last_run_at = ?, created_at = ? WHERE id = ?')
    .run(enabled, fails, lastError, lastStatus, iso(HOUR), iso(90 * DAY), f.id);
  return repo.feeds.get(f.id);
}
function run(f, status, error, msAgo = HOUR) {
  repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, error) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), f.id, iso(msAgo), iso(msAgo), status, error);
}

test('failing feeds carry the cause of their last error', () => {
  const a = feed('rss', { fails: 4, lastError: 'HTTP 403 for https://site.example/feed.xml', lastStatus: 'error' });
  const b = feed('rss', { fails: 3, lastError: 'HTTP 429 for https://site.example/b.xml', lastStatus: 'error' });
  const rep = sourcehealth.report();
  const byId = Object.fromEntries(rep.failing.map((f) => [f.id, f]));
  assert.equal(byId[a.id].errorKind, 'blocked');
  assert.equal(byId[b.id].errorKind, 'rate_limited');
  assert.equal(rep.failingByKind.blocked >= 1 && rep.failingByKind.rate_limited >= 1, true);
});

test('runs of the last week are counted by cause, in total and per platform; empty runs are their own cause', () => {
  const f1 = feed('bluesky'); const f2 = feed('bluesky'); const f3 = feed('x');
  run(f1, 'error', 'HTTP 429 for https://bsky.example/x');
  run(f1, 'error', 'HTTP 429 for https://bsky.example/x');
  run(f2, 'error', 'Invalid JSON from https://bsky.example/y');
  run(f2, 'empty', null);
  run(f3, 'skipped', 'X_BEARER_TOKEN is not set (not configured)');
  run(f3, 'error', 'HTTP 404 for https://x.example/z');
  run(f3, 'error', 'HTTP 403 for https://x.example/old', 20 * DAY); // outside the window: not counted
  const { causes } = sourcehealth.report();
  assert.equal(causes.days, 7);
  const bsky = causes.byPlatform.bluesky;
  assert.equal(bsky.rate_limited, 2); assert.equal(bsky.parse, 1); assert.equal(bsky.empty, 1);
  const x = causes.byPlatform.x;
  assert.equal(x.config, 1); assert.equal(x.not_found, 1); assert.equal(x.blocked || 0, 0);
  assert.ok(causes.total.rate_limited >= 2 && causes.total.parse >= 1 && causes.total.empty >= 1 && causes.total.not_found >= 1);
  assert.equal(typeof causes.truncated, 'boolean');
});

test('feeds the engine switched off are listed with the reason, newest first, and a person-made pause is not', () => {
  const gone = feed('reddit', { enabled: 0, fails: 3, lastError: 'Not found (404) — disabled after 3 tries', lastStatus: 'error' });
  const chronic = feed('rss', { enabled: 0, fails: 5, lastError: 'Chronic failure (5 consecutive errors: Invalid JSON from https://q.example) — disabled', lastStatus: 'error' });
  const manual = feed('rss', { enabled: 0, fails: 0, lastError: null, lastStatus: 'ok' });
  const { disabled, totals } = sourcehealth.report();
  const ids = disabled.map((d) => d.id);
  assert.ok(ids.includes(gone.id) && ids.includes(chronic.id));
  assert.ok(!ids.includes(manual.id));
  assert.equal(disabled.find((d) => d.id === gone.id).errorKind, 'not_found');
  assert.equal(disabled.find((d) => d.id === chronic.id).errorKind, 'parse');
  assert.ok(totals.disabledByEngine >= 2);
});

test('a feed the library sweep switched off (it leaves last_error alone) is listed too, until a person changes it', () => {
  const repoLocal = require('../src/db/repo');
  const swept = feed('rss', { enabled: 0, fails: 4, lastError: 'HTTP 410 Gone for https://dead.example/a.xml', lastStatus: 'error' });
  repoLocal.logAction('feed', swept.id, 'sweep-disable', 'not_found, 4 failures', 'system');
  const before = sourcehealth.report();
  assert.ok(before.disabled.some((d) => d.id === swept.id), 'listed although its last_error never says "disabled"');
  const n = before.totals.disabledByEngine;
  repoLocal.logAction('feed', swept.id, 'enable', 'I turned it back on and off', 'admin');
  const after = sourcehealth.report();
  assert.ok(!after.disabled.some((d) => d.id === swept.id), 'a person acted since: not the engine\'s any more');
  assert.equal(after.totals.disabledByEngine, n - 1);
});

test('maintenance.sweep records the marker when it disables a failing feed', async () => {
  const maintenance = require('../src/engine/maintenance');
  const f = feed('rss', { enabled: 1, fails: 5, lastError: 'HTTP 410 Gone for https://dead.example/b.xml', lastStatus: 'error' });
  await maintenance.sweep({ limit: 1 });
  assert.equal(require('../src/db/repo').feeds.get(f.id).enabled, 0);
  assert.ok(sourcehealth.report().disabled.some((d) => d.id === f.id), 'the report lists what the sweep switched off');
});

test('the admin API exposes it: /sources/health, and a cause on each feed and run row', async () => {
  const f = feed('mastodon', { fails: 2, lastError: 'HTTP 503 Service Unavailable for https://m.example/api', lastStatus: 'error' });
  run(f, 'error', 'HTTP 503 Service Unavailable for https://m.example/api');
  const health = await (await fetch(`${base}/api/admin/sources/health`, { headers: ADMIN })).json();
  assert.ok(health.causes && health.causes.byPlatform.mastodon.server >= 1);
  const feeds = await (await fetch(`${base}/api/admin/feeds?platform=mastodon`, { headers: ADMIN })).json();
  assert.equal(feeds.items.find((x) => x.id === f.id).last_error_kind, 'server');
  const runs = await (await fetch(`${base}/api/admin/runs?feedId=${f.id}`, { headers: ADMIN })).json();
  assert.equal(runs[0].error_kind, 'server');
});

test('warnings and errors survive INFO chatter: they have a log of their own, also over the admin API', async () => {
  const events = require('../src/engine/events');
  events.clearLogs();
  events.log('ERR', 'rss/feed:https://x.example/a.xml: HTTP 403');
  events.log('WARN', 'Media host cdn.example refuses this server');
  for (let i = 0; i < 700; i++) events.log('INFO', `run ${i}`);
  assert.ok(!events.getLogs(600).some((l) => l.level === 'ERR'), 'pushed out of the main log');
  assert.deepEqual(events.getProblems().map((l) => l.level), ['ERR', 'WARN']);
  const api = await (await fetch(`${base}/api/admin/logs?level=problems`, { headers: ADMIN })).json();
  assert.equal(api.length, 2); assert.match(api[0].msg, /HTTP 403/);
  assert.equal((await (await fetch(`${base}/api/admin/logs`, { headers: ADMIN })).json()).length, 300, 'the plain log is unchanged');
});

test('the review queue is counted: how many wait, how long, and why', () => {
  const ins = repo.db.prepare(`INSERT INTO media (id, platform, source_key, post_key, media_type, media_url, hash, publish_state, review_reason, ingested_at)
    VALUES (?, 'rss', ?, ?, 'image', 'https://q.example/a.jpg', ?, 'review', ?, ?)`);
  const add = (reason, msAgo) => { const id = crypto.randomUUID(); ins.run(id, `rss:rq${id}:0`, `rss:rq${id}`, id.replace(/-/g, ''), reason, iso(msAgo)); };
  add('scope:unclear', 12 * DAY); add('scope:unclear', 1 * DAY); add('attribution:telegram-ambiguous', 2 * HOUR); add(null, 9 * DAY);
  const { reviewQueue: q } = sourcehealth.report();
  assert.equal(q.total, 4); assert.equal(q.olderThan7d, 2);
  assert.ok(Date.parse(q.oldestAt) <= Date.now() - 11 * DAY);
  const by = Object.fromEntries(q.byReason.map((r) => [r.reason, r.n]));
  assert.equal(by['scope:unclear'], 2); assert.equal(by['attribution:telegram-ambiguous'], 1); assert.equal(by.unspecified, 1);
});
