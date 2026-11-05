'use strict';
/**
 * Auto-retire: the app pauses the feeds IT made when they have clearly stopped working, and never the ones a person made.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let repo; let sourcehealth; let maintenance; let settingsStore;
const HOUR = 3600000; const DAY = 24 * HOUR;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
let n = 0;

before(() => {
  prepareEnv({ MEDIA_STORE: 'disk' });
  repo = require('../src/db/repo');
  sourcehealth = require('../src/engine/sourcehealth');
  maintenance = require('../src/engine/maintenance');
  settingsStore = require('../src/settings');
});

/** A feed with a given origin and run history. */
function feed(origin, { fails = 0, lastOk = iso(HOUR), runs = 0, added = 0, fetched = 0 } = {}) {
  const f = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: `retire${++n}`, origin, enabled: 1, trusted: 0 }).feed;
  repo.db.prepare('UPDATE feeds SET created_at = ?, last_run_at = ?, last_success_at = ?, consecutive_failures = ?, last_error = ? WHERE id = ?')
    .run(iso(120 * DAY), iso(HOUR), lastOk, fails, fails ? 'HTTP 403' : null, f.id);
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < runs; i++) ins.run(crypto.randomUUID(), f.id, iso(i * DAY + HOUR), iso(i * DAY), added ? 'ok' : 'empty', fetched, added ? 3 : 0);
  return f;
}
const enabled = (f) => repo.feeds.get(f.id).enabled;

test('a feed the app made, failing for weeks with no success, is paused with a reason and an action row', () => {
  const f = feed('discovered', { fails: 25, lastOk: iso(30 * DAY) });
  const r = sourcehealth.retireDead({ max: 1000 });
  assert.ok(r.paused.some((p) => p.id === f.id), 'paused');
  assert.equal(enabled(f), 0, 'paused, not deleted');
  assert.ok(repo.feeds.get(f.id), 'the feed still exists');
  const a = repo.db.prepare("SELECT action, reason, actor FROM moderation_actions WHERE target_type = 'feed' AND target_id = ? ORDER BY id DESC LIMIT 1").get(String(f.id));
  assert.equal(a.action, 'auto-retire'); assert.equal(a.actor, 'system'); assert.match(a.reason, /failed 25 runs in a row/);
});

test('a feed the app made that ran 12+ times in 45 days and added nothing is paused', () => {
  const f = feed('seed', { runs: 14, fetched: 20, added: 0 });
  assert.ok(sourcehealth.retireDead({ max: 1000 }).paused.some((p) => p.id === f.id));
  assert.equal(enabled(f), 0);
});

test('feeds a person made (admin, import) are never touched, however broken', () => {
  const a = feed('admin', { fails: 99, lastOk: iso(200 * DAY) });
  const i = feed('import', { runs: 30, added: 0 });
  const r = sourcehealth.retireDead({ max: 1000 });
  assert.ok(!r.paused.some((p) => p.id === a.id || p.id === i.id));
  assert.equal(enabled(a), 1); assert.equal(enabled(i), 1);
});

test('healthy, merely slow or recently-failing feeds stay on', () => {
  const healthy = feed('discovered', { runs: 14, fetched: 20, added: 4 });
  const blip = feed('discovered', { fails: 25, lastOk: iso(2 * DAY) });   // failing, but it worked 2 days ago
  const few = feed('discovered', { fails: 5, lastOk: iso(30 * DAY) });    // not enough failures yet
  const young = feed('discovered', { runs: 5, added: 0 });               // not enough runs yet
  sourcehealth.retireDead({ max: 1000 });
  for (const f of [healthy, blip, few, young]) assert.equal(enabled(f), 1, f.target);
});

test('a feed an admin turned back on is left alone, and a dry run changes nothing', () => {
  const f = feed('discovered', { fails: 30, lastOk: iso(40 * DAY) });
  const dry = sourcehealth.retireDead({ max: 1000, dryRun: true });
  assert.ok(dry.paused.some((p) => p.id === f.id)); assert.equal(enabled(f), 1, 'dry run: nothing changed');
  repo.logAction('feed', f.id, 'enable', 'it works for me', 'admin');
  const r = sourcehealth.retireDead({ max: 1000 });
  assert.ok(!r.paused.some((p) => p.id === f.id), 'the admin decision stands'); assert.equal(enabled(f), 1);
});

test('one call pauses at most `max` feeds, so a bad day cannot empty the library', () => {
  for (let i = 0; i < 5; i++) feed('discovered', { fails: 40, lastOk: iso(60 * DAY) });
  const r = sourcehealth.retireDead({ max: 2 });
  assert.equal(r.paused.length, 2); assert.equal(r.capped, true);
});

test('the daily hook runs once a day and honours the setting', () => {
  const f = feed('discovered', { fails: 50, lastOk: iso(90 * DAY) });
  settingsStore.update({ autoRetireFeeds: false });
  try {
    assert.equal(maintenance.retireDeadFeeds(Date.now() + 10 * DAY), null, 'switched off: nothing runs');
    assert.equal(enabled(f), 1);
    settingsStore.update({ autoRetireFeeds: true });
    assert.equal(maintenance.retireDeadFeeds(Date.now() + 10 * DAY + 1000), null, 'ran a moment ago: waits a day');
    const r = maintenance.retireDeadFeeds(Date.now() + 12 * DAY);
    assert.ok(r && r.paused.some((p) => p.id === f.id)); assert.equal(enabled(f), 0);
  } finally { settingsStore.update({ autoRetireFeeds: true }); }
});
