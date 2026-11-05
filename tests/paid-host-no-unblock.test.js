'use strict';
// The unblocker tiers (Bright Data, Scrapfly) spend credits to get past a refusal. A paid creator platform
// that refuses PRISM is not ours to unblock: the content there sits behind the platform's own gate, and
// spending to break a refusal is not what the owner's 2026-11-05 decision allows.
//
// Covered: every paid host is recognized, other hosts are not affected, and the unblocker refuses a paid
// host before any request leaves the machine (the test never touches the network).
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./helpers/mock');

mock.prepareEnv();
const paid = require('../src/lib/paid');

test('every paid platform is recognized as one', () => {
  for (const url of ['https://onlyfans.com/x', 'https://fansly.com/x', 'https://justfor.fans/x', 'https://manyvids.com/x',
    'https://loyalfans.com/x', 'https://fanvue.com/x', 'https://fancentro.com/x', 'https://clips4sale.com/store/x', 'https://patreon.com/x']) {
    assert.equal(paid.isPaidPlatform(url), true, url);
  }
  assert.equal(paid.isPaidPlatform('https://example.com/x'), false);
  assert.equal(paid.isPaidPlatform(''), false);
  assert.equal(paid.isPaidPlatform(null), false);
});

test('the unblocker refuses a paid host before it spends anything', async () => {
  const { _unlockedRead } = require('../src/sources/web');
  for (const url of ['https://onlyfans.com/x', 'https://fansly.com/x', 'https://justfor.fans/x', 'https://patreon.com/x']) {
    const out = await _unlockedRead({ target: url, platform: 'web', kind: 'page' }, 'media');
    assert.ok(out && out.skipped, `${url} is not unblocked`);
    assert.match(out.skipped, /paid platform/i);
  }
});

test('an ordinary host is still eligible for the unblocker', () => {
  assert.equal(paid.isPaidPlatform('https://example.com/page'), false);
});
