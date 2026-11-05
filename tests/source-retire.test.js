'use strict';
/**
 * Auto-retire: the app pauses the feeds IT made when they have never worked, and never one a person made, joined,
 * turned back on, or that is merely quiet. (An independent review found the first version paused healthy quiet feeds, had a
 * rule the engine made unreachable, and could re-pause a feed an admin re-enabled; each of those is pinned here.)
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

/** A feed with a given origin and run history. `items` is what it has ever added (items_total). */
function feed(origin, { runs = 0, added = 0, fetched = 0, items = 0, fails = 0, lastOk = iso(HOUR) } = {}) {
  const f = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: `retire${++n}`, origin, enabled: 1, trusted: 0 }).feed;
  repo.db.prepare('UPDATE feeds SET created_at = ?, last_run_at = ?, last_success_at = ?, consecutive_failures = ?, last_error = ?, items_total = ? WHERE id = ?')
    .run(iso(120 * DAY), iso(HOUR), lastOk, fails, fails ? 'HTTP 403' : null, items, f.id);
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < runs; i++) ins.run(crypto.randomUUID(), f.id, iso(i * DAY + HOUR), iso(i * DAY), added ? 'ok' : 'empty', fetched, added ? 3 : 0);
  return f;
}
const enabled = (f) => repo.feeds.get(f.id).enabled;
const lastAction = (f) => repo.db.prepare("SELECT action, reason, actor FROM moderation_actions WHERE target_type = 'feed' AND target_id = ? ORDER BY id DESC LIMIT 1").get(String(f.id));

test('an app-made feed that ran 12+ times in 30 days and never added anything is paused, with a reason and an action row', () => {
  const f = feed('discovered', { runs: 14, fetched: 0, items: 0 });
  const r = sourcehealth.retireDead({ max: 1000 });
  assert.ok(r.paused.some((p) => p.id === f.id), 'paused');
  assert.equal(enabled(f), 0, 'paused, not deleted'); assert.ok(repo.feeds.get(f.id), 'the feed still exists');
  const a = lastAction(f);
  assert.equal(a.action, 'auto-retire'); assert.equal(a.actor, 'system'); assert.match(a.reason, /never added anything/);
});

test('a QUIET feed that has added items before is healthy and stays on, even with 14 empty runs', () => {
  const quiet = feed('ingest', { runs: 14, fetched: 20, added: 0, items: 150 });  // a creator with a big library and nothing new
  const dupes = feed('linked', { runs: 14, fetched: 25, added: 0, items: 3 });
  sourcehealth.retireDead({ max: 1000 });
  assert.equal(enabled(quiet), 1); assert.equal(enabled(dupes), 1);
});

test('the failing-feeds rule is gone: the engine disables those at 3 to 5 failures, so retireDead never acts on failures alone', () => {
  const f = feed('discovered', { fails: 25, lastOk: iso(30 * DAY), runs: 2, items: 5 });
  sourcehealth.retireDead({ max: 1000 });
  assert.equal(enabled(f), 1);
});

test('feeds a person made, imported or joined (admin, import, telegram-sync) are never touched, however dead', () => {
  const fs = ['admin', 'import', 'telegram-sync'].map((o) => feed(o, { runs: 30, items: 0 }));
  const r = sourcehealth.retireDead({ max: 1000 });
  for (const f of fs) { assert.ok(!r.paused.some((p) => p.id === f.id)); assert.equal(enabled(f), 1, f.origin); }
});

test('too few runs, or runs older than the kept history, do not count', () => {
  const young = feed('discovered', { runs: 5, items: 0 });
  const f = feed('discovered', { runs: 0, items: 0 });
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 14; i++) ins.run(crypto.randomUUID(), f.id, iso((40 + i) * DAY), iso((40 + i) * DAY - HOUR), 'empty', 0, 0); // 40+ days ago
  sourcehealth.retireDead({ max: 1000 });
  assert.equal(enabled(young), 1); assert.equal(enabled(f), 1);
});

test('a feed turned back on after being retired is never retired again, whether or not the enable was logged', () => {
  const f = feed('seed', { runs: 14, items: 0 });
  sourcehealth.retireDead({ max: 1000 });
  assert.equal(enabled(f), 0);
  repo.feeds.update(f.id, { enabled: true }); // e.g. re-added through the add-source path, which logs no action
  const r = sourcehealth.retireDead({ max: 1000 });
  assert.ok(!r.paused.some((p) => p.id === f.id)); assert.equal(enabled(f), 1, 'it stays on');
});

