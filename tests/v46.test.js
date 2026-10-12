'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let server; let base; let mock; let repo; let engine; let backup; let discovery; let settings; let registry; let query;
const AGE = { cookie: 'prism_age=1' };
const call = async (p, headers = AGE) => { const res = await fetch(`${base}${p}`, { headers }); return { status: res.status, json: await res.json().catch(() => null) }; };
const state = { subSearches: [], feedSearches: [], xLookups: 0 };

before(async () => {
  mock = await start({
    '/subreddits/search.json': (req, res, url) => {
      state.subSearches.push(url.searchParams.get('q'));
      return { json: { data: { children: [
        { data: { display_name: 'GaybrosGoneWild', title: 'Gaybros gone wild', public_description: 'Gay guys showing off. 18+ men only.', subscribers: 250000, over18: true } },
        { data: { display_name: 'gaybros', title: 'Gaybros', public_description: 'A community for gay guys', subscribers: 400000, over18: false } },
        { data: { display_name: 'GirlsGoneWild', title: 'Girls', public_description: 'Women only, hot girls', subscribers: 900000, over18: true } },
        { data: { display_name: 'TeenBoysNSFW', title: 'Teen boys', public_description: 'teen boys', subscribers: 100, over18: true } },
      ] } } };
    },
    '/xrpc/app.bsky.unspecced.getPopularFeedGenerators': (req, res, url) => {
      state.feedSearches.push(url.searchParams.get('query'));
      return { json: { feeds: [
        { uri: 'at://did:plc:feedmaker/app.bsky.feed.generator/gaynsfw', displayName: 'Gay NSFW 🔞', description: 'Hot men, muscle and bulge. 18+', likeCount: 5400, creator: { handle: 'maker.bsky.social' } },
        { uri: 'at://did:plc:news/app.bsky.feed.generator/gaynews', displayName: 'LGBT News', description: 'Daily headlines', likeCount: 9000, creator: { handle: 'news.bsky.social' } },
      ] } };
    },
    '/2/users/by': (req, res, url) => {
      state.xLookups++;
      const names = (url.searchParams.get('usernames') || '').split(',');
      return { json: { data: names.filter((u) => u !== 'gone').map((u) => ({ username: u, name: `X ${u}`, description: u.startsWith('musc') ? 'Gay muscle model, 18+' : 'just vibes', public_metrics: { followers_count: 12000 }, profile_image_url: `https://pbs.twimg.com/p/${u}_normal.jpg` })) } };
    },
  });
  prepareEnv({ AGE_GATE_ENFORCE: 'true', REDDIT_BASE_URL: mock.url, BSKY_BASE_URL: mock.url, X_BEARER_TOKEN: 'xt', X_BASE_URL: mock.url, LEMMY_INSTANCES: 'lemmy.test' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  discovery = require('../src/engine/discovery'); settings = require('../src/settings'); registry = require('../src/sources'); query = require('../src/lib/query');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); discovery.stop(); await mock.close(); await new Promise((r) => server.close(r)); });

let n = 0;
const post = (creator, tags, extra = {}) => {
  n++;
  repo.media.insert({ creator_id: creator.id, platform: 'reddit', source_id: `q${n}`, source_key: `reddit:q${n}:0`, post_key: `reddit:q${n}`, title: extra.title || 'post', media_type: extra.type || 'image', media_url: `https://i.redd.it/q${n}.jpg`, preview_url: `https://i.redd.it/q${n}p.jpg`, hash: `v46h${n}`, community: extra.community || null }, tags);
};

describe('query understanding', () => {
  const vocab = () => query.buildVocabulary({
    tags: [{ name: 'beard', count: 40 }, { name: 'beach', count: 30 }, { name: 'muscle', count: 90 }, { name: 'locker-room', count: 12 }, { name: 'tattoo', count: 25 }, { name: 'bear', count: 50 }, { name: 'twink', count: 20 }],
    creators: [{ id: 'c1', handle: 'jules_fit', display_name: 'Jules Fit', media_count: 30 }],
    communities: [{ name: 'GaybrosGoneWild', count: 10 }],
  });
  test('natural language becomes filters; unknown words stay as text', () => {
    const u = query.understand('hairy beard guys at the beach videos this week', vocab());
    assert.equal(u.type, 'video'); assert.equal(u.since, 'week');
    assert.deepEqual(u.tags, ['beard', 'beach']);
    assert.equal(u.text, 'hairy');
    assert.ok(u.understood);
  });
  test('plurals, multi-word tags, typos, creators, sources and sorts', () => {
    const u = query.understand('best musscle locker room pics on reddit', vocab());
    assert.deepEqual(u.tags, ['muscle', 'locker-room']);
    assert.deepEqual(u.corrections, [{ from: 'musscle', to: 'muscle' }]);
    assert.equal(u.sort, 'top'); assert.equal(u.type, 'image'); assert.equal(u.platform, 'reddit');
    assert.deepEqual(query.understand('tatoos', vocab()).tags, ['tattoo']);
    assert.deepEqual(query.understand('bears and twinks', vocab()).tags, ['bear', 'twink']);
    assert.equal(query.understand('@jules_fit', vocab()).creator.id, 'c1');
    assert.equal(query.understand('jules fit gym', vocab()).creator.id, 'c1');
    assert.equal(query.understand('r/gaybrosgonewild', vocab()).community, 'GaybrosGoneWild');
    assert.equal(query.understand('#beach "exact words"', vocab()).text, '"exact words"');
    const forms = query.understand('bearded tattooed guys showering', query.buildVocabulary({ tags: [{ name: 'beard', count: 3 }, { name: 'tattoo', count: 3 }, { name: 'shower', count: 3 }] }));
    assert.deepEqual(forms.tags, ['beard', 'tattoo', 'shower'], 'descriptive forms map to the noun tag');
    assert.deepEqual(forms.corrections, [], 'and are not reported as spelling fixes');
  });
  test('short words are not "corrected" into unrelated tags', () => {
    const u = query.understand('bean', vocab());
    assert.deepEqual(u.tags, ['bear'], 'one edit on a 4-letter word is allowed');
    assert.deepEqual(query.understand('cat', vocab()).tags, [], 'three-letter words never fuzzy-match');
    assert.equal(query.understand('the and of', vocab()).understood, false);
  });
  test('distance is bounded and handles transpositions', () => {
    assert.equal(query.distance('muscle', 'msucle'), 1);
    assert.equal(query.distance('abc', 'xyzxyz', 2), 3);
  });
});

describe('tag intelligence', () => {
  let gymA; let beachA;
  before(() => {
    gymA = repo.creators.create({ handle: 'gym_guy' }); beachA = repo.creators.create({ handle: 'beach_guy' });
    for (let i = 0; i < 6; i++) post(gymA, ['gym', 'muscle', i % 2 ? 'mirror' : 'flex'], { type: i % 3 ? 'image' : 'video', community: 'gymsub' });
    for (let i = 0; i < 6; i++) post(beachA, ['beach', 'surf', i % 2 ? 'sunset' : 'speedo'], { community: 'beachsub' });
    post(beachA, ['beach', 'muscle']);
    repo.creators.refreshStats(gymA.id); repo.creators.refreshStats(beachA.id);
  });
  test('tagsAll requires every tag, tagsAny accepts any', () => {
    const all = repo.media.list({ tagsAll: ['beach', 'muscle'], limit: 50 });
    assert.equal(all.total, 1);
    const any = repo.media.list({ tagsAny: ['surf', 'mirror'], limit: 50 });
    assert.equal(any.total, 9);
  });
  test('related tags are the ones that travel together (lift), not the most common overall', () => {
    const rel = repo.tagIntel.related(['gym']).map((t) => t.name);
    assert.ok(rel.includes('muscle'), rel.join());
    assert.ok(!rel.includes('beach') && !rel.includes('gym'), 'unrelated and query tags are excluded');
    assert.ok(!rel.includes('gymsub'), 'community names are not offered as tags');
  });
  test('topics group co-occurring tags with previews', () => {
    const topics = repo.tagIntel.topics({ minCount: 2 });
    assert.ok(topics.length >= 2, JSON.stringify(topics));
    const gym = topics.find((t) => t.tags.includes('gym'));
    const beach = topics.find((t) => t.tags.includes('beach'));
    assert.ok(gym && beach && gym !== beach);
    assert.ok(!gym.tags.includes('surf'));
    assert.ok(gym.previews.length >= 1 && gym.count >= 6);
    assert.match(gym.title, /&/);
  });
  test('API: /understand, /tags/related, /topics, tags= and anytags= filters, age gate', async () => {
    const u = await call(`/api/understand?q=${encodeURIComponent('gym_guy muscle videos')}`);
    assert.equal(u.status, 200);
    assert.equal(u.json.query.creator, gymA.id);
    assert.equal(u.json.query.tags, 'muscle');
    assert.equal(u.json.query.type, 'video');
    assert.ok(u.json.chips.some((c) => c.key === 'creator' && c.value === gymA.id));
    const media = await call(`/api/media?tags=${encodeURIComponent('gym,muscle')}&type=video`);
    assert.equal(media.json.total, 2);
    assert.equal((await call('/api/media?anytags=surf,mirror')).json.total, 9);
    assert.ok((await call('/api/tags/related?tags=beach')).json.some((t) => t.name === 'surf'));
    assert.ok(Array.isArray((await call('/api/topics')).json));
    for (const p of ['/api/understand?q=x', '/api/topics', '/api/tags/related?tags=gym']) assert.equal((await call(p, {})).status, 403, p);
  });
});

describe('far-reaching discovery', () => {
  test('popularity adds a capped, log-scaled bonus', () => {
    assert.equal(discovery.scoreOf({ search: ['a'] }, 'uncertain'), 2);
    assert.equal(discovery.scoreOf({ search: ['a'], popularity: 50 }, 'uncertain'), 2, 'tiny audiences add nothing');
    assert.equal(discovery.scoreOf({ search: ['a'], popularity: 1000 }, 'uncertain'), 4);
    assert.equal(discovery.scoreOf({ search: ['a'], popularity: 5e6 }, 'uncertain'), 5, 'capped at +3');
  });
  test('communities and custom feeds are usable leads; arbitrary sites are not', () => {
    const { parseProfile } = require('../src/lib/links');
    assert.ok(discovery.usable(parseProfile('r/gaybros')));
    assert.ok(discovery.usable(parseProfile('https://lemmynsfw.com/c/gaybros')));
    assert.ok(discovery.usable(parseProfile('at://did:plc:x/app.bsky.feed.generator/abc')));
    assert.ok(!discovery.usable(parseProfile('https://example.com/blog')));
  });
  test('community search: NSFW subreddits, adult Bluesky feeds, Lemmy lists — safety and scope still apply', async () => {
    const lemmy = registry.get('lemmy');
    const orig = lemmy.listCommunities;
    let lemmyCalls = 0;
    lemmy.listCommunities = async (host) => { lemmyCalls++; return [
      { name: 'gaymen', host, title: 'Gay men', description: 'NSFW gay men', nsfw: true, subscribers: 3000 },
      { name: 'cats', host, title: 'Cats', description: 'cats', nsfw: false, subscribers: 9000 },
    ]; };
    try {
      const r = await discovery.communityDiscovery({ keywords: 1 });
      assert.equal(state.subSearches.length, 1); assert.equal(state.feedSearches.length, 1);
      assert.equal(r.reddit, 1, 'only the NSFW, safe, on-topic subreddit is a lead');
      const sub = repo.candidates.find('reddit', 'community', 'gaybrosgonewild');
      assert.equal(sub.status, 'pending'); assert.equal(sub.signals.popularity, 250000); assert.equal(sub.scope, 'in');
      assert.ok(sub.score >= 2 + 2 + 3 - 0.01, String(sub.score));
      assert.equal(repo.candidates.find('reddit', 'community', 'gaybros'), null, 'SFW subreddits are skipped');
      assert.equal(repo.candidates.find('reddit', 'community', 'teenboysnsfw'), null, 'borderline wording drops a community outright (even when CamelCased)');
      const girls = repo.candidates.find('reddit', 'community', 'girlsgonewild');
      assert.ok(!girls || girls.scope === 'excluded', 'female-focused communities sink');
      const feed = repo.candidates.find('bluesky', 'feedgen', 'at://did:plc:feedmaker/app.bsky.feed.generator/gaynsfw');
      assert.ok(feed); assert.equal(feed.signals.popularity, 5400);
      assert.equal(repo.candidates.find('bluesky', 'feedgen', 'at://did:plc:news/app.bsky.feed.generator/gaynews'), null, 'non-adult feeds are not leads');
      assert.ok(repo.candidates.find('lemmy', 'community', 'gaymen@lemmy.test'));
      assert.equal(repo.candidates.find('lemmy', 'community', 'cats@lemmy.test'), null);
      // Lemmy lists are read at most once a day per instance; keywords rotate.
      await discovery.communityDiscovery({ keywords: 1 });
      assert.equal(lemmyCalls, 1);
      assert.notEqual(state.subSearches[1], state.subSearches[0]);
    } finally { lemmy.listCommunities = orig; }
  });
  test('the stricter community gate applies on every path, not just community search', () => {
    const { parseProfile } = require('../src/lib/links');
    // a creator mentions a borderline subreddit: rejected outright, CamelCase and all
    const viaMention = discovery.consider(parseProfile('r/TeenBoysNSFW'), 'mention', 'c1');
    assert.equal(viaMention.status, 'rejected'); assert.match(viaMention.reason, /safety/);
    // ... while a person with the same wording still waits for a human
    const person = discovery.consider(parseProfile('https://bsky.app/profile/teenfan.bsky.social'), 'mention', 'c1', { bio: 'teen boys' });
    assert.equal(person.status, 'pending'); assert.match(person.reason, /needs review/);
  });
  test('a failed Lemmy read is retried on the next run instead of waiting a day', async () => {
    const lemmy = registry.get('lemmy');
    const orig = lemmy.listCommunities;
    let calls = 0;
    lemmy.listCommunities = async () => { calls++; throw new Error('timeout'); };
    try {
      repo.discoveryState.set('lemmy.list.lemmy.test', '');
      await discovery.communityDiscovery({ keywords: 0 });
      await discovery.communityDiscovery({ keywords: 0 });
      assert.equal(calls, 2);
    } finally { lemmy.listCommunities = orig; }
  });
  test('auto-follow: strong male-focused communities follow untrusted (posts still checked); the switch turns it off', () => {
    const sub = repo.candidates.find('reddit', 'community', 'gaybrosgonewild');
    // a second keyword hit pushes it over the threshold
    discovery.consider(require('../src/lib/links').parseProfile('r/GaybrosGoneWild'), 'search', 'reddit:bears', { popularity: 250000 });
    assert.ok(repo.candidates.get(sub.id).score >= 8);
    settings.update({ discoveryAutoCommunities: false });
    discovery.promote(settings.get());
    assert.equal(repo.candidates.get(sub.id).status, 'pending');
    settings.update({ discoveryAutoCommunities: true });
    discovery.promote(settings.get());
    assert.equal(repo.candidates.get(sub.id).status, 'followed');
    const feed = repo.feeds.find('reddit', 'community', 'gaybrosgonewild');
    assert.ok(feed); assert.equal(feed.trusted, 0, 'auto-followed communities are untrusted');
  });
  test('a human follow of a community is trusted', () => {
    const c = discovery.consider(require('../src/lib/links').parseProfile('https://lemmynsfw.com/c/hairymen'), 'search', 'lemmy:x', { displayName: 'Hairy men', bio: 'gay hairy men' });
    assert.ok(discovery.follow(c.id, { actor: 'admin' }).ok);
    assert.equal(repo.feeds.find('lemmy', 'community', 'hairymen@lemmynsfw.com').trusted, 1);
  });
  test('X leads get bios and follower counts in one batched lookup', async () => {
    const { parseProfile } = require('../src/lib/links');
    discovery.consider(parseProfile('https://x.com/musclejake'), 'mention', 'c1');
    discovery.consider(parseProfile('https://x.com/gone'), 'mention', 'c1');
    const before = state.xLookups;
    await discovery.enrich();
    assert.equal(state.xLookups, before + 1);
    const jake = repo.candidates.find('x', 'user', 'musclejake');
    assert.equal(jake.display_name, 'X musclejake'); assert.equal(jake.scope, 'in'); assert.equal(jake.signals.popularity, 12000);
    assert.match(jake.avatar_url, /_400x400/);
    assert.ok(jake.score > 3 + 2, 'mention + male bio + audience');
    assert.equal(repo.candidates.find('x', 'user', 'gone').reason, 'checked', 'missing accounts are not looked up again');
    await discovery.enrich();
    assert.equal(state.xLookups, before + 1, 'nothing left to look up');
  });
  test('settings and status expose the new controls', () => {
    const s = settings.get();
    assert.equal(s.discoveryCommunities, true);
    assert.ok(s.discoveryKeywords.split('\n').length >= 5);
    const st = discovery.status();
    assert.equal(st.communities, true); assert.equal(st.autoCommunities, true);
  });
});
