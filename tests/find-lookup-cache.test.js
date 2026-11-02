'use strict';
/**
 * Find (#/find) session cache. /api/lookup is rate-limited and takes ~30s, so re-running a query
 * that already resolved (Back, Try again, Enter twice, the ?q= remount) must not hit the network.
 * The cache is a pure module so it is exercised directly; the view wiring is guarded by reading the source.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const pub = path.join(__dirname, '..', 'public', 'js');
const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');

// The browser module uses ES syntax with no package.json "type", so copy it to a .mjs for node.
async function loadCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-cache-'));
  const file = path.join(dir, 'lookup-cache.mjs');
  fs.copyFileSync(path.join(pub, 'lookup-cache.js'), file);
  return import(pathToFileURL(file).href);
}

test('a resolved query is served from the cache, ignoring case and extra spaces', async () => {
  const { createLookupCache } = await loadCache();
  const cache = createLookupCache();
  const result = { candidates: [{ target: 'jakipz' }] };
  cache.set('Reno  Gold', result);
  assert.equal(cache.get('reno gold'), result);
  assert.equal(cache.get('  RENO GOLD '), result);
  assert.equal(cache.get('someone else'), null);
});

test('empty results and empty queries are never stored (a failed or blank lookup must be retried live)', async () => {
  const { createLookupCache } = await loadCache();
  const cache = createLookupCache();
  cache.set('', { candidates: [] });
  cache.set('   ', { candidates: [] });
  cache.set('nobody', null);
  assert.equal(cache.size, 0);
  assert.equal(cache.get('nobody'), null);
});

test('entries expire after the TTL', async () => {
  const { createLookupCache } = await loadCache();
  let now = 1_000_000;
  const cache = createLookupCache({ ttl: 60_000, now: () => now });
  cache.set('jakipz', { candidates: [1] });
  now += 59_999;
  assert.notEqual(cache.get('jakipz'), null);
  now += 2;
  assert.equal(cache.get('jakipz'), null);
  assert.equal(cache.size, 0);
});

test('the cache is bounded and evicts the least recently stored query', async () => {
  const { createLookupCache } = await loadCache();
  const cache = createLookupCache({ max: 2 });
  cache.set('a', { candidates: ['a'] });
  cache.set('b', { candidates: ['b'] });
  cache.set('a', { candidates: ['a2'] }); // re-store moves "a" to the newest slot
  cache.set('c', { candidates: ['c'] }); // evicts "b", the oldest
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), null);
  assert.deepEqual(cache.get('a'), { candidates: ['a2'] });
  assert.deepEqual(cache.get('c'), { candidates: ['c'] });
});

test('the Find view checks the cache before it calls /api/lookup, and only stores successful results', () => {
  const src = read('views', 'find.js');
  assert.match(src, /import \{ lookupCache \} from '\.\.\/lookup-cache\.js'/);
  const hit = src.indexOf('lookupCache.get(q)');
  const call = src.indexOf("post('/api/lookup'");
  assert.ok(hit > 0 && call > 0 && hit < call, 'cache lookup happens before the rate-limited network call');
  const store = src.indexOf('lookupCache.set(q, state.result)');
  assert.ok(store > call, 'successful result is stored after the call');
  const catchIdx = src.indexOf('} catch (e) {', call);
  assert.ok(store < catchIdx, 'the store sits in the try block, so errors are never cached');
});
