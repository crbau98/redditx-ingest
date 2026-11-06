'use strict';
/**
 * The background sweeps must not block the server.
 *
 * The link-health work list and the picture backfill's work list used to be asked of the WHOLE published
 * library in one statement, with an ORDER BY that made SQLite sort every published row into a temporary
 * B-tree. On the live database (389k published items) that cost 8-17 seconds per call, on the main thread:
 * the server could not answer a request for the duration, and it happened every ten minutes (link health)
 * and every minute (the picture backfill).
 *
 * These tests pin two things:
 *   1. the new statements pick THE SAME items, in THE SAME order, as the statements they replaced;
 *   2. they do not sort the library: the query plan has no temporary B-tree over the whole table.
 *
 * The old statements are kept here verbatim as the reference.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const health = require('../src/engine/health');
const visual = require('../src/engine/visual');
const settings = require('../src/settings');

const db = repo.db;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

let n = 0;
/**
 * A published item with a picture and a source page.
 * Each one gets a different score, so the `hot` tiebreak (score decayed by age) is a real order and not
 * an arbitrary one among equals: the old and the new statements must agree on the order, not just the set.
 */
const item = (extra = {}) => {
  const i = ++n;
  const id = repo.media.insert({
    platform: 'reddit', source_id: `pf${i}`, source_key: `pf:${i}:0`, post_key: `pf:${i}`,
    community: 'testsub', author: 'tester', title: `Item ${i}`, media_type: 'image',
    media_url: `https://i.redd.it/p${i}.jpg`, hash: `hpf${i}`, score: i, posted_at: iso(60 * DAY), ...extra,
  }) && db.prepare('SELECT id FROM media WHERE source_key = ?').get(`pf:${i}:0`).id;
  // `hot` is the stored popularity score the sweep orders by. It is normally recomputed from the score and
  // age; here it is set directly so the order the test checks is a real one and not a tie.
  db.prepare('UPDATE media SET hot = ? WHERE id = ?').run(i, id);
  return id;
};
const healthRow = (id, { checkedAt, verdict = 'ok', streak = 0 }) => {
  db.prepare('INSERT OR REPLACE INTO media_health (media_id, reports, last_report, checked_at, verdict, http_status, gone_streak) VALUES (?, 0, NULL, ?, ?, NULL, ?)')
    .run(id, checkedAt, verdict, streak);
};

/** The statements the sweeps used before, kept as the reference answer. */
const OLD_ORDER = health._OLD.ORDER;
const OLD_DUE = health._OLD.DUE;
const oldDue = (scope, n) => db.prepare(`SELECT m.id FROM media m LEFT JOIN media_health h ON h.media_id = m.id
      WHERE ${OLD_DUE} AND ${scope} ${OLD_ORDER}`).all({ stale: iso(14 * DAY), confirm: iso(HOUR), n });

const OLD_PENDING = `SELECT m.id FROM media m
      WHERE m.publish_state = 'published' AND m.scope != 'excluded'
        AND NOT EXISTS (SELECT 1 FROM media_embeddings e WHERE e.media_id = m.id AND (e.model = ? OR (e.model = 'fail' AND e.created_at > ?)))
      ORDER BY m.seq DESC LIMIT ?`;
const oldPending = (limit) => db.prepare(OLD_PENDING).all(visual._MODEL_ID, iso(14 * DAY), limit);

/** What the new code does: the same question, asked in tiers. */
const newDue = (scope, n) => health._dueRows({ scope, n, stale: iso(14 * DAY), confirm: iso(HOUR) });

before(() => { settings.get(); });

