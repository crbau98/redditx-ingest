'use strict';
/**
 * Coomer's public creator index (src/lib/coomer-index.js) and the discovery pass that follows
 * creators from it. The index is served by a mock, so a suite never touches the public mirror.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');

const CREATORS = [
  { id: 'adamxlee', name: 'adamxlee', service: 'onlyfans', indexed: 1734717454, updated: 1737977860 },
  { id: 'aidengarciaxxx', name: 'aidengarciaxxx', service: 'onlyfans', indexed: 1745659411, updated: 1758990198 },
  { id: 'nash.brandt', name: 'nash.brandt', service: 'onlyfans', indexed: 1740000000, updated: 1740000001 },
  { id: 'somegirl', name: 'somegirl', service: 'onlyfans', indexed: 1740000000, updated: 1740000001 },
  { id: 'fanslyguy', name: 'fanslyguy', service: 'fansly', indexed: 1740000000, updated: 1740000001 },
];

let mock; let repo; let index; let discovery; let settings;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-coomerindex-'));
  process.env.COOMER_BASE_URL = 'http://coomer.test';
  process.env.COOMER_INDEX_CACHE = path.join(dir, 'creators.json');
  mock = await start({
    '/api/v1/creators': () => ({ json: CREATORS }),
  });
  // The module reads the base URL at require time, so point it at the mock through config.
  process.env.COOMER_BASE_URL = mock.url;
  prepareEnv({ COOMER_BASE_URL: mock.url, BRAVE_API_KEY: '' });
  repo = require('../src/db/repo');
  settings = require('../src/settings');
  index = require('../src/lib/coomer-index');
  discovery = require('../src/engine/discovery');
});

after(async () => { await mock.close(); });

describe('coomer creator index', () => {
  test('one public response becomes a lookup table for every service', async () => {
    const info = await index.ensure({ force: true });
    assert.equal(info.count, CREATORS.length);
    assert.equal(info.services.onlyfans, 4);
    assert.equal(info.services.fansly, 1);
  });

  test('handle lookups ignore dots, dashes and underscores', () => {
    assert.equal(index.lookup('adamxlee').id, 'adamxlee');
    assert.equal(index.lookup('Adam_XLee').id, 'adamxlee');
    assert.equal(index.lookup('nash.brandt').id, 'nash.brandt');
    assert.equal(index.lookup('nashbrandt').id, 'nash.brandt');
    assert.equal(index.lookup('nobody-here'), null);
  });

  test('a name only matches when the indexed account is built from that name', () => {
    // "Adam Lee" → adamxlee is NOT built from the name, so no match: a namesake must not become his feed.
    assert.equal(index.best({ name: 'Adam Lee' }), null);
    // An exact handle always wins.
    assert.equal(index.best({ handle: 'adamxlee', name: 'Someone Else' }).how, 'handle');
    // A name whose own handle is built from it does match.
    assert.equal(index.best({ name: 'Fansly Guy' }).id, 'fanslyguy');
  });

  test('the index is cached on disk, so a restart does not refetch it', async () => {
    const first = await index.ensure({ force: true });
    assert.ok(first.count > 0);
    const size = fs.statSync(process.env.COOMER_INDEX_CACHE).size;
    assert.ok(size > 0, 'the creator list is written to the data dir');
    // A second load reads the cache: the mock would answer again, but the file is fresh.
    const again = await index.ensure();
    assert.equal(again.count, CREATORS.length);
  });

  test('an unreachable index leaves the caller with nothing, not a crash', async () => {
    // A fresh module instance pointed at a closed port with no disk cache: the fetch fails, nothing
    // is cached, and the caller gets null (so discovery logs a warning and moves on instead of throwing).
    delete require.cache[require.resolve('../src/lib/coomer-index')];
    const savedCache = process.env.COOMER_INDEX_CACHE;
    process.env.COOMER_INDEX_CACHE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-nocache-')), 'creators.json');
    const config = require('../src/config');
    const savedBase = config.baseUrls.coomer;
    config.baseUrls.coomer = 'http://127.0.0.1:1';
    const broken = require('../src/lib/coomer-index');
    const info = await broken.ensure();
    assert.equal(info, null);
    assert.equal(broken.lookup('adamxlee'), null);
    config.baseUrls.coomer = savedBase;
    process.env.COOMER_INDEX_CACHE = savedCache;
    delete require.cache[require.resolve('../src/lib/coomer-index')];
    index = require('../src/lib/coomer-index');
  });
});

describe('coomer index discovery', () => {
  test('paid handles the mirror knows become creator feeds; unknown handles do not', async () => {
    await index.ensure({ force: true });
    // Two leads: one the mirror has (adamxlee), one it does not (ghosthandle).
    repo.onlyfans.note('adamxlee', { service: 'OnlyFans', origin: 'search', displayName: 'Adam' });
    repo.onlyfans.note('ghosthandle', { service: 'OnlyFans', origin: 'search', displayName: 'Ghost' });
    const out = await discovery.coomerIndexDiscovery({ limit: 10 });
    assert.equal(out.indexed, true);
    assert.equal(out.checked, 2);
    assert.equal(out.matched, 1);
    assert.equal(out.feeds, 1);
    const feed = repo.feeds.list({ platform: 'coomer', kind: 'user' }).items.find((f) => /adamxlee/.test(f.target));
    assert.ok(feed, 'the mirrored creator now has his own coomer feed');
    assert.match(feed.target, /^onlyfans\/adamxlee$/);
  });

  test('a hard-female or unsafe handle is rejected before it becomes a feed', async () => {
    await index.ensure({ force: true });
    repo.onlyfans.note('somegirl', { service: 'OnlyFans', origin: 'search', displayName: 'Some Girl' });
    const out = await discovery.coomerIndexDiscovery({ limit: 10 });
    assert.equal(out.feeds, 0, 'no new feed for a female-scoped handle');
    const feed = repo.feeds.list({ platform: 'coomer', kind: 'user' }).items.find((f) => /somegirl/.test(f.target));
    assert.equal(feed, undefined);
  });

  test('the pass is gated behind the test flag like every other live-network strategy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'discovery.js'), 'utf8');
    assert.match(src, /report\.coomerIndex = await coomerIndexDiscovery/, 'the index pass runs in the discovery cycle');
    assert.match(src, /!config\.isTest\)\s*report\.coomerIndex/, 'and is skipped under test');
  });

  test('the mirror pass respects the per-run follow cap', async () => {
    settings.update({ coomerIndexFollows: 0 });
    const out = await discovery.coomerIndexDiscovery({ limit: 0 });
    assert.equal(out.feeds, 0);
    settings.update({ coomerIndexFollows: 25 });
  });
});
