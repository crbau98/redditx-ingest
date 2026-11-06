'use strict';
/**
 * rss / web / link-in-bio feeds talk to many unrelated sites under one platform key. A site that answers with gateway errors used
 * to count against the PLATFORM breaker (4 failures stop every RSS feed for minutes) and its other feeds were still tried one by
 * one. It is now handled per host, like the fediverse platforms: two gateway errors rest that host, and only that host.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let engine; let breaker; let limiter;

before(async () => {
  mock = await start({ '/down.xml': () => ({ status: 503, body: 'bad gateway' }) });
  prepareEnv();
  repo = require('../src/db/repo');
  limiter = require('../src/lib/limiter');
  engine = require('../src/engine/engine');
  breaker = require('../src/engine/breaker');
});
after(async () => { engine.shutdown(); await mock.close(); });
beforeEach(() => { breaker.reset(); limiter.reset(); mock.hits.length = 0; });

let n = 0;
const rssFeed = () => repo.feeds.upsert({ platform: 'rss', kind: 'feed', target: `${mock.url}/down.xml?n=${++n}`, intervalMin: 60, origin: 'admin' }).feed;

test('gateway errors from one site rest that site, not the whole RSS platform', async () => {
  const feeds = [rssFeed(), rssFeed(), rssFeed(), rssFeed(), rssFeed()];
  await engine.runFeed(repo.feeds.get(feeds[0].id), 'schedule');
  await engine.runFeed(repo.feeds.get(feeds[1].id), 'schedule');
  const host = new URL(mock.url).hostname;
  assert.ok(breaker.hostOpenUntil(host) > Date.now(), 'the host breaker is open after two gateway errors');
  assert.equal((breaker.snapshot().rss || { state: 'closed' }).state, 'closed', 'the platform breaker is not');
  assert.ok(!(breaker.snapshot().rss && breaker.snapshot().rss.failures), 'and counted none of them');
  // the rest of that site's feeds are skipped without a request
  const before = mock.hits.length;
  const r = await engine.runFeed(repo.feeds.get(feeds[2].id), 'schedule');
  assert.equal(r.status, 'skipped');
  assert.equal(mock.hits.length, before, 'nothing was requested');
  const row = repo.feeds.get(feeds[2].id);
  assert.equal(row.consecutive_failures, 0);
  assert.ok(Date.parse(row.next_run_at) > Date.now());
});
