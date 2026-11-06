'use strict';
/**
 * Fewer wasted fetches: an item PRISM already stores must be recognised before anything touches the network for it.
 * The duplicate check used to sit after link resolution (a RedGIFs API call, 2 s apart), the host probe and the reachability probe,
 * so every re-read of a feed (manual/forced runs, feeds without a date cursor, overlapping pages) paid for items it already had.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { start, prepareEnv, JPEG } = require('./helpers/mock');

let mock; let repo; let pipeline; let registry; let feed; let realResolve; let resolveCalls;
const settings = { probeUnknownHosts: true, hostReachability: true, scopeMode: 'open' };
let n = 0;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

before(async () => {
  mock = await start({ '/p/a.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }), '/p/b.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }) });
  prepareEnv();
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  registry = require('../src/sources');
  feed = repo.feeds.upsert({ platform: 'rss', kind: 'feed', target: `${mock.url}/feed.xml`, trusted: 1, origin: 'admin' }).feed;
  const rg = registry.get('redgifs'); realResolve = rg.resolve; resolveCalls = [];
  rg.resolve = async (url) => { resolveCalls.push(url); return { mediaUrl: 'https://media.redgifs.com/Resolved.mp4', previewUrl: null, mediaType: 'video' }; };
});
after(async () => { registry.get('redgifs').resolve = realResolve; await mock.close(); });

function stored({ sourceKey, url }) {
  const id = crypto.randomUUID();
  repo.db.prepare(`INSERT INTO media (id, platform, source_key, post_key, media_type, media_url, hash, publish_state)
    VALUES (?, 'rss', ?, ?, 'image', ?, ?, 'published')`).run(id, sourceKey, sourceKey, url, md5(`${new URL(url).hostname}${new URL(url).pathname}${new URL(url).search}`));
  return id;
}
const item = (o) => ({ sourceId: `e${++n}`, title: 'Gym selfie', author: 'earlyguy', mediaType: 'image', probe: true, ...o });

test('a stored item (same source key) is a duplicate before its RedGIFs link is resolved', async () => {
  stored({ sourceKey: 'rss:known-redgifs:0', url: 'https://media.redgifs.com/Old.mp4' });
  const r = await pipeline.processItem(item({ sourceId: 'known-redgifs', mediaType: 'video', mediaUrl: 'https://www.redgifs.com/watch/somegif', resolve: 'redgifs', trusted: true }), feed, null, settings);
  assert.equal(r.outcome, 'dupe');
  assert.equal(resolveCalls.length, 0, 'no API call for something already stored');
});

test('a stored picture (same URL, new key) is a duplicate without probing its host', async () => {
  stored({ sourceKey: 'rss:old-key:0', url: `${mock.url}/p/a.jpg` });
  const before = mock.hits.length;
  const r = await pipeline.processItem(item({ sourceId: 'new-key', mediaUrl: `${mock.url}/p/a.jpg` }), feed, null, settings);
  assert.equal(r.outcome, 'dupe');
  assert.equal(mock.hits.length, before, 'nothing was requested from the host');
});

test('a new picture is still probed and stored', async () => {
  const before = mock.hits.length;
  const r = await pipeline.processItem(item({ sourceId: 'brand-new', mediaUrl: `${mock.url}/p/b.jpg` }), feed, null, settings);
  assert.equal(r.outcome, 'added', JSON.stringify(r));
  assert.ok(mock.hits.length > before, 'the host was probed');
});

test('a link that resolves to something already stored is a duplicate (the key could not know)', async () => {
  stored({ sourceKey: 'rss:other-post:0', url: 'https://media.redgifs.com/Resolved.mp4' });
  const r = await pipeline.processItem(item({ sourceId: 'fresh-post', mediaType: 'video', mediaUrl: 'https://www.redgifs.com/watch/another', resolve: 'redgifs', trusted: true }), feed, null, settings);
  assert.equal(r.outcome, 'dupe');
  assert.equal(resolveCalls.length, 1, 'resolved once to find out');
});
