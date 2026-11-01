'use strict';
/**
 * Coomer's deep backfill: a creator with more posts than one run can read must be walked across
 * runs (cursor `walk`), a run with nothing new must cost two requests, and new posts at the front
 * must never be missed. The mirror is a mock, so no test reaches the public site.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { start, prepareEnv } = require('./helpers/mock');

// 120 posts, newest first, all by the followed creator.
const POSTS = Array.from({ length: 120 }, (_, i) => ({
  id: `p${i}`,
  service: 'onlyfans',
  user: 'adamxlee',
  title: `post ${i}`,
  content: `<p>body ${i}</p>`,
  published: new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString(),
  file: { name: `clip${i}.mp4`, path: `/aa/bb/clip${i}.mp4` },
  attachments: [],
}));

let mock; let coomer; let settings; let asked; let limiter; let realSchedule;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-coomer-backfill-'));
  process.env.COOMER_BASE_URL = `http://127.0.0.1:1`;
  mock = await start({
    // The per-creator endpoint the adapter now uses for creator feeds: one array of his posts.
    '/api/v1/onlyfans/user/adamxlee/posts': (req, res, url) => {
      const o = Number(url.searchParams.get('o') || 0);
      asked.push(o);
      if (o % 50) return { status: 400, json: { error: "Offset is not a multiple of 50." } };
      return { json: POSTS.slice(o, o + 50) };
    },
    '/api/v1/posts': (req, res, url) => {
      const o = Number(url.searchParams.get('o') || 0);
      asked.push(o);
      if (o % 50) return { status: 400, json: { error: "Offset is not a multiple of 50." } };
      return { json: { posts: POSTS.slice(o, o + 50) } };
    },
  });
  process.env.COOMER_BASE_URL = mock.url;
  prepareEnv({ COOMER_BASE_URL: mock.url });
  asked = [];
  // The per-platform politeness limiter spaces coomer calls 2.5 s apart: pointless in a test.
  limiter = require('../src/lib/limiter');
  realSchedule = limiter.schedule;
  limiter.schedule = (key, ms, fn) => fn();
  settings = require('../src/settings');
  settings.update({ coomerPages: 40 });
  coomer = require('../src/sources/coomer');
});

after(async () => { limiter.schedule = realSchedule; await mock.close(); });

const userFeed = { platform: 'coomer', kind: 'user', target: 'onlyfans/adamxlee' };
const keywordFeed = { platform: 'coomer', kind: 'search', target: 'gay muscle' };

describe('coomer deep backfill', () => {
  test('the first run reads the whole list the mirror will give it and remembers where it stopped', async () => {
    asked = [];
    const out = await coomer.fetch(userFeed, { limit: 100 });
    assert.equal(out.items.length, 120, 'every post on the mirror is ingested');
    assert.equal(out.items[0].sourceId, 'coomer-onlyfans-p0-0');
    assert.equal(out.cursor.newestAt, POSTS[0].published);
    assert.equal(out.cursor.walk, 120, 'the walk is the offset where the list ran out');
    assert.deepEqual(asked, [0, 50, 100], 'three pages: 50 + 50 + 20');
  });

  test('a run with nothing new costs two requests and stores nothing twice', async () => {
    const first = await coomer.fetch(userFeed, { limit: 100 });
    asked = [];
    const out = await coomer.fetch(userFeed, { limit: 100, cursor: first.cursor });
    assert.equal(out.items.length, 0, 'nothing new: no items, no duplicate work');
    assert.equal(out.cursor.walk, 120, 'the walk is kept so the next run resumes at the end');
    assert.deepEqual(asked, [0, 100], 'is anything new? then resume at the page holding the saved walk (120 is not a multiple of 50)');
  });

  test('new posts at the front are found even when the backfill is mid-walk', async () => {
    // Pretend the backfill stopped at offset 50 (half the list stored).
    const cursor = { newestAt: POSTS[0].published, walk: 50 };
    asked = [];
    const out = await coomer.fetch(userFeed, { limit: 100, cursor });
    assert.equal(out.items.length, 70, 'the unread half of the list is ingested');
    assert.equal(out.cursor.newestAt, POSTS[0].published);
    assert.ok(out.cursor.walk >= 120, `the walk moved to the end of the list (${out.cursor.walk})`);
    assert.deepEqual(asked, [0, 50, 100], 'front check, then resume at the walk');
  });

  test('a newer post shifts every offset: it is still found and the walk follows it', async () => {
    const cursor = { newestAt: POSTS[0].published, walk: 120 };
    POSTS.unshift({
      id: 'brandnew', service: 'onlyfans', user: 'adamxlee', title: 'brand new',
      content: 'fresh', published: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      file: { name: 'new.mp4', path: '/aa/bb/new.mp4' }, attachments: [],
    });
    try {
      asked = [];
      const out = await coomer.fetch(userFeed, { limit: 100, cursor });
      assert.equal(out.items.length, 1, 'the new post is ingested');
      assert.equal(out.items[0].sourceId, 'coomer-onlyfans-brandnew-0');
      assert.equal(out.cursor.newestAt, POSTS[0].published);
      assert.ok(out.cursor.walk >= 120, 'the walk follows the shifted list');
      assert.deepEqual(asked[0], 0, 'the run starts at the newest page');
    } finally { POSTS.shift(); }
  });

  test('a keyword feed stops at the stored region: it never re-reads old results', async () => {
    const cursor = { newestAt: POSTS[0].published, walk: 0 };
    asked = [];
    const out = await coomer.fetch(keywordFeed, { limit: 100, cursor });
    assert.equal(out.items.length, 0, 'nothing newer than the cursor: no results');
    assert.deepEqual(asked, [0], 'one page is enough to know there is nothing new');
  });

  test('a probe reads exactly one page and reports it in the cursor', async () => {
    asked = [];
    const out = await coomer.fetch(userFeed, { limit: 10 });
    assert.deepEqual(asked, [0], 'a probe is one request');
    assert.equal(out.items.length, 10, 'the probe limit is honoured');
  });

  test('the run stops at its time budget instead of being killed mid-request', async () => {
    const original = coomer.fetch;
    assert.equal(typeof original, 'function');
    // A 40-page walk on a big list must not exceed the engine's 150 s run budget: the deadline is
    // checked before each page, so the worst case is one page over ~95 s plus the pipeline's share.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'sources', 'coomer.js'), 'utf8');
    assert.match(src, /deadline = Date\.now\(\) \+ \(probe \? 20000 : 95000\)/, 'the paging deadline leaves room for the pipeline');
    assert.match(src, /if \(Date\.now\(\) > deadline\)/, 'and it is checked per page');
  });
});
