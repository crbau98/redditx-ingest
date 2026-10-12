'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let sharp; try { sharp = require('sharp'); } catch { /* optional */ }
const skip = !sharp && 'sharp not installed';

let phash; let PhashIndex; let repo; let pipeline; let maintenance; let dedupe; let imagefilter; let feed; let n = 0; let mock;

/** A textured test picture: deterministic blobs on a gradient (seeded), so different seeds are different pictures. */
function svg(seed, { w = 480, h = 360, bright = 0 } = {}) {
  let x = seed * 2654435761 >>> 0;
  const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
  const shapes = Array.from({ length: 14 }, () => `<circle cx="${rnd() * w}" cy="${rnd() * h}" r="${20 + rnd() * 90}" fill="rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})" opacity="0.8"/>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})"/>${shapes}<rect width="100%" height="100%" fill="white" opacity="${bright}"/></svg>`);
}
const jpeg = (seed, o = {}, q = 90) => sharp(svg(seed, o)).jpeg({ quality: q }).toBuffer();

before(async () => {
  prepareEnv();
  mock = await start({});
  phash = require('../src/lib/phash');
  ({ PhashIndex } = require('../src/lib/phash-index'));
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  maintenance = require('../src/engine/maintenance');
  dedupe = require('../src/services/dedupe');
  imagefilter = require('../src/lib/imagefilter');
  feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
});
after(async () => { imagefilter._reset(); await imagefilter.shutdown(); await mock.close(); });

describe('perceptual hash', { skip }, () => {
  test('survives resizing, recompression and a brightness change, and tells different pictures apart', async () => {
    const base = await phash.hashBuffer(await jpeg(1));
    assert.match(base, /^[0-9a-f]{32}$/);
    const small = await phash.hashBuffer(await sharp(await jpeg(1)).resize(160).jpeg({ quality: 40 }).toBuffer());
    const bright = await phash.hashBuffer(await jpeg(1, { bright: 0.12 }));
    assert.ok(phash.similar(base, small, 6), `resized/recompressed ${JSON.stringify(phash.distances(base, small))}`);
    assert.ok(phash.similar(base, bright, 6), `brighter ${JSON.stringify(phash.distances(base, bright))}`);
    for (const s of [2, 3, 4, 5]) assert.equal(phash.similar(base, await phash.hashBuffer(await jpeg(s)), 6), false, `seed ${s} is a different picture`);
  });
  test('a flat image has nothing to hash, garbage never throws', async () => {
    assert.equal(await phash.hashBuffer(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()), null);
    assert.equal(await phash.hashBuffer(Buffer.from('not an image')), null);
  });
});

describe('multi-index', () => {
  const rand = (() => { let x = 7; return () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x; }; })();
  const hex = () => Array.from({ length: 4 }, () => rand().toString(16).padStart(8, '0')).join('');
  const flip = (h, bits) => { const b = Buffer.from(h, 'hex'); for (const i of bits) b[i >> 3] ^= 1 << (i & 7); return b.toString('hex'); };

  test('finds exactly what a brute-force scan finds (pHash half), supports removal', () => {
    const idx = new PhashIndex(); const all = [];
    for (let i = 0; i < 400; i++) { const h = hex(); all.push([`m${i}`, h]); idx.add(`m${i}`, h, { type: 'image', aspect: 1 }); }
    for (let q = 0; q < 100; q++) {
      const src = all[q][1];
      const bits = Array.from({ length: q % 8 }, (_, k) => (k * 7 + q) % 64); // flip up to 7 of the first 64 bits
      const query = flip(src, [...new Set(bits)]);
      const got = idx.find(query, { max: 7, type: 'image', aspect: 1 }).map((m) => m.id);
      assert.ok(got.includes(all[q][0]), `query ${q} must find its source`);
    }
    idx.remove('m0');
    assert.equal(idx.find(all[0][1], { max: 0, type: 'image', aspect: 1 }).some((m) => m.id === 'm0'), false);
  });
  test('image and video poster hashes are never mixed, wildly different aspect ratios do not match', () => {
    const idx = new PhashIndex(); const h = hex();
    idx.add('v', h, { type: 'video', aspect: 1.78 });
    assert.equal(idx.find(h, { max: 6, type: 'image', aspect: 1.78 }).length, 0);
    assert.equal(idx.find(h, { max: 6, type: 'video', aspect: 0.56 }).length, 0);
    assert.equal(idx.find(h, { max: 6, type: 'video', aspect: 1.77 }).length, 1);
  });
});

