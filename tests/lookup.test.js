'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let registry; let lookup; let websearch; let server; let base; let engine; let imagefilter; const queued = [];
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };

// A tiny fake internet: platform:user:target -> profile + posts (or absent = 404)
const post = (id, title = 'gym pic') => ({ sourceId: id, title, permalink: `https://www.reddit.com/r/gaybros/comments/${id}`, mediaType: 'image', mediaUrl: `https://i.redd.it/${id}.jpg`, previewUrl: `https://i.redd.it/${id}.jpg` });
const WORLD = {
  'reddit:user:jaxstone': { profile: { displayName: 'Jax Stone', bio: 'gay fitness model • bsky: https://bsky.app/profile/jaxstone.bsky.social • https://onlyfans.com/jaxstone • https://linktr.ee/jaxstone', links: [
    { platform: 'bluesky', kind: 'user', target: 'jaxstone.bsky.social', ingestable: true }, { platform: 'external', service: 'OnlyFans', label: 'OnlyFans', url: 'https://onlyfans.com/jaxstone', external: true, ingestable: false },
    { platform: 'linkinbio', kind: 'page', target: 'https://linktr.ee/jaxstone', ingestable: true }] }, items: [post('r1'), post('r2'), post('r3')] },
  'bluesky:user:jaxstone.bsky.social': { profile: { displayName: 'Jax Stone 💪', bio: 'gay model. nsfw', handle: 'jaxstone.bsky.social', links: [] }, items: [post('b1')] },
  'linkinbio:page:https://linktr.ee/jaxstone': { profile: { displayName: 'jaxstone', bio: 'all my links', links: [
    { platform: 'telegram', kind: 'user', target: 'jaxstone_official', ingestable: true }, { platform: 'x', kind: 'user', target: 'jaxstone', ingestable: true },
    { platform: 'external', service: 'Throne', label: 'Throne', url: 'https://throne.com/jaxstone', external: true, ingestable: false }] }, items: [] },
  'telegram:user:jaxstone_official': { profile: { displayName: 'Jax Stone official', bio: 'gay' }, items: [post('t1')] },
  'x:user:jaxstone': { profile: { displayName: 'Jax Stone', bio: 'gay muscle model' }, items: [post('x1')] },
  // the underscore variant is a different person: a trans woman (must never surface)
  'redgifs:user:jax_stone': { profile: { displayName: 'Jax Stone', bio: 'trans girl creator' }, items: [post('g1')] },
  // a minor-looking bio is dropped silently
  'tumblr:user:jaxstone': { profile: { displayName: 'jax', bio: "i'm 16" }, items: [post('tu1')] },
};

