'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let engine; let backup; let discovery; let settings;
const state = { suggested: 0, actorSearch: [], gifSearch: [] };

before(async () => {
  mock = await start({
    '/xrpc/app.bsky.graph.getSuggestedFollowsByActor': () => {
      state.suggested++;
      return { json: { suggestions: [
        { handle: 'lookalike.bsky.social', displayName: 'Muscle Model 18+', description: 'gay muscle creator, links below', followersCount: 4200 },
        { handle: 'newsbot.bsky.social', displayName: 'News', description: 'headlines every hour' },
        { handle: 'locked.bsky.social', displayName: 'Hidden', description: 'gay nsfw', labels: [{ val: '!no-unauthenticated' }] },
      ] } };
    },
    '/xrpc/app.bsky.actor.searchActors': (req, res, url) => {
      state.actorSearch.push(url.searchParams.get('q'));
      return { json: { actors: [
        { handle: 'beardguy.bsky.social', displayName: 'Beard Guy 🔞', description: 'gay jock creator · onlyfans in bio', followersCount: 900 },
        { handle: 'plainuser.bsky.social', displayName: 'Plain', description: 'I like gay history books' },
        { handle: 'teenacc.bsky.social', displayName: 'Teen boys', description: 'gay nsfw creator' },
      ] } };
    },
    '/v2/auth/temporary': () => ({ json: { token: 'rg' } }),
    '/v2/gifs/search': (req, res, url) => {
      state.gifSearch.push(url.searchParams.get('search_text'));
      return { json: {
        gifs: [
          { id: 'a1', userName: 'HungJock', tags: ['Muscle', 'Gay'] }, { id: 'a2', userName: 'HungJock', tags: ['Jock'] },
          { id: 'b1', userName: 'oneoff', tags: ['Gay'] },
        ],
        users: [{ username: 'HungJock', name: 'Hung Jock', description: 'gay jock, 18+ only', followers: 31000, verified: true }],
      } };
    },
  });
  prepareEnv({ BSKY_BASE_URL: mock.url, REDGIFS_BASE_URL: mock.url });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  discovery = require('../src/engine/discovery'); settings = require('../src/settings');
});
after(async () => { engine.shutdown(); backup.stop(); discovery.stop(); await mock.close(); });

let n = 0;
const post = (creator, community, platform = 'reddit') => {
  n++;
  repo.media.insert({ creator_id: creator.id, platform, source_id: `h${n}`, source_key: `${platform}:h${n}:0`, post_key: `${platform}:h${n}`, title: 't', media_type: 'image', media_url: `https://i.redd.it/h${n}.jpg`, hash: `v47h${n}`, community }, []);
};

