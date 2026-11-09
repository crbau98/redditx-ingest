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
    assert.equal(deepsearch.samePerson(c, 'xyz', 'Jake Doe posts here'), true, 'his name in the result text');
    assert.equal(deepsearch.samePerson(c, 'xyz', 'a list of top models'), false, 'no name, no claim');
    assert.equal(deepsearch.samePerson(c, 'doe'), false, 'a bare surname is not enough');
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
    assert.deepEqual(out, { ok: true, pages: 0, feeds: 0, paid: 0, pictures: 0, reviews: 0, results: 0, aliases: 0 });
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