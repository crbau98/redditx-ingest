'use strict';
/**
 * src/engine/discovery.js is the facade (run loop, status, timers); the strategies live in src/engine/discovery/*.js.
 * The public API must not change: callers and tests use the same 47 keys, in the same order.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const discovery = require('../src/engine/discovery');

const KEYS = ['normalizeBskyActor', 'fetchBskyProfiles', 'archivePosts', 'fetchPerformerDirectory', 'seedCreators', 'seedStatus', 'onlyfansDiscovery',
  'coomerDiscovery', 'coomerIndexDiscovery', 'coomerNameDiscovery', 'gffDiscovery', 'gffNextPage', 'xhamsterDiscovery', 'pornhubDiscovery',
  'directoryHarvest', 'discoverCreatorMentions', 'mentionSearchQuery', 'probeFediMentions', 'noteOnlyFans', 'notePaidHandles', 'noteSearchedPaid',
  'probeOnlyFans', 'run', 'status', 'statusSummary', 'start', 'stop', 'follow', 'reject', 'promote', 'consider', 'mineMentions', 'blueskyGraph',
  'braveIdentity', 'braveTopics', 'communityDiscovery', 'creatorHangouts', 'redditPosters', 'imageKeywordDiscovery', '_setImageProvider',
  'blueskySuggested', 'peopleSearch', 'signalYield', 'enrich', 'scoreOf', 'coreHandle', 'usable'];

test('the public API is unchanged: the same keys in the same order, all functions', () => {
  assert.deepEqual(Object.keys(discovery), KEYS);
  for (const k of KEYS) assert.equal(typeof discovery[k], 'function', k);
  assert.equal(discovery.statusSummary, discovery.status);
});

test('every module in src/engine/discovery loads and the facade re-exports its strategies', () => {
  const dir = path.join(__dirname, '../src/engine/discovery');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(files, ['core.js', 'decisions.js', 'paid.js', 'performers.js', 'social.js']);
  for (const f of files) {
    const mod = require(path.join(dir, f));
    assert.ok(Object.keys(mod).length > 0, `${f} exports something`);
    for (const [k, v] of Object.entries(mod)) if (KEYS.includes(k) && k !== 'normalizeBskyActor') assert.equal(discovery[k], v, `${f}: discovery.${k} is the module's own function`);
  }
});

test('discovery._setImageProvider still replaces the image search in its module', async () => {
  const social = require('../src/engine/discovery/social');
  const seen = [];
  discovery._setImageProvider(async (q, n) => { seen.push([q, n]); return [{ url: 'https://example.org/a.jpg' }]; });
  try { assert.deepEqual(await social.searchImages('gym', 3), [{ url: 'https://example.org/a.jpg' }]); } finally { discovery._setImageProvider(null); }
  assert.deepEqual(seen, [['gym', 3]]);
});

test('src/engine/discovery.js stays a short facade', () => {
  const lines = fs.readFileSync(path.join(__dirname, '../src/engine/discovery.js'), 'utf8').split('\n').length;
  assert.ok(lines < 600, `${lines} lines`);
});
