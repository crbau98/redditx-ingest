'use strict';
/** Admin cleanup: move or unassign every item one feed brought in, in one call, with recounts and an audit row. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let server; let base; let engine;
before(async () => {
  repo = require('../src/db/repo'); engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

const H = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const post = (path, body, headers = H) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
let n = 0;
const item = (creatorId, feedId) => { n++; return repo.media.insert({ creator_id: creatorId, feed_id: feedId, platform: 'bluesky', source_id: `ra${n}`, source_key: `bluesky:ra${n}:0`, post_key: `bluesky:ra${n}`, author: 'x', media_type: 'image', media_url: `https://example.com/ra${n}.jpg`, hash: `rah${n}` }, []); };
const count = (id) => repo.creators.get(id).media_count;

test('moving a wrong feed\'s items to the right creator recounts both and touches nothing else', async () => {
  const wrong = repo.creators.create({ handle: 'dantecolle.bsky.social', displayName: 'Dante Colle' });
  const right = repo.creators.create({ handle: 'cartoonhunks.bsky.social', displayName: 'Cartoon Hunks' });
  const foreign = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'cartoonhunks.bsky.social', creatorId: wrong.id, runNow: false }).feed;
  const own = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'dantecolle.bsky.social', creatorId: wrong.id, runNow: false }).feed;
  const moved = [item(wrong.id, foreign.id), item(wrong.id, foreign.id), item(wrong.id, foreign.id)];
  const kept = [item(wrong.id, own.id), item(wrong.id, own.id)];
  for (const id of [wrong.id, right.id]) repo.creators.refreshStats(id);
  assert.equal(count(wrong.id), 5);
  const res = await post(`/feeds/${foreign.id}/media/reassign`, { creatorId: right.id });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { moved: 3, from: [wrong.id], to: right.id });
  for (const id of moved) assert.equal(repo.media.get(id).creator_id, right.id);
  for (const id of kept) assert.equal(repo.media.get(id).creator_id, wrong.id, 'his own feed\'s items stay his');
  assert.equal(repo.feeds.get(foreign.id).creator_id, right.id, 'the feed itself moved with its items');
  assert.equal(repo.feeds.get(own.id).creator_id, wrong.id);
  // the next post from that feed goes to the new owner, not back to the old one (pipeline ownedByFeed)
  const pipeline = require('../src/engine/pipeline');
  const next = pipeline.resolveCreator({ author: 'cartoonhunks.bsky.social', title: 'new art' }, repo.feeds.get(foreign.id), null);
  assert.equal(next.id, right.id);
  assert.equal(count(wrong.id), 2); assert.equal(count(right.id), 3);
  const audit = repo.db.prepare("SELECT action, reason FROM moderation_actions WHERE target_type = 'feed' AND target_id = ?").all(foreign.id);
  assert.equal(audit.length, 1); assert.equal(audit[0].action, 'reassign-media'); assert.match(audit[0].reason, /3 item\(s\)/);
  // running it again is a no-op
  assert.deepEqual(await (await post(`/feeds/${foreign.id}/media/reassign`, { creatorId: right.id })).json(), { moved: 0, from: [], to: right.id });
});

test('unassigning (null or "") leaves the items without a creator and recounts the old one', async () => {
  const c = repo.creators.create({ handle: 'unassign_me', displayName: 'Unassign Me' });
  const feed = repo.feeds.upsert({ platform: 'rss', kind: 'feed', target: 'https://www.bftv.gay/rss/pornstars.xml', creatorId: c.id, runNow: false }).feed;
  const ids = [item(c.id, feed.id), item(c.id, feed.id)];
  repo.creators.refreshStats(c.id);
  assert.equal(count(c.id), 2);
  const r = await (await post(`/feeds/${feed.id}/media/reassign`, { creatorId: null })).json();
  assert.equal(r.moved, 2); assert.equal(r.to, null);
  for (const id of ids) assert.equal(repo.media.get(id).creator_id, null);
  assert.equal(count(c.id), 0);
  assert.equal(repo.feeds.get(feed.id).creator_id, null, 'the feed is unassigned too');
  // a later post from it is not credited to the old creator
  const pipeline = require('../src/engine/pipeline');
  const next = pipeline.resolveCreator({ author: 'somebody_else', title: 'x' }, repo.feeds.get(feed.id), null);
  assert.notEqual(next && next.id, c.id);
  const again = await (await post(`/feeds/${feed.id}/media/reassign`, { creatorId: '' })).json();
  assert.equal(again.moved, 0);
});

test('the action is admin-only and refuses unknown feeds, unknown creators and a missing creatorId', async () => {
  const c = repo.creators.create({ handle: 'guard_c', displayName: 'Guard' });
  const feed = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'guard_c', creatorId: c.id, runNow: false }).feed;
  assert.equal((await post(`/feeds/${feed.id}/media/reassign`, { creatorId: null }, { 'content-type': 'application/json' })).status, 401);
  assert.equal((await post('/feeds/nope/media/reassign', { creatorId: null })).status, 404);
  assert.equal((await post(`/feeds/${feed.id}/media/reassign`, { creatorId: 'no-such-creator' })).status, 404);
  assert.equal((await post(`/feeds/${feed.id}/media/reassign`, {})).status, 400);
});
