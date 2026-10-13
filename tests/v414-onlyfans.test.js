'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let engine; let backup; let discovery; let server; let base;
const state = { rgLookups: [], searches: [] };
const AGE = { cookie: 'prism_age=1' };
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };

before(async () => {
  mock = await start({
    '/v2/auth/temporary': () => ({ json: { token: 'rg' } }),
    // RedGIFs profiles: one links the exact OnlyFans page (proven), one only shares the handle.
    '/v2/users/gymjake': () => { state.rgLookups.push('gymjake'); return { json: { user: { username: 'gymjake', name: 'Gym Jake', description: 'Fitness model 💪 18+ · onlyfans.com/gymjake', followers: 52000, gifs: 140 } } }; },
    '/v2/users/oakbuilt': () => { state.rgLookups.push('oakbuilt'); return { json: { user: { username: 'oakbuilt', name: 'Oak', description: 'athlete, gay, 18+', followers: 900, gifs: 12 } } }; },
    '/v2/users/linedrive': () => ({ json: { user: { username: 'linedrive', name: 'Line Drive', description: 'pitcher. gay. 18+', followers: 300, gifs: 9, profileUrl: 'https://onlyfans.com/linedrive' } } }),
    '/xrpc/app.bsky.actor.getProfiles': (req, res, url) => {
      const a = url.searchParams.getAll('actors');
      if (a.includes('gymjake.bsky.social')) return { json: { profiles: [{ handle: 'gymjake.bsky.social', displayName: 'Gym Jake', description: 'gay fitness model, free OF: onlyfans.com/gymjake', followersCount: 8000 }] } };
      return { json: { profiles: [] } };
    },
    '/search': (req, res, url) => {
      state.searches.push(url.searchParams.get('q'));
      return { json: { results: [
        { url: 'https://linktr.ee/linedrive', title: 'Line Drive | Linktree', content: 'All my links: onlyfans.com/linedrive, x, redgifs' },
        { url: 'https://x.com/somefan', title: 'fan', content: 'go sub to onlyfans.com/linedrive' }, // someone else's page that only mentions him
      ] } };
    },
  });
  prepareEnv({ BSKY_BASE_URL: mock.url, REDGIFS_BASE_URL: mock.url, SEARXNG_URL: mock.url, SEARCH_PROVIDERS: 'searxng', AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  discovery = require('../src/engine/discovery');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); discovery.stop(); server.close(); await mock.close(); });

let n = 0;
const post = (creator, text, platform = 'telegram') => {
  n++;
  repo.media.insert({ creator_id: creator.id, platform, source_id: `of${n}`, source_key: `${platform}:of${n}:0`, post_key: `${platform}:of${n}`, title: text, media_type: 'image', media_url: `https://cdn.test/of${n}.jpg`, hash: `v414-${n}` }, []);
};

describe('OnlyFans links', () => {
  // required lazily: lib/links loads config, which must see prepareEnv's DB_PATH first
  let of; let extractLinks; let parseProfile;
  before(() => { of = require('../src/lib/onlyfans'); ({ extractLinks, parseProfile } = require('../src/lib/links')); });
  test('profile, campaign and post links collapse to one handle; site pages are not people', () => {
    assert.equal(of.ofHandle('https://onlyfans.com/GymJake'), 'gymjake');
    assert.equal(of.ofHandle('onlyfans.com/gymjake/c42?ref=x'), 'gymjake');
    assert.equal(of.ofHandle('https://onlyfans.com/123456789/gymjake'), 'gymjake');
    for (const u of ['https://onlyfans.com/', 'https://onlyfans.com/my/chats', 'https://onlyfans.com/action/subscribe', 'https://public.onlyfans.com/files/x.jpg', 'https://onlyfans.com/123']) assert.equal(of.ofHandle(u), null, u);
  });
  test('bios and posts: full links, bare "onlyfans.com/x" and "OnlyFans: @x"', () => {
    assert.deepEqual(of.findOnlyFans('💪 new set up! onlyfans.com/gymjake and my buddy https://www.onlyfans.com/oakbuilt/c3.'), ['gymjake', 'oakbuilt']);
    assert.deepEqual(of.findOnlyFans('OnlyFans: @LineDrive | x: @ld'), ['linedrive']);
    assert.deepEqual(of.findOnlyFans('onlyfans: link in bio'), [], 'prose without a username');
    assert.ok(of.freeHint('FREE OF this week!')); assert.ok(of.freeHint('my onlyfans is free')); assert.ok(of.freeHint('70% off for 30 days'));
    assert.equal(of.freeHint('subscribe to my onlyfans'), false);
  });
  test('extractLinks finds bare links and stores one canonical OnlyFans link', () => {
    const links = extractLinks('onlyfans.com/GymJake/c12 and https://onlyfans.com/gymjake?x=1 linktr.ee/gymjake');
    assert.deepEqual(links.map((l) => [l.platform, l.target]), [['external', 'https://onlyfans.com/gymjake'], ['linkinbio', 'https://linktr.ee/gymjake']]);
    assert.equal(links[0].handle, 'gymjake');
    assert.equal(parseProfile('https://onlyfans.com/my/notifications'), null);
  });
  test('creatorOnlyFans reads stored links, including old raw URLs', () => {
    assert.deepEqual(of.creatorOnlyFans({ links: [{ service: 'OnlyFans', url: 'https://onlyfans.com/OldStyle/c1' }] }), { handle: 'oldstyle', url: 'https://onlyfans.com/oldstyle', free: false });
    assert.equal(of.creatorOnlyFans({ links: '[]' }), null);
  });
});

describe('OnlyFans discovery', () => {
  test('a creator naming his own page claims it; pages of other men become leads, once per source', () => {
    const own = repo.creators.create({ handle: 'linedrive_x' });
    const promo = repo.creators.create({ handle: 'gaypromochannel' });
    post(own, 'new vid 🔥 onlyfans.com/linedrive — FREE OF this week');
    post(promo, 'Check out onlyfans.com/gymjake 💪 and onlyfans.com/oakbuilt');
    post(promo, 'again: onlyfans.com/gymjake');
    const other = repo.creators.create({ handle: 'otherpromo' });
    post(other, 'https://onlyfans.com/gymjake');
    discovery.mineMentions();
    const c = repo.creators.get(own.id);
    assert.ok(/onlyfans\.com\/linedrive"/.test(JSON.stringify(c.links)), 'own page stored on the creator');
    assert.equal(repo.onlyfans.get('linedrive').status, 'claimed');
    const lead = repo.onlyfans.get('gymjake');
    assert.equal(lead.status, 'pending');
    assert.equal(lead.mentions, 2, 'two distinct sources, the repost does not count');
    assert.deepEqual(lead.sources.sort(), [promo.id, other.id].sort());
  });
  test('a lead is traced to the same man’s free accounts; an account linking the exact page is proven', async () => {
    const r = await discovery.onlyfansDiscovery({ budget: 5 });
    assert.ok(r.found >= 1);
    const rg = repo.candidates.find('redgifs', 'user', 'gymjake');
    assert.ok(rg, 'RedGIFs account found');
    assert.deepEqual(rg.signals.ofconfirmed, ['gymjake']);
    assert.equal(rg.signals.ofsrc, 2);
    assert.ok(rg.score >= 8, `proven + audience + male bio scores high (${rg.score})`);
    const bs = repo.candidates.find('bluesky', 'user', 'gymjake.bsky.social');
    assert.deepEqual(bs.signals.ofconfirmed, ['gymjake']);
    const weak = repo.candidates.find('redgifs', 'user', 'oakbuilt');
    assert.deepEqual(weak.signals.onlyfans, ['oakbuilt'], 'same handle only: a weak signal');
    assert.equal(weak.signals.ofconfirmed, undefined);
    assert.equal(repo.onlyfans.get('gymjake').status, 'found');
    assert.ok(state.searches.some((q) => q.includes('onlyfans.com/gymjake')), 'twice-named leads get a web search');
    assert.ok(!state.searches.some((q) => q.includes('oakbuilt')), 'once-named leads do not spend searches');
  });
  test('following a proven account brings the OnlyFans page onto the creator and closes the lead', () => {
    const rg = repo.candidates.find('redgifs', 'user', 'gymjake');
    const s = require('../src/settings').get();
    const r = discovery.promote({ ...s, maxFeeds: 1000 });
    assert.ok(r.followed >= 1);
    const followed = repo.candidates.get(rg.id);
    assert.equal(followed.status, 'followed');
    const creator = repo.creators.get(followed.creator_id);
    assert.ok(/onlyfans\.com\/gymjake"/.test(JSON.stringify(creator.links)));
    assert.equal(repo.onlyfans.get('gymjake').status, 'claimed');
  });
  test('creators with a page get their free accounts elsewhere linked to them', async () => {
    // linedrive_x claimed onlyfans.com/linedrive in the first test; the trace runs for followed creators too
    const c = repo.onlyfans.ownerOf('linedrive');
    assert.equal(c.handle, 'linedrive_x');
    await discovery.onlyfansDiscovery({ budget: 5, leads: 0 });
    const rg = repo.candidates.find('redgifs', 'user', 'linedrive');
    assert.ok(rg); assert.deepEqual(rg.signals.identity, [c.id]);
    const lt = repo.candidates.find('linkinbio', 'page', 'https://linktr.ee/linedrive');
    assert.ok(lt, 'link page from the web search'); assert.deepEqual(lt.signals.identity, [c.id]);
    assert.equal(repo.candidates.find('x', 'user', 'somefan'), null, 'a page that merely mentions him is not his');
  });
  test('female or underage leads are rejected before any lookup', async () => {
    repo.onlyfans.note('teenboy_x', { origin: 'search', bio: 'teen boy 17' });
    repo.onlyfans.note('hotgirlamy', { origin: 'search', displayName: 'Amy', bio: 'hot girl, she/her' });
    await discovery.onlyfansDiscovery({ budget: 0 });
    assert.equal(repo.onlyfans.get('teenboy_x').status, 'rejected');
    assert.equal(repo.onlyfans.get('hotgirlamy').status, 'rejected');
  });
});

describe('OnlyFans in the app', () => {
  const call = async (p, opts = {}) => { const res = await fetch(`${base}${p}`, { headers: AGE, ...opts }); return { status: res.status, json: await res.json().catch(() => null) }; };
  test('creators carry their page and can be filtered to OnlyFans creators', async () => {
    const withOf = repo.creators.create({ handle: 'fitpage' });
    repo.creators.enrich(withOf.id, { links: [require('../src/lib/onlyfans').ofLink('fitpage', { free: true })] });
    const without = repo.creators.create({ handle: 'nopage' });
    for (const c of [withOf, without]) { post(c, 'pic', 'reddit'); repo.creators.refreshStats(c.id); }
    const one = await call(`/api/creators/${withOf.id}`);
    assert.deepEqual(one.json.onlyfans, { handle: 'fitpage', url: 'https://onlyfans.com/fitpage', free: true });
    const all = await call('/api/creators?onlyfans=1&limit=100');
    assert.ok(all.json.items.some((c) => c.id === withOf.id));
    assert.ok(!all.json.items.some((c) => c.id === without.id));
    assert.ok(all.json.items.every((c) => c.onlyfans));
  });
  test('a page that stops saying it is free loses the flag', () => {
    const c = repo.creators.create({ handle: 'wasfree' });
    const { ofLink, creatorOnlyFans } = require('../src/lib/onlyfans');
    repo.creators.enrich(c.id, { links: [ofLink('wasfree', { free: true })] });
    assert.equal(creatorOnlyFans(repo.creators.get(c.id)).free, true);
    repo.creators.enrich(c.id, { links: [ofLink('wasfree')] });
    assert.equal(creatorOnlyFans(repo.creators.get(c.id)).free, false);
  });
  test('admin: paste pages to trace, list leads, retry and reject', async () => {
    const add = await call('/api/admin/discovery/onlyfans', { method: 'POST', headers: ADMIN, body: JSON.stringify({ handles: 'https://onlyfans.com/newguy/c9\nanotherguy\nhttps://onlyfans.com/my/chats\nfitpage' }) });
    assert.equal(add.status, 200);
    assert.deepEqual(add.json, { added: 2, claimed: 1, invalid: ['https://onlyfans.com/my/chats'] });
    const list = await call('/api/admin/discovery/onlyfans?status=pending', { headers: ADMIN });
    assert.ok(list.json.items.some((l) => l.handle === 'newguy' && l.origin === 'admin'));
    assert.ok(list.json.counts.creators >= 1);
    const rej = await call('/api/admin/discovery/onlyfans/newguy', { method: 'POST', headers: ADMIN, body: JSON.stringify({ action: 'reject' }) });
    assert.equal(rej.json.status, 'rejected');
    const st = await call('/api/admin/discovery', { headers: ADMIN });
    assert.equal(st.json.onlyfans.enabled, true);
  });
});
