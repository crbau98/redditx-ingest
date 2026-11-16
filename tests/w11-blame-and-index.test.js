'use strict';
/**
 * Wave 11: loop-stall attribution and the packed perceptual-hash index.
 *
 *   blockwatch   a block is blamed on the timed work that held the loop (a named slice or the SQL text), not on every job
 *                that merely happened to be pending; with no timed work it falls back to the pending labels
 *   PhashIndex   packed typed-array storage answers exactly what the old per-row-object index did
 *   dedupe       the boot build is sliced by time and ends with the same index a straight load would give
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ PRISM_SLOW_BLOCK_MS: '60', PRISM_SLICE_MIN_MS: '10', ADMIN_KEY: 'test-key' });
const blockwatch = require('../src/lib/blockwatch');
const { PhashIndex } = require('../src/lib/phash-index');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* the stall */ } };
after(() => { blockwatch.stop(); blockwatch.reset(); });

describe('blockwatch names the code that held the loop', () => {
  test('a timed slice is the culprit; pending async labels are only context', async () => {
    blockwatch.start(); blockwatch.reset();
    const leaveA = blockwatch.enter('warm:dedupe'); const leaveB = blockwatch.enter('faceSweep'); blockwatch.work('embed');
    await wait(120);
    blockwatch.slice('dedupe:load', () => spin(300));
    await wait(450);
    const b = blockwatch.lastBlock();
    assert.ok(b && b.ms >= 250, `block recorded, got ${b && b.ms}`);
    assert.equal(b.culprit, 'dedupe:load');
    assert.match(b.job, /^dedupe:load \(\d+ ms/, 'the headline is the culprit, not the three pending jobs');
    assert.deepEqual(b.pending.split(', ').sort(), ['embed', 'faceSweep', 'warm:dedupe']);
    leaveA(); leaveB(); blockwatch.work('idle'); blockwatch.stop(); blockwatch.reset();
  });

  test('instrumentDb blames the slow statement by its SQL text', async () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    blockwatch.instrumentDb(db);
    assert.equal(blockwatch.instrumentDb(db), false, 'idempotent');
    db.exec('CREATE TABLE t (n INTEGER)');
    const ins = db.prepare('INSERT INTO t VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 20000; i++) ins.run(i); })();
    blockwatch.start(); blockwatch.reset();
    await wait(120);
    const rows = db.prepare('SELECT a.n FROM t a, t b WHERE a.n < 2500 AND b.n < 2500 AND (a.n + b.n) % 7 = 0').all(); // a deliberately slow scan
    assert.ok(rows.length > 0);
    await wait(450);
    const b = blockwatch.lastBlock();
    assert.ok(b, 'block recorded');
    assert.match(b.culprit || '', /^sql: SELECT a\.n FROM t a, t b/);
    assert.equal(db.prepare('SELECT 1 AS x').pluck().get(), 1, 'wrapped statements keep pluck()/get() semantics');
    assert.equal(db.transaction((x) => x + 1)(1), 2, 'transactions still return their value');
    assert.equal(db.transaction((x) => x + 1).immediate(2), 3);
    blockwatch.stop(); blockwatch.reset(); db.close();
  });

  test('no timed work in the window: fall back to the pending labels, culprit null', async () => {
    blockwatch.start(); blockwatch.reset();
    blockwatch.work('testJob');
    await wait(120);
    spin(250);
    await wait(400);
    const b = blockwatch.lastBlock();
    assert.ok(b);
    assert.equal(b.culprit, null);
    assert.equal(b.job, 'testJob');
    blockwatch.work('idle'); blockwatch.stop(); blockwatch.reset();
  });

  test('a small timed slice does not steal the blame from a long untimed stall', async () => {
    blockwatch.start(); blockwatch.reset();
    blockwatch.work('realCulprit');
    await wait(120);
    blockwatch.slice('tiny', () => spin(15));
    spin(300);
    await wait(450);
    const b = blockwatch.lastBlock();
    assert.ok(b);
    assert.equal(b.culprit, null);
    assert.equal(b.job, 'realCulprit');
    blockwatch.work('idle'); blockwatch.stop(); blockwatch.reset();
  });
});

describe('PhashIndex (packed)', () => {
  const rhex = () => crypto.randomBytes(16).toString('hex');
  const flip = (hex, bits) => { const b = Buffer.from(hex, 'hex'); for (let i = 0; i < bits; i++) b[i * 2] ^= 1 << (i % 8); return b.toString('hex'); };
  const uuid = () => crypto.randomUUID();
  const pop = (a, b) => { let n = 0; const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex'); for (let i = 0; i < 16; i++) { let v = x[i] ^ y[i]; while (v) { n += v & 1; v >>= 1; } } return n; };

  test('finds exactly what a brute-force scan finds (uuid ids, 32-hex ids, plain strings)', () => {
    const ix = new PhashIndex(4); // tiny start: forces several growths
    const rows = [];
    for (let i = 0; i < 3000; i++) {
      const id = i % 3 === 0 ? uuid() : i % 3 === 1 ? rhex() : `plain-${i}`;
      const h = rows.length && i % 5 === 0 ? flip(rows[i - 1].h, 1 + (i % 4)) : rhex();
      rows.push({ id, h, type: i % 7 === 0 ? 'video' : 'image', aspect: i % 4 === 0 ? 0 : 1 + (i % 5) / 10 });
      ix.add(id, h, { type: rows[i].type, aspect: rows[i].aspect });
    }
    assert.equal(ix.size, 3000);
    const ref = (q, { max, type, aspect }) => {
      const out = [];
      for (const r of rows) {
        if (type && r.type !== type) continue;
        if (aspect && r.aspect && Math.abs(Math.log(aspect / r.aspect)) > 0.15) continue;
        const wp = pop(q.slice(0, 16), r.h.slice(0, 16)); const wd = pop(q.slice(16), r.h.slice(16));
        // the index checks first-half then second-half distances with limit and limit+6, and only sees rows sharing a key byte
        let share = false; for (let k = 0; k < 16; k += 2) if (q.slice(k, k + 2) === r.h.slice(k, k + 2)) share = true;
        if (share && wp <= max && wd <= max + 6) out.push(r.id);
      }
      return out.sort();
    };
    for (let i = 0; i < 300; i += 3) {
      const opts = { max: 6, type: i % 2 ? 'image' : undefined, aspect: i % 2 ? 1.1 : undefined };
      const got = ix.find(i % 2 ? flip(rows[i].h, 2) : rows[i].h, opts).map((m) => m.id).sort();
      assert.deepEqual(got, ref(i % 2 ? flip(rows[i].h, 2) : rows[i].h, opts), `row ${i}`);
    }
  });

  test('ids round-trip unchanged (dashed uuid, bare hex, other strings)', () => {
    const ix = new PhashIndex();
    const ids = [uuid(), uuid().replace(/-/g, ''), 'not-a-uuid', 'ABCDEF01-2345-6789-ABCD-EF0123456789', ''];
    for (const id of ids.slice(0, 4)) { const h = rhex(); ix.add(id, h); assert.equal(ix.find(h)[0].id, id); }
    assert.equal(ix.size, 4);
  });

  test('remove(), re-add (same id replaces), slot reuse, clear()', () => {
    const ix = new PhashIndex(2);
    const a = uuid(); const h1 = rhex(); const h2 = rhex();
    ix.add(a, h1); ix.add(a, h2);
    assert.equal(ix.size, 1, 're-adding an id replaces it');
    assert.deepEqual(ix.find(h1).map((m) => m.id), []);
    assert.deepEqual(ix.find(h2).map((m) => m.id), [a]);
    ix.remove(a);
    assert.equal(ix.size, 0); assert.equal(ix.buckets.size, 0, 'every bucket is released'); assert.equal(ix.has(a), false);
    const keep = []; for (let i = 0; i < 500; i++) { const id = uuid(); const h = rhex(); keep.push([id, h]); ix.add(id, h); }
    for (let i = 0; i < 500; i += 2) ix.remove(keep[i][0]);
    for (let i = 0; i < 100; i++) ix.add(uuid(), rhex()); // reuses freed slots, rehashes past the tombstones
    assert.equal(ix.size, 250 + 100);
    for (let i = 1; i < 500; i += 2) assert.equal(ix.find(keep[i][1])[0].id, keep[i][0]);
    ix.clear(); assert.equal(ix.size, 0); assert.deepEqual(ix.find(keep[1][1]), []);
  });

  test('bad hashes are ignored; type and aspect filters apply', () => {
    const ix = new PhashIndex();
    ix.add('x', 'short'); ix.add('y', null); assert.equal(ix.size, 0);
    const h = rhex();
    ix.add('img', h, { type: 'image', aspect: 1 }); ix.add('vid', h, { type: 'video', aspect: 1 }); ix.add('wide', h, { type: 'image', aspect: 2 });
    assert.deepEqual(ix.find(h, { type: 'video' }).map((m) => m.id), ['vid']);
    assert.deepEqual(ix.find(h, { type: 'image', aspect: 1 }).map((m) => m.id).sort(), ['img']);
    assert.equal(ix.find(h, {}).length, 3);
  });

  test('1M-row footprint stays under 130 bytes per picture (off the V8 heap)', () => {
    const ix = new PhashIndex();
    const N = 200000;
    for (let i = 0; i < N; i++) ix.add(uuid(), rhex());
    assert.ok(ix.bytes / N < 130, `bytes per row ${Math.round(ix.bytes / N)}`);
  });
});

describe('dedupe boot build', () => {
  test('is sliced by time and produces the same index as a straight load', async () => {
    const repo = require('../src/db/repo');
    const dedupe = require('../src/services/dedupe');
    const mk = (i) => repo.media.insert({ platform: 'reddit', source_id: `w11${i}`, source_key: `reddit:w11${i}:0`, post_key: `reddit:w11${i}`, author: 'a', title: `t${i}`, media_type: 'image', media_url: `https://i.redd.it/w11${i}.jpg`, hash: `w11h${i}`, phash: crypto.randomBytes(16).toString('hex'), posted_at: new Date().toISOString() }, []);
    const hashes = new Map();
    for (let i = 0; i < 1500; i++) { const id = mk(i); hashes.set(id, repo.media.hashInfo(id).phash); }
    dedupe._reset();
    const r = await dedupe.loadChunked({ chunk: 400, targetMs: 5 });
    assert.ok(r.chunks >= 4, `several slices, got ${r.chunks}`);
    assert.equal(r.rows, 1500);
    assert.equal(dedupe.stats().indexed, 1500);
    for (const [id, h] of [...hashes].slice(0, 25)) assert.equal(dedupe.check({ phash: h, mediaType: 'image' }).dup.id, id);
    dedupe._reset();
  });
});