describe('the link-health work list', () => {
  test('picks the same items, in the same order, as the single statement it replaced', () => {
    // A mix: never checked, checked long ago, a "gone" verdict waiting for its second confirmation,
    // and a "gone" verdict that was checked only just now (so it must NOT be picked yet).
    const never = [item(), item(), item()];
    const stale = [item(), item()];
    const goneOld = [item(), item()];
    const goneFresh = [item()];
    for (const id of stale) healthRow(id, { checkedAt: iso(20 * DAY), verdict: 'ok' });
    for (const id of goneOld) healthRow(id, { checkedAt: iso(3 * HOUR), verdict: 'gone', streak: 1 });
    healthRow(goneFresh[0], { checkedAt: iso(5 * 60 * 1000), verdict: 'gone', streak: 1 });

    const scope = '1 = 1';
    const old = oldDue(scope, 50).map((r) => r.id);
    const now = newDue(scope, 50);

    assert.deepEqual(now, old, 'the tiers pick the same items in the same order');
    assert.ok(now.includes(goneOld[0]), 'a gone verdict waiting an hour is picked');
    assert.ok(!now.includes(goneFresh[0]), 'a gone verdict checked just now is not picked again yet');
    assert.ok(now.includes(never[0]), 'never-checked items are picked');
    assert.ok(now.includes(stale[0]), 'items checked long ago are picked');
  });

  test('the order is: waiting confirmations, then never checked, then the least recently checked', () => {
    const fresh = item();
    const old = item();
    const gone = item();
    // Two stale items (checked more than 14 days ago) and one "gone" verdict waiting for its second look.
    healthRow(old, { checkedAt: iso(30 * DAY), verdict: 'ok' });
    healthRow(fresh, { checkedAt: iso(20 * DAY), verdict: 'ok' });
    healthRow(gone, { checkedAt: iso(2 * HOUR), verdict: 'gone', streak: 1 });
    const ids = newDue('1 = 1', 50);
    const at = (id) => ids.indexOf(id);
    assert.ok(at(gone) >= 0, 'the waiting confirmation is picked');
    assert.ok(at(gone) < at(fresh), 'a waiting confirmation comes before a merely stale item');
    assert.ok(at(old) < at(fresh), 'the longest-ago check comes first');
  });

  test('an item checked inside the stale window is not picked, and a "gone" verdict checked just now is not picked again', () => {
    const recent = item();
    const goneFresh = item();
    healthRow(recent, { checkedAt: iso(2 * DAY), verdict: 'ok' });
    healthRow(goneFresh, { checkedAt: iso(5 * 60 * 1000), verdict: 'gone', streak: 1 });
    const ids = newDue('1 = 1', 50);
    assert.ok(!ids.includes(recent), 'a recent check is not due yet');
    assert.ok(!ids.includes(goneFresh), 'a "gone" verdict waits an hour for its second look');
  });

  test('the rot-host cohort and the rest are asked about separately, and a cohort item is not in the general list', () => {
    const cohort = item({ media_url: 'https://i.redd.it/cohort.jpg' });
    const other = item({ media_url: 'https://example.com/other.jpg' });
    const cohortScope = `(m.posted_at < @cutoff AND (m.media_url LIKE @h0 OR COALESCE(m.preview_url, '') LIKE @h0))`;
    const params = { cutoff: iso(14 * DAY), h0: '%://i.redd.it/%' };
    const cohortList = health._dueRows({ scope: cohortScope, params, n: 50, stale: iso(14 * DAY), confirm: iso(HOUR) });
    const generalList = health._dueRows({ scope: `NOT ${cohortScope}`, params, n: 50, stale: iso(14 * DAY), confirm: iso(HOUR) });
    assert.ok(cohortList.includes(cohort), 'the cohort item is in the cohort list');
    assert.ok(!generalList.includes(cohort), 'and not in the general list');
    assert.ok(generalList.includes(other), 'the other item is in the general list');
  });

  test('the query plan has no temporary sort over the library', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT m.id FROM media m INDEXED BY ix_media_pub_hot WHERE m.publish_state = \'published\' AND 1 = 1 AND NOT EXISTS (SELECT 1 FROM media_health h WHERE h.media_id = m.id AND h.checked_at IS NOT NULL) ORDER BY m.hot DESC LIMIT 40').all();
    const text = plan.map((r) => r.detail).join(' | ');
    assert.ok(!/TEMP B-TREE/.test(text), `the never-checked query must not sort: ${text}`);
  });
});

describe('the picture backfill work list', () => {
  before(() => { visual.ensureTable(); });

  test('picks the same items, in the same order, as the statement it replaced', () => {
    const withVector = [item(), item()];
    const without = [item(), item(), item()];
    const save = db.prepare('INSERT OR REPLACE INTO media_embeddings (media_id, model, vec, created_at) VALUES (?, ?, ?, ?)');
    for (const id of withVector) save.run(id, visual._MODEL_ID, Buffer.alloc(256), iso(HOUR));
    const old = oldPending(50).map((r) => r.id);
    const now = visual._pending(50).map((r) => r.id);
    assert.deepEqual(now, old, 'the same items, in the same order');
    assert.ok(now.includes(without[0]), 'items without a vector are picked');
    assert.ok(!now.includes(withVector[0]), 'items with a vector are not picked');
  });

  test('the query plan has no temporary sort over the library', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT m.id FROM media m NOT INDEXED WHERE m.publish_state = \'published\' AND m.scope != \'excluded\' AND NOT EXISTS (SELECT 1 FROM media_embeddings e WHERE e.media_id = m.id AND (e.model = ? OR (e.model = \'fail\' AND e.created_at > ?))) ORDER BY m.rowid DESC LIMIT 40').all(visual._MODEL_ID, iso(14 * DAY));
    const text = plan.map((r) => r.detail).join(' | ');
    assert.ok(!/TEMP B-TREE/.test(text), `the pending query must not sort: ${text}`);
  });
});
