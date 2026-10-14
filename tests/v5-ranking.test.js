'use strict';
/**
 * v5 ranking: creator-first For You. Creators are chosen first, each leads with his best fresh
 * post, and a prolific creator's further posts step down so more creators reach the first page.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let recs;
const AGE = { cookie: 'prism_age=1' };
const pub = async (p) => { const res = await fetch(`${base}${p}`, { headers: AGE }); return { status: res.status, json: await res.json() }; };

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  recs = require('../src/engine/recommend');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

let n = 0;
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
const post = (creator, tags, extra = {}) => {
  n++;
  const id = repo.media.insert({ creator_id: creator.id, platform: 'reddit', source_id: `v5r${n}`, source_key: `reddit:v5r${n}:0`, post_key: `reddit:v5r${n}`, author: creator.handle,
    title: `post ${n}`, media_type: 'image', media_url: `https://i.redd.it/v5r${n}.jpg`, hash: `v5rh${n}`, ...extra }, tags);
  repo.creators.refreshStats(creator.id);
  return id;
};
const mk = (handle) => repo.creators.create({ handle });
const w = {};

describe('creator-first For You', () => {
  before(() => {
    // A prolific favourite and two quieter favourites with the same style.
    w.big = mk('prolific_pete'); w.q1 = mk('quiet_quinn'); w.q2 = mk('quiet_quade');
    w.bigIds = [];
    for (let i = 0; i < 24; i++) w.bigIds.push(post(w.big, ['gym', 'muscle', 'shirtless'], { posted_at: daysAgo(i * 0.1) }));
    w.q1Ids = [post(w.q1, ['gym', 'muscle'], { posted_at: daysAgo(1) }), post(w.q1, ['gym', 'shirtless'], { posted_at: daysAgo(2) })];
    w.q2Ids = [post(w.q2, ['gym', 'muscle'], { posted_at: daysAgo(1) }), post(w.q2, ['muscle', 'shirtless'], { posted_at: daysAgo(3) })];
    // Same liking, one posting this week and one gone quiet for two months.
    w.live = mk('active_ari'); w.dormant = mk('dormant_dev');
    w.liveIds = [post(w.live, ['beach', 'swimmer'], { posted_at: daysAgo(0.5) })];
    w.dormantIds = [post(w.dormant, ['beach', 'swimmer'], { posted_at: daysAgo(60) })];
    // One creator with an old hit and a fresh post.
    w.mixed = mk('mixed_max');
    w.oldHit = post(w.mixed, ['hiking', 'outdoor'], { posted_at: daysAgo(40), score: 5000 });
    w.fresh = post(w.mixed, ['hiking', 'outdoor'], { posted_at: daysAgo(0.2) });
  });

  test('the first page reaches every liked creator before a second post from any of them', async () => {
    const q = `creators=${w.big.id}:9,${w.q1.id}:6,${w.q2.id}:6&tags=gym:2&limit=6&seed=11`;
    const r = await pub(`/api/recommend?${q}`);
    assert.equal(r.status, 200);
    const firstThree = r.json.items.slice(0, 3).map((x) => x.creator_id);
    assert.equal(new Set(firstThree).size, 3, `three different creators lead: ${firstThree}`);
    const counts = {};
    for (const it of r.json.items) counts[it.creator_id] = (counts[it.creator_id] || 0) + 1;
    assert.ok((counts[w.big.id] || 0) <= 2, 'the prolific creator does not flood the page');
    for (const id of [w.q1.id, w.q2.id]) assert.ok(counts[id] >= 1, 'each quieter favourite is on the first page');
  });

  test('the prolific creator still fills later pages once the others run out', async () => {
    const q = `creators=${w.big.id}:9,${w.q1.id}:6,${w.q2.id}:6&tags=gym:2&limit=6&seed=11`;
    const seen = [];
    for (let page = 0; page < 6; page++) seen.push(...(await pub(`/api/recommend?${q}&page=${page}`)).json.items.map((x) => x.id));
    assert.equal(new Set(seen).size, seen.length, 'no repeats across pages');
    assert.ok(seen.filter((id) => w.bigIds.includes(id)).length >= 15, 'nothing of his is lost, it just comes later');
  });

  test('a creator posting this week leads one who has gone quiet', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = await pub(`/api/recommend?creators=${w.live.id}:5,${w.dormant.id}:5&limit=4&seed=${seed}`);
      assert.equal(r.json.items[0].creator_id, w.live.id, `seed ${seed}`);
    }
  });

  test("each creator leads with his best fresh post, not an old hit", async () => {
    for (const seed of [1, 2, 3]) {
      const r = await pub(`/api/recommend?creators=${w.mixed.id}:5&limit=4&seed=${seed}`);
      assert.equal(r.json.items[0].id, w.fresh, `seed ${seed}`);
      assert.ok(r.json.items.some((x) => x.id === w.oldHit), 'the old hit still follows');
    }
  });

  test('internal ranking fields stay out of the response', async () => {
    const r = await pub(`/api/recommend?creators=${w.mixed.id}:5&limit=4`);
    for (const it of r.json.items) { assert.equal(it.creator_last_at, undefined); assert.equal(it.rn, undefined); }
  });

  test('creatorFirst steps each further post of one creator down', () => {
    const now = Date.now();
    const row = (id, creator, ago) => ({ id, creator_id: creator, seq: 1, posted_at: new Date(now - ago * 86400000).toISOString(), creator_last_at: new Date(now).toISOString() });
    const scored = [
      { row: row('a1', 'A', 1), score: 5 }, { row: row('a2', 'A', 1), score: 4.9 }, { row: row('a3', 'A', 1), score: 4.8 },
      { row: row('b1', 'B', 1), score: 4.6 }, { row: row('x1', null, 1), score: 4.5 },
    ];
    assert.deepEqual(recs.creatorFirst(scored, now).map((s) => s.row.id), ['a1', 'b1', 'a2', 'x1', 'a3']);
  });
});
