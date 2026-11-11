'use strict';
/**
 * Keyless X budget (Halyard: the 150/day cap was spent by mid-day; feeds with hits re-searched every run although nothing
 * was new, and a spent cap retried every ~45 min). A search that only re-finds seen posts rests 12 h without spending, a
 * cached answer costs nothing, and a spent cap waits for the daily reset.
 */
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let fxHits = 0;
let x; let websearch; let repo; let engine; let calls; let answer; let realSearch; let realConfigured;
before(async () => {
  // post reads (fxtwitter / X embed) go to a local mock: no network
  mock = await start({
    '/status/333': () => { fxHits++; return { json: { code: 200, tweet: { id: '333', url: 'https://x.com/jockfit/status/333', text: 'gym', author: { screen_name: 'jockfit', name: 'Jock' }, created_timestamp: 1791000000, media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/333.jpg', width: 800, height: 1000 }] } } } }; },
  });
  prepareEnv({ X_BEARER_TOKEN: '', FXTWITTER_BASE_URL: mock.url, X_EMBED_URL: mock.url, X_SYNDICATION_URL: mock.url, X_BASE_URL: mock.url });
  repo = require('../src/db/repo'); x = require('../src/sources/x'); websearch = require('../src/lib/websearch'); engine = require('../src/engine/engine');
  realSearch = websearch.search; realConfigured = websearch.configured;
  websearch.configured = () => true;
  websearch.search = async () => { calls++; const out = answer.slice(); if (answer.cached) Object.defineProperty(out, 'cached', { value: true }); return out; };
});
beforeEach(() => { calls = 0; answer = []; repo.settings.set('x.websearch', '{}'); });
after(async () => { websearch.search = realSearch; websearch.configured = realConfigured; engine.shutdown(); await mock.close(); });

const ctx = (o = {}) => ({ aborted: () => false, force: false, ...o });
const spent = () => x.webUsage().count;
const feed = { kind: 'user', target: 'jockfit' };

test('a search that only re-finds seen posts rests 12 h, without a search and without spending', async () => {
  answer = [{ url: 'https://x.com/jockfit/status/111', title: 'jockfit' }, { url: 'https://x.com/jockfit/status/222', title: 'jockfit' }];
  const first = await x._viaWebSearch(feed, ctx(), { seen: ['111', '222'] });
  assert.equal(calls, 1); assert.equal(spent(), 1);
  assert.ok(first.cursor.noNewAt, 'nothing new: the rest starts');
  assert.equal(first.cursor.noHitAt, null, 'it found posts, so it is not a miss');
  const second = await x._viaWebSearch(feed, ctx(), first.cursor);
  assert.equal(calls, 1, 'no second search'); assert.equal(spent(), 1, 'no second spend');
  assert.equal(second.via, 'websearch:cached-no-new');
  assert.ok(second.retryAfter > 11 * 3600000);
  const later = await x._viaWebSearch(feed, ctx(), { ...first.cursor, noNewAt: new Date(Date.now() - 13 * 3600000).toISOString() });
  assert.equal(calls, 2, 'searched again after 12 h'); assert.ok(later.cursor.noNewAt);
  // a forced run searches at once (it then re-reads every post; the local mock has none of them, so it may throw after)
  await x._viaWebSearch(feed, ctx({ force: true }), first.cursor).catch(() => {});
  assert.equal(calls, 3, 'a forced run searches at once');
});

test('a run that finds a new post does not rest, and a total miss still uses the 7-day noHitAt', async () => {
  answer = [{ url: 'https://x.com/jockfit/status/333', title: 'jockfit' }];
  const r = await x._viaWebSearch(feed, ctx(), { seen: [] });
  assert.equal(fxHits, 1, 'the new post was read (from the local mock)');
  assert.deepEqual(r.items.map((i) => i.sourceId), ['333']);
  assert.equal(r.cursor.noNewAt, null);
  answer = [{ url: 'https://example.com/unrelated', title: 'jockfit elsewhere' }];
  const miss = await x._viaWebSearch(feed, ctx(), {});
  assert.ok(miss.cursor.noHitAt); assert.equal(miss.cursor.noNewAt, null);
});

test('an answer from the 10-minute search cache costs nothing', async () => {
  answer = Object.assign([{ url: 'https://x.com/jockfit/status/444', title: 'jockfit' }], { cached: true });
  await x._viaWebSearch(feed, ctx(), { seen: ['444'] });
  assert.equal(spent(), 0);
});

test('a spent cap waits for the daily reset, also while syndication is parked', async () => {
  repo.settings.set('x.websearch', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 100000 }));
  const nextReset = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z') + 86400000;
  let err;
  try { await x._viaWebSearch(feed, ctx(), {}); } catch (e) { err = e; }
  assert.ok(err && err.cooldown && err.budget, 'a cooldown, not a skip');
  assert.ok(Date.now() + err.retryAfter >= nextReset && Date.now() + err.retryAfter <= nextReset + 3600000, 'after the reset, within the next hour');
  assert.equal(calls, 0, 'no search');
  // through the engine: the feed is scheduled after the reset, still enabled
  x.syndState.parkedUntil = Date.now() + 30 * 60000; x.syndState.reason = 'parked for the test';
  try {
    const f = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'budgetedguy', runNow: false }).feed;
    const r = await engine.runFeed(f, 'schedule');
    assert.equal(r.status, 'skipped');
    const row = repo.feeds.get(f.id);
    assert.equal(row.enabled, 1);
    assert.ok(Date.parse(row.next_run_at) >= nextReset, `next run ${row.next_run_at} is after the reset, not when the 30-min park ends`);
  } finally { x.syndState.parkedUntil = 0; x.syndState.reason = null; }
});
