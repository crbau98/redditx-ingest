'use strict';
/**
 * Coomer scout: the intelligence that decides *which* creators on the mirror are gay male creators.
 * The bank / scoring / decision logic is pure and unit-tested; the two discovery passes run against
 * a mock mirror, so nothing here touches the public site.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');

const scout = require('../src/lib/coomer-scout');

const post = (id, user, title, published = '2026-10-30T12:00:00Z') => ({
  id, service: 'onlyfans', user, title, content: `<p>${title}</p>`, published,
  file: { name: `${id}.mp4`, path: `/aa/${id}.mp4` }, attachments: [],
});

// Two creators the mirror surfaces, one per query pair: one reads male in his own captions, one
// reads female. Handles are deliberately opaque so only the content can tell them apart.
const MUSCLE_POSTS = [
  post('m1', 'musclestud', 'hot muscle jock in the gym'),
  post('m2', 'musclestud', 'gym bro flexing for you'),
  post('m3', 'musclestud', 'hunk in the shower'),
  post('m4', 'musclestud', 'jockstrap on the locker room bench'),
];
const FEMALE_POSTS = [
  post('f1', 'fakemale', 'my girlfriend and me at home'),
  post('f2', 'fakemale', 'she loves this lingerie'),
  post('f3', 'fakemale', 'mommy wants you'),
];
const OPAQUE_POSTS = [
  post('o1', 'xxl_92', 'gay gym bro blowing me'),
  post('o2', 'xxl_92', 'jockstrap and a huge cock'),
  post('o3', 'xxl_92', 'my boyfriend fucks me hard'),
];

const SEARCH = {
  'gay onlyfans muscle': [MUSCLE_POSTS[0], MUSCLE_POSTS[1], FEMALE_POSTS[0]],
  'gay onlyfans jock': [MUSCLE_POSTS[2], FEMALE_POSTS[1]],
  'gay onlyfans amateur': [OPAQUE_POSTS[0], OPAQUE_POSTS[1]],
};

let mock; let repo; let discovery; let settings; let limiter; let realSchedule;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-coomer-scout-'));
  process.env.COOMER_INDEX_CACHE = path.join(dir, 'creators.json');
  process.env.COOMER_BASE_URL = 'http://coomer.test';
  mock = await start({
    '/api/v1/posts': (req, res, url) => ({ json: { posts: SEARCH[url.searchParams.get('q')] || [] } }),
    '/api/v1/onlyfans/user/musclestud/posts': () => ({ json: MUSCLE_POSTS }),
    '/api/v1/onlyfans/user/fakemale/posts': () => ({ json: FEMALE_POSTS }),
    '/api/v1/onlyfans/user/xxl_92/posts': () => ({ json: OPAQUE_POSTS }),
    '/api/v1/creators': () => ({ json: [{ id: 'nash.brandt', name: 'nash.brandt', service: 'onlyfans' }] }),
  });
  prepareEnv({ COOMER_BASE_URL: mock.url, BRAVE_API_KEY: '' });
  process.env.COOMER_BASE_URL = mock.url;
  limiter = require('../src/lib/limiter');
  realSchedule = limiter.schedule;
  limiter.schedule = (key, ms, fn) => fn();
  repo = require('../src/db/repo');
  settings = require('../src/settings');
  discovery = require('../src/engine/discovery');
});

after(async () => { limiter.schedule = realSchedule; await mock.close(); });

describe('coomer scout: the query bank', () => {
  test('every query is male-scoped and passes the safety gate', () => {
    const { checkText } = require('../src/lib/safety');
    const { femaleCheck } = require('../src/lib/scope');
    assert.ok(scout.QUERY_BANK.length >= 40, 'a bank long enough to cover many niches');
    for (const q of scout.QUERY_BANK) {
      assert.equal(checkText(q).level, null, `safety gate on "${q}"`);
      assert.equal(femaleCheck(q).level, null, `male scope on "${q}"`);
      assert.match(q, /\bgay\b/, `"${q}" names the audience explicitly`);
    }
  });

  test('a run rotates through the bank instead of re-asking the same phrases', () => {
    const first = scout.pickQueries(0, 8);
    const second = scout.pickQueries(scout.nextRotate(0, 8), 8);
    assert.equal(new Set(first).size, 8, 'no repeats inside one run');
    assert.equal(first.filter((q) => second.includes(q)).length, 0, 'the next run asks different phrases');
    // The cursor wraps rather than running off the end of the bank.
    assert.equal(scout.nextRotate(scout.QUERY_BANK.length - 2, 8), 6);
    assert.deepEqual(scout.pickQueries(-3, 3), scout.pickQueries(scout.QUERY_BANK.length - 3, 3));
  });
});

describe('coomer scout: evidence', () => {
  const items = [
    { author: 'musclestud', title: 'a', sourceId: 'post1-0', service: 'onlyfans' },
    { author: 'musclestud', title: 'b', sourceId: 'post1-1', service: 'onlyfans' }, // same post, second file
    { author: 'musclestud', title: 'c', sourceId: 'post2-0', service: 'onlyfans' },
  ];

  test('a post with three files counts as one surfacing post', () => {
    const t = scout.tally(items, 'gay jock');
    assert.equal(t.get('musclestud').posts, 2);
    assert.equal(t.get('musclestud').queries.size, 1);
  });

  test('independent queries are the strongest signal', () => {
    const a = scout.tally(items, 'gay jock');
    const b = scout.tally([{ author: 'musclestud', title: 'd', sourceId: 'post3-0' }], 'gay massage');
    scout.merge(a, b);
    const e = a.get('musclestud');
    assert.equal(e.queries.size, 2);
    assert.ok(scout.score(e) > scout.score({ handle: 'x', posts: e.posts, queries: new Set(['one']) }));
  });

  test('a candidate needs corroboration, not one stray caption', () => {
    assert.equal(scout.candidate({ posts: 5, queries: new Set() }), false);
    assert.equal(scout.candidate({ posts: 1, queries: new Set(['gay jock']) }), false);
    assert.equal(scout.candidate({ posts: 2, queries: new Set(['gay jock']) }), true);
  });
});

describe('coomer scout: verification', () => {
  const asItems = (posts) => posts.map((p) => ({ ...p, mediaUrl: 'https://coomer.st/data/x.mp4' }));

  test('a page whose captions read male is verified, even with an opaque handle', () => {
    const v = scout.verify(asItems(OPAQUE_POSTS));
    assert.equal(v.verdict, 'verified');
    assert.ok(v.maleRatio >= 0.5);
  });

  test('a page that reads female is never followed, whatever the search said', () => {
    const v = scout.verify(asItems(FEMALE_POSTS));
    assert.equal(v.verdict, 'female');
    const d = scout.decide({ queries: new Set(['a', 'b', 'c', 'd']) }, v);
    assert.equal(d.follow, false);
  });

  test('too little readable signal is unverified: followed only with several agreeing queries', () => {
    const blank = asItems([{ id: 'z1', title: 'new post', postKey: 'z1' }, { id: 'z2', title: '', postKey: 'z2' }]);
    const v = scout.verify(blank);
    assert.equal(v.verdict, 'unverified');
    assert.equal(scout.decide({ queries: new Set(['one']) }, v).follow, false);
    assert.equal(scout.decide({ queries: new Set(['a', 'b', 'c']) }, v).follow, true);
  });

  test('an item with no media is not evidence', () => {
    assert.equal(scout.verify([{ title: 'hot jock' }]).total, 0);
  });
});

describe('coomer scout: evidence survives the run boundary', () => {
  test('queries from previous runs count towards corroboration', () => {
    const first = scout.tally([{ author: 'xxl_92', title: 'a', sourceId: 'p1-0' }, { author: 'xxl_92', title: 'b', sourceId: 'p2-0' }], 'gay onlyfans amateur');
    const stored = scout.snapshot(first, {}, { now: 1000 });
    const second = scout.tally([{ author: 'xxl_92', title: 'c', sourceId: 'p3-0' }], 'gay muscle hunk');
    scout.restore(second, stored, { now: 2000 });
    const e = second.get('xxl_92');
    assert.equal(e.queries.size, 2, 'both runs count');
    // One run alone would not be enough for an unverified page; two are still short of three.
    const v = { verdict: 'unverified', maleRatio: 0.2, femaleRatio: 0, total: 5, reason: 'thin' };
    assert.equal(scout.decide(e, v).follow, false);
    scout.merge(second, scout.tally([{ author: 'xxl_92', title: 'd', sourceId: 'p4-0' }], 'gay otter'));
    assert.equal(scout.decide(second.get('xxl_92'), v).follow, true, 'three niches agree → followed');
  });

  test('stale evidence is dropped and the map stays bounded', () => {
    const old = { a: { queries: ['q'], posts: 2, seenAt: 1 }, b: { queries: ['q'], posts: 2, seenAt: 9 } };
    const kept = scout.restore(new Map(), old, { now: 10, ttlMs: 5 });
    assert.equal(kept.has('a'), false);
    assert.equal(kept.has('b'), true);
    const snap = scout.snapshot(new Map(), old, { now: 10, ttlMs: 5, keep: 1 });
    assert.deepEqual(Object.keys(snap), ['b']);
    // The public contract: only a handle, its queries and a count are stored — never post text.
    assert.deepEqual(Object.keys(snap.b).sort(), ['posts', 'queries', 'seenAt']);
  });

  test('the discovery pass persists what it learned', async () => {
    repo.discoveryState.set('coomer.query.rotate', '0');
    repo.discoveryState.set('coomer.evidence', '{}');
    settings.update({ coomerScoutQueries: 1, coomerScoutVerify: true });
    await discovery.coomerDiscovery({ aborted: () => false });
    const stored = JSON.parse(repo.discoveryState.get('coomer.evidence', '{}'));
    assert.ok(stored.musclestud, 'the creator this run saw is remembered');
    assert.ok(Array.isArray(stored.musclestud.queries) && stored.musclestud.queries.length === 1);
    assert.equal(stored.musclestud.texts, undefined, 'no post text is stored');
  });
});

describe('coomer discovery pass', () => {
  test('follows the verified male creators and rejects the page that reads female', async () => {
    settings.update({ coomerScoutQueries: 2, coomerScoutVerify: true });
    repo.discoveryState.set('coomer.query.rotate', '0');
    const out = await discovery.coomerDiscovery({ aborted: () => false });
    assert.equal(out.searched, 2);
    assert.ok(out.verified >= 1);
    const feeds = repo.feeds.list({ platform: 'coomer', kind: 'user' }).items;
    assert.ok(feeds.find((f) => f.target === 'onlyfans/musclestud'), 'captions read male → followed');
    assert.equal(feeds.find((f) => f.target === 'onlyfans/fakemale'), undefined, 'female captions → never followed');
    assert.ok(out.rejected >= 1);
    // The rotation advanced, so the next run asks different niches.
    assert.equal(repo.discoveryState.get('coomer.query.rotate'), '2');
  });

  test('verification off falls back to query corroboration instead of following blind', async () => {
    settings.update({ coomerScoutQueries: 1, coomerScoutVerify: false });
    repo.discoveryState.set('coomer.query.rotate', '2'); // "gay onlyfans amateur"
    const out = await discovery.coomerDiscovery({ aborted: () => false });
    assert.equal(out.searched, 1);
    const feeds = repo.feeds.list({ platform: 'coomer', kind: 'user' }).items;
    assert.equal(feeds.find((f) => f.target === 'onlyfans/xxl_92'), undefined, 'one query is not corroboration');
    assert.ok(out.deferred >= 1);
    settings.update({ coomerScoutVerify: true });
  });

  test('the run respects the per-run follow cap', async () => {
    repo.discoveryState.set('coomer.query.rotate', '0');
    const before = repo.feeds.list({ platform: 'coomer', kind: 'user' }).items.length;
    const out = await discovery.coomerDiscovery({ limit: 0, aborted: () => true });
    assert.equal(out.feeds, 0);
    assert.equal(repo.feeds.list({ platform: 'coomer', kind: 'user' }).items.length, before);
  });
});

describe('coomer by name', () => {
  test("a followed creator is matched on the mirror by the name he uses, with no paid handle", async () => {
    const c = repo.creators.create({ handle: 'nashbrandt', displayName: 'Nash Brandt', origin: 'ingest' });
    const out = await discovery.coomerNameDiscovery({ limit: 5 });
    assert.equal(out.indexed, true);
    assert.ok(out.feeds >= 1);
    const feed = repo.feeds.list({ platform: 'coomer', kind: 'user' }).items.find((f) => /nash\.brandt/.test(f.target));
    assert.ok(feed, 'the mirrored page is followed');
    assert.equal(feed.creator_id, c.id, 'and attributed to the creator we already knew');
  });

  test('name targets skip creators the mirror already covers and are re-checked on a schedule', () => {
    const again = repo.onlyfans.nameTargets(10).map((r) => r.display_name);
    assert.equal(again.includes('Nash Brandt'), false, 'a matched creator is not re-offered immediately');
  });
});
