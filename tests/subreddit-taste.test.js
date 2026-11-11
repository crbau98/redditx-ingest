'use strict';
/**
 * Subreddit taste (engine/subreddit-taste.js): a read-only score per Reddit community feed, recommendations that are
 * never applied on their own, and the Subreddits page's pause button, which only flips `enabled` through the existing PATCH.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
const NOW = Date.parse('2026-11-11T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
let taste; let repo; let server; let base; let engine;

before(async () => {
  repo = require('../src/db/repo');
  taste = require('../src/engine/subreddit-taste');
  engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

const base0 = { published14: 14, published30: 30, followed30: 0, runs: 10, badRuns: 0, lastUsefulAt: daysAgo(1) };

test('followed-creator items weigh most: fewer items that carry follows outrank more items that carry none', () => {
  const follows = taste.score({ ...base0, published14: 7, followed30: 10 }, NOW);
  const volume = taste.score({ ...base0, published14: 70, followed30: 0 }, NOW);
  assert.ok(follows.score > volume.score, `${follows.score} > ${volume.score}`);
  assert.equal(follows.label, 'carries your follows');
});

test('empty or rate-limited runs lower the score', () => {
  const clean = taste.score({ ...base0, runs: 10, badRuns: 0 }, NOW);
  const flaky = taste.score({ ...base0, runs: 10, badRuns: 8 }, NOW);
  assert.ok(clean.score > flaky.score);
  assert.equal(flaky.badShare, 0.8);
});

test('recency: a stale last useful item scores lower, and 30+ days without one is dead', () => {
  const fresh = taste.score({ ...base0, lastUsefulAt: daysAgo(1) }, NOW);
  const stale = taste.score({ ...base0, lastUsefulAt: daysAgo(20) }, NOW);
  const gone = taste.score({ ...base0, published14: 0, published30: 0, lastUsefulAt: daysAgo(45) }, NOW);
  assert.ok(fresh.score > stale.score);
  assert.equal(gone.label, 'dead');
  assert.equal(taste.score({ ...base0, published14: 1, runs: 10, badRuns: 9, lastUsefulAt: daysAgo(25) }, NOW).label, 'weak');
});

test('recommendations: pause only enabled, follow-less, low-rate feeds; re-enable paused feeds that carried follows', () => {
  const rows = [
    { feedId: 'a', name: 'quiet', enabled: true, followed30: 0, followedTotal: 0, perDay: 0.2 },
    { feedId: 'b', name: 'busy', enabled: true, followed30: 0, followedTotal: 0, perDay: 3 },
    { feedId: 'c', name: 'fans', enabled: true, followed30: 2, followedTotal: 5, perDay: 0.1 },
    { feedId: 'd', name: 'pausedgood', enabled: false, followed30: 0, followedTotal: 4, perDay: 0 },
    { feedId: 'e', name: 'pausedbad', enabled: false, followed30: 0, followedTotal: 1, perDay: 0 },
  ];
  const r = taste.recommend(rows);
  assert.deepEqual(r.pause.map((x) => [x.feedId, x.enabled]), [['a', 0]]);
  assert.deepEqual(r.enable.map((x) => [x.feedId, x.enabled]), [['d', 1]]);
});

test('report reads the library: follows from user feeds and linked candidates, runs, and changes nothing', () => {
  const followedC = repo.creators.create({ handle: 'taste_followed', displayName: 'Followed' });
  const linkedC = repo.creators.create({ handle: 'taste_linked', displayName: 'Linked' });
  const otherC = repo.creators.create({ handle: 'taste_other', displayName: 'Other' });
  repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'taste_followed', creatorId: followedC.id, runNow: false });
  repo.db.prepare("INSERT INTO candidates (id, platform, kind, target, status, creator_id) VALUES ('cand1', 'reddit', 'user', 'taste_linked', 'linked', ?)").run(linkedC.id);
  const good = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'tastegood', runNow: false }).feed;
  const junk = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'tastejunk', runNow: false }).feed;
  let n = 0;
  const item = (feed, creator, d) => { n++; repo.media.insert({ creator_id: creator.id, feed_id: feed.id, platform: 'reddit', source_id: `t${n}`, source_key: `reddit:t${n}:0`, post_key: `reddit:t${n}`, community: feed.target, author: creator.handle, title: `taste ${n}`, media_type: 'image', media_url: `https://example.com/${n}.jpg`, hash: `taste${n}`, ingested_at: new Date(Date.now() - d * 86400000).toISOString() }, []); };
  item(good, followedC, 1); item(good, linkedC, 3); item(junk, otherC, 2);
  const run = (feed, status) => { n++; repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status) VALUES (?, ?, ?, ?, ?)').run(`run${n}`, feed.id, new Date().toISOString(), new Date().toISOString(), status); };
  run(good, 'ok'); run(junk, 'empty'); run(junk, 'skipped'); run(junk, 'ok');
  const before = JSON.stringify(repo.db.prepare('SELECT * FROM feeds ORDER BY id').all());
  taste._clear();
  const r = taste.report();
  const g = r.rows.find((x) => x.name === 'tastegood');
  const j = r.rows.find((x) => x.name === 'tastejunk');
  assert.equal(g.followed30, 2, 'a user feed and a linked candidate both count as followed');
  assert.equal(j.followed30, 0);
  assert.equal(j.runs, 3); assert.equal(j.badRuns, 2);
  assert.ok(g.score > j.score);
  assert.equal(g.label, 'carries your follows');
  assert.ok(r.recommendations.pause.some((x) => x.feedId === junk.id));
  assert.ok(!r.recommendations.pause.some((x) => x.feedId === good.id));
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM feeds ORDER BY id').all()), before, 'scoring changes nothing');
});

test('GET /api/admin/subreddits is admin-only', async () => {
  assert.equal((await fetch(`${base}/api/admin/subreddits`)).status, 401);
  const ok = await fetch(`${base}/api/admin/subreddits`, { headers: { 'x-admin-key': 'test-key' } });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray((await ok.json()).rows));
});

test('the pause button sends the existing PATCH with enabled 0/1 and nothing else changes', async () => {
  const { feedToggle, applyRecommendations } = await import('../public/js/views/admin/logic.js');
  assert.deepEqual(feedToggle('f 1', false), { path: '/feeds/f%201', body: { enabled: 0 } });
  assert.deepEqual(feedToggle('f1', true), { path: '/feeds/f1', body: { enabled: 1 } });
  const feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'tastetoggle', runNow: false }).feed;
  const before = repo.feeds.get(feed.id);
  const sent = [];
  const patch = async (path, body) => {
    sent.push({ path, body });
    const res = await fetch(`${base}/api/admin${path}`, { method: 'PATCH', headers: { 'x-admin-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  assert.equal(await applyRecommendations([{ feedId: feed.id, enabled: 0 }], patch), 1);
  assert.deepEqual(sent, [{ path: `/feeds/${feed.id}`, body: { enabled: 0 } }]);
  const after = repo.feeds.get(feed.id);
  assert.equal(after.enabled, 0);
  const strip = (f) => { const { enabled, updated_at, ...rest } = f; return rest; };
  assert.deepEqual(strip(after), strip(before), 'only enabled changed');
  await applyRecommendations([{ feedId: feed.id, enabled: 1 }], patch);
  assert.equal(repo.feeds.get(feed.id).enabled, 1);
});
