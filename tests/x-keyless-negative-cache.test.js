'use strict';
// Keyless X: a handle the web search could not find on x.com is not searched again for 7 days.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-xnhc-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

test('a handle with no x.com hits is cached as a miss and not searched again within 7 days', async () => {
  const websearch = require('../src/lib/websearch');
  const x = require('../src/sources/x');
  let calls = 0;
  const origSearch = websearch.search;
  const origConfigured = websearch.configured;
  websearch.configured = () => true;
  websearch.search = async () => { calls++; return [{ url: 'https://example.com/other', title: 'unrelated', snippet: '' }]; };
  try {
    const feed = { kind: 'user', target: 'nobodyhere' };
    const ctx = { aborted: () => false, force: false };
    const first = await x._viaWebSearch(feed, ctx, {});
    assert.equal(calls, 1);
    assert.ok(first.cursor.noHitAt, 'miss is recorded');
    const second = await x._viaWebSearch(feed, ctx, first.cursor);
    assert.equal(calls, 1, 'no second search inside the TTL');
    assert.equal(second.via, 'websearch:cached-miss');
    assert.deepEqual(second.items, []);
    // after the TTL the handle is searched again
    const aged = { ...first.cursor, noHitAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() };
    await x._viaWebSearch(feed, ctx, aged);
    assert.equal(calls, 2, 'searched again after 7 days');
    // force bypasses the cache
    await x._viaWebSearch(feed, { ...ctx, force: true }, first.cursor);
    assert.equal(calls, 3, 'force run searches again');
  } finally {
    websearch.search = origSearch;
    websearch.configured = origConfigured;
  }
});
