'use strict';
/**
 * v4.15 "Intelligence": weighted taste, "show less", similar-creator recommendations, variety,
 * creators for you, best-match search, "more like this" and the duplicate-creator finder.
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
const post = (creator, tags, extra = {}) => {
  n++;
  const id = repo.media.insert({ creator_id: creator.id, platform: 'reddit', source_id: `i${n}`, source_key: `reddit:i${n}:0`, post_key: `reddit:i${n}`, author: creator.handle,
    title: `post ${n}`, media_type: 'image', media_url: `https://i.redd.it/i${n}.jpg`, hash: `v415h${n}`, ...extra }, tags);
  repo.creators.refreshStats(creator.id);
  return id;
};
const world = {};

describe('taste parsing', () => {
  test('weights are read, clamped and cleaned; junk is dropped', () => {
    const m = recs.parseWeighted('Beach:3.5,beard,bad:-1,nan:x,%27;drop:2,beach:1', /^[\p{L}\p{N}-]{2,40}$/u, 10, repo.cleanTag);
    assert.deepEqual([...m], [['beach', 4.5], ['beard', 1]]);
    assert.equal(recs.parseWeighted(undefined, /./, 5).size, 0);
  });
});

describe('recommendations v2', () => {
  before(() => {
    const mk = (handle, extra) => repo.creators.create({ handle, ...extra });
    world.a = mk('surfer_alpha'); world.b = mk('surfer_bravo'); world.c = mk('gym_charlie'); world.d = mk('hidden_delta'); world.e = mk('tagonly_echo');
    world.aIds = [];
    for (let i = 0; i < 6; i++) world.aIds.push(post(world.a, i % 2 ? ['beach', 'surfing', 'blond', 'waves'] : ['beach', 'blond', 'waves']));
    // two images of the same post
    world.carousel = post(world.a, ['beach', 'blond', 'waves'], { post_key: 'reddit:carousel', position: 0 });
    world.carousel2 = post(world.a, ['beach', 'blond', 'waves'], { post_key: 'reddit:carousel', position: 1, source_key: 'reddit:carousel:1' });
    world.bIds = [];
    for (let i = 0; i < 5; i++) world.bIds.push(post(world.b, ['surfing', 'blond', 'waves', 'tan']));
    world.cIds = [];
    for (let i = 0; i < 4; i++) world.cIds.push(post(world.c, ['gym', 'beard', 'muscle']));
    world.dIds = [post(world.d, ['beach', 'blond', 'waves']), post(world.d, ['surfing', 'blond'])];
    repo.creators.update(world.d.id, { status: 'hidden' }); // e.g. hidden by the body filter
    world.hiddenMedia = post(world.e, ['beach', 'blond']);
    repo.media.setState(world.hiddenMedia, 'hidden', 'physique:test');
    world.eIds = [post(world.e, ['beach', 'waves']), post(world.e, ['beach', 'tan'])];
  });

  test('similar creators come through, with a reason naming who they resemble', async () => {
    const r = await pub(`/api/recommend?creators=${world.a.id}:6&tags=beach:2,blond:1&limit=40&seed=7`);
    assert.equal(r.status, 200); assert.equal(r.json.personalized, true);
    const ids = r.json.items.map((x) => x.id);
    assert.ok(world.bIds.some((id) => ids.includes(id)), 'a creator with the same style is recommended');
    const fromB = r.json.items.find((x) => x.creator_id === world.b.id);
    assert.equal(fromB.reason, 'Like @surfer_alpha');
    assert.equal(r.json.items.find((x) => x.creator_id === world.a.id).reason, 'A creator you like');
    assert.ok(!world.cIds.some((id) => ids.includes(id)), 'unrelated style stays out');
  });

  test('hidden creators and hidden media (body filter, moderation) never come back', async () => {
    const r = await pub(`/api/recommend?creators=${world.a.id}:6,${world.d.id}:9&tags=beach:3,blond:2&limit=60`);
    const ids = r.json.items.map((x) => x.id);
    for (const id of [...world.dIds, world.hiddenMedia]) assert.ok(!ids.includes(id));
  });

  test('one picture per post, at most two per creator in a page', async () => {
    const r = await pub(`/api/recommend?creators=${world.a.id}:6&tags=beach:2&limit=6&seed=3`);
    const ids = r.json.items.map((x) => x.id);
    assert.ok(!(ids.includes(world.carousel) && ids.includes(world.carousel2)), 'carousel siblings collapse');
    const perCreator = {};
    for (const it of r.json.items) perCreator[it.creator_id] = (perCreator[it.creator_id] || 0) + 1;
    const others = r.json.total - (perCreator[world.a.id] || 0);
    if (others >= 4) assert.ok(perCreator[world.a.id] <= 2, `creator cap held: ${JSON.stringify(perCreator)}`);
  });

  test('pages of one seed do not repeat', async () => {
    const q = `creators=${world.a.id}:6&tags=beach:2,waves:1&limit=4&seed=11`;
    const p0 = (await pub(`/api/recommend?${q}&page=0`)).json.items.map((x) => x.id);
    const p1 = (await pub(`/api/recommend?${q}&page=1`)).json.items.map((x) => x.id);
    assert.equal(p0.length, 4); assert.ok(p1.length > 0);
    assert.deepEqual(p0.filter((id) => p1.includes(id)), []);
  });

  test('"not interested": avoided creators vanish, avoided tags sink', async () => {
    const r = await pub(`/api/recommend?creators=${world.a.id}:6&tags=beach:2,blond:1&avoid_creators=${world.b.id}&avoid_tags=surfing&limit=40`);
    const items = r.json.items;
    assert.ok(!items.some((x) => x.creator_id === world.b.id));
    const firstSurf = items.findIndex((x) => x.tags.includes('surfing'));
    const lastPlain = items.map((x) => x.tags.includes('surfing')).lastIndexOf(false);
    if (firstSurf >= 0) assert.ok(firstSurf > 0, 'a surfing item is not the top pick');
    assert.ok(lastPlain >= 0);
  });

  test('a tag-only taste still finds matching creators; type filter holds', async () => {
    const r = await pub('/api/recommend?tags=tan:3,waves:1&limit=30');
    assert.ok(r.json.items.length > 0);
    assert.ok(r.json.items.every((x) => x.tags.some((t) => ['tan', 'waves'].includes(t))));
    assert.equal((await pub('/api/recommend?tags=beach&type=video')).json.items.length, 0, 'no videos in this library');
  });

  test('creators for you: neighbours of who you like, minus who you already follow or avoid', async () => {
    const r = await pub(`/api/recommend/creators?creators=${world.a.id}:5`);
    assert.equal(r.status, 200);
    const ids = r.json.map((c) => c.id);
    assert.ok(ids.includes(world.b.id)); assert.ok(!ids.includes(world.a.id)); assert.ok(!ids.includes(world.d.id), 'hidden creator');
    assert.match(r.json.find((c) => c.id === world.b.id).reason, /^Like @surfer_alpha$/);
    const ex = await pub(`/api/recommend/creators?creators=${world.a.id}:5&exclude=${world.b.id}`);
    assert.ok(!ex.json.some((c) => c.id === world.b.id));
    assert.deepEqual((await pub('/api/recommend/creators')).json, [], 'no taste, no guesses');
  });

  test('similar creators rank by shared distinctive style', () => {
    const sim = repo.creators.similar(world.a.id, 5).map((c) => c.id);
    assert.ok(sim.includes(world.b.id));
    assert.ok(!sim.includes(world.c.id));
  });

  test('"more like this": same post first, then a capped few from the creator, then lookalikes', () => {
    const rel = repo.media.related(world.carousel, 8);
    assert.equal(rel[0].id, world.carousel2);
    const own = rel.filter((x) => x.creator_id === world.a.id).length;
    assert.ok(own <= 4, `own creator capped (${own})`);
    assert.ok(rel.some((x) => x.creator_id !== world.a.id));
    assert.ok(!rel.some((x) => x.creator_id === world.d.id), 'hidden creators stay hidden');
  });
});

describe('search ranking', () => {
  test('a title or tag hit outranks a passing mention in a long description', async () => {
    const z = repo.creators.create({ handle: 'search_zulu' });
    const desc = post(z, ['misc'], { title: 'Sunday', description: `long caption ${'words '.repeat(40)} volleyballer mention` });
    const title = post(z, ['misc'], { title: 'Volleyballer at the beach' });
    const r = await pub('/api/media?q=volleyballer&sort=relevance');
    const ids = r.json.items.map((x) => x.id);
    assert.ok(ids.indexOf(title) >= 0 && ids.indexOf(title) < ids.indexOf(desc));
    assert.equal(r.json.total, 2);
  });
});

describe('duplicate creators', () => {
  test('grouped by shared link, picture or near-identical handle, each with a reason', () => {
    const one = repo.creators.create({ handle: 'jakeriverfit', avatarUrl: 'https://cdn.example.com/avatars/jake-river-1.jpg' });
    const two = repo.creators.create({ handle: 'jake.river.bsky.social' });
    const three = repo.creators.create({ handle: 'jakeriverr' });
    const linkA = repo.creators.create({ handle: 'linkguy_one' }); const linkB = repo.creators.create({ handle: 'totally_different' });
    repo.creators.update(linkA.id, { links: [{ url: 'https://linktr.ee/MarcoSun', service: 'linktree' }] });
    repo.creators.update(linkB.id, { links: [{ url: 'https://www.linktr.ee/marcosun/', service: 'linktree' }] });
    const loner = repo.creators.create({ handle: 'nobody_like_me' });
    const groups = repo.creators.duplicates();
    const groupOf = (id) => groups.find((g) => g.some((c) => c.id === id));
    const jake = groupOf(one.id);
    assert.ok(jake && [two.id, three.id].every((id) => jake.some((c) => c.id === id)), 'same core handle and one typo apart');
    const links = groupOf(linkA.id);
    assert.ok(links && links.some((c) => c.id === linkB.id));
    assert.ok(links.slice(1).every((c) => c.match.some((m) => m.startsWith('same link'))));
    assert.ok(!groupOf(loner.id));
    assert.ok(groups.every((g) => g.every((c) => c.links === undefined)), 'raw links are not sent');
  });
});
