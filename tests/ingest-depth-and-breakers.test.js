'use strict';
/**
 * Ingest depth + resilience: seed feeds beyond Coomer, paginated backfill (Bluesky, RedGIFs), per-host gateway breaker,
 * Brave quota cooldown, Telegram adult-channel diagnosis.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let registry; let breaker; let derive; let tg; let brave; let engine; let repo;
const gifs = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `g${from + i}`, userName: 'zed', type: 1, urls: { hd: `https://media.example/g${from + i}.mp4`, poster: `https://media.example/g${from + i}.jpg` }, createDate: 1700000000 - (from + i), tags: ['x'] }));
const bskyPost = (i) => ({ post: { uri: `at://did:plc:abc/app.bsky.feed.post/r${i}`, cid: `c${i}`, author: { did: 'did:plc:abc', handle: 'zed.bsky.social' }, record: { text: `p${i}`, createdAt: new Date(1700000000000 - i * 1000).toISOString() }, indexedAt: new Date(1700000000000 - i * 1000).toISOString(), embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: `https://cdn.example/t${i}.jpg`, fullsize: `https://cdn.example/f${i}.jpg`, alt: '' }] } } });

before(async () => {
  const calls = { bskyCursors: [], redgifsPages: [], brave: 0, tgBase: null };
  mock = await start({
    '/xrpc/app.bsky.feed.getAuthorFeed': (req, res, url) => {
      const c = url.searchParams.get('cursor');
      calls.bskyCursors.push(c);
      const idx = c ? Number(c.replace('cur', '')) : 0;
      const feed = Array.from({ length: 2 }, (_, i) => bskyPost(idx * 2 + i));
      return { json: { feed, cursor: idx < 5 ? `cur${idx + 1}` : undefined } };
    },
    '/v2/auth/temporary': () => ({ json: { token: 't' } }),
    '/v2/users/zed/search': (req, res, url) => {
      const page = Number(url.searchParams.get('page'));
      calls.redgifsPages.push(page);
      return { json: { gifs: gifs(page * 10, 3), pages: 6, users: [{ username: 'zed' }] } };
    },
    '/res/v1/web/search': () => { calls.brave++; return { status: 402, headers: { 'x-ratelimit-reset': '1, 2592000' }, body: '{}' }; },
    '/s/adultchan': () => ({ status: 200, body: '<html><body><div class="tgme_page"><div class="tgme_page_title">Adult</div></div></body></html>' }),
  });
  mock.calls = calls;
  prepareEnv({ BSKY_BASE_URL: mock.url, REDGIFS_BASE_URL: mock.url, BRAVE_BASE_URL: mock.url, BRAVE_API_KEY: 'k', TELEGRAM_WEB_BASE_URL: mock.url });
  registry = require('../src/sources'); breaker = require('../src/engine/breaker'); derive = require('../src/sources/seed-feeds');
  tg = require('../src/sources/telegram');
  brave = require('../src/lib/brave'); engine = require('../src/engine/engine'); repo = require('../src/db/repo');
});
after(async () => { await mock.close(); });

/* ------------------------------------------------------------------ seed feeds */
test('seed feeds: Bluesky handles in OnlyFans slots are repaired and the creator\'s other accounts get feeds', () => {
  const seed = require('../src/sources/creators-seed.json');
  const feeds = derive.deriveFeeds(seed);
  const key = (f) => `${f.platform}/${f.kind}`;
  const by = feeds.reduce((a, f) => ({ ...a, [key(f)]: (a[key(f)] || 0) + 1 }), {});
  assert.ok(by['coomer/user'] >= 120, 'every creator keeps a Coomer feed');
  assert.ok(by['bluesky/user'] >= 60, 'Bluesky accounts the seed media came from are followed');
  assert.ok(by['gff/user'] >= 30 && by['linkinbio/page'] >= 10 && by['web/page'] >= 5, 'GayForFans, link-in-bio and own-site links get feeds');
  for (const f of feeds) {
    const a = registry.get(f.platform);
    assert.ok(a && a.kinds.includes(f.kind), `${key(f)} has an adapter`);
    if (f.platform === 'coomer') assert.ok(!/\.bsky\.social$/i.test(f.target), `Coomer target is not a Bluesky handle: ${f.target}`);
  }
  // dannybaldwin.bsky.social was the broken Coomer slot: now onlyfans/dannybaldwin + a Bluesky feed
  assert.ok(feeds.some((f) => f.platform === 'coomer' && f.target === 'onlyfans/dannybaldwin'));
  assert.ok(feeds.some((f) => f.platform === 'bluesky' && f.target === 'dannybaldwin.bsky.social'));
  assert.equal(new Set(feeds.map((f) => `${key(f)}|${f.target.toLowerCase()}`)).size, feeds.length, 'no duplicates');
});

test('seedCuratedCreators writes the derived feeds and switches off the old broken Coomer targets', () => {
  const seed = require('../src/sources/creators-seed.json');
  const broken = seed.feeds.find((f) => /\.bsky\.social$/.test(f.target));
  repo.db.prepare("INSERT OR IGNORE INTO creators (id, handle, status, scope, origin) VALUES (?, 'x', 'active', 'in', 'seed')").run(broken.creator_id);
  repo.db.prepare("INSERT INTO feeds (id, platform, kind, target, creator_id, enabled, trusted, origin, interval_min) VALUES ('old-1', 'coomer', 'user', ?, ?, 1, 1, 'seed', 240)").run(broken.target, broken.creator_id);
  engine.seedCuratedCreators(repo.db);
  assert.equal(repo.db.prepare("SELECT enabled FROM feeds WHERE id = 'old-1'").get().enabled, 0, 'broken target switched off');
  const n = repo.db.prepare("SELECT platform, COUNT(*) n FROM feeds WHERE origin = 'seed' AND enabled = 1 GROUP BY platform").all();
  const m = Object.fromEntries(n.map((r) => [r.platform, r.n]));
  assert.ok(m.coomer >= 120 && m.bluesky >= 60 && m.gff >= 30, JSON.stringify(m));
  assert.equal(repo.db.prepare("SELECT COUNT(*) n FROM feeds WHERE next_run_at IS NOT NULL AND origin = 'seed'").get().n, 0, 'seeded feeds are due immediately, not after the 240-minute interval');
});

