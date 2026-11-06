'use strict';
/**
 * Creator popularity: the stored rank behind "Popular here".
 *
 * The rank must be earned from signals the library has (engagement per platform, breadth, volume,
 * freshness), not from raw post count; a stale account with a big archive must not lead a row; and
 * the rank must surface in the public API, /api/discover and the no-taste recommendation fallback.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let popularity;
const AGE = { cookie: 'prism_age=1' };
const pub = async (p) => { const res = await fetch(`${base}${p}`, { headers: AGE }); return { status: res.status, json: await res.json() }; };
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  popularity = require('../src/engine/popularity');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

let n = 0;
const post = (creator, platform, extra = {}) => {
  n++;
  return repo.media.insert({
    creator_id: creator.id, platform, source_id: `p${n}`, source_key: `${platform}:p${n}:0`, post_key: `${platform}:p${n}`,
    author: creator.handle, title: `post ${n}`, media_type: 'image',
    media_url: `https://img.example/${n}.jpg`, hash: `popularity-h${n}`, posted_at: ago(0), ...extra,
  });
};

const world = {};
describe('popularity rank', () => {
  before(() => {
    const mk = (handle) => repo.creators.create({ handle });
    world.engaged = mk('engaged_everywhere'); // recent, real engagement on two platforms, small archive
    world.prolific = mk('prolific_stale');    // huge archive, one platform, last post 200 days ago
    world.broad = mk('broad_fresh');           // five platforms, recent, little volume, no scores
    world.hidden = mk('hidden_creator');

    // Engagement is normalised per platform: reddit's top item here is 400, bluesky's is 120.
    for (let i = 0; i < 12; i++) post(world.engaged, 'reddit', { score: 400 - i * 10 });
    for (let i = 0; i < 6; i++) post(world.engaged, 'bluesky', { score: 120 - i * 5 });
    for (let i = 0; i < 400; i++) post(world.prolific, 'reddit', { score: 0, posted_at: ago(400) });
    for (const [i, platform] of ['reddit', 'bluesky', 'mastodon', 'redgifs', 'coomer'].entries()) {
      post(world.broad, platform, { score: 0, posted_at: ago(i / 24) });
      post(world.broad, platform, { score: 0, posted_at: ago(i / 24) });
    }
    for (let i = 0; i < 3; i++) post(world.hidden, 'reddit');
    repo.creators.update(world.hidden.id, { status: 'hidden' });
  });

  test('engagement, breadth and freshness beat a bigger stale archive', async () => {
    const r = await popularity.recompute({ force: true });
    assert.equal(r.updated, 3, 'the hidden creator is not ranked');
    const top = await pub('/api/creators?sort=popular&limit=5');
    const ids = top.json.items.map((c) => c.id);
    assert.deepEqual(ids.slice(0, 2), [world.engaged.id, world.broad.id]);
    assert.ok(!ids.includes(world.prolific.id), 'the Popular list leaves out anyone quiet for 90 days');

    const engaged = top.json.items.find((c) => c.id === world.engaged.id);
    assert.ok(engaged.popularity > 70, `engaged creator should rank high, got ${engaged.popularity}`);
    const stale = popularity.explain(world.prolific.id);
    assert.ok(stale.popularity < engaged.popularity / 2, `400 stale posts must not outrank real engagement (${stale.popularity} vs ${engaged.popularity})`);
  });

  test('the components explain the order and no signal is invented', () => {
    const e = popularity.explain(world.engaged.id);
    assert.equal(e.platforms, 2);
    assert.equal(e.items, 18);
    assert.ok(e.parts.engagement > 0.5, 'two platforms of real engagement');
    assert.ok(e.parts.freshness > 0.9);
    const p = popularity.explain(world.prolific.id);
    assert.ok(p.parts.volume >= 0.99, 'the biggest archive still earns full volume');
    assert.ok(p.parts.freshness < 0.01, 'and earns almost no freshness');
    assert.ok(p.parts.engagement === 0, 'a platform with no scores contributes no invented engagement');
    assert.equal(popularity.explain(world.hidden.id), null, 'hidden creators carry no rank');
  });

  test('default creator list is the popular order, and the rank is public', async () => {
    const dflt = await pub('/api/creators?limit=5');
    assert.equal(dflt.json.items[0].id, world.engaged.id);
    const one = await pub(`/api/creators/${world.engaged.id}`);
    assert.ok(one.json.popularity > 0);
  });

  test('/api/discover leads with the popular creator and keeps stale accounts out of the rail', async () => {
    const d = await pub('/api/discover');
    assert.equal(d.json.topCreators[0].id, world.engaged.id);
    assert.ok(!d.json.topCreators.some((c) => c.id === world.prolific.id), 'over a year without posting is off the rail');
  });

  test('a visitor with no taste gets the popular fallback, honestly labelled', async () => {
    const r = await pub('/api/recommend/creators');
    assert.equal(r.json[0].id, world.engaged.id);
    assert.ok(r.json.every((c) => c.reason === 'Popular here'));
    const ex = await pub(`/api/recommend/creators?exclude=${world.engaged.id}`);
    assert.ok(!ex.json.some((c) => c.id === world.engaged.id), 'show-less still applies');
  });

  test('recompute is idempotent and status reports what was ranked', async () => {
    const before = await pub('/api/creators?sort=popular&limit=5');
    const again = await popularity.recompute({ force: true });
    const after = await pub('/api/creators?sort=popular&limit=5');
    assert.deepEqual(after.json.items.map((c) => [c.id, c.popularity]), before.json.items.map((c) => [c.id, c.popularity]));
    const s = popularity.status();
    assert.equal(s.ranked, again.updated);
    assert.ok(s.at && Number.isFinite(Date.parse(s.at)), 'popularity_at is an ISO timestamp');
  });
});
