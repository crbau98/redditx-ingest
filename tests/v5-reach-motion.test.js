'use strict';
/**
 * v5 reach + motion: homepage/link-hub feeds actually become RSS sources,
 * mention search covers display name + paid slug + one fedi probe, RedGIFs
 * image posts without an hd file are kept, and the public motion/perf pass
 * stays inside the existing guards.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');

const pub = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');

let mock;
let repo;
let engine;
let discovery;
let reddit;
let redgifs;
let webSource;
let registry;

before(async () => {
  mock = await start({
    '/search.json': (req, res, url) => {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (!q.includes('atlas_fit')) return { json: { data: { children: [] } } };
      return { json: { data: { children: [
        { data: { id: 'abc', author: 'gymbro_repost', title: 'pump with @atlas_fit', selftext: 'collab', url: 'https://i.redd.it/a.jpg', subreddit: 'gaybrosgonewild', permalink: '/r/gaybrosgonewild/comments/abc/pump/', over_18: true } },
        { data: { id: 'del', author: '[deleted]', title: 'gone', selftext: '', url: 'https://i.redd.it/b.jpg', over_18: true } },
      ] } } };
    },
    '/api/v2/search': (req, res, url) => {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (!q.includes('atlas_fit')) return { json: { accounts: [] } };
      return { json: { accounts: [
        { username: 'atlas_fit', acct: 'atlas_fit', display_name: 'Atlas Fit', note: '<p>Gay muscle 18+ · onlyfans.com/atlas_fit</p>', followers_count: 900, avatar: 'https://cdn.example/a.png' },
        { username: 'plainfan', acct: 'plainfan', display_name: 'Plain Fan', note: '<p>just passing through</p>', followers_count: 2 },
      ] } };
    },
    '/api/users/search-by-username': (req) => {
      let body = {};
      try { body = JSON.parse(req.bodyText || '{}'); } catch { /* ignore */ }
      if (!String(body.query || '').toLowerCase().includes('atlas_fit')) return { json: [] };
      return { json: [
        { id: 'm1', username: 'atlas_fit', host: 'misskey.io', name: 'Atlas Fit', description: 'Gay fitness 18+', avatarUrl: null, followersCount: 40 },
        { id: 'm2', username: 'plainfan', host: 'misskey.io', name: 'Plain', description: 'hello', avatarUrl: null, followersCount: 1 },
      ] };
    },
    '/hub': () => ({
      headers: { 'content-type': 'text/html' },
      body: `<html><head><title>Marco</title>
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
        <link rel="alternate" type="application/atom+xml" title="Comments" href="/comments/feed.xml">
        </head><body><a href="https://x.com/marco_swim">x</a></body></html>`,
    }),
  });
  const host = `127.0.0.1:${mock.port}`;
  prepareEnv({
    REDDIT_BASE_URL: mock.url,
    MASTODON_INSTANCES: host,
    MISSKEY_INSTANCES: host,
    SEARCH_PROVIDERS: '',
    AGE_GATE_ENFORCE: 'true',
    ALLOW_PRIVATE_HOSTS: 'true',
  });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  discovery = require('../src/engine/discovery');
  reddit = require('../src/sources/reddit');
  redgifs = require('../src/sources/redgifs');
  webSource = require('../src/sources/web');
  registry = require('../src/sources');
});

after(async () => { await mock.close(); });

