'use strict';
/** Wave 11 item 2: one anonymous list request must not be able to hold the event loop (depth cap, bounded totals, short cache). */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ PRISM_LIST_CACHE: '1' });
const repo = require('../src/db/repo');
const pub = require('../src/routes/public');

let n = 0;
const add = (o = {}, tags = []) => { n++; return repo.media.insert({ platform: 'reddit', source_id: `w11l${n}`, source_key: `reddit:w11l${n}:0`, post_key: `reddit:w11l${n}`, media_type: 'image', media_url: `https://i.redd.it/w11l${n}.jpg`, hash: `w11lh${n}`, posted_at: new Date(Date.now() - n * 1000).toISOString(), ...o }, tags); };
before(() => { for (let i = 0; i < 60; i++) add({}, i % 2 ? ['w11bear', 'w11all'] : ['w11all']); });

describe('depth cap', () => {
  test('past MAX_PUBLIC_OFFSET rows the answer is an empty page and no query runs', () => {
    const real = repo.media.list; let calls = 0;
    repo.media.list = (...a) => { calls++; return real(...a); };
    try {
      const r = pub.mediaList({ page: '100000', limit: '120' });
      assert.deepEqual([r.items.length, r.total, r.nextCursor, r.page, r.limit], [0, null, null, 100000, 120]);
      const r2 = pub.mediaList({ page: '48123', limit: '117', sort: 'trending', tag: 'w11bear' });
      assert.equal(r2.items.length, 0);
      assert.equal(calls, 0, 'the database was not touched');
      const last = Math.floor(pub.MAX_PUBLIC_OFFSET / 48);
      pub.mediaList({ page: String(last), limit: '48', sort: 'recent' });
      assert.equal(calls, 1, 'the last page inside the cap still answers');
    } finally { repo.media.list = real; }
  });
  test('a cursor is never subject to the cap (keyset paging costs the same on every page)', () => {
    const first = pub.mediaList({ sort: 'recent', limit: '10' });
    assert.ok(first.nextCursor);
    const next = pub.mediaList({ sort: 'recent', limit: '10', cursor: first.nextCursor });
    assert.equal(next.items.length, 10);
    assert.notEqual(next.items[0].id, first.items[0].id);
  });
});

describe('a junk cursor does not lift the depth cap', () => {
  const real = repo.media.list;
  const spy = (fn) => { let calls = 0; repo.media.list = (...a) => { calls++; return real(...a); }; try { fn(); } finally { repo.media.list = real; } return calls; };
  test('malformed, wrong-sort and cursor-less-sort requests are capped like any deep page', () => {
    const good = pub.mediaList({ sort: 'recent', limit: '10' }).nextCursor;
    const topCursor = pub.mediaList({ sort: 'top', limit: '10' }).nextCursor;
    const calls = spy(() => {
      for (const q of [
        { sort: 'recent', page: '100000', cursor: 'x' },
        { sort: 'recent', page: '100000', cursor: 'not-base64-json' },
        { sort: 'recent', page: '100000', cursor: topCursor }, // a valid token, for another sort
        { q: 'gay', page: '100000', cursor: good },            // text match without a sort: cursors are ignored
        { sort: 'relevance', q: 'gay', page: '100000', cursor: good },
        { sort: 'random', page: '100000', cursor: good },
      ]) { const r = pub.mediaList(q); assert.equal(r.items.length, 0, JSON.stringify(q)); }
    });
    assert.equal(calls, 0, 'none of them reached the database');
  });
  test('a valid cursor on a cursor-capable sort still pages (no cap)', () => {
    const first = pub.mediaList({ sort: 'recent', limit: '10' });
    const calls = spy(() => { assert.equal(pub.mediaList({ sort: 'recent', limit: '10', page: '100000', cursor: first.nextCursor }).items.length, 10); });
    assert.equal(calls, 1);
  });
  test('the creator media route is under the same cap', async () => {
    const http = require('http');
    const c = repo.creators.create({ handle: 'w11capc', origin: 'admin' });
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: 'w11cc1', source_key: 'reddit:w11cc1:0', post_key: 'reddit:w11cc1', media_type: 'image', media_url: 'https://i.redd.it/w11cc1.jpg', hash: 'w11cch1', posted_at: new Date().toISOString() }, []);
    repo.creators.refreshStats(c.id);
    const server = require('../src/app').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const get = async (q) => (await fetch(`http://127.0.0.1:${server.address().port}/api/creators/${c.id}/media?${q}`, { headers: { cookie: 'prism_age=1' } })).json();
      assert.equal((await get('page=0')).items.length, 1);
      let calls = 0; repo.media.list = (...a) => { calls++; return real(...a); };
      const deep = await get('sort=recent&page=100000&cursor=x');
      assert.equal(deep.items.length, 0); assert.equal(calls, 0);
    } finally { repo.media.list = real; server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
  });
});