describe('v4.7 discovery reach', () => {
  test('"where your creators post": communities shared by several followed creators become leads', () => {
    const a = repo.creators.create({ handle: 'hang_a' }); const b = repo.creators.create({ handle: 'hang_b' }); const c = repo.creators.create({ handle: 'hang_c' });
    post(a, 'GayBeards'); post(b, 'GayBeards'); post(c, 'GayBeards');
    post(a, 'OnlyMine');                       // a single creator is not a pattern
    post(a, 'otters@lemmy.test', 'lemmy'); post(b, 'otters@lemmy.test', 'lemmy');
    repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'alreadyfollowed', origin: 'admin', runNow: false });
    post(a, 'alreadyfollowed'); post(b, 'alreadyfollowed');
    const r = discovery.creatorHangouts();
    const sub = repo.candidates.find('reddit', 'community', 'gaybeards');
    assert.ok(sub, 'shared subreddit is a lead');
    assert.equal(sub.signals.hangout.length, 3);
    assert.equal(sub.score, 1.5 * 3 + 2, 'three creators + "gay" in the name');
    assert.equal(repo.candidates.find('reddit', 'community', 'onlymine'), null);
    assert.equal(repo.candidates.find('reddit', 'community', 'alreadyfollowed'), null, 'followed communities are skipped');
    assert.ok(repo.candidates.find('lemmy', 'community', 'otters@lemmy.test'));
    assert.ok(r.found >= 2);
  });
  test('Bluesky lookalikes: suggestions for followed creators, adult/creator-looking only, refreshed weekly', async () => {
    const c = repo.creators.create({ handle: 'bsky_src' });
    repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'source.bsky.social', creatorId: c.id, origin: 'admin', runNow: false });
    post(c, null, 'bluesky');
    repo.creators.refreshStats(c.id);
    const r = await discovery.blueskyLookalikes();
    assert.ok(r.checked >= 1);
    const lead = repo.candidates.find('bluesky', 'user', 'lookalike.bsky.social');
    assert.ok(lead); assert.deepEqual(lead.signals.similar, [c.id]); assert.equal(lead.signals.popularity, 4200);
    assert.equal(repo.candidates.find('bluesky', 'user', 'newsbot.bsky.social'), null, 'non-creator accounts are skipped');
    assert.equal(repo.candidates.find('bluesky', 'user', 'locked.bsky.social'), null, 'logged-out-hidden accounts are skipped');
    const calls = state.suggested;
    await discovery.blueskyLookalikes();
    assert.equal(state.suggested, calls, 'not asked again within the week');
  });
  test('people search: Bluesky accounts and RedGIFs creators for a rotating keyword, through the safety gate', async () => {
    settings.update({ discoveryKeywords: 'gay otters\ngay jocks' });
    const r = await discovery.peopleSearch();
    assert.deepEqual(state.actorSearch, ['gay otters']); assert.deepEqual(state.gifSearch, ['gay otters']);
    assert.ok(repo.candidates.find('bluesky', 'user', 'beardguy.bsky.social'));
    assert.equal(repo.candidates.find('bluesky', 'user', 'plainuser.bsky.social'), null, 'needs creator + adult wording');
    const teen = repo.candidates.find('bluesky', 'user', 'teenacc.bsky.social');
    assert.ok(teen && /needs review/.test(teen.reason), 'borderline wording waits for a human');
    const rg = repo.candidates.find('redgifs', 'user', 'hungjock');
    assert.ok(rg); assert.equal(rg.signals.popularity, 31000); assert.equal(rg.display_name, 'Hung Jock');
    assert.equal(repo.candidates.find('redgifs', 'user', 'oneoff'), null, 'one stray result is not enough');
    assert.equal(r.bluesky, 2, 'beardguy + the one held for review'); assert.equal(r.redgifs, 1);
    await discovery.peopleSearch();
    assert.equal(state.actorSearch[1], 'gay jocks', 'keywords rotate');
  });
  test('the run report and status include the new strategies; the switch turns them off', async () => {
    settings.update({ discoveryExpand: false, discoveryGraph: false, discoveryCommunities: true });
    const before = state.actorSearch.length;
    const rep = await discovery.run({ trigger: 'manual' });
    assert.ok(rep.hangouts); assert.equal(rep.people, undefined);
    assert.equal(state.actorSearch.length, before);
    settings.update({ discoveryExpand: true });
    const rep2 = await discovery.run({ trigger: 'manual' });
    assert.ok(rep2.people && rep2.lookalikes);
    assert.equal(discovery.status().expand, true);
  });
  test('signal yield: followed leads are credited to their strongest signal, with how many now post', () => {
    const { parseProfile } = require('../src/lib/links');
    const lead = discovery.consider(parseProfile('https://bsky.app/profile/yield.bsky.social'), 'mention', 'x1', { displayName: 'gay model' });
    discovery.consider(parseProfile('https://bsky.app/profile/yield.bsky.social'), 'mention', 'x2');
    const r = discovery.follow(lead.id, { actor: 'admin' });
    assert.ok(r.ok);
    let y = discovery.signalYield().find((x) => x.signal === 'mention');
    assert.equal(y.followed, 1); assert.equal(y.posting, 0);
    post(r.creator, null, 'bluesky'); repo.creators.refreshStats(r.creator.id);
    y = discovery.signalYield().find((x) => x.signal === 'mention');
    assert.equal(y.posting, 1);
  });
});
