'use strict';
/**
 * v5 iteration item 2: Fansly / JustFor.Fans lead tracing parity with OnlyFans.
 * Paid hosts are parsed as strings and never fetched — the mocks below only stand in for
 * RedGIFs, Bluesky and the web search index (free public surfaces).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let discovery; let server; let base;
const state = { searches: [] };
const AGE = { cookie: 'prism_age=1' };
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };

before(async () => {
  mock = await start({
    '/v2/auth/temporary': () => ({ json: { token: 'rg' } }),
    // RedGIFs profiles: one links the exact Fansly page (proven), one only shares the JFF handle.
    '/v2/users/northpeak': () => ({ json: { user: { username: 'northpeak', name: 'North Peak', description: 'gay hiker 18+ · my page: https://fansly.com/northpeak', followers: 9000, gifs: 60 } } }),
    '/v2/users/cedarline': () => ({ json: { user: { username: 'cedarline', name: 'Cedar', description: 'gay runner, 18+', followers: 700, gifs: 8 } } }),
    '/xrpc/app.bsky.actor.getProfiles': (req, res, url) => {
      const a = url.searchParams.getAll('actors');
      if (a.includes('northpeak.bsky.social')) return { json: { profiles: [{ handle: 'northpeak.bsky.social', displayName: 'North Peak', description: 'gay hiker · fansly.com/northpeak', followersCount: 4000 }] } };
      return { json: { profiles: [] } };
    },
    '/search': (req, res, url) => {
      state.searches.push(url.searchParams.get('q'));
      return { json: { results: [] } };
    },
  });
  prepareEnv({ BSKY_BASE_URL: mock.url, REDGIFS_BASE_URL: mock.url, SEARXNG_URL: mock.url, SEARCH_PROVIDERS: 'searxng', AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo');
  discovery = require('../src/engine/discovery');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await mock.close(); });

let n = 0;
const post = (creator, text, platform = 'telegram') => {
  n++;
  repo.media.insert({ creator_id: creator.id, platform, source_id: `paid${n}`, source_key: `${platform}:paid${n}:0`, post_key: `${platform}:paid${n}`, title: text, media_type: 'image', media_url: `https://cdn.test/paid${n}.jpg`, hash: `v5iter-paid-${n}` }, []);
};

describe('iter2: paid-lead tracing parity (Fansly/JFF)', () => {
  test('migration v11 gives leads a service column keyed per service', () => {
    assert.equal(repo.db.pragma('user_version', { simple: true }), 11);
    const cols = repo.db.prepare('PRAGMA table_info(onlyfans_leads)').all().map((c) => c.name);
    assert.ok(cols.includes('service'));
    repo.onlyfans.note('samehandle', { origin: 'post' });
    repo.onlyfans.note('samehandle', { service: 'Fansly', origin: 'post' });
    assert.equal(repo.onlyfans.get('samehandle', 'OnlyFans').service, 'OnlyFans');
    assert.equal(repo.onlyfans.get('samehandle', 'Fansly').service, 'Fansly');
  });
  test('posts naming Fansly/JFF pages become leads; a creator naming his own page claims it', () => {
    const own = repo.creators.create({ handle: 'northpeak_x' });
    const promo = repo.creators.create({ handle: 'promochan' });
    const other = repo.creators.create({ handle: 'otherchan' });
    post(own, 'new set 🔥 fansly.com/northpeak_x — free page');
    post(promo, 'go follow fansly.com/northpeak and justfor.fans/cedarline 💪');
    post(other, 'fansly.com/northpeak is 🔥');
    discovery.mineMentions();
    const c = repo.creators.get(own.id);
    assert.ok(/fansly\.com\/northpeak_x"/.test(JSON.stringify(c.links)), 'own Fansly page stored on the creator');
    assert.equal(repo.onlyfans.get('northpeak_x', 'Fansly').status, 'claimed');
    const lead = repo.onlyfans.get('northpeak', 'Fansly');
    assert.equal(lead.status, 'pending');
    assert.equal(lead.mentions, 2, 'two distinct sources');
    const jff = repo.onlyfans.get('cedarline', 'JustFor.Fans');
    assert.equal(jff.status, 'pending');
    assert.equal(repo.onlyfans.get('cedarline', 'OnlyFans'), null, 'no OnlyFans row for a JFF page');
  });
  test('a Fansly lead is traced to the same man’s free accounts; an exact page link proves it', async () => {
    const r = await discovery.onlyfansDiscovery({ budget: 5 });
    assert.ok(r.found >= 1);
    const rg = repo.candidates.find('redgifs', 'user', 'northpeak');
    assert.ok(rg, 'RedGIFs account found');
    assert.deepEqual(rg.signals.ofconfirmed, ['Fansly:northpeak']);
    const bs = repo.candidates.find('bluesky', 'user', 'northpeak.bsky.social');
    assert.ok(bs);
    assert.deepEqual(bs.signals.ofconfirmed, ['Fansly:northpeak']);
    const weak = repo.candidates.find('redgifs', 'user', 'cedarline');
    assert.deepEqual(weak.signals.onlyfans, ['JustFor.Fans:cedarline'], 'same handle only: a weak signal');
    assert.equal(repo.onlyfans.get('northpeak', 'Fansly').status, 'found');
    assert.ok(state.searches.some((q) => q.includes('fansly.com/northpeak')), 'twice-named leads get a web search');
    assert.ok(!state.searches.some((q) => q.includes('cedarline')), 'once-named leads do not spend searches');
  });
  test('following a proven Fansly account brings the page onto the creator and closes the lead', () => {
    const rg = repo.candidates.find('redgifs', 'user', 'northpeak');
    const r = discovery.follow(rg, { actor: 'admin' });
    assert.ok(r.ok, JSON.stringify(r));
    const creator = repo.creators.get(r.creator.id);
    assert.ok(/fansly\.com\/northpeak"/.test(JSON.stringify(creator.links)));
    assert.equal(repo.onlyfans.get('northpeak', 'Fansly').status, 'claimed');
  });
  test('admin: paste Fansly/JFF pages to trace, filter leads by service', async () => {
    const call = async (p, opts = {}) => { const res = await fetch(`${base}${p}`, { headers: AGE, ...opts }); return { status: res.status, json: await res.json().catch(() => null) }; };
    const add = await call('/api/admin/discovery/onlyfans', { method: 'POST', headers: ADMIN, body: JSON.stringify({ handles: 'https://fansly.com/adminguy\njustfor.fans/adminjff\nhttps://fansly.com/login' }) });
    assert.equal(add.status, 200);
    assert.deepEqual([add.json.added, add.json.invalid], [2, ['https://fansly.com/login']], JSON.stringify(add.json));
    const list = await call('/api/admin/discovery/onlyfans?service=Fansly', { headers: ADMIN });
    assert.ok(list.json.items.some((l) => l.handle === 'adminguy' && l.service === 'Fansly'));
    assert.ok(list.json.items.every((l) => l.service === 'Fansly'));
    assert.ok((list.json.counts.byService.Fansly.pending || 0) >= 1);
    const rej = await call('/api/admin/discovery/onlyfans/adminguy', { method: 'POST', headers: ADMIN, body: JSON.stringify({ action: 'reject', service: 'Fansly' }) });
    assert.equal(rej.json.status, 'rejected');
    assert.equal(rej.json.service, 'Fansly');
  });
});
