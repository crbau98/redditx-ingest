'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server;
let base;
let repo;
let engine;
let backup;

const AGE = { cookie: 'prism_age=1' };
const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, json, text };
};
const pub = (p, o = {}) => call(p, { ...o, headers: { ...AGE, ...(o.headers || {}) } });

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  backup = require('../src/engine/backup');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  engine.shutdown();
  backup.stop();
  await new Promise((r) => server.close(r));
});

let seq = 0;
function createPost(creator, title, extra = {}) {
  seq++;
  const id = repo.media.insert({
    creator_id: creator.id,
    platform: 'x',
    source_id: `collab_src_${seq}`,
    source_key: `x:collab_${seq}:0`,
    post_key: `x:collab_${seq}`,
    author: creator.handle,
    title,
    media_type: 'video',
    media_url: `https://example.com/video_${seq}.mp4`,
    hash: `chash_${seq}`,
    ...extra,
  }, ['collab', 'scene']);
  repo.creators.refreshStats(creator.id);
  return id;
}

describe('Frequent Co-Stars & Collabs', () => {
  test('repo.creators.collabs identifies co-stars from post mentions', () => {
    const starA = repo.creators.create({ handle: 'collab_star_a', displayName: 'Star A' });
    const starB = repo.creators.create({ handle: 'collab_star_b', displayName: 'Star B' });
    const starC = repo.creators.create({ handle: 'collab_star_c', displayName: 'Star C' });

    // Star A mentions Star B in 2 posts, and mentions himself
    createPost(starA, 'New hot scene out now with @collab_star_b! Follow @collab_star_a');
    createPost(starA, 'Behind the scenes video featuring @collab_star_b');
    // Star A mentions Star C once
    createPost(starA, 'Workout gym session with @collab_star_c');

    const collabsA = repo.creators.collabs(starA.id);
    assert.ok(Array.isArray(collabsA));
    assert.ok(collabsA.length >= 2);
    assert.equal(collabsA[0].id, starB.id);
    assert.equal(collabsA[0].collab_count, 2);
    assert.equal(collabsA[1].id, starC.id);
    assert.equal(collabsA[1].collab_count, 1);
    // Never mentions self
    assert.ok(!collabsA.some((x) => x.id === starA.id));
  });

  test('bidirectional mentions boost collab ranking', () => {
    const devA = repo.creators.create({ handle: 'duo_first', displayName: 'Duo 1' });
    const devB = repo.creators.create({ handle: 'duo_second', displayName: 'Duo 2' });
    const devC = repo.creators.create({ handle: 'solo_third', displayName: 'Solo 3' });

    // devA mentions devB and devC
    createPost(devA, 'Video with @duo_second and @solo_third');
    // devB also mentions devA back (bidirectional)
    createPost(devB, 'Loved shooting with @duo_first today!');

    const res = repo.creators.collabs(devA.id);
    assert.ok(res.length >= 2);
    assert.equal(res[0].id, devB.id);
    assert.ok(res[0].collab_count > res[1].collab_count, 'Duo 2 ranked higher due to reciprocal collab');
  });

  test('GET /api/creators/:id/collabs returns serialized cards with collab_count and respects status', async () => {
    const hero = repo.creators.create({ handle: 'hero_actor', displayName: 'Hero Actor' });
    const friend = repo.creators.create({ handle: 'friend_actor', displayName: 'Friend Actor' });
    const hidden = repo.creators.create({ handle: 'hidden_actor', displayName: 'Hidden Actor' });

    createPost(hero, 'Collab scene with @friend_actor and @hidden_actor');
    repo.creators.update(hidden.id, { status: 'hidden' });

    const r = await pub(`/api/creators/${hero.id}/collabs`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length >= 1);
    assert.equal(r.json[0].handle, 'friend_actor');
    assert.ok(!r.json.some((x) => x.handle === 'hidden_actor'));
    assert.equal(typeof r.json[0].collab_count, 'number');

    const notFound = await pub('/api/creators/00000000-0000-0000-0000-000000000000/collabs');
    assert.equal(notFound.status, 404);
  });
});

describe('OnlyFans Free Trials & Limited-Time Promos', () => {
  test('publicCreator flags trial and promo on onlyfans object', async () => {
    const promoGuy = repo.creators.create({
      handle: 'promoguy',
      displayName: 'Promo Guy',
      bio: 'Gay creator • 50% off sale on my page!',
    });
    repo.creators.enrich(promoGuy.id, {
      links: [{ platform: 'external', service: 'OnlyFans', label: 'OnlyFans · promoguy', url: 'https://onlyfans.com/promoguy', handle: 'promoguy' }],
    });
    const r = await pub(`/api/creators/${promoGuy.id}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.onlyfans);
    assert.equal(r.json.onlyfans.promo, true);
    assert.equal(r.json.onlyfans.free, false);

    const trialGuy = repo.creators.create({
      handle: 'trialguy',
      displayName: 'Trial Guy',
      bio: 'Free trial link in bio: https://onlyfans.com/action/trial/abcdef123',
    });
    repo.creators.enrich(trialGuy.id, {
      links: [{ platform: 'external', service: 'OnlyFans', label: 'OnlyFans · trialguy', url: 'https://onlyfans.com/trialguy', handle: 'trialguy' }],
    });
    const r2 = await pub(`/api/creators/${trialGuy.id}`);
    assert.equal(r2.status, 200);
    assert.ok(r2.json.onlyfans);
    assert.equal(r2.json.onlyfans.trial, true);
  });
});
