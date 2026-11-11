'use strict';
/** Phase B: a read-only admin list of account feeds attached to a creator whose own handle is not his. */
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
const get = (path, headers = { 'x-admin-key': 'test-key' }) => fetch(`${base}${path}`, { headers });

test('only the foreign deep-search / discovered account feeds are listed, with their cleanup call', async () => {
  const c = repo.creators.create({ handle: 'dantecolle.bsky.social', displayName: 'Dante Colle' });
  const add = (platform, kind, target, origin) => repo.feeds.upsert({ platform, kind, target, creatorId: c.id, origin, runNow: false }).feed;
  const foreign = add('bluesky', 'user', 'cartoonhunks.bsky.social', 'deep-search');
  const foreignRss = add('rss', 'feed', 'https://www.bftv.gay/rss/pornstars.xml', 'deep-search');
  add('bluesky', 'user', 'dantecolle.bsky.social', 'deep-search');          // his own account
  add('coomer', 'user', 'onlyfans/dante_colle', 'discovered');              // his own, another platform
  add('web', 'page', 'https://example.com/dante-colle-interview', 'deep-search'); // a page about him: not an account
  add('x', 'user', 'somebodyelse', 'admin');                                // attached by an admin: not listed
  repo.media.insert({ creator_id: c.id, feed_id: foreign.id, platform: 'bluesky', source_id: 'ff1', source_key: 'bluesky:ff1:0', post_key: 'bluesky:ff1', author: 'x', media_type: 'image', media_url: 'https://example.com/ff1.jpg', hash: 'ffh1' }, []);
  const r = await get('/feeds/foreign');
  assert.equal(r.status, 200);
  const body = await r.json();
  const mine = body.items.filter((i) => i.creatorId === c.id);
  assert.deepEqual(mine.map((i) => i.target).sort(), ['cartoonhunks.bsky.social', 'https://www.bftv.gay/rss/pornstars.xml']);
  const row = mine.find((i) => i.id === foreign.id);
  assert.equal(row.mediaCount, 1);
  assert.equal(row.creatorHandle, 'dantecolle.bsky.social');
  assert.equal(row.origin, 'deep-search');
  assert.deepEqual(row.cleanup, { method: 'POST', path: `/api/admin/feeds/${foreign.id}/media/reassign`, body: { creatorId: '' } });
  assert.ok(mine.some((i) => i.id === foreignRss.id));
  // read-only: nothing moved
  assert.equal(repo.feeds.get(foreign.id).creator_id, c.id);
  // paging
  const p1 = await (await get('/feeds/foreign?limit=1&offset=0')).json();
  assert.equal(p1.items.length, 1); assert.equal(p1.total, body.total);
});

test('the list is admin-only', async () => {
  assert.equal((await get('/feeds/foreign', {})).status, 401);
});