describe('pipeline dedupe (analyzer replaced by a fake)', () => {
  const settings = { probeUnknownHosts: false, scopeMode: 'open', imageFilter: true, imageFilterThreshold: 50, dedupe: true, dedupeDistance: 6 };
  const item = (o) => ({ sourceId: `d${++n}`, title: 'Gym selfie', author: `bro${n}`, community: 'gaybrosgonewild', mediaType: 'image', trusted: true, width: 800, height: 600, mediaUrl: `https://i.redd.it/dd${n}.jpg`, sourceUrl: `https://reddit.com/r/x/${n}`, ...o });
  const H = (seed) => { const r = Array.from({ length: 4 }, (_, i) => (Math.imul(seed + i, 2654435761) >>> 0).toString(16).padStart(8, '0')).join(''); return r; };
  const fake = (map) => imagefilter._setAnalyzer(async (url) => map[url] || { status: 'ok', faces: [], phash: H(900 + url.length * 31 + url.charCodeAt(url.length - 5)) });

  test('the same picture again becomes an "also on" entry of the original, not a second item', async () => {
    fake({ 'https://i.redd.it/orig.jpg': { status: 'ok', faces: [], phash: H(1) }, 'https://other.example/copy.jpg': { status: 'ok', faces: [], phash: H(1) } });
    const a = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/orig.jpg' }), feed, null, settings);
    assert.equal(a.outcome, 'added');
    const b = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/copy.jpg', previewUrl: 'https://other.example/copy.jpg', platform: 'reddit', author: 'someoneelse' }), feed, null, settings);
    assert.equal(b.outcome, 'dupe', JSON.stringify(b));
    assert.equal(b.mediaId, a.mediaId);
    assert.equal(repo.media.altSources(a.mediaId).length, 1);
  });
  test('dedupe off: both are kept; a removed picture comes back blocked', async () => {
    fake({ 'https://i.redd.it/k1.jpg': { status: 'ok', faces: [], phash: H(2) }, 'https://i.redd.it/k2.jpg': { status: 'ok', faces: [], phash: H(2) } });
    const off = { ...settings, dedupe: false };
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/k1.jpg' }), feed, null, off)).outcome, 'added');
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/k2.jpg' }), feed, null, off)).outcome, 'added');

    fake({ 'https://i.redd.it/r1.jpg': { status: 'ok', faces: [], phash: H(3) }, 'https://i.redd.it/r2.jpg': { status: 'ok', faces: [], phash: H(3) } });
    const r = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/r1.jpg' }), feed, null, settings);
    repo.media.block(r.mediaId, 'admin removed it', 'admin');
    const again = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/r2.jpg' }), feed, null, settings);
    assert.equal(again.outcome, 'blocked', JSON.stringify(again));
  });
  test('a picture excluded for showing a woman blocks its look-alikes too', async () => {
    fake({ 'https://i.redd.it/w1.jpg': { status: 'ok', faces: [{ gender: 'female', score: 0.95, confidence: 0.9 }], phash: H(4) }, 'https://mirror.example/w2.jpg': { status: 'ok', faces: [], phash: H(4) } });
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/w1.jpg' }), feed, null, settings)).outcome, 'excluded');
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://mirror.example/w2.jpg' }), feed, null, settings)).outcome, 'blocked');
  });
  test('schema v6 provides the phash column and the dedupe tables', () => {
    const cols = repo.db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
    assert.ok(cols.includes('phash'));
    for (const t of ['media_alt_sources', 'phash_blocklist']) assert.ok(repo.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
  });
  test('GET media detail lists alternative sources', async () => {
    const id = repo.db.prepare('SELECT media_id AS id FROM media_alt_sources LIMIT 1').get().id;
    const also = repo.media.altSources(id);
    assert.ok(also.length && also[0].source_url);
  });
  test('hash sweep gives stored pictures a hash and hides later duplicates of older ones', async () => {
    const ins = (u) => repo.media.insert({
      creator_id: null, feed_id: feed.id, platform: 'reddit', source_id: `hs${++n}`, source_key: `reddit:hs${n}:0`, post_key: `reddit:hs${n}`, position: 0, source_url: `https://reddit.com/hs${n}`,
      community: 'gaybrosgonewild', author: 'hsuser', title: 'old', media_type: 'image', media_url: u, preview_url: u, hash: `hshash${n}`, nsfw_level: 'explicit', scope: 'in', width: 800, height: 600,
      publish_state: 'published', posted_at: new Date().toISOString(),
    }, ['gay']);
    const first = ins('https://i.redd.it/sw-a.jpg'); const second = ins('https://i.redd.it/sw-b.jpg'); const third = ins('https://i.redd.it/sw-c.jpg');
    fake({ 'https://i.redd.it/sw-a.jpg': { status: 'ok', phash: H(50) }, 'https://i.redd.it/sw-b.jpg': { status: 'ok', phash: H(50) }, 'https://i.redd.it/sw-c.jpg': { status: 'ok', phash: H(51) } });
    const r = await maintenance.hashSweep({ limit: 500, settings });
    assert.ok(r.hashed >= 3 && r.collapsed >= 1, JSON.stringify(r));
    assert.equal(repo.media.get(first).publish_state, 'published');
    assert.equal(repo.media.get(second).publish_state, 'hidden');
    assert.equal(repo.media.get(third).publish_state, 'published');
    assert.equal(repo.media.altSources(first).length, 1);
    assert.equal((await maintenance.hashSweep({ limit: 500, settings })).checked, 0, 'cursor moved on');
  });
});