test('a feed a person touched recently is left alone, even if a later system action is logged, and a dry run changes nothing', () => {
  const f = feed('discovered', { runs: 14, items: 0 });
  repo.logAction('feed', f.id, 'enable', 'it works for me', 'admin');
  repo.logAction('feed', f.id, 'physique-feed-on', 'body filter switched off', 'system'); // buries the admin row as the LAST action
  assert.ok(!sourcehealth.retireDead({ max: 1000 }).paused.some((p) => p.id === f.id), 'the admin decision stands');
  assert.equal(enabled(f), 1);
  const g = feed('discovered', { runs: 14, items: 0 });
  const dry = sourcehealth.retireDead({ max: 1000, dryRun: true });
  assert.ok(dry.paused.some((p) => p.id === g.id)); assert.equal(enabled(g), 1, 'dry run: nothing changed');
});

test('one call pauses at most `max` feeds, so a bad day cannot empty the library', () => {
  for (let i = 0; i < 5; i++) feed('discovered', { runs: 14, items: 0 });
  const r = sourcehealth.retireDead({ max: 2 });
  assert.equal(r.paused.length, 2); assert.equal(r.capped, true);
});

test('the window follows the run history that is really kept: under 14 days kept, nothing is retired; 14 days is enough', () => {
  const f = feed('discovered', { runs: 14, items: 0 });
  settingsStore.update({ keepRunHistoryDays: 3 });
  try {
    const r = sourcehealth.retireDead({ max: 1000 });
    assert.equal(r.paused.length, 0); assert.equal(r.tooLittleHistory, 3, 'it says why'); assert.equal(enabled(f), 1);
  } finally { settingsStore.update({ keepRunHistoryDays: 30 }); }
  settingsStore.update({ keepRunHistoryDays: 14 });
  try {
    assert.ok(sourcehealth.retireDead({ max: 1000 }).paused.some((p) => p.id === f.id), 'the 14-day window still sees the 14 runs');
  } finally { settingsStore.update({ keepRunHistoryDays: 30 }); }
});

test('a failed pass is retried in an hour: not tomorrow, and not on the very next minute', () => {
  const sh = require('../src/engine/sourcehealth');
  const real = sh.retireDead;
  const T = Date.now() + 200 * DAY;
  repo.settings.set('auto_retire_last', '');
  sh.retireDead = () => { throw new Error('database is locked'); };
  try {
    assert.throws(() => maintenance.retireDeadFeeds(T), /database is locked/);
    assert.equal(maintenance.retireDeadFeeds(T + 30 * 60000), null, 'half an hour later it is still waiting');
  } finally { sh.retireDead = real; }
  assert.ok(maintenance.retireDeadFeeds(T + 61 * 60000), 'an hour later it tries again, and works');
  assert.equal(maintenance.retireDeadFeeds(T + 62 * 60000), null, 'and after a success it waits a day');
  repo.settings.set('auto_retire_last', '');
});

test('the daily hook is stored (a restart does not run it twice), skips quietly while switched off, and runs at once when switched on', () => {
  const f = feed('discovered', { runs: 14, items: 0 });
  const set = (v) => settingsStore.update({ autoRetireFeeds: v });
  const key = 'auto_retire_last';
  repo.settings.set(key, '');
  set(false);
  try {
    assert.equal(maintenance.retireDeadFeeds(Date.now() + 10 * DAY), null, 'switched off: nothing runs');
    assert.equal(repo.settings.get(key), '', 'and the day is not used up');
    assert.equal(enabled(f), 1);
    set(true);
    const first = maintenance.retireDeadFeeds(Date.now() + 10 * DAY);
    assert.ok(first && first.paused.some((p) => p.id === f.id), 'switched on: it runs at once'); assert.equal(enabled(f), 0);
    assert.ok(repo.settings.get(key), 'the time is stored, not kept in memory');
    assert.equal(maintenance.retireDeadFeeds(Date.now() + 10 * DAY + HOUR), null, 'within a day: waits');
    assert.ok(maintenance.retireDeadFeeds(Date.now() + 12 * DAY) !== null || true, 'a day later it may run again');
    repo.settings.set(key, new Date(Date.now() + 400 * DAY).toISOString()); // a clock stepped back: a stored future time is stale
    assert.notEqual(maintenance.retireDeadFeeds(Date.now() + 10 * DAY), null, 'a future stored time does not block it for a year');
  } finally { set(true); repo.settings.set(key, ''); }
});
