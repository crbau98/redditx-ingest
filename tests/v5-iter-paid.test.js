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
});

describe('iter7: paid link-out accuracy', () => {
  test('enrich dedupes paid pages case-insensitively and refreshes the free flag', () => {
    const paid = require('../src/lib/paid');
    const c = repo.creators.create({ handle: 'casepage' });
    repo.creators.enrich(c.id, { links: [{ platform: 'external', service: 'Fansly', label: 'Fansly · OldCase', url: 'https://fansly.com/OldCase' }] });
    repo.creators.enrich(c.id, { links: [paid.paidLink('Fansly', 'oldcase', { free: true })] });
    const links = repo.creators.get(c.id).links;
    assert.equal(links.filter((l) => /fansly\.com/i.test(l.url)).length, 1, 'no duplicate page');
    assert.equal(links.find((l) => /fansly\.com/i.test(l.url)).free, true);
    repo.creators.enrich(c.id, { links: [paid.paidLink('Fansly', 'oldcase')] });
    assert.equal(repo.creators.get(c.id).links.find((l) => /fansly\.com/i.test(l.url)).free, false, 'flag clears when the page stops saying free');
  });
  test('lookup follow stores canonical paid links with handles and claims them per service', () => {
    const lookup = require('../src/engine/lookup');
    const r = lookup.follow({ name: 'Paid Guy', selections: [{ platform: 'redgifs', kind: 'user', target: 'paidguy' }],
      externalLinks: [{ service: 'Fansly', label: 'Fansly', url: 'https://fansly.com/PaidGuy' }, { service: 'JustFor.Fans', label: 'JFF', url: 'https://justfor.fans/paidguy' }] });
    assert.ok(r.ok, JSON.stringify(r));
    const links = repo.creators.get(r.creator.id).links;
    assert.ok(links.some((l) => l.url === 'https://fansly.com/paidguy' && l.handle === 'paidguy'), JSON.stringify(links));
    assert.ok(links.some((l) => l.url === 'https://justfor.fans/paidguy' && l.handle === 'paidguy'));
    assert.equal(repo.onlyfans.get('paidguy', 'Fansly').status, 'claimed');
    assert.equal(repo.onlyfans.get('paidguy', 'JustFor.Fans').status, 'claimed');
  });
});
describe('iter8: thumbnail sweep reads several pictures in flight', () => {
  test('bounded concurrency keeps the same accounting and isolates failures', async () => {
    const thumbs = require('../src/engine/thumbs');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fetch = async (url) => (String(url).includes('/bad') ? { status: 500, buffer: Buffer.alloc(0) } : { status: 200, buffer: png });
    const ins = repo.db.prepare(`INSERT INTO media (id, platform, media_type, media_url, hash, publish_state, posted_at) VALUES (?, 'reddit', 'image', ?, ?, 'published', '2026-10-01T00:00:00Z')`);
    ins.run('sw-good1', 'https://img.test/a.png', 'sw-h1');
    ins.run('sw-good2', 'https://img.test/b.png', 'sw-h2');
    ins.run('sw-good3', 'https://img.test/c.png', 'sw-h3');
    ins.run('sw-bad1', 'https://img.test/bad.png', 'sw-h4');
    const r = await thumbs.sweep({ limit: 4, concurrency: 3, fetch });
    assert.equal(r.checked, 4, JSON.stringify(r));
    assert.equal(r.retry, 1, 'the unreadable picture is left for a later round');
    assert.equal(r.tinted, 3, 'every readable picture got its placeholder colour');
    assert.match(repo.db.prepare('SELECT tint FROM media WHERE id = ?').get('sw-good1').tint, /^#[0-9a-f]{6}$/);
    assert.equal(repo.db.prepare('SELECT tint FROM media WHERE id = ?').get('sw-bad1').tint, null, 'failures are not marked done');
  });
});

describe('iter2-admin: paid lead admin actions', () => {
  test('paste Fansly/JFF pages to trace, filter leads by service', async () => {
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

describe('iter9: autocomplete answers repeat keystrokes from a short cache', () => {
  test('the second identical query skips the database; the cache is capped', () => {
    const pub = require('../src/routes/public');
    let calls = 0;
    const real = repo.suggest;
    repo.suggest = (...a) => { calls++; return real(...a); };
    try {
      pub.suggestCache.clear();
      const first = pub.suggestCached('gym', 6);
      assert.deepEqual(pub.suggestCached('gym', 6), first);
      assert.equal(calls, 1, 'repeat keystroke served from cache');
      for (let i = 0; i < 250; i++) pub.suggestCached(`query${i}`, 6);
      assert.ok(pub.suggestCache.size <= 200, `cap holds (${pub.suggestCache.size})`);
    } finally { repo.suggest = real; pub.suggestCache.clear(); }
  });
});

describe('iter10: the image cache never walks the disk on the request path', () => {
  test('puts do no filesystem stats; eviction walks once over budget, then skips while under it', () => {
    const fs = require('fs');
    const cache = require('../src/lib/media-cache');
    assert.equal(cache.enabled, true, 'test env enables the cache');
    let stats = 0;
    const realStat = fs.statSync;
    fs.statSync = (...a) => { stats++; return realStat(...a); };
    try {
      const buf = Buffer.alloc(1024, 9);
      for (let i = 0; i < 50; i++) cache.put(`https://img.test/cache${i}.png`, buf, 'image/png');
      assert.equal(stats, 0, 'no stat() during 50 proxy puts — eviction is scheduled, not inline');
      assert.ok(cache.get('https://img.test/cache0.png'), 'entries survive');
      const big = Buffer.alloc(100 * 1024, 7);
      for (let i = 0; i < 200; i++) cache.put(`https://img.test/big${i}.png`, big, 'image/png'); // ~20 MB over the 16 MB test budget
      const before = stats;
      cache.evict({ force: true });
      assert.ok(stats > before, 'one walk establishes the true size and trims the oldest');
      const walked = stats;
      cache.evict({ force: true });
      assert.equal(stats, walked, 'back under budget, the walk is skipped');
    } finally { fs.statSync = realStat; }
  });
});

describe('iter11: the discovery queue filters by platform', () => {
  test('platform narrows the queue; paid signal chips name their service', async () => {
    const { parseProfile } = require('../src/lib/links');
    discovery.consider(parseProfile('https://www.redgifs.com/users/platfilter_a'), 'search', 'test', { bio: 'gay creator 18+ onlyfans' });
    discovery.consider(parseProfile('https://bsky.app/profile/platfilter-b.bsky.social'), 'search', 'test', { bio: 'gay creator 18+ onlyfans' });
    const call = async (p) => { const res = await fetch(`${base}${p}`, { headers: { ...AGE, ...ADMIN } }); return res.json(); };
    const rg = await call('/api/admin/discovery?status=pending&platform=redgifs&limit=200');
    assert.ok(rg.candidates.items.length >= 1);
    assert.ok(rg.candidates.items.every((c) => c.platform === 'redgifs'));
    assert.ok(!rg.candidates.items.some((c) => c.target === 'platfilter-b.bsky.social'));
    const all = await call('/api/admin/discovery?status=pending&limit=200');
    assert.ok(all.candidates.items.some((c) => c.target === 'platfilter-b.bsky.social'));
  });
});
