'use strict';
/**
 * Rate limits are a wait, not a failure.
 *
 * Before: a platform that was cooling down after a 429 (limiter.penalize, e.g. RedGIFs holds 10-30 min) made every queued feed
 * sit inside limiter.schedule() until the 150 s run timeout fired ("timed out", status 0), which counted as a platform failure
 * and a feed failure; five of those disabled the feed for good. A Retry-After of an hour was clamped to 2 minutes, and the
 * scheduler kept starting feeds of a platform it already knew was cooling down.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let engine; let breaker; let limiter; let net; let settingsStore;
const state = { status: 429, hits: 0 };

before(async () => {
  mock = await start({
    '/limited.xml': () => { state.hits++; return { status: state.status, headers: state.status === 429 ? { 'retry-after': '600' } : {}, body: 'slow down' }; },
  });
  prepareEnv();
  repo = require('../src/db/repo');
  net = require('../src/lib/net');
  limiter = require('../src/lib/limiter');
  engine = require('../src/engine/engine');
  breaker = require('../src/engine/breaker');
  settingsStore = require('../src/settings');
});
after(async () => { engine.shutdown(); await mock.close(); });
beforeEach(() => { limiter.reset(); breaker.reset(); state.hits = 0; state.status = 429; engine._state.running.clear(); engine._state.queue.length = 0; });

const feed = (o) => repo.feeds.upsert({ origin: 'admin', ...o }).feed;
let n = 0;
const rssFeed = () => feed({ platform: 'rss', kind: 'feed', target: `${mock.url}/limited.xml?n=${++n}`, intervalMin: 60 });

describe('limiter', () => {
  test('a call that would wait longer than maxWaitMs for a cooldown fails at once, with the wait on the error', async () => {
    limiter.penalize('t-plat', 10 * 60000);
    let ran = false;
    const t0 = Date.now();
    await assert.rejects(limiter.schedule('t-plat', 0, async () => { ran = true; }, { maxWaitMs: 1000 }), (e) => {
      assert.equal(e.status, 429); assert.equal(e.cooldown, true);
      assert.ok(e.retryAfter > 9 * 60000 && e.retryAfter <= 10 * 60000, `retryAfter ${e.retryAfter}`);
      return true;
    });
    assert.ok(Date.now() - t0 < 500, 'no waiting');
    assert.equal(ran, false, 'nothing was sent');
  });

  test('without maxWaitMs the old behaviour stays: the call waits for the cooldown', async () => {
    limiter.penalize('t-wait', 80);
    const t0 = Date.now();
    await limiter.schedule('t-wait', 0, async () => 1);
    assert.ok(Date.now() - t0 >= 60);
  });

  test('coolingDown() says how long a key is held', () => {
    assert.equal(limiter.coolingDown('nobody'), 0);
    limiter.penalize('t-cd', 5000);
    const left = limiter.coolingDown('t-cd');
    assert.ok(left > 4000 && left <= 5000);
  });

  test('the platform client does not re-penalise (or escalate) when the call was refused by our own cooldown', async () => {
    const real = net.fetchJSON; let called = 0;
    net.fetchJSON = async () => { called++; return {}; };
    try {
      const http = require('../src/sources/http').forPlatform('t-http', 0, { penalty: { ms: 60000, repeatMs: 600000, repeatWindowMs: 3600000 } });
      limiter.penalize('t-http', 120000);
      const before = limiter.coolingDown('t-http');
      await assert.rejects(http.json('http://127.0.0.1:1/x'), (e) => e.cooldown === true);
      await assert.rejects(http.json('http://127.0.0.1:1/x'), (e) => e.cooldown === true);
      assert.equal(called, 0);
      assert.ok(limiter.coolingDown('t-http') <= before, 'the hold did not grow');
    } finally { net.fetchJSON = real; }
  });

  test('Retry-After is honoured up to six hours (it used to be clamped to two minutes)', () => {
    assert.equal(net.parseRetryAfter('3600'), 3600 * 1000);
    assert.equal(net.parseRetryAfter('999999'), 6 * 3600 * 1000);
    assert.equal(net.parseRetryAfter(''), 0);
  });
});

describe('scheduler', () => {
  test('a platform that is cooling down gets no new run; it is picked again once the hold ends', () => {
    repo.db.prepare("DELETE FROM feeds WHERE platform = 'rss'").run();
    const f = rssFeed();
    const cfg = { ...settingsStore.get(), schedulerEnabled: true };
    assert.equal(engine._nextWork(cfg).feed.id, f.id, 'due and free: picked');
    limiter.penalize('rss', 10 * 60000);
    assert.equal(engine._nextWork(cfg), null, 'cooling down: left alone');
    limiter.reset();
    assert.equal(engine._nextWork(cfg).feed.id, f.id);
  });
});

describe('a throttled feed', () => {
  test('run while its platform is cooling down: no request, no failure counted, retried after the hold', async () => {
    const f = rssFeed();
    limiter.penalize('rss', 10 * 60000);
    const r = await engine.runFeed(repo.feeds.get(f.id), 'manual');
    assert.equal(r.status, 'skipped');
    assert.equal(state.hits, 0, 'nothing was sent');
    const row = repo.feeds.get(f.id);
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.enabled, 1);
    assert.match(row.last_error, /rate.?limit|cooling/i);
    const wait = Date.parse(row.next_run_at) - Date.now();
    assert.ok(wait > 9 * 60000, `next run in ${Math.round(wait / 1000)} s`);
    assert.equal((breaker.snapshot().rss || { failures: 0 }).failures, 0, 'no breaker damage');
  });

  test('real 429 answers back the feed off but never switch it off', async () => {
    const f = rssFeed();
    for (let i = 0; i < 6; i++) { limiter.reset(); await engine.runFeed(repo.feeds.get(f.id), 'manual'); }
    const row = repo.feeds.get(f.id);
    assert.equal(row.enabled, 1, 'still on');
    assert.equal(row.consecutive_failures, 6);
    assert.ok(row.next_run_at, 'rescheduled');
    assert.match(row.last_error, /429/);
  });

  test('a server that keeps answering 503 is backed off, not disabled for good', async () => {
    state.status = 503;
    const f = rssFeed();
    for (let i = 0; i < 6; i++) { limiter.reset(); breaker.reset(); await engine.runFeed(repo.feeds.get(f.id), 'manual'); }
    const row = repo.feeds.get(f.id);
    assert.equal(row.enabled, 1);
    assert.equal(row.consecutive_failures, 6);
  });

  test('a 404 is still switched off after three tries (that is about the target, not the moment)', async () => {
    state.status = 404;
    const f = rssFeed();
    for (let i = 0; i < 3; i++) { limiter.reset(); breaker.reset(); await engine.runFeed(repo.feeds.get(f.id), 'manual'); }
    assert.equal(repo.feeds.get(f.id).enabled, 0);
  });
});
