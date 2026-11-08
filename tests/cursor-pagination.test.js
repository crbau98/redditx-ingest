'use strict';
/**
 * Cursor paging for the media feed: stable across inserts, no duplicate rows between pages, and
 * a plain page fallback when the caller did not send a cursor.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let server; let base;

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (server) await new Promise((r) => server.close(r)); });

let n = 0;
const post = (over = {}) => {
  n++;
  return repo.media.insert({
    creator_id: null, platform: 'reddit', source_id: `cur${n}`, source_key: `reddit:cur${n}:0`, post_key: `reddit:cur${n}`,
    author: 'cursor_author', title: `cursor post ${n}`, media_type: 'image', media_url: `https://media.example/cur${n}.jpg`,
    hash: `curhash${n}`, source_url: `https://example.com/cur${n}`,
    posted_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), score: n,
    ...over,
  }, []);
};

test('recent cursor walks the whole list once, with no duplicates', () => {
  for (let i = 0; i < 30; i++) post();
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = repo.media.list({ sort: 'recent', limit: 7, cursor });
    seen.push(...r.items.map((x) => x.id));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30);
});

test('a newer row inserted between pages does not shift or repeat the next page', () => {
  const first = repo.media.list({ sort: 'recent', limit: 5 });
  const firstIds = new Set(first.items.map((x) => x.id));
  post({ posted_at: new Date(Date.UTC(2026, 1, 1)).toISOString() }); // newer than everything
  const second = repo.media.list({ sort: 'recent', limit: 5, cursor: first.nextCursor });
  assert.equal(second.items.some((x) => firstIds.has(x.id)), false);
  assert.equal(second.items.some((x) => x.title === `cursor post ${n}`), false);
});

test('the last page reports no next cursor, and an invalid cursor falls back to page 0', () => {
  const all = repo.media.list({ sort: 'recent', limit: 500 });
  assert.equal(all.nextCursor, null);
  const fallback = repo.media.list({ sort: 'recent', limit: 3, cursor: 'not-a-cursor' });
  assert.equal(fallback.page, 0);
  assert.equal(fallback.items.length, 3);
});

test('top and oldest have their own stable cursors', () => {
  const top = repo.media.list({ sort: 'top', limit: 4 });
  assert.ok(top.nextCursor);
  const next = repo.media.list({ sort: 'top', limit: 4, cursor: top.nextCursor });
  assert.ok(next.items.every((x) => top.items.every((y) => x.id !== y.id)));
  const old = repo.media.list({ sort: 'oldest', limit: 4 });
  assert.ok(old.nextCursor);
  assert.ok(new Date(old.items[0].posted_at) <= new Date(old.items[old.items.length - 1].posted_at));
});

test('the HTTP API returns the cursor and continues without overlap', async () => {
  const call = async (cursor) => {
    const qs = new URLSearchParams({ sort: 'recent', limit: '5' });
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${base}/api/media?${qs}`, { headers: { cookie: 'prism_age=1' } });
    assert.equal(res.status, 200);
    return res.json();
  };
  const first = await call();
  assert.equal(typeof first.nextCursor, 'string');
  assert.ok(first.total >= 30);
  const second = await call(first.nextCursor);
  assert.ok(second.items.length > 0);
  assert.equal(second.items.some((x) => first.items.some((y) => x.id === y.id)), false);
  assert.equal(second.total, null, 'a cursor page skips the COUNT(*)');
});
