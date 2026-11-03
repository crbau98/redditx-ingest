'use strict';
/**
 * Bluesky creator backfill, cursor edge cases (sources/bluesky.js):
 *  - a stored backfill cursor (bfNext) the AppView now rejects must not cost the run its fresh top-of-feed posts, and must
 *    not count as a failure of the feed (an error from fetch() adds to "Chronic failure"); the cursor is cleared and
 *    backfill starts over, and gives up after a few misses;
 *  - a cursor from before backfill existed ({newestAt}, no bfNext) enters backfill, like RedGIFs does with `bfPage || 3`.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let registry;
const hits = [];
const state = { staleCursor: true, rejectAll: false, endAfterFirstPage: false };
const post = (i) => ({ post: { uri: `at://did:plc:abc/app.bsky.feed.post/r${i}`, cid: `c${i}`, author: { did: 'did:plc:abc', handle: 'zed.bsky.social' }, record: { text: `p${i}`, createdAt: new Date(1700000000000 - i * 1000).toISOString() }, indexedAt: new Date(1700000000000 - i * 1000).toISOString(), embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: `https://cdn.example/t${i}.jpg`, fullsize: `https://cdn.example/f${i}.jpg`, alt: '' }] } } });

before(async () => {
  mock = await start({
    '/xrpc/app.bsky.feed.getAuthorFeed': (req, res, url) => {
      const c = url.searchParams.get('cursor');
      hits.push(c);
      if ((c === 'stale' && state.staleCursor) || (c === 'deep' && state.rejectAll)) return { status: 400, json: { error: 'InvalidRequest', message: 'cursor expired' } };
      return { json: { feed: [post(1), post(2)], ...(state.endAfterFirstPage ? {} : { cursor: c ? 'deep' : 'next' }) } };
    },
  });
  prepareEnv({ BSKY_BASE_URL: mock.url });
  registry = require('../src/sources');
});
after(async () => { await mock.close(); });
beforeEach(() => { hits.length = 0; state.staleCursor = true; state.rejectAll = false; state.endAfterFirstPage = false; });

const feed = { platform: 'bluesky', kind: 'user', target: 'zed.bsky.social' };
const run = (cursor) => registry.get('bluesky').fetch(feed, { limit: 100, cursor, aborted: () => false });
const OLD = '2000-01-01T00:00:00.000Z'; // older than every post, so the top of the feed is all fresh

describe('a backfill cursor the AppView rejects', () => {
  test('keeps the run\'s fresh top-of-feed items, clears bfNext, and does not throw (so no "Chronic failure" count)', async () => {
    const res = await run({ newestAt: OLD, bfNext: 'stale' });
    assert.ok(res.items.length >= 2, 'the fresh posts are kept');
    assert.ok(res.cursor && res.cursor.newestAt, 'newestAt still advances');
    assert.notEqual(res.cursor.bfNext, 'stale', 'the rejected cursor is dropped');
    assert.ok(!res.cursor.bfDone, 'and the feed is not declared finished');
  });

  test('the next run starts backfill again from the top instead of reusing the bad cursor', async () => {
    const first = await run({ newestAt: OLD, bfNext: 'stale' });
    hits.length = 0;
    const second = await run(first.cursor);
    assert.ok(!hits.includes('stale'), 'the stale cursor is not sent again');
    assert.ok(second.cursor.bfNext, 'backfill is running again');
  });

  test('after three misses in a row it gives up on backfill for that creator, and never throws', async () => {
    let cursor = { newestAt: OLD, bfNext: 'stale' };
    state.rejectAll = true; // every deep (backfill-range) cursor the AppView is given is rejected from now on
    for (let i = 0; i < 3; i++) {
      const r = await run(cursor);
      if (i === 0) assert.ok(r.items.length >= 1, 'the first run keeps its fresh posts');
      cursor = r.cursor; // later runs have nothing new, but still must not throw
    }
    assert.equal(cursor.bfDone, true, 'given up after three misses');
    assert.ok(!cursor.bfNext);
  });
});

describe('a cursor from before backfill existed', () => {
  test('{newestAt} with no bfNext enters backfill (like RedGIFs\' bfPage || 3)', async () => {
    const res = await run({ newestAt: OLD });
    assert.ok(res.cursor.bfNext || res.cursor.bfDone, `got ${JSON.stringify(res.cursor)}`);
    assert.ok(res.cursor.bfNext, 'this account has more pages, so backfill is pending');
  });

  test('an account that ends within the part the first run already read is marked done', async () => {
    state.endAfterFirstPage = true;
    const res = await run({ newestAt: OLD });
    assert.equal(res.cursor.bfDone, true);
    assert.ok(!res.cursor.bfNext);
  });

  test('a cursor that already has bfDone is left alone (no extra requests)', async () => {
    await run({ newestAt: OLD, bfDone: true });
    assert.ok(hits.length <= 2, `only the top-of-feed read happens (${hits.length} requests)`);
  });
});
