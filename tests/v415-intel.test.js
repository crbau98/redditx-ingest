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

  test('later pages continue the order the session started with, even after the library changes', async () => {
    const q = `creators=${world.a.id}:6&tags=beach:2,waves:1&limit=4&seed=13`;
    const p0 = (await pub(`/api/recommend?${q}&page=0`)).json.items.map((x) => x.id);
    // New, fresh posts that would rank near the top of a rebuilt list.
    const fresh = [post(world.a, ['beach', 'blond', 'waves']), post(world.b, ['beach', 'waves', 'blond'])];
    try {
      const later = [];
      for (const page of [1, 2]) later.push(...(await pub(`/api/recommend?${q}&page=${page}`)).json.items.map((x) => x.id));
      assert.ok(later.length > 0);
      assert.deepEqual(p0.filter((id) => later.includes(id)), [], 'no item of page 0 comes back on a later page');
      assert.equal(new Set(later).size, later.length);
      assert.ok(!later.some((id) => fresh.includes(id)), 'items added mid-session wait for the next fresh first page');
      assert.ok((await pub(`/api/recommend?${q}&page=0`)).json.items.length > 0);
    } finally { for (const id of fresh) repo.media.setState(id, 'hidden', 'admin'); }
  });

  test('an item moderated after its page was served is replaced, so the page stays full', async () => {
    recs.setCacheTtl(60000);
    const q = `creators=${world.a.id}:6,${world.b.id}:4,${world.e.id}:3&tags=beach:2,waves:1&limit=3&seed=17`;
    let victim;
    try {
      const p0 = (await pub(`/api/recommend?${q}&page=0`)).json.items.map((x) => x.id);
      const p1 = (await pub(`/api/recommend?${q}&page=1`)).json.items.map((x) => x.id);
      assert.equal(p1.length, 3);
      victim = p1[1];
      repo.media.setState(victim, 'hidden', 'admin');
      // A retried (or shared) request for the same later page, after the moderation.
      const again = (await pub(`/api/recommend?${q}&page=1`)).json.items.map((x) => x.id);
      assert.equal(again.length, 3, 'a short page would end infinite scroll');
      assert.ok(!again.includes(victim));
      assert.deepEqual([again[0], again[2]], [p1[0], p1[2]], 'the rest of the page keeps its place');
      assert.ok(!p0.includes(again[1]), 'the stand-in is something not shown before');
      const p2 = (await pub(`/api/recommend?${q}&page=2`)).json.items.map((x) => x.id);
      assert.deepEqual(p2.filter((id) => [...p0, ...again].includes(id)), []);
    } finally { recs.setCacheTtl(0); if (victim) repo.media.setState(victim, 'published'); }
  });

  test('a deep page is cheap, and retries of a page never shrink the total', async () => {
    recs.setCacheTtl(60000);
    const q = `creators=${world.a.id}:6,${world.b.id}:4&tags=beach:2,waves:1&limit=1&seed=19`;
    let victim;
    try {
      const first = (await pub(`/api/recommend?${q}&page=0`)).json;
      const far = await pub(`/api/recommend?${q}&page=100000`);
      assert.equal(far.status, 200); assert.deepEqual(far.json.items, []);
      const t0 = Date.now(); await pub(`/api/recommend?${q}&page=${first.total - 1}`);
      assert.ok(Date.now() - t0 < 2000);
      const last = (await pub(`/api/recommend?${q}&page=${first.total - 1}`)).json;
      victim = last.items[0] && last.items[0].id;
      if (victim) {
        repo.media.setState(victim, 'hidden', 'admin');
        const totals = [];
        for (let k = 0; k < 4; k++) totals.push((await pub(`/api/recommend?${q}&page=${first.total - 1}`)).json.total);
        assert.ok(totals.every((x) => x === totals[0] && x >= 0), JSON.stringify(totals));
      }
    } finally { recs.setCacheTtl(0); if (victim) repo.media.setState(victim, 'published'); }
  });

  test('a cached ranking still honours each request\'s exclusions and later moderation', async () => {
    recs.setCacheTtl(60000);
    try {
      const q = `creators=${world.a.id}:6&tags=beach:2,waves:1&limit=40&seed=21`;
      const all = (await pub(`/api/recommend?${q}`)).json.items.map((x) => x.id);
      const victim = all.find((id) => world.bIds.includes(id)) || all[1];
      const ex = (await pub(`/api/recommend?${q}&exclude=${all[0]}`)).json.items.map((x) => x.id);
      assert.ok(!ex.includes(all[0]), 'excluded by this request, though the list is cached');
      assert.ok((await pub(`/api/recommend?${q}`)).json.items.some((x) => x.id === all[0]), 'and not by the next one');
      repo.media.setState(victim, 'hidden', 'admin');
      for (const page of [0, 1]) {
        const ids = (await pub(`/api/recommend?${q.replace('limit=40', 'limit=3')}&page=${page}`)).json.items.map((x) => x.id);
        assert.ok(!ids.includes(victim), `hidden media drops out of the cached list (page ${page})`);
      }
      repo.creators.update(world.b.id, { status: 'hidden' });
      assert.ok(!(await pub(`/api/recommend?${q}`)).json.items.some((x) => x.creator_id === world.b.id), 'a creator hidden after ranking drops out too');
      repo.creators.update(world.b.id, { status: 'active' });
      repo.media.setState(victim, 'published');
    } finally { recs.setCacheTtl(0); }
  });

  test('the per-page creator cap holds even when one creator fills the look-ahead', () => {
    const mk = (cid, i, score) => ({ row: { id: `${cid}-${i}`, creator_id: cid, seq: i }, tags: new Set(), score });
    const scored = [...Array.from({ length: 60 }, (_, i) => mk('big', i, 100 - i * 0.01)), mk('small', 0, 1), mk('tiny', 0, 0.5)];
    const page = recs.diversify(scored, 4, 4);
    assert.equal(page.filter((c) => c.row.creator_id === 'big').length, 2);
  });

  test('a negative-only taste keeps "not interested" creators and tags out of the trending fallback', async () => {
    const r = await pub(`/api/recommend?avoid_creators=${world.a.id}&avoid_tags=tan&limit=60`);
    assert.equal(r.json.personalized, false);
    assert.ok(r.json.items.length > 0);
    assert.ok(!r.json.items.some((x) => x.creator_id === world.a.id || x.tags.includes('tan')));
  });

  test('the negative-only fallback pages through the filtered list without gaps', async () => {
    const q = `avoid_creators=${world.a.id}&avoid_tags=tan`;
    const all = (await pub(`/api/recommend?${q}&limit=60`)).json.items.map((x) => x.id);
    const p0 = (await pub(`/api/recommend?${q}&limit=3&page=0`)).json.items.map((x) => x.id);
    const p1 = (await pub(`/api/recommend?${q}&limit=3&page=1`)).json.items.map((x) => x.id);
    assert.deepEqual([...p0, ...p1], all.slice(0, 6));
  });

  test('variety holds on every page after this request\'s exclusions', async () => {
    recs.setCacheTtl(60000);
    try {
      const q = `creators=${world.a.id}:6,${world.b.id}:5,${world.e.id}:4&tags=beach:2&limit=4&seed=5`;
      const first = (await pub(`/api/recommend?${q}&limit=40`)).json.items.map((x) => x.id);
      const ex = first.filter((id, i) => i % 3 === 1).join(',');
      for (let page = 0; page < 3; page++) {
        const items = (await pub(`/api/recommend?${q}&exclude=${ex}&page=${page}`)).json.items;
        const per = {};
        for (const it of items) per[it.creator_id] = (per[it.creator_id] || 0) + 1;
        if (Object.keys(per).length > 1) assert.ok(Object.values(per).every((n) => n <= 2), `page ${page}: ${JSON.stringify(per)}`);
      }
    } finally { recs.setCacheTtl(0); }
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

  test('hidden or scope-excluded creators never take a neighbour slot or a related spot', () => {
    const sim = require('../src/lib/similarity');
    const lib = repo.library();
    const near = sim.neighbours(lib, repo.GENERIC_TAGS, world.a.id, 50).map(([id]) => id);
    assert.ok(!near.includes(world.d.id), 'hidden creator is not a neighbour');
    repo.creators.update(world.e.id, { scope: 'excluded' });
    try {
      const near2 = sim.neighbours(repo.library(), repo.GENERIC_TAGS, world.a.id, 50).map(([id]) => id);
      assert.ok(!near2.includes(world.e.id), 'excluded creator is not a neighbour');
      assert.ok(!repo.media.related(world.aIds[0], 40).some((x) => x.creator_id === world.e.id), 'nor in more like this');
    } finally { repo.creators.update(world.e.id, { scope: 'in' }); }
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
    // shared default avatars are not evidence; a unique picture plus the same name is
    const pic = 'https://files.example.social/accounts/avatars/original/missing.png';
    const m1 = repo.creators.create({ handle: 'alpha_mast', avatarUrl: pic }); const m2 = repo.creators.create({ handle: 'zed_other', avatarUrl: pic });
    const p1 = repo.creators.create({ handle: 'kai_one', displayName: 'Kai Storm', avatarUrl: 'https://cdn.example.com/u/kai-storm-77.jpg' });
    const p2 = repo.creators.create({ handle: 'stormy_k', displayName: 'Kai Storm', avatarUrl: 'https://cdn.example.com/u/kai-storm-77.jpg' });
    const again = repo.creators.duplicates();
    const g = (id) => again.find((x) => x.some((c) => c.id === id));
    assert.ok(!g(m1.id) && !g(m2.id), 'placeholder avatars do not group strangers');
    assert.ok(g(p1.id) && g(p1.id).some((c) => c.id === p2.id && c.match.includes('same profile picture')));
  });
});