describe('public feeds discovered on homepages and link hubs', () => {
  test('a link hub returns every alternate feed, and the engine enqueues the non-comment ones', async () => {
    const res = await webSource.linkInBioAdapter.fetch({ platform: 'linkinbio', kind: 'page', target: `${mock.url}/hub` });
    assert.equal(res.feeds.length, 2);
    assert.ok(res.discoveredFeeds.some((f) => f.platform === 'rss' && f.kind === 'feed' && f.target.endsWith('/feed.xml')));
    assert.ok(res.discoveredFeeds.some((f) => f.target.endsWith('/comments/feed.xml')));
    const parent = repo.feeds.upsert({ platform: 'linkinbio', kind: 'page', target: `${mock.url}/hub`, origin: 'admin' }).feed;
    const adopted = engine.adoptDiscoveredFeeds(res, parent, { autoLinkProfiles: false });
    assert.equal(adopted.created, 1);
    const kept = repo.feeds.find('rss', 'feed', `${mock.url}/feed.xml`);
    assert.ok(kept, 'public feed was created');
    assert.equal(kept.origin, 'discovered');
    assert.equal(kept.creator_id, null);
    assert.equal(kept.trusted, 0);
    assert.equal(repo.feeds.find('rss', 'feed', `${mock.url}/comments/feed.xml`), null);
  });

  test('creator homepages link at most three feeds, and only takedowns stay out', () => {
    const creator = repo.creators.create({ handle: 'marco_swim', displayName: 'Marco Swim', origin: 'admin' });
    const parent = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://marco.example/', creatorId: creator.id, origin: 'admin' }).feed;
    repo.takedowns.add({ kind: 'domain', value: 'gone.example', reason: 'creator asked' });
    const adopted = engine.adoptDiscoveredFeeds({
      discoveredFeeds: [
        { platform: 'rss', kind: 'feed', target: 'https://marco.example/feed.xml' },
        { platform: 'rss', kind: 'feed', target: 'https://marco.example/feed.xml' },
        { platform: 'rss', kind: 'feed', target: 'https://marco.example/comments/feed.xml' },
        { platform: 'rss', kind: 'feed', target: 'https://gone.example/feed.xml' },
        { platform: 'rss', kind: 'feed', target: 'https://onlyfans.com/marco_swim/feed.xml' },
        { platform: 'rss', kind: 'feed', target: 'https://coomer.su/feed.xml' },
        { platform: 'rss', kind: 'feed', target: 'https://marco.example/atom.xml' },
      ],
      discoveredFeed: { platform: 'rss', kind: 'feed', target: 'https://marco.example/feed.xml' },
    }, parent, { autoLinkProfiles: true });
    assert.equal(adopted.created, 3, 'comment feeds and takedowns are skipped, paid / mirror feeds are allowed, at most three are created');
    const first = repo.feeds.find('rss', 'feed', 'https://marco.example/feed.xml');
    assert.equal(first.creator_id, creator.id);
    assert.equal(first.trusted, 1);
    assert.ok(repo.feeds.find('rss', 'feed', 'https://onlyfans.com/marco_swim/feed.xml'), 'a paid creator page feed is allowed now');
    assert.ok(repo.feeds.find('rss', 'feed', 'https://coomer.su/feed.xml'), 'a mirror feed is allowed now');
    assert.equal(repo.feeds.find('rss', 'feed', 'https://gone.example/feed.xml'), null, 'takedown feed stays out');
    assert.equal(repo.feeds.find('rss', 'feed', 'https://marco.example/atom.xml'), null, 'fourth public feed waits');
    assert.equal(engine.adoptDiscoveredFeeds({ optedOut: true, discoveredFeeds: [{ platform: 'rss', kind: 'feed', target: 'https://marco.example/nope.xml' }] }, parent).created, 0);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'engine.js'), 'utf8');
    assert.match(src, /enqueue\(ids, \{ trigger: 'discovered-feed'/);
  });
});

describe('mention search stays on a budget and off the paywall', () => {
  test('the web query names handle, display name and paid slug, and is not a URL to fetch', () => {
    const q = discovery.mentionSearchQuery({ handle: 'atlas_fit', displayName: 'Atlas Fit', service: 'Fansly' });
    assert.match(q, /fansly\.com\/atlas_fit/);
    assert.match(q, /@atlas_fit/);
    assert.match(q, /"Atlas Fit"/);
    assert.match(q, /site:youtube\.com/);
    assert.match(q, /site:pixelfed\.social/);
    assert.match(q, /site:mastodon\.social/);
    assert.doesNotMatch(q, /^https?:\/\//);
    const same = discovery.mentionSearchQuery({ handle: 'atlas_fit', displayName: 'atlas_fit', service: 'OnlyFans' });
    assert.doesNotMatch(same, /OR "atlas_fit"/);
    assert.match(same, /onlyfans\.com\/atlas_fit/);
  });

  test('reddit post search returns authors and drops deleted accounts', async () => {
    const posts = await reddit.searchPosts('"onlyfans.com/atlas_fit" OR "atlas_fit"', 10);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].author, 'gymbro_repost');
    assert.equal(posts[0].subreddit, 'gaybrosgonewild');
  });

  test('one mastodon search and one misskey search queue the matching creator and skip a plain fan', async () => {
    const tally = await discovery.probeFediMentions({ handle: 'atlas_fit', displayName: 'Atlas Fit', service: 'OnlyFans' }, null, () => false);
    assert.ok(tally.found >= 2, JSON.stringify(tally));
    assert.ok(repo.candidates.find('mastodon', 'user', 'atlas_fit@127.0.0.1'));
    assert.equal(repo.candidates.find('mastodon', 'user', 'plainfan@127.0.0.1'), null);
    assert.ok(repo.candidates.find('misskey', 'user', 'atlas_fit@misskey.io'));
    assert.equal(repo.candidates.find('misskey', 'user', 'plainfan@misskey.io'), null);
  });
});

