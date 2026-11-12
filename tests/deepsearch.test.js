'use strict';
/**
 * Deep pull (engine/deepsearch.js): searching a creator we already follow sweeps text and video
 * search for him, registers only what proves itself as his, records progress, and stays on a cooldown.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let deepsearch; let settings; let saved;

before(async () => {
  mock = await start({
    '/robots.txt': () => ({ status: 200, body: 'User-agent: *\nAllow: /\n' }),
  });
  prepareEnv({});
  saved = {};
  repo = require('../src/db/repo');
  deepsearch = require('../src/engine/deepsearch');
  settings = require('../src/settings');
});
after(async () => { deepsearch._resetSearchers(); await mock.close(); });

const creator = (handle, name) => repo.creators.create({ handle, displayName: name });

describe('query bank', () => {
  test('every query names him, and covers platforms plus standing phrases', () => {
    const c = creator('jakedoe', 'Jake Doe');
    const { text, video } = deepsearch.buildQueries(c);
    assert.ok(text.length >= 8, `expected a full bank, got ${text.length}`);
    assert.ok(text.some((q) => q.includes('site:x.com')), 'a platform shape');
    assert.ok(text.some((q) => /onlyfans|fansly|justfor/i.test(q)), 'his paid pages');
    assert.ok(text.some((q) => /nude|leaked|repost|mirror/i.test(q)), 'mirror/leak shape');
    assert.ok(text.every((q) => q.includes('Jake Doe') || q.includes('jakedoe')), 'every query carries his name');
    assert.ok(video.length >= 1 && video.every((q) => q.toLowerCase().includes('jake')), 'video queries too');
  });

  test('the site shapes rotate so a second pull asks different platforms', () => {
    const c = creator('rotated', 'Rotated Guy');
    const first = deepsearch.buildQueries(c).text.filter((q) => q.includes('site:'));
    repo.discoveryState.set('deepsearch.rotate', '5');
    const second = deepsearch.buildQueries(c).text.filter((q) => q.includes('site:'));
    repo.discoveryState.set('deepsearch.rotate', '0');
    assert.notDeepEqual(first, second, 'rotation changed the site set');
    assert.equal(first.length, second.length);
  });
});

describe('corroboration', () => {
  test('a result is his only under his own name or handle', () => {
    const c = { handle: 'jakedoe', display_name: 'Jake Doe' };
    assert.equal(deepsearch.samePerson(c, 'jakedoe'), true, 'the same handle');
    assert.equal(deepsearch.samePerson(c, 'jakedoefit'), true, 'a handle containing his name');
    assert.equal(deepsearch.samePerson(c, 'randomguy'), false, 'somebody else');
    assert.equal(deepsearch.samePerson(c, 'xyz', 'Jake Doe posts here'), false, 'a result that mentions him does not make the account his');
    assert.equal(deepsearch.samePerson(c, 'xyz', 'a list of top models'), false, 'no name, no claim');
    assert.equal(deepsearch.samePerson(c, 'doe'), false, 'a bare surname is not enough');
    assert.equal(deepsearch.samePerson(c, 'officialjakedoe'), true, 'official- prefix is the same stem');
    assert.equal(deepsearch.samePerson({ handle: 'jake', display_name: 'Jake' }, 'mrmusclebearx', ['mrmusclebear']), true, 'a trailing x on a known handle');
    assert.equal(deepsearch.samePerson({ handle: 'jake', display_name: 'Jake' }, 'mrmusclebeaz', ['mrmusclebear']), true, 'one trailing edit on a 10+ character handle');
    assert.equal(deepsearch.samePerson({ handle: 'jake', display_name: 'Jake' }, 'totallyunrelated', ['mrmusclebear']), false, 'a different known handle is not him');
    assert.equal(deepsearch.samePerson({ handle: 'theodore', display_name: 'Theodore' }, 'odorexxx'), false, 'Theodore does not lose its the-');
    assert.equal(deepsearch.samePerson({ display_name: 'Ryan Fitness', handle: 'ryanfitness', slug: 'ryanfitness' }, 'ryan'), false, 'a bare given-name slice of his handle is not his account');
    assert.equal(deepsearch.samePerson({ display_name: 'Ryan Fitness', handle: 'ryanfitness', slug: 'ryanfitness' }, 'fitness'), false, 'a generic word slice of his handle is not his account');
    assert.equal(deepsearch.samePerson({ display_name: 'Ben Smith', handle: 'bensmith', slug: 'bensmith' }, 'bens'), false, 'a 4-char prefix slice is not his account');
    assert.equal(deepsearch.samePerson({ display_name: 'Brandon', handle: 'brandon', slug: 'brandon' }, 'brendon'), false, 'vowel swap on a 7-char given name is a different man');
    assert.equal(deepsearch.samePerson({ display_name: 'Brandon', handle: 'brandon', slug: 'brandon' }, 'brandan'), false, 'vowel swap brandon/brandan stays separate');
    assert.equal(deepsearch.samePerson({ display_name: 'José', handle: 'jose', slug: 'jose' }, 'josé'), true, 'diacritics fold cleanly');
  });
});

describe('the pull', () => {
  test('registers his profile and a page that names him, and skips a page that does not', async () => {
    const c = creator('jakedoe2', 'Jake Two');
    const seen = [];
    deepsearch._setSearchers(async (q) => {
      seen.push(q);
      if (q.includes('site:x.com')) return [{ url: 'https://x.com/jakedoe2', title: 'Jake Two (@jakedoe2)', description: 'fitness creator' }];
      if (q.includes('nude')) return [
        { url: `${mock.url}/posts/jake-interview`, title: 'An interview with Jake Two', description: 'Jake Two talks about his training' },
        { url: 'https://unrelated.example/pic', title: 'Some gallery', description: 'nothing to do with anybody' },
      ];
      return [];
    }, async () => []);

    const out = await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(out.feeds >= 2, `expected his profile + the naming page, got ${JSON.stringify(out)}`);

    const feeds = repo.feeds.list({ creatorId: c.id, limit: 50 }).items;
    assert.ok(feeds.some((f) => f.platform === 'x' && f.target === 'jakedoe2'), 'his X profile became a feed');
    assert.ok(feeds.some((f) => f.platform === 'web' && String(f.target).includes('/posts/jake-interview')), 'the page that names him became a web feed');
    assert.ok(!feeds.some((f) => String(f.target).includes('unrelated.example')), 'a page that never names him was not followed');
    assert.ok(seen.length >= 8, 'the whole query bank was read');
  });

  test('accounts and feeds that only mention him are not attached to him (Dante Colle QA)', async () => {
    const c = creator('dantecolle.bsky.social', 'Dante Colle');
    deepsearch._setSearchers(async (q) => {
      if (!q.includes('nude')) return [];
      return [
        { url: 'https://bsky.app/profile/dantecolle.bsky.social', title: 'Dante Colle (@dantecolle.bsky.social)', description: 'his own account' },
        { url: 'https://bsky.app/profile/cartoonhunks.bsky.social', title: 'Fan art of Dante Colle', description: 'Dante Colle drawn by me' },
        { url: 'https://bsky.app/profile/ainpostolo.bsky.social', title: 'Ain Postolos', description: 'collab with Dante Colle' },
        { url: 'https://www.bftv.gay/rss/pornstars.xml', title: 'bftv.gay - RSS pornstar Feed', description: 'new: Dante Colle and others' },
        { url: 'https://www.instagram.com/joshuajammersmith/', title: 'Jammer Draws', description: 'Dante Colle commission' },
      ];
    }, async () => []);
    await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    const targets = repo.feeds.list({ creatorId: c.id, limit: 50 }).items.map((f) => `${f.platform}:${f.target}`);
    assert.ok(targets.includes('bluesky:dantecolle.bsky.social'), `his own account is attached: ${targets}`);
    for (const foreign of ['cartoonhunks', 'ainpostolo', 'bftv.gay']) assert.ok(!targets.some((t) => t.includes(foreign)), `${foreign} not attached: ${targets}`);
    const aliases = require('../src/engine/identity').aliasesOf(c.id).map((a) => String(a.alias).toLowerCase());
    assert.ok(!aliases.includes('joshuajammersmith'), `no foreign link-out alias: ${aliases}`);
  });

  test('progress is recorded so the profile can show what it is doing', async () => {
    const c = creator('prog', 'Progress Guy');
    deepsearch._setSearchers(async () => [], async () => []);
    await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    const st = deepsearch.status(c.id);
    assert.equal(st.done, true);
    assert.equal(st.running, false);
    assert.ok(st.lastAt, 'lastAt is stamped');
    assert.ok(Array.isArray(st.queries), 'queries are reported back');
    assert.ok(st.cooldownMs > 0, 'a finished pull is on cooldown');
  });

  test('a second pull inside the cooldown does not start', async () => {
    const c = creator('cool', 'Cooldown Guy');
    deepsearch._setSearchers(async () => [], async () => []);
    await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    const again = await deepsearch.pull(c.id, { trigger: 'manual', force: false });
    assert.equal(again.started, false);
    assert.equal(again.reason, 'cooldown');
    assert.ok(again.until, 'it says when the next one may run');
  });

  test('a proven link-out profile becomes an alias, never a feed', () => {
    const c = creator('aliasguy', 'Alias Guy');
    deepsearch._setSearchers(async (q) => {
      if (q.includes('nude')) return [{ url: 'https://www.instagram.com/aliasguy/', title: 'Alias Guy on Instagram', description: 'Alias Guy official' }];
      return [];
    }, async () => []);
    return deepsearch.pull(c.id, { trigger: 'manual', force: true }).then((out) => {
      assert.ok((out.aliases || 0) >= 1, `expected the instagram handle as an alias, got ${JSON.stringify(out)}`);
      const aliases = require('../src/engine/identity').aliasesOf(c.id).map((a) => (a.alias || a.handle || a).toString().toLowerCase());
      assert.ok(aliases.includes('aliasguy'), `alias recorded: ${JSON.stringify(aliases)}`);
      const igFeeds = repo.feeds.list({ creatorId: c.id, limit: 50 }).items.filter((f) => /instagram/.test(f.target || ''));
      assert.equal(igFeeds.length, 0, 'instagram is a link-out: no feed');
    });
  });

  test('an empty search is still a finished, clean run', async () => {
    const c = creator('empty', 'Empty Guy');
    deepsearch._setSearchers(async () => [], async () => []);
    const out = await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    assert.deepEqual(out, { ok: true, pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0, aliases: 0, enqueuedFeeds: 0, postsAdded: 0 });
  });

  test('fromLookup sweeps the creator the search resolved to', () => {
    const c = creator('known', 'Known Guy');
    settings.update({ deepSearch: true });
    const id = deepsearch.fromLookup({ candidates: [{ creatorId: c.id, platform: 'x', target: 'known' }] }, 'Known Guy');
    assert.equal(id, c.id, 'a follow the search already knew about triggers the sweep');
    assert.equal(deepsearch.fromLookup({ error: 'nope' }, 'x'), null, 'a failed lookup triggers nothing');
    assert.equal(deepsearch.fromLookup({ candidates: [] }, 'zzzz-unknown-name'), null, 'nobody we follow, nothing to sweep');
  });
});

describe('whole-library rotation', () => {
  test('kicks seeded names first, then honours the day cooldown', async () => {
    deepsearch._setSearchers(async () => [], async () => []);
    settings.update({ creatorSeeds: 'Jake Doe\nRandom Seed', deepPullPerHour: 5 });
    const seeded = creator('jakedoe2', 'Jake Doe');          // a seed name
    const big = creator('bigacct', 'Big Account');           // not a seed
    repo.db.prepare('UPDATE creators SET media_count = 500 WHERE id = ?').run(big.id); // he sorts first on size
    const first = deepsearch.rotate({ limit: 1 });
    assert.ok(first.kicked.includes('Jake Doe'), `seed beats raw size: ${JSON.stringify(first)}`);
    // simulate the kicked pull finishing (rotate is fire-and-forget; only its done-state gates the cooldown)
    repo.discoveryState.set(`deepsearch.${seeded.id}`, JSON.stringify({ lastAt: new Date().toISOString(), done: true }));
    const second = deepsearch.rotate({ limit: 5 });          // Jake is on his day cooldown now
    assert.ok(!second.kicked.includes('Jake Doe'), 'a creator pulled today is skipped');
    assert.ok(second.kicked.length >= 1, 'rotation continues down the list');
    settings.update({ creatorSeeds: '' });
  });
});

describe('known handles', () => {
  test('aliases, live leads, and account feeds are loaded; a rejected lead is not', () => {
    const c = creator('handlebank', 'Jake');
    repo.db.prepare("INSERT INTO creator_aliases (creator_id, norm, alias, kind, source) VALUES (?, 'mrmusclebear', 'mrmusclebear', 'handle', 'account')").run(c.id);
    repo.db.prepare("INSERT INTO creator_aliases (creator_id, norm, alias, kind, source) VALUES (?, 'cartoonhunks', 'cartoonhunks', 'handle', 'bio')").run(c.id);
    repo.db.prepare("INSERT INTO onlyfans_leads (service, handle, creator_id, status) VALUES ('OnlyFans', 'claimedbear', ?, 'claimed')").run(c.id);
    repo.db.prepare("INSERT INTO onlyfans_leads (service, handle, creator_id, status) VALUES ('OnlyFans', 'rejectedbear', ?, 'rejected')").run(c.id);
    repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'secretbear', creatorId: c.id, origin: 'admin', runNow: false });
    repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://example.com/not-a-handle', creatorId: c.id, origin: 'admin', runNow: false });
    const known = deepsearch.loadCreatorKnownHandles(c.id);
    for (const want of ['mrmusclebear', 'cartoonhunks', 'claimedbear', 'secretbear']) {
      assert.ok(known.includes(want), `missing ${want} in ${known}`);
    }
    assert.ok(!known.includes('rejectedbear'), `rejected lead leaked: ${known}`);
    assert.ok(!known.some((h) => String(h).includes('example.com')), `a page url is not a handle: ${known}`);
    const { text } = deepsearch.buildQueries(c);
    assert.ok(text.some((q) => q.includes('"mrmusclebear"') && q.includes('onlyfans') && q.includes('bsky')), 'alias platform query');
    assert.ok(text.some((q) => q.includes('"mrmusclebear"') && q.includes('muscle') && q.includes('xxx')), 'alias phrase query');
    assert.ok(text.some((q) => q.includes('Jake')), 'his name is still searched');
    assert.ok(!text.some((q) => q.includes('rejectedbear')), 'a rejected lead is not searched');
  });

  test('a bio-only alias is searched but does not attach that account', async () => {
    const c = creator('quietname', 'Quiet Name');
    repo.db.prepare("INSERT INTO creator_aliases (creator_id, norm, alias, kind, source) VALUES (?, 'cartoonhunks', 'cartoonhunks', 'handle', 'bio')").run(c.id);
    const seen = [];
    deepsearch._setSearchers(async (q) => {
      seen.push(q);
      if (q.includes('cartoonhunks')) return [{ url: 'https://bsky.app/profile/cartoonhunks.bsky.social', title: 'Cartoon Hunks', description: 'fan art' }];
      return [];
    }, async () => []);
    await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    assert.ok(seen.some((q) => q.includes('"cartoonhunks"')), 'the bio handle is still a search');
    const targets = repo.feeds.list({ creatorId: c.id, limit: 20 }).items.map((f) => f.target);
    assert.ok(!targets.some((t) => String(t).includes('cartoonhunks')), `bio alias is not proof: ${targets}`);
  });

  test('a live lead is matched and the new feed is enqueued once', async () => {
    const c = creator('plainjake', 'Jake');
    repo.db.prepare("INSERT INTO onlyfans_leads (service, handle, creator_id, status) VALUES ('OnlyFans', 'leadbearx', ?, 'claimed')").run(c.id);
    const enqueued = [];
    deepsearch._setEnqueuer((ids) => { enqueued.push(...ids); return ids.length; });
    deepsearch._setSearchers(async (q) => {
      if (String(q).includes('leadbearx')) return [{ url: 'https://x.com/leadbearx', title: 'leadbearx', description: '' }];
      return [];
    }, async () => []);
    const out = await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    const feeds = repo.feeds.list({ creatorId: c.id, limit: 20 }).items;
    const x = feeds.find((f) => f.platform === 'x' && f.target === 'leadbearx');
    assert.ok(x, `lead became a feed: ${feeds.map((f) => `${f.platform}:${f.target}`)}`);
    assert.deepEqual(enqueued, [x.id], `enqueued once: ${enqueued}`);
    assert.ok(out.enqueuedFeeds >= 1);
    const st = deepsearch.status(c.id);
    assert.equal(typeof st.postsAdded, 'number');
    assert.equal(st.found.enqueuedFeeds, out.enqueuedFeeds);
    assert.equal(st.phase, 'done');
  });

  test('a feed fetched in the last 10 minutes is not enqueued again', async () => {
    const c = creator('freshguy', 'Fresh Guy');
    const feed = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'freshguy', creatorId: c.id, origin: 'admin', runNow: false }).feed;
    repo.db.prepare('UPDATE feeds SET last_run_at = ? WHERE id = ?').run(new Date().toISOString(), feed.id);
    const enqueued = [];
    deepsearch._setEnqueuer((ids) => { enqueued.push(...ids); return ids.length; });
    deepsearch._setSearchers(async (q) => {
      if (q.includes('site:x.com')) return [{ url: 'https://x.com/freshguy', title: 'Fresh Guy (@freshguy)', description: '' }];
      return [];
    }, async () => []);
    const out = await deepsearch.pull(c.id, { trigger: 'manual', force: true });
    assert.ok(!enqueued.includes(feed.id), `fresh feed was enqueued: ${enqueued}`);
    assert.equal(out.enqueuedFeeds, 0);
  });
});

describe('public pull routes', () => {
  let server; let base;
  before(async () => {
    deepsearch._setSearchers(async () => [], async () => []);
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { if (server) await new Promise((r) => server.close(r)); });

  test('GET and POST /api/creators/:id/pull resolve id or handle, keep the cooldown, and rate-limit', async () => {
    assert.equal((await fetch(`${base}/api/creators/no-such-creator-zz/pull`)).status, 404);
    const c = creator('pullslug', 'Pull Slug');
    const got = await fetch(`${base}/api/creators/pullslug/pull`);
    assert.equal(got.status, 200);
    const job = (await got.json()).job;
    assert.equal(job.running, false);
    assert.equal(typeof job.postsAdded, 'number');
    const started = await fetch(`${base}/api/creators/${c.id}/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}' });
    assert.equal(started.status, 200);
    const first = await started.json();
    assert.equal(first.started, true, JSON.stringify(first));
    assert.ok(first.job);
    const deadline = Date.now() + 8000;
    let settled = first.job;
    while (settled.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
      settled = (await (await fetch(`${base}/api/creators/${c.id}/pull`)).json()).job;
    }
    assert.equal(settled.running, false, 'the pull finished before the cooldown check');
    const again = await fetch(`${base}/api/creators/${c.id}/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}' });
    assert.equal(again.status, 200);
    const second = await again.json();
    assert.equal(second.started, false);
    assert.equal(second.reason, 'cooldown');
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const extra = creator(`pullextra${i}`, `Pull Extra ${i}`);
      const res = await fetch(`${base}/api/creators/${extra.id}/pull`, { method: 'POST' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 429], `sixth start in the window is refused: ${statuses}`);
  });
});