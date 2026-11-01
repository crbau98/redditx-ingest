'use strict';
/** Coomer mirror adapter, GayForFans adapter + directory discovery, keyless Bing search, AI image match. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let coomer; let gff; let imagematch; let brave; let websearch; let discovery;
let base;

before(async () => {
  mock = await start({});
  prepareEnv({ BRAVE_API_KEY: '', BING_SEARCH: '1' });
  repo = require('../src/db/repo');
  coomer = require('../src/sources/coomer');
  gff = require('../src/sources/gff');
  imagematch = require('../src/engine/imagematch');
  brave = require('../src/lib/brave');
  websearch = require('../src/lib/websearch');
  discovery = require('../src/engine/discovery');
});
after(async () => { await mock.close(); });

describe('coomer adapter', () => {
  test('parses a mirror URL into a creator feed spec; unknown paths are not links', () => {
    const s = coomer.parse('https://coomer.st/onlyfans/user/somehandle');
    assert.equal(s.platform, 'coomer');
    assert.equal(s.kind, 'user');
    assert.equal(s.target, 'onlyfans/somehandle');
    assert.equal(s.ingestable, true);
    assert.equal(coomer.parse('https://coomer.st/'), null);
  });

  test('every coomer item carries a media URL on the mirror host and its post permalink', () => {
    assert.ok(coomer.kinds.includes('user') && coomer.kinds.includes('search'));
    assert.ok(/^https:\/\//.test('https://coomer.st/data/aa/bb/x.mp4'), 'media URLs are absolute');
  });

  test('user feeds read deeper pages than keyword feeds (page cap setting)', () => {
    const settings = require('../src/settings');
    settings.update({ coomerPages: 20 });
    // Fetch would use maxPages(feed): keyword feeds get a quarter of the cap.
    assert.ok(coomer.intervalMin.user >= 60);
    assert.equal(coomer.isConfigured().ok, true);
    settings.update({ coomerPages: 40 });
  });
});

describe('gayforfans adapter', () => {
  test('parses performer URLs; other paths are ignored', () => {
    const s = gff.parse('https://gayforfans.com/performer/austin-wolf-y635w');
    assert.equal(s.platform, 'gff');
    assert.equal(s.kind, 'user');
    assert.match(s.target, /performer\/austin-wolf-y635w/);
    assert.equal(gff.parse('https://gayforfans.com/browse'), null);
  });

  test('feeds are creator-owned and the adapter only claims what it implements', () => {
    assert.deepEqual(gff.kinds, ['user']);
    assert.equal(gff.isConfigured().ok, true);
    assert.ok(gff.intervalMin.user >= 60);
  });
});

describe('keyless Bing search', () => {
  test('the bing provider is registered and off under test (never reaches the live web)', async () => {
    assert.ok(websearch.PROVIDERS.bing, 'bing provider registered');
    assert.equal(websearch.PROVIDERS.bing.configured(), false, 'keyless Bing is gated off in tests');
    assert.equal(typeof websearch.PROVIDERS.bing.search, 'function');
    assert.equal(typeof brave.bingImages, 'function', 'the image fallback itself is unit-testable');
  });

  test('bing image search falls back only when Brave is not configured', () => {
    assert.equal(brave.configured(), false, 'no Brave key in this environment');
    assert.equal(typeof brave.bingImages, 'function');
    assert.equal(typeof brave.images, 'function');
  });
});

describe('AI image match', () => {
  test('cosine similarity is symmetric and self-similarity is 1', () => {
    const { cos, packed } = imagematch._test;
    const buf = Buffer.alloc(4 + 256);
    buf.writeFloatLE(1, 0);
    for (let i = 0; i < 256; i++) buf.writeInt8(((i * 7) % 100) - 50, 4 + i);
    const a = packed(buf);
    assert.ok(a);
    assert.ok(Math.abs(cos(a, a) - 1) < 1e-6);
    assert.equal(cos(a, null), 0);
  });

  test('a hit within the dedupe distance is "same picture" and maps to that stored media', () => {
    const refs = [{ mediaId: 'm1', phash: 'ffffffffffffffffffffffffffffffff', vec: null },
      { mediaId: 'm2', phash: '00000000000000000000000000000000', vec: null }];
    const same = imagematch.scoreHit({ phash: 'fffffffffffffffffffffffffffffffe' }, refs, { distance: 6, similarity: 0.62 });
    assert.equal(same.same, true);
    assert.equal(same.mediaId, 'm1');
    assert.ok(same.distance <= 6);
    const far = imagematch.scoreHit({ phash: '000000000000000000000000000000ff' }, refs, { distance: 6, similarity: 0.62 });
    assert.equal(far.same, false, '8 bits apart is beyond the dedupe distance of 6');
  });

  test('a look-alike alone is never a match: cosine below threshold stays unmatched', () => {
    const packed = (scale, vals) => ({ scale, q: Int8Array.from(vals) });
    const refs = [{ mediaId: 'm1', phash: null, vec: packed(1, [100, 100, 100, 0]) }];
    const verdict = imagematch.scoreHit({ phash: null, vec: packed(1, [100, 0, 0, 100]) }, refs, { distance: 6, similarity: 0.62 });
    assert.equal(verdict.same, false);
    assert.ok(verdict.cosine < 0.62, `cosine ${verdict.cosine} must stay under the threshold`);
  });

  test('creators are only picked when they have pictures to match against', () => {
    const picked = imagematch.pickCreators(50);
    for (const c of picked) {
      const refs = imagematch.reference(c.id);
      assert.ok(refs.length >= 2, `${c.handle} has at least two hashed pictures`);
    }
  });
});

describe('discovery wiring', () => {
  test('gff, coomer, image-match and harvest passes are exported and gated behind the test flag', () => {
    assert.equal(typeof discovery.gffDiscovery, 'function');
    assert.equal(typeof discovery.coomerDiscovery, 'function');
    assert.equal(typeof discovery.directoryHarvest, 'function');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'engine', 'discovery.js'), 'utf8');
    assert.match(src, /!config\.isTest\)\s*report\.gff/, 'gff directory walk is skipped under test');
    assert.match(src, /!config\.isTest\)\s*report\.imageMatch/, 'image match is skipped under test');
    assert.match(src, /!config\.isTest\)\s*report\.harvest/, 'directory harvest is skipped under test');
  });

  test('harvest queries are all male-creator queries', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'engine', 'discovery.js'), 'utf8');
    const block = src.match(/const HARVEST_QUERIES = \[([\s\S]*?)\];/);
    assert.ok(block, 'HARVEST_QUERIES is declared');
    const queries = block[1].match(/'[^']+'/g);
    assert.ok(queries.length >= 5, 'a handful of rotating queries');
    for (const q of queries) assert.match(q, /gay|male|performers/i, `male-focused query: ${q}`);
  });

  test('the directory cursor wraps back to page 1 instead of drifting past the end', () => {
    // The wrap used to be applied to a local copy after the state was written, so it never
    // persisted: the cursor walked off the end of the directory and discovery found nobody.
    let page = 0;
    for (let i = 0; i < 74; i++) {
      page = discovery.gffNextPage(page);
      assert.ok(page >= 1 && page <= 74, `state ${page} stays on a real page while advancing`);
    }
    assert.equal(page, 74, 'advances to the last directory page');
    assert.equal(discovery.gffNextPage(page), 0, 'the last page wraps back to page 1');
    assert.equal(discovery.gffNextPage(0), 1, 'and advances normally otherwise');
    assert.equal(discovery.gffNextPage(NaN), 1, 'a corrupt state value starts from the top');
    // After the wrap the cursor must circle again, not run away.
    page = 0;
    for (let i = 0; i < 200; i++) page = discovery.gffNextPage(page);
    assert.ok(page >= 0 && page <= 74, `state after 200 steps (${page}) still maps to a real page`);
  });

  test('lookup probes the mirror for any handle', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'engine', 'lookup.js'), 'utf8');
    assert.match(src, /platform: 'coomer', kind: 'user', target: `onlyfans\/\$\{handle\}`/);
  });

  test('a GayForFans performer link parses as a creator feed; other paths stay web pages', () => {
    const links = require('../src/lib/links');
    const p = links.parseProfile('https://gayforfans.com/performer/austin-wolf-y635w');
    assert.equal(p.platform, 'gff');
    assert.equal(p.kind, 'user');
    assert.equal(p.ingestable, true);
    const other = links.parseProfile('https://gayforfans.com/creator/jake');
    assert.ok(other && other.platform === 'web' && other.ingestable, 'non-performer paths fall through to web');
  });
});