describe('bounded totals', () => {
  test('exact below the cap, a flagged lower bound above it; tag-driven and plain filters agree', () => {
    const exact = repo.media.list({ tag: 'w11bear', since: 'year', limit: 5 });
    assert.equal(exact.total, 30); assert.equal(exact.totalCapped, undefined);
    const all = repo.media.list({ tag: 'w11all', since: 'year', limit: 5 });
    assert.equal(all.total, 60);
    const capped = repo.media.list({ tag: 'w11all', since: 'year', limit: 5, countCap: 25 });
    assert.equal(capped.total, 25); assert.equal(capped.totalCapped, true);
    const plain = repo.media.list({ since: 'year', limit: 5, sort: 'top', countCap: 25 });
    assert.equal(plain.totalCapped, true); assert.equal(plain.total, 25);
  });
  test('admin lists keep the exact total (no cap)', () => {
    const r = repo.media.list({ admin: true, state: 'any', countCap: 5, limit: 5 });
    assert.ok(r.total >= 60); assert.equal(r.totalCapped, undefined);
  });
  test('"since" no longer makes a new query text every millisecond: the second identical list reuses the count', async () => {
    repo.media.list({ since: 'week', tag: 'w11bear', limit: 3, countCap: 10 }); // past the cap: reused whatever is written
    const real = repo.db.prepare.bind(repo.db); let counts = 0;
    repo.db.prepare = (sql) => { if (/COUNT\(\*\)/.test(sql)) counts++; return real(sql); };
    try {
      await new Promise((r) => setTimeout(r, 5));
      const again = repo.media.list({ since: 'week', tag: 'w11bear', limit: 3, countCap: 10 });
      assert.equal(again.total, 10); assert.equal(counts, 0, 'no new COUNT statement was even prepared');
    } finally { repo.db.prepare = real; }
  });
});

describe('totals under the cap follow writes at once', () => {
  test('a new item shows in an exact total immediately; a capped total is reused', () => {
    const before0 = repo.media.list({ tag: 'w11bear', since: 'year', limit: 2 }).total;
    add({}, ['w11bear']);
    assert.equal(repo.media.list({ tag: 'w11bear', since: 'year', limit: 2 }).total, before0 + 1);
  });
});

describe('short list cache', () => {
  test('identical requests share one query; random and different filters do not', () => {
    pub._listCache.clear();
    const real = repo.media.list; let calls = 0;
    repo.media.list = (...a) => { calls++; return real(...a); };
    try {
      const a = pub.mediaList({ sort: 'top', tag: 'w11bear', limit: '12' });
      const b = pub.mediaList({ sort: 'top', tag: 'w11bear', limit: '12' });
      assert.equal(calls, 1); assert.equal(a, b);
      pub.mediaList({ sort: 'top', tag: 'w11all', limit: '12' }); assert.equal(calls, 2);
      pub.mediaList({ sort: 'random', seed: '3' }); pub.mediaList({ sort: 'random', seed: '3' }); assert.equal(calls, 4);
    } finally { repo.media.list = real; }
  });
});