before(() => {
  prepareEnv({ MASTODON_INSTANCES: 'masto.test', MISSKEY_INSTANCES: 'miss.test' });
  repo = require('../src/db/repo');
  registry = require('../src/sources');
  lookup = require('../src/engine/lookup');
  websearch = require('../src/lib/websearch');
  engine = require('../src/engine/engine');
  imagefilter = require('../src/lib/imagefilter');
  // every adapter reads from the fake internet
  for (const a of registry.list()) {
    a.fetch = async (feed) => {
      const hit = WORLD[`${feed.platform}:${feed.kind}:${feed.target}`];
      if (!hit) throw Object.assign(new Error('not found'), { status: 404 });
      return { items: hit.items, profile: hit.profile, via: 'fake' };
    };
  }
  registry.get('bluesky').searchActors = async (q) => (/jax/i.test(q) ? [{ handle: 'jaxstone.bsky.social', displayName: 'Jax Stone 💪', description: 'gay model. nsfw', avatar: null, followers: 900 }, { handle: 'mike.bsky.social', displayName: 'Mike', description: '', followers: 5 }] : []);
  registry.get('redgifs').searchCreators = async () => [];
  websearch.search = async (q) => { const r = [{ url: 'https://x.com/jaxstone', title: 'Jax Stone (@jaxstone) / X', description: 'gay muscle model' }, { url: 'https://example.com/unrelated', title: 'Weather', description: 'sunny' }]; Object.defineProperty(r, 'provider', { value: 'fake' }); return r; };
  websearch.configured = () => true;
  imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [] }));
  engine.enqueue = (ids, o) => { queued.push({ ids, o }); return ids.length; };
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  return new Promise((r) => server.once('listening', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
after(async () => { imagefilter._reset(); await new Promise((r) => server.close(r)); });

describe('creator lookup', () => {
  test('a performer name finds the same person across platforms, with evidence; women and minors never surface', async () => {
    const r = await lookup.lookup('Jax Stone');
    const by = Object.fromEntries(r.candidates.map((c) => [`${c.platform}:${c.target}`, c]));
    assert.ok(by['reddit:jaxstone'] && by['bluesky:jaxstone.bsky.social'] && by['x:jaxstone'], Object.keys(by).join());
    assert.ok(by['telegram:jaxstone_official'], 'found through the link-in-bio page');
    assert.equal(by['reddit:jaxstone'].tier, 'strong'); assert.ok(by['reddit:jaxstone'].sampleCount === 3);
    assert.deepEqual(by['reddit:jaxstone'].sample, { type: 'image', preview: 'https://i.redd.it/r1.jpg', thumb: 'https://i.redd.it/r1.jpg', title: 'gym pic', url: 'https://www.reddit.com/r/gaybros/comments/r1' });
    assert.ok(by['telegram:jaxstone_official'].evidence.some((e) => /link-in-bio/.test(e)));
    assert.ok(!Object.keys(by).some((k) => k.startsWith('redgifs:')), 'the trans-feminine account is hidden');
    assert.ok(!Object.keys(by).some((k) => k.startsWith('tumblr:')), 'the account whose bio states an age under 18 is dropped');
    assert.ok(r.hidden.notMale >= 1 && r.hidden.safety >= 1, JSON.stringify(r.hidden));
    assert.deepEqual(r.externalLinks.map((l) => l.service).sort(), ['OnlyFans', 'Throne']);
    assert.equal(r.webSearch, 'fake');
    assert.ok(r.candidates.every((c, i, a) => !i || a[i - 1].confidence >= c.confidence), 'sorted by confidence');
    assert.ok(!r.candidates.some((c) => /example\.com/.test(c.url || '')), 'unrelated search results are not candidates');
  });

  test('a handle, a profile link and a bare u/name all work as the query', async () => {
    for (const q of ['jaxstone', '@jaxstone', 'https://x.com/jaxstone', 'u/jaxstone']) {
      const r = await lookup.lookup(q);
      assert.ok(r.candidates.some((c) => c.platform === 'reddit' && c.target === 'jaxstone'), `query ${q}: ${JSON.stringify(r.candidates.map((c) => c.platform))}`);
    }
  });

  test('queries are gated: female / minor wording is refused, nothing found is not an error', async () => {
    assert.match((await lookup.lookup('trans girl jenny')).error, /male/);
    assert.ok((await lookup.lookup('im 15 jax')).error);
    const none = await lookup.lookup('zzzz nobody');
    assert.equal(none.candidates.length, 0);
  });

  test('a woman in the avatar excludes the candidate (image filter)', async () => {
    imagefilter._setAnalyzer(async (url) => (/face\.jpg/.test(url) ? { status: 'ok', faces: [{ gender: 'female', score: 0.95, confidence: 0.9 }] } : { status: 'ok', faces: [] }));
    WORLD['reddit:user:avatarguy'] = { profile: { displayName: 'avatarguy', bio: 'gay', avatarUrl: 'https://i.redd.it/face.jpg' }, items: [post('av1')] };
    const r = await lookup.lookup('avatarguy');
    assert.equal(r.candidates.length, 0); assert.ok(r.hidden.notMale >= 1);
    imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [] }));
  });

  test('follow: one creator owns every chosen account, external links are kept, a deep read is queued; bad picks are rejected', () => {
    const r = lookup.follow({ name: 'Jax Stone', selections: [
      { platform: 'reddit', kind: 'user', target: 'jaxstone' }, { platform: 'bluesky', kind: 'user', target: 'jaxstone.bsky.social' }, { platform: 'x', kind: 'user', target: 'jaxstone' },
      { platform: 'redgifs', kind: 'user', target: 'femboy_jax' }, { platform: 'reddit', kind: 'community', target: 'gaybros' },
    ], externalLinks: [{ service: 'OnlyFans', label: 'OnlyFans', url: 'https://onlyfans.com/jaxstone' }] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.feeds.length, 3);
    assert.ok(r.rejected.some((x) => x.target === 'femboy_jax' && /male/.test(x.reason)));
    const c = repo.creators.get(r.creator.id);
    assert.equal(c.display_name, 'Jax Stone');
    assert.ok(JSON.stringify(c.links).includes('onlyfans.com/jaxstone'));
    assert.ok(r.feeds.every((f) => f.creator_id === c.id));
    assert.equal(queued.at(-1).o.limit, 300); assert.equal(queued.at(-1).o.force, true);
    assert.equal(lookup.follow({ name: 'x', selections: [{ platform: 'redgifs', kind: 'user', target: 'sissy_x' }] }).error, 'Nothing to follow');
  });

  test('already-followed accounts are marked, and findAndFollow takes only strong, new, verified matches', async () => {
    const again = await lookup.lookup('Jax Stone');
    assert.equal(again.candidates.find((c) => c.platform === 'reddit' && c.target === 'jaxstone').status, 'following');
    const auto = await lookup.findAndFollow('Jax Stone');
    assert.ok(auto.followed && auto.followed.ok, JSON.stringify(auto.followed));
    const followedTargets = auto.followed.feeds.map((f) => `${f.platform}:${f.target}`);
    assert.ok(followedTargets.includes('telegram:jaxstone_official'), followedTargets.join());
  });

  test('HTTP API: lookup, follow and auto are admin-only and validate input', async () => {
    const call = (path, body, headers = ADMIN) => fetch(`${base}/api/admin${path}`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    assert.equal((await call('/lookup', { query: 'jaxstone' }, { 'content-type': 'application/json' })).status, 401);
    assert.equal((await call('/lookup', { query: '' })).status, 400);
    const ok = await call('/lookup', { query: 'jaxstone' });
    assert.equal(ok.status, 200); assert.ok(ok.json.candidates.length >= 1);
    assert.equal((await call('/lookup/follow', { name: 'n', selections: [] })).status, 400);
    assert.equal((await call('/lookup', { query: 'femboy jax' })).status, 400);
  });

  test('scoring: name similarity prefers the right account', () => {
    const s = lookup.nameSimilarity;
    assert.ok(s('Jax Stone', 'jaxstone') >= 0.88);
    assert.ok(s('Jax Stone', 'jax_stone_official') >= 0.7);
    assert.ok(s('Jax Stone', 'mike_r', 'Mike') < 0.3);
  });
});

describe('creator lookup: attaching to an existing creator', () => {
  test('creatorId attaches new accounts to that creator instead of creating one', () => {
    const c = repo.creators.create({ handle: 'existing_guy', displayName: 'Existing Guy', origin: 'admin' });
    const r = lookup.follow({ creatorId: c.id, name: 'Existing Guy', selections: [{ platform: 'telegram', kind: 'user', target: 'existing_guy_tg' }] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.creator.id, c.id);
    assert.equal(r.feeds[0].creator_id, c.id);
    assert.equal(lookup.follow({ creatorId: 'nope', selections: [{ platform: 'x', kind: 'user', target: 'someone' }] }).error, 'Creator not found or not active');
  });
});