describe('Reels taste signals', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'views', 'reels.js'), 'utf8');
  test('dwell is settled when a slide stops being active, not when its buffer is torn down', () => {
    assert.match(src, /if \(slides\[active\]\) \{ settle\(slides\[active\]\);/);
    assert.match(src, /function deactivate\(s\) \{\s*settle\(s, \{ teardown: true \}\)/, 'leaving Reels is not a skip');
    assert.match(src, /document\.hidden && cur\.at\) \{ cur\.ms = dwell\(cur\)/, 'background time does not count');
    assert.doesNotMatch(src.match(/function activate\(s\) \{[\s\S]*?\n {2}\}/)[0], /tastes\.record/, 'no positive signal before the dwell is known');
  });
  test('later For you pages reuse the taste the session started with', () => {
    assert.match(src, /tasteQ = \(page && tasteQ\) \|\| tastes\.query/);
  });
});

describe('taste store', () => {
  test('quick skips of an unfamiliar creator build a negative that ends in avoid', async () => {
    const mem = new Map();
    global.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    global.window = { matchMedia: () => ({ matches: false }) };
    const { tastes } = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', 'public', 'js', 'store.js')).href);
    const item = { id: 'x', creator_id: '11111111-1111-1111-1111-111111111111', tags: ['beach', 'tan'], media_type: 'image', platform: 'reddit' };
    for (let i = 0; i < 3; i++) tastes.skip(item);
    const q = tastes.query();
    assert.ok((q.avoid_creators || '').includes(item.creator_id), 'creator avoided after three quick skips');
    assert.ok(!(q.avoid_tags || '').includes('beach'), 'a tag needs more than three skips');
  });
});
