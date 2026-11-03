'use strict';
/**
 * Find / follow, attacks found in review. Each test is a repro:
 *  1. a single selection whose target holds several handles (newline, comma, semicolon, space) used to pass the group check as
 *     "one pick" and be split into several feeds on one creator; it is now refused, and every pick is added as its own spec;
 *  2. a forged, missing or expired lookupId let a visitor's externalLinks (any URL, a namesake's OnlyFans) be stored on the new
 *     creator and shown to everyone; client links are now ignored unless the lookup is known, and the server attaches only the
 *     chosen accounts' own pages;
 *  3. following an account by its name no longer reuses an existing creator that merely has the same name;
 *  4. auto-follow takes the best account plus the accounts tied to it DIRECTLY by strong evidence, never a whole chain.
 * Own process, so the public follow rate limit (10 an hour) is not shared with other test files; at most 6 HTTP follows here.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let registry; let lookup; let websearch; let server; let base; let engine; let imagefilter;
const AGE = { cookie: 'prism_age=1', 'content-type': 'application/json' };
const post = (id) => ({ sourceId: id, title: 'gym pic', permalink: `https://example.test/p/${id}`, mediaType: 'image', mediaUrl: `https://i.example.test/${id}.jpg`, previewUrl: `https://i.example.test/${id}.jpg` });
const who = (displayName, bio = '', links = [], id = 'x') => ({ profile: { displayName, bio, links }, items: [post(id)] });
const link = (platform, target) => ({ platform, kind: 'user', target, ingestable: true });
const WORLD = {
  'bluesky:user:hogueblog.bsky.social': who('Christian Hogue', 'blog', [], 'b1'),
  'bluesky:user:hogue38.bsky.social': who('Christian Hogue', 'gym', [], 'b2'),
  'bluesky:user:christianhogue912.bsky.social': who('Christian Hogue', 'another', [], 'b4'),
  'bluesky:user:fresh-namesake.bsky.social': who('Christian Hogue', 'yet another', [], 'b5'), // never followed by any other test
  // a four-account chain of MUTUAL links: x - telegram - bluesky - redgifs (no account links to all the others)
  'x:user:zedcalloway': who('Zed Calloway', 'x account', [link('telegram', 'zed_calloway')], 'z1'),
  'telegram:user:zed_calloway': who('Zed Calloway', 'tg account', [link('x', 'zedcalloway'), link('bluesky', 'zedcalloway.bsky.social')], 'z2'),
  'bluesky:user:zedcalloway.bsky.social': who('Zed Calloway', 'bsky account', [link('telegram', 'zed_calloway'), link('redgifs', 'zedcalloway')], 'z3'),
  'redgifs:user:zedcalloway': who('Zed Calloway', 'rg account', [link('bluesky', 'zedcalloway.bsky.social')], 'z4'),
};
const ACTORS = (term) => (/christian|hogue/i.test(term) ? ['hogueblog', 'hogue38', 'christianhogue912'] : /zed|calloway/i.test(term) ? ['zedcalloway'] : [])
  .map((h) => ({ handle: `${h}.bsky.social`, displayName: /zed/i.test(h) ? 'Zed Calloway' : 'Christian Hogue', description: '', avatar: null, followers: 50 }));

before(() => {
  prepareEnv({ MASTODON_INSTANCES: 'masto.test', MISSKEY_INSTANCES: 'miss.test' });
  repo = require('../src/db/repo');
  registry = require('../src/sources');
  lookup = require('../src/engine/lookup');
  websearch = require('../src/lib/websearch');
  engine = require('../src/engine/engine');
  imagefilter = require('../src/lib/imagefilter');
  for (const a of registry.list()) {
    a.fetch = async (feed) => {
      const hit = WORLD[`${feed.platform}:${feed.kind}:${feed.target}`];
      if (!hit) throw Object.assign(new Error('not found'), { status: 404 });
      return { items: hit.items, profile: hit.profile, via: 'fake' };
    };
  }
  registry.get('bluesky').searchActors = async (q) => ACTORS(q);
  registry.get('redgifs').searchCreators = async () => [];
  websearch.search = async () => { const r = []; Object.defineProperty(r, 'provider', { value: 'fake' }); return r; };
  websearch.configured = () => true;
  imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [] }));
  engine.enqueue = (ids) => ids.length;
  server = require('../src/app').createApp().listen(0);
  return new Promise((r) => server.once('listening', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
after(async () => { imagefilter._reset(); await new Promise((r) => server.close(r)); });

const http = async (path, body) => { const r = await fetch(`${base}/api${path}`, { method: 'POST', headers: AGE, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const sel = (target, platform = 'bluesky', kind = 'user') => ({ platform, kind, target });
const counts = () => ({ creators: repo.db.prepare('SELECT COUNT(*) AS n FROM creators').get().n, feeds: repo.db.prepare('SELECT COUNT(*) AS n FROM feeds').get().n });
const linksOf = (creatorId) => JSON.parse(repo.db.prepare('SELECT links FROM creators WHERE id = ?').get(creatorId).links || '[]');
const EVIL = [{ url: 'https://evil.example/pay-here', label: 'Official store', platform: 'external' }, { service: 'OnlyFans', handle: 'alphabottom', url: 'https://onlyfans.com/alphabottom', label: 'OnlyFans' }];

describe('1. one selection is one account', () => {
  const MULTI = [
    'hogue38.bsky.social\nhogueblog.bsky.social\nchristianhogue912.bsky.social',
    'hogue38.bsky.social, hogueblog.bsky.social',
    'hogue38.bsky.social;hogueblog.bsky.social',
    'hogue38.bsky.social hogueblog.bsky.social',
    'hogue38.bsky.social\thogueblog.bsky.social',
  ];

  test('HTTP: a newline-joined target in ONE selection (valid lookup) is refused and creates nothing', async () => {
    const found = await http('/lookup', { query: 'Christian Hogue' });
    const before = counts();
    const r = await http('/lookup/follow', { name: 'Christian Hogue', lookupId: found.json.lookupId, selections: [sel(MULTI[0])] });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /one account/);
    assert.deepEqual(counts(), before, 'no creator and no feed was created');
  });

  test('checkSelections refuses newline, comma, semicolon, space and tab inside a target', () => {
    for (const t of MULTI) {
      const c = lookup.checkSelections('whatever', [sel(t)]);
      assert.equal(c.status, 400, JSON.stringify(t));
    }
    assert.equal(lookup.checkSelections('whatever', [sel('hogue38.bsky.social')]).ok, true);
  });

  test('follow() is the choke point too (admin route, findAndFollow): each bad pick is rejected, nothing is split', () => {
    for (const t of MULTI) {
      const before = counts();
      const r = lookup.follow({ name: 'Christian Hogue', selections: [sel(t)] });
      assert.equal(r.error, 'Nothing to follow', JSON.stringify(t));
      assert.ok(r.rejected.some((x) => x.reason === 'invalid account'));
      assert.deepEqual(counts(), before);
    }
  });

  test('a valid pick next to a hostile one is still followed, as ONE feed, from its own parsed spec', () => {
    const before = counts();
    const r = lookup.follow({ name: 'Zed Solo', selections: [sel('hogue38.bsky.social'), sel(MULTI[0]), sel('bad,target', 'telegram')] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.feeds.length, 1);
    assert.equal(r.feeds[0].target, 'hogue38.bsky.social');
    assert.equal(r.rejected.filter((x) => x.reason === 'invalid account').length, 2);
    assert.equal(counts().feeds, before.feeds + 1);
  });

  test('platform and kind are plain words too', () => {
    const r = lookup.follow({ name: 'X', selections: [{ platform: 'bluesky\nx', kind: 'user', target: 'zed.bsky.social' }, { platform: 'bluesky', kind: 'user user', target: 'zed2.bsky.social' }] });
    assert.equal(r.error, 'Nothing to follow');
  });
});

describe('2. client-supplied links and bio are never stored', () => {
  test('a forged lookupId: the visitor\'s URL and a namesake\'s OnlyFans are not attached', async () => {
    const r = await http('/lookup/follow', { lookupId: 'forged-id', name: 'Hogue Forged', selections: [sel('hogueblog.bsky.social')], externalLinks: EVIL, bio: 'buy my stuff https://evil.example' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const stored = linksOf(r.json.creator.id);
    assert.deepEqual(stored, [], JSON.stringify(stored));
    assert.ok(!/evil\.example|alphabottom/.test(JSON.stringify(repo.creators.get(r.json.creator.id))), 'nowhere on the creator');
  });

  test('no lookupId at all: same', async () => {
    const r = await http('/lookup/follow', { name: 'Hogue Missing', selections: [sel('hogue38.bsky.social')], externalLinks: EVIL });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(linksOf(r.json.creator.id), []);
  });

  test('an expired lookupId (31 minutes later): same', async () => {
    const found = await http('/lookup', { query: 'Christian Hogue' });
    const RD = Date; const shift = 31 * 60e3;
    global.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(RD.now() + shift); } static now() { return RD.now() + shift; } };
    try {
      const r = await http('/lookup/follow', { lookupId: found.json.lookupId, name: 'Hogue Expired', selections: [sel('christianhogue912.bsky.social')], externalLinks: EVIL });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(linksOf(r.json.creator.id), []);
    } finally { global.Date = RD; }
  });

  test('a VALID lookupId: the client\'s links are still ignored; only what the lookup found for the chosen account is attached', async () => {
    const found = await http('/lookup', { query: 'Christian Hogue' });
    const r = await http('/lookup/follow', { lookupId: found.json.lookupId, name: 'Hogue Valid', selections: [sel('hogue38.bsky.social')], externalLinks: EVIL });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(linksOf(r.json.creator.id), [], 'hogue38 has no paid page of its own, so nothing is attached');
  });
});

describe('3. a name is not a merge', () => {
  test('following a namesake does not extend an existing creator that has the same name', () => {
    const existing = repo.creators.create({ handle: 'christian-hogue-existing', displayName: 'Christian Hogue', origin: 'admin' });
    const own = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'existing-hogue.bsky.social', creatorId: existing.id, runNow: false }).feed;
    // (more than one creator may already be called that: the property is that following creates a NEW creator, whoever shares the name)
    repo.creators.create({ handle: 'christian-hogue-another', displayName: 'Christian Hogue', origin: 'admin' });
    const before = counts();
    const r = lookup.follow({ name: 'Christian Hogue', selections: [sel('fresh-namesake.bsky.social')] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(counts().creators, before.creators + 1, 'exactly one new creator was created');
    assert.equal(counts().feeds, before.feeds + 1);
    assert.deepEqual(r.feeds.map((f) => f.target), ['fresh-namesake.bsky.social']);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE creator_id = ?').get(r.creator.id).n, 1, 'and it owns only that account');
    assert.notEqual(r.creator.id, existing.id, 'not the one that shares the name');
    assert.deepEqual(repo.db.prepare('SELECT target FROM feeds WHERE creator_id = ?').all(existing.id).map((f) => f.target), ['existing-hogue.bsky.social'], 'the existing creator is unchanged');
    assert.ok(own.id);
  });

  test('an account that already belongs to a creator is added to THAT creator, which is the one legitimate reuse', () => {
    const owner = repo.creators.create({ handle: 'owns-hogue38', displayName: 'Somebody', origin: 'admin' });
    repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'owned.bsky.social', creatorId: owner.id, runNow: false });
    const r = lookup.follow({ name: 'Another Name', selections: [sel('owned.bsky.social'), sel('christianhogue912.bsky.social')] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.creator.id, owner.id);
  });
});

describe('4. auto-follow: the best account plus accounts tied to it directly, never the chain', () => {
  test('a four-account chain of mutual links: findAndFollow follows the best account and its direct partners only', async () => {
    const found = await lookup.lookup('Zed Calloway');
    const keys = found.candidates.map((c) => `${c.platform}:${c.target}`).sort();
    assert.deepEqual(keys, ['bluesky:zedcalloway.bsky.social', 'redgifs:zedcalloway', 'telegram:zed_calloway', 'x:zedcalloway'].sort());
    assert.equal(found.groups.length, 1);
    assert.equal(found.groups[0].members.length, 4, 'the chain is ONE group on screen (a click follows all four)');
    const top = found.candidates.find((c) => c.status === 'new' && c.confidence >= 0.7);
    assert.ok(top, 'a strong best match exists');
    const topKey = `${top.platform}:${top.kind}:${String(top.target).toLowerCase()}`;
    const direct = new Set(found.groups[0].evidence.filter((e) => e.a === topKey || e.b === topKey).map((e) => (e.a === topKey ? e.b : e.a)));
    const expected = [`${top.platform}:${top.target}`, ...found.candidates.filter((c) => direct.has(`${c.platform}:${c.kind}:${String(c.target).toLowerCase()}`)).map((c) => `${c.platform}:${c.target}`)].sort();

    const auto = await lookup.findAndFollow('Zed Calloway');
    assert.ok(auto.followed && auto.followed.ok, JSON.stringify(auto.followed || auto.note));
    const followed = auto.followed.feeds.map((f) => `${f.platform}:${f.target}`).sort();
    assert.deepEqual(followed, expected);
    assert.ok(followed.length < 4, 'not the whole chain');
  });

  test('name-only matches are never auto-followed with the best one', async () => {
    const auto = await lookup.findAndFollow('Christian Hogue');
    const followed = auto.followed && auto.followed.feeds ? auto.followed.feeds.map((f) => f.target) : [];
    assert.ok(followed.length <= 1, `at most the single best account: ${followed.join()}`);
  });
});