describe('redgifs keeps in-scope image posts and profile links', () => {
  test('an image with only urls.gif is ingested; a video with only a poster is not', () => {
    const img = redgifs.itemFromGif({ id: 'img1', type: 2, userName: 'atlas', tags: ['gay', 'muscle'], urls: { gif: 'https://media.redgifs.com/img1.gif' } }, null);
    assert.equal(img.mediaType, 'image');
    assert.equal(img.mediaUrl, 'https://media.redgifs.com/img1.gif');
    const vid = redgifs.itemFromGif({ id: 'vid1', type: 1, userName: 'atlas', tags: ['gay'], urls: { poster: 'https://media.redgifs.com/vid1.jpg' } }, null);
    assert.equal(vid, null);
  });

  test('profile links include a paid page as a link record', () => {
    const profile = redgifs.profileFromUser({
      username: 'atlas_fit',
      name: 'Atlas Fit',
      description: 'Gay bodybuilder 18+',
      profileUrl: 'https://onlyfans.com/atlas_fit',
      links: [{ url: 'https://x.com/atlas_fit' }],
    });
    assert.equal(profile.displayName, 'Atlas Fit');
    assert.ok(profile.links.some((l) => l.external && l.service === 'OnlyFans' && l.handle === 'atlas_fit'));
    assert.ok(profile.links.some((l) => l.platform === 'x' && l.target === 'atlas_fit'));
  });
});

describe('seed version 9 uses real adapter kinds', () => {
  test('every seed is a kind its adapter implements, and none point at a paywalled host', () => {
    assert.equal(registry.SEED_VERSION, 9);
    const targets = new Set(registry.SEEDS.map((s) => `${s.platform}:${s.kind}:${s.target}`));
    for (const t of [
      'lemmy:community:gayvideos@lemmynsfw.com',
      'lemmy:community:gaylockerroom@lemmynsfw.com',
      'lemmy:community:gayrimming@lemmynsfw.com',
      'lemmy:community:gayanal@lemmynsfw.com',
      'misskey:tag:gaynsfw',
      'peertube:search:gay hunk',
      'x:search:gay hunk',
    ]) assert.ok(targets.has(t), t);
    for (const s of registry.SEEDS) {
      const adapter = registry.get(s.platform);
      assert.ok(adapter && adapter.kinds.includes(s.kind), `${s.platform}/${s.kind}/${s.target}`);
      assert.doesNotMatch(String(s.target), /onlyfans\.com|fansly\.com|justfor\.fans|patreon\.com|loyalfans\.com|manyvids\.com/i);
    }
  });
});

describe('motion and perf pass stays inside the existing language', () => {
  const css = read('css', 'app.css');
  const masonry = read('js', 'components', 'masonry.js');
  const main = read('js', 'main.js');
  const card = read('js', 'components', 'card.js');

  test('masonry parks far cards, restores them, and staggers only a capped first paint', () => {
    assert.match(masonry, /WINDOW_PX = 3600/);
    assert.match(masonry, /card-parked/);
    assert.match(masonry, /STAGGER_CAP = 8/);
    assert.match(masonry, /prefers-reduced-motion: reduce/);
    assert.match(masonry, /saveData/);
    assert.match(masonry, /return colWidth \* r;/);
    assert.match(card, /decoding: 'async'/);
    assert.match(card, /fetchpriority: eager \? 'high' : 'auto'/);
    assert.match(main, /sharedMotionBusy/);
    assert.match(main, /routeMotionExit/);
    assert.match(main, /prefers-reduced-motion: reduce/);
  });

  test('new animations are opacity and transform, with no :has() and no new card blur', () => {
    const body = css.match(/@keyframes card-arrive \{([^}]*)\}/)[1];
    assert.match(body, /opacity/);
    assert.match(body, /transform/);
    assert.doesNotMatch(body.replace(/transform|opacity/g, ''), /[a-z-]+\s*:/);
    assert.match(css, /\.card-arrive \{ animation: card-arrive var\(--dur-base\) var\(--spring-glide\) both/);
    assert.match(css, /\.view-enter \{ animation: viewIn var\(--dur-base\) var\(--spring-glide\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.card-arrive, \.view-enter \{ animation: none/);
    assert.doesNotMatch(css, /:has\(/);
    assert.doesNotMatch(css.match(/\.card-parked \{[^}]*\}/)[0], /backdrop-filter/);
    assert.doesNotMatch(css.match(/\.filterbar::before \{[^}]*\}/)[0], /backdrop-filter/);
  });
});
