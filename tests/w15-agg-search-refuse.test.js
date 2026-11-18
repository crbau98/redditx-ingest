'use strict';
/**
 * Aggregator SEARCH pages (eporner/spankbang /search/…, tag listings) must not attach as enabled feeds.
 * Automatic origins are refused; admin may record the URL but the feed stays off.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const { isAggregatorSearch } = require('../src/lib/aggregators');
const targets = require('../src/services/targets');
const repo = require('../src/db/repo');

let n = 0;
const man = () => { n++; return repo.creators.create({ handle: `searchman${n}`, displayName: `searchman${n}`, origin: 'admin' }); };

test('isAggregatorSearch flags tube search URLs on aggregator hosts', () => {
  assert.equal(isAggregatorSearch('https://www.eporner.com/search/bigggwild/'), true);
  assert.equal(isAggregatorSearch('https://spankbang.com/search/ben%20batchelor/'), true);
  assert.equal(isAggregatorSearch('https://www.eporner.com/search/?q=foo'), true);
});

test('isAggregatorSearch leaves single-person aggregator profiles alone', () => {
  assert.equal(isAggregatorSearch('https://fanstats.com/bigggwild'), false);
  assert.equal(isAggregatorSearch('https://fapello.com/bigggwild/'), false);
  assert.equal(isAggregatorSearch('https://www.onlypedia.com/profile/bigggwild/'), false);
  assert.equal(isAggregatorSearch('https://example.com/search/foo'), false);
});

test('deep-search refuses an eporner search page', () => {
  const c = man();
  const r = targets.addSpec(
    { platform: 'web', kind: 'page', target: 'https://www.eporner.com/search/bigggwild/', label: 'search' },
    { creatorId: c.id, origin: 'deep-search', trusted: true },
  );
  assert.equal(r.status, 'invalid');
  assert.match(r.reason, /Aggregator search/i);
  assert.equal(r.feed, undefined);
});

test('admin may record a search page but it stays disabled', () => {
  const r = targets.addSpec(
    { platform: 'web', kind: 'page', target: `https://spankbang.com/search/testhandle-${Date.now()}/`, label: 'search' },
    { origin: 'admin', trusted: false },
  );
  assert.equal(r.status, 'created');
  assert.equal(!!r.feed.enabled, false);
});

test('named aggregator profile still attaches for deep-search when URL names him', () => {
  const c = man();
  const r = targets.addSpec(
    { platform: 'web', kind: 'page', target: `https://www.onlypedia.com/profile/${c.handle}/`, label: c.handle },
    { creatorId: c.id, origin: 'deep-search', trusted: true },
  );
  assert.ok(r.feed, r.reason || r.status);
  assert.equal(r.feed.creator_id, c.id);
});
