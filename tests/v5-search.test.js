'use strict';
/**
 * v5 search: one box answering with Creators, Posts and Tags; typo-tolerant creator names
 * (handles and full names); paid platforms ("on Fansly") as a creator filter; build words
 * ("athletic") as a measured-physique filter.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let query;
const AGE = { cookie: 'prism_age=1' };
const pub = async (p) => { const res = await fetch(`${base}${p}`, { headers: AGE }); return { status: res.status, json: await res.json() }; };

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  query = require('../src/lib/query');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

let n = 0;
const post = (creator, tags, extra = {}) => {
  n++;
  const id = repo.media.insert({ creator_id: creator.id, platform: 'x', source_id: `v5s${n}`, source_key: `x:v5s${n}:0`, post_key: `x:v5s${n}`, author: creator.handle,
    title: `post ${n}`, media_type: 'image', media_url: `https://pbs.twimg.com/v5s${n}.jpg`, hash: `v5sh${n}`, ...extra }, tags);
  repo.creators.refreshStats(creator.id);
  return id;
};
const w = {};

describe('grouped search', () => {
  before(() => {
    w.hogue = repo.creators.create({ handle: 'hogue_fit', displayName: 'Christian Hogue' });
    repo.creators.update(w.hogue.id, { links: [{ platform: 'fansly', label: 'Fansly', url: 'https://fansly.com/christianhogue' }] });
    w.jak = repo.creators.create({ handle: 'jakipz', displayName: 'Jakipz' });
    repo.creators.update(w.jak.id, { links: [{ platform: 'onlyfans', label: 'OnlyFans', url: 'https://onlyfans.com/jakipz' }] });
    w.other = repo.creators.create({ handle: 'gymbro_otto', displayName: 'Otto' });
    w.h1 = post(w.hogue, ['gym', 'blond', 'shirtless'], { physique: 12 });
    w.h2 = post(w.hogue, ['beach', 'blond']);
    w.j1 = post(w.jak, ['gym', 'muscle'], { physique: 20 });
    w.o1 = post(w.other, ['gym', 'blond'], { physique: 55 });
    w.o2 = post(w.other, ['gym', 'muscle']);
  });

  test('creator names survive a typo, as a handle or a full name', async () => {
    for (const q of ['jakips', 'christan hogue', 'christianhoge']) {
      const r = await pub(`/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200);
      const want = q.startsWith('jak') ? w.jak.id : w.hogue.id;
      assert.equal(r.json.creators[0] && r.json.creators[0].id, want, q);
      assert.equal(r.json.creators[0].match, 'name');
      assert.ok(r.json.corrections.length, `${q}: the correction is reported`);
      assert.ok(r.json.posts.items.every((x) => x.creator_id === want), `${q}: posts are his`);
    }
  });

  test('ordinary words are not bent into a creator name', () => {
    const vocab = query.buildVocabulary(repo.tagIntel.vocabulary());
    assert.equal(query.understand('gym blond', vocab).creator, undefined);
    assert.equal(query.understand('show me', vocab).creator, undefined);
  });

  test('"on Fansly" finds creators with a Fansly page and their free posts', async () => {
    const r = await pub(`/api/search?q=${encodeURIComponent('gym guys on fansly')}`);
    assert.equal(r.json.query.paid, 'fansly');
    assert.deepEqual(r.json.creators.map((c) => c.id), [w.hogue.id]);
    assert.ok(r.json.posts.items.length && r.json.posts.items.every((x) => x.creator_id === w.hogue.id));
    assert.ok(r.json.chips.some((c) => c.key === 'paid' && c.label === 'On Fansly'));
    const bare = await pub('/api/search?q=onlyfans');
    assert.deepEqual(bare.json.creators.map((c) => c.id), [w.jak.id], 'a bare platform word lists its creators');
    assert.equal(bare.json.creators[0].match, 'platform');
    const list = await pub('/api/creators?paid=onlyfans');
    assert.deepEqual(list.json.items.map((c) => c.id), [w.jak.id]);
  });

  test('"of" means OnlyFans only right after "on"', () => {
    const vocab = query.buildVocabulary(repo.tagIntel.vocabulary());
    assert.equal(query.understand('pics of gym', vocab).paid, undefined);
    assert.equal(query.understand('gym on of', vocab).paid, 'onlyfans');
  });

  test('build words filter to pictures measured as lean or athletic', async () => {
    const r = await pub(`/api/search?q=${encodeURIComponent('athletic gym')}`);
    assert.equal(r.json.query.build, 'fit');
    const ids = r.json.posts.items.map((x) => x.id).sort();
    assert.deepEqual(ids, [w.h1, w.j1].sort(), 'only measured lean pictures; unmeasured and heavier ones drop');
    const media = await pub('/api/media?build=fit');
    assert.deepEqual(media.json.items.map((x) => x.id).sort(), [w.h1, w.j1].sort());
  });

  test('tags come back with the understood tags first, and style matches fill the creators', async () => {
    const r = await pub(`/api/search?q=${encodeURIComponent('blond gym')}`);
    assert.deepEqual(r.json.tags.slice(0, 2).map((t) => t.name).sort(), ['blond', 'gym']);
    assert.ok(r.json.creators.length >= 2 && r.json.creators.every((c) => c.match === 'style'));
  });

  test('an unknown extra word does not sink a good query', async () => {
    const r = await pub(`/api/search?q=${encodeURIComponent('gym blond zzqx')}`);
    assert.equal(r.json.relaxed, true);
    assert.ok(r.json.posts.items.length > 0);
  });

  test('a tag only one creator uses still lists him', async () => {
    const r = await pub('/api/search?q=shirtless');
    assert.deepEqual(r.json.creators.map((c) => [c.id, c.match]), [[w.hogue.id, 'tag']]);
  });

  test('a relaxed search stays relaxed on later pages', async () => {
    const q = encodeURIComponent('gym zzqx');
    const p0 = await pub(`/api/search?q=${q}&limit=2`);
    const p1 = await pub(`/api/search?q=${q}&limit=2&page=1`);
    assert.equal(p0.json.relaxed, true); assert.equal(p1.json.relaxed, true);
    assert.equal(p1.json.posts.items.length, 2, 'page 2 continues the relaxed results');
    assert.ok(!p1.json.posts.items.some((x) => p0.json.posts.items.some((y) => y.id === x.id)));
  });

  test('later pages carry posts only; empty queries are cheap', async () => {
    const r = await pub('/api/search?q=gym&page=1&limit=2');
    assert.deepEqual(r.json.creators, []); assert.deepEqual(r.json.tags, []);
    const e = await pub('/api/search?q=');
    assert.equal(e.json.posts.total, 0);
  });
});
