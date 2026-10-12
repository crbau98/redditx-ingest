'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv, JPEG } = require('./helpers/mock');

let mock; let wall; let pipeline; let repo; let feed; let n = 0; let walled = true;
const settings = { probeUnknownHosts: false, scopeMode: 'open', hostReachability: true };

before(async () => {
  mock = await start({
    '/walled/a.jpg': () => (walled ? { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }, body: '<html>challenge</html>' } : { headers: { 'content-type': 'image/jpeg' }, body: JPEG }),
    '/ok/a.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }),
    '/ok/gone.jpg': () => ({ status: 404, body: 'gone' }),
    '/html/one.jpg': () => ({ headers: { 'content-type': 'text/html' }, body: '<html>this item was deleted</html>' }),
    '/html/two.jpg': () => ({ headers: { 'content-type': 'text/html' }, body: '<html>this one too</html>' }),
    '/html/good.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }),
  });
  prepareEnv();
  pipeline = require('../src/engine/pipeline'); repo = require('../src/db/repo');
  feed = repo.feeds.upsert({ platform: 'lemmy', kind: 'community', target: 'gayporn@lemmy.test', trusted: 1, origin: 'admin' }).feed;
});
after(async () => { await mock.close(); });

const item = (path) => ({ sourceId: `h${++n}`, title: 'gay gym', author: `u${n}`, community: 'gayporn', mediaType: 'image', trusted: true, mediaUrl: `${mock.url}${path}` });

test('a trusted federated host that walls us off is skipped (with the reason), and recovers after the window', async () => {
  const a = await pipeline.processItem(item('/walled/a.jpg'), feed, null, settings);
  assert.equal(a.outcome, 'skipped'); assert.match(a.reason, /unreachable host .*Cloudflare/);
  walled = false; // the host is now fine, but the verdict is cached for the window
  assert.equal((await pipeline.processItem(item('/walled/a.jpg?2'), feed, null, settings)).outcome, 'skipped');
  for (const v of pipeline._hostState.values()) v.at = 0; // window elapsed
  assert.equal((await pipeline.processItem(item('/walled/a.jpg?3'), feed, null, settings)).outcome, 'added');
});

test('a 404 is about one item, not the host; and the gate is off unless enabled', async () => {
  pipeline._hostState.clear();
  assert.equal((await pipeline.processItem(item('/ok/gone.jpg'), feed, null, settings)).outcome, 'added');
  walled = true; pipeline._hostState.clear();
  assert.equal((await pipeline.processItem(item('/walled/a.jpg?off'), feed, null, { ...settings, hostReachability: false })).outcome, 'added');
});

test('one HTML answer (a deleted / gated single item) skips only that item; two different urls confirm a wall; a healthy probe clears the strikes', async () => {
  pipeline._hostState.clear();
  const one = await pipeline.processItem(item('/html/one.jpg'), feed, null, settings);
  assert.equal(one.outcome, 'skipped');
  // the host is NOT condemned: a valid item from it still gets through
  const good = await pipeline.processItem(item('/html/good.jpg'), feed, null, settings);
  assert.equal(good.outcome, 'added', 'one bad item must not close the whole host');
  pipeline._hostState.clear();
  await pipeline.processItem(item('/html/one.jpg?a'), feed, null, settings);
  await pipeline.processItem(item('/html/two.jpg'), feed, null, settings); // second DIFFERENT url -> confirmed
  const after = await pipeline.processItem(item('/html/good.jpg?b'), feed, null, settings);
  assert.equal(after.outcome, 'skipped'); assert.match(after.reason, /unreachable host/);
});