/* ------------------------------------------------------------------ backfill */
test('Bluesky user feed: first run remembers where it stopped, later runs read older posts', async () => {
  mock.calls.bskyCursors.length = 0;
  const feed = { platform: 'bluesky', kind: 'user', target: 'zed.bsky.social' };
  const first = await registry.get('bluesky').fetch(feed, { limit: 100, cursor: null, aborted: () => false });
  assert.equal(first.items.length, 8, '4 pages of 2 posts');
  assert.ok(first.cursor.bfNext, 'resume point stored');
  const second = await registry.get('bluesky').fetch(feed, { limit: 100, cursor: first.cursor, aborted: () => false });
  const oldest = second.items.filter((i) => /^p([4-9]|1\d)$/.test(i.title));
  assert.ok(oldest.length >= 2, 'older posts came in on the second run');
  assert.ok(second.cursor.bfNext || second.cursor.bfDone, 'backfill progress kept');
});

test('RedGIFs user feed: pages 1-2 on the first run, then older pages on later runs until the list ends', async () => {
  mock.calls.redgifsPages.length = 0;
  const feed = { platform: 'redgifs', kind: 'user', target: 'zed' };
  const a = registry.get('redgifs');
  const first = await a.fetch(feed, { limit: 40, cursor: null, aborted: () => false });
  assert.deepEqual(mock.calls.redgifsPages, [1, 2]);
  assert.equal(first.cursor.bfPage, 3);
  mock.calls.redgifsPages.length = 0;
  const second = await a.fetch(feed, { limit: 40, cursor: first.cursor, aborted: () => false, force: true });
  assert.deepEqual(mock.calls.redgifsPages, [1, 3, 4], 'newest page + 2 older pages');
  assert.equal(second.cursor.bfPage, 5);
  const third = await a.fetch(feed, { limit: 40, cursor: second.cursor, aborted: () => false, force: true });
  const fourth = await a.fetch(feed, { limit: 40, cursor: third.cursor, aborted: () => false, force: true });
  assert.ok(fourth.cursor.bfDone, 'backfill completes at the last page');
});

/* ------------------------------------------------------------------ breakers */
test('host breaker: two 502s from one instance skip that host, not the platform', () => {
  breaker.reset();
  const e502 = Object.assign(new Error('Bad Gateway'), { status: 502 });
  assert.equal(breaker.feedHost({ target: 'gayporn@lemmynsfw.com' }), 'lemmynsfw.com');
  assert.equal(breaker.feedHost({ target: 'https://mastodon.social/@x' }), 'mastodon.social');
  assert.equal(breaker.hostFailure('lemmynsfw.com', e502), false, 'first failure only counts');
  assert.equal(breaker.hostOpenUntil('lemmynsfw.com'), 0);
  assert.equal(breaker.hostFailure('lemmynsfw.com', e502), true, 'second trips');
  assert.ok(breaker.hostOpenUntil('lemmynsfw.com') > Date.now() + 10 * 60 * 1000);
  assert.equal(breaker.canRun('lemmy'), true, 'the lemmy platform breaker stays closed');
  assert.equal(breaker.hostFailure('lemmy.world', Object.assign(new Error('nope'), { status: 404 })), false, 'only gateway errors count');
  breaker.hostSuccess('lemmynsfw.com');
  assert.equal(breaker.hostOpenUntil('lemmynsfw.com'), 0);
});

test('a feed on a tripped host is skipped without a request and rescheduled after the cooldown', async () => {
  breaker.reset();
  const f = repo.feeds.upsert({ platform: 'mastodon', kind: 'tag', target: 'gayporn@down.example', origin: 'admin', trusted: 1, runNow: true }).feed;
  breaker.hostFailure('down.example', Object.assign(new Error('Bad Gateway'), { status: 502 }));
  breaker.hostFailure('down.example', Object.assign(new Error('Bad Gateway'), { status: 502 }));
  const r = await engine.runFeed(f.id, 'schedule');
  assert.equal(r.status, 'skipped');
  const row = repo.feeds.get(f.id);
  assert.ok(new Date(row.next_run_at).getTime() >= breaker.hostOpenUntil('down.example'), 'next run is after the host reopens');
});

/* ------------------------------------------------------------------ brave quota */
test('Brave HTTP 402 is remembered: later queries do not call Brave again', async () => {
  brave._resetQuota();
  mock.calls.brave = 0;
  await assert.rejects(brave.search('q1', { budget: 100 }), /plan limit/);
  assert.equal(mock.calls.brave, 1);
  assert.equal(brave.quotaState().exhausted, true);
  await assert.rejects(brave.search('q2', { budget: 100 }), /plan limit/);
  assert.equal(mock.calls.brave, 1, 'no second HTTP request');
  brave._resetQuota();
});

/* ------------------------------------------------------------------ telegram */
test('Telegram: a channel whose /s/ preview is the plain landing page is explained, not silently empty', async () => {
  await assert.rejects(
    tg.fetch({ platform: 'telegram', kind: 'user', target: 'adultchan' }, { cursor: null, limit: 40, aborted: () => false }),
    (e) => e.status === 404 && /adult channels/.test(e.message) && /TELEGRAM_API_ID/.test(e.message),
  );
});
