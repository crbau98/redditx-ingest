'use strict';
/**
 * Comprehensive tests for:
 * 1. First-class Creator Takedown & Opt-Out Honoring (src/lib/takedowns.js, DB v12, repo, pipeline, web.js, API routes)
 * 2. Expanded Image, Video & Creator Mention Search across Brave, DDG, X, Reddit, Bluesky, RedGIFs (src/lib/brave.js, discovery.js, lookup.js, pipeline.js)
 * 3. Expanded Link-in-Bio & Public Web Scraping Capabilities (src/lib/links.js, src/sources/web.js, JSON-LD, __NEXT_DATA__, <picture>, RSS/Atom alternate links)
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock;
let repo;
let pipeline;
let discovery;
let lookup;
let takedowns;
let brave;
let webSource;
let links;
let server;
let base;

const AGE = { cookie: 'prism_age=1' };
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };

before(async () => {
  mock = await start({
    '/v2/auth/temporary': () => ({ json: { token: 'rg-test-token' } }),
    '/v2/gifs/search': (req, res, url) => {
      const q = (url.searchParams.get('search_text') || '').toLowerCase();
      if (q.includes('atlas_fit')) {
        return {
          json: {
            gifs: [
              {
                id: 'rgcollab1',
                userName: 'collab_partner',
                tags: ['gay', 'muscle', 'hunk'],
                description: 'Gym session with @atlas_fit 🔥 onlyfans.com/atlas_fit',
                urls: { hd: 'https://media.redgifs.com/RgCollab1.mp4', poster: 'https://media.redgifs.com/RgCollab1.jpg' },
                duration: 18,
                width: 1080,
                height: 1920,
              },
            ],
            users: [
              { username: 'collab_partner', name: 'Collab Partner', description: 'Gay fitness collabs 18+ w/ @atlas_fit', followers: 5200, gifs: 35 },
            ],
          },
        };
      }
      return { json: { gifs: [], users: [] } };
    },
    '/v2/users/atlas_fit': () => ({
      json: {
        user: {
          username: 'atlas_fit',
          name: 'Atlas Fit',
          description: 'Gay bodybuilder 18+ · https://onlyfans.com/atlas_fit',
          followers: 14000,
          gifs: 45,
        },
      },
    }),
    '/search.json': (req, res, url) => {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (q.includes('atlas_fit')) {
        return {
          json: {
            data: {
              children: [
                {
                  data: {
                    id: 'rdmention1',
                    author: 'gymbro_repost',
                    subreddit: 'gaybrosgonewild',
                    title: 'Workout pump ft @atlas_fit (onlyfans.com/atlas_fit)',
                    selftext: 'Collab with u/atlas_fit',
                    url: 'https://i.redd.it/rdmention1.jpg',
                    permalink: '/r/gaybrosgonewild/comments/rdmention1/workout/',
                    over_18: true,
                    created_utc: 1760000000,
                  },
                },
              ],
            },
          },
        };
      }
      return { json: { data: { children: [] } } };
    },
    '/user/atlas_fit/about.json': () => ({
      json: {
        data: {
          name: 'atlas_fit',
          subreddit: {
            title: 'Atlas Fit',
            public_description: 'Gay muscle athlete 18+ · onlyfans.com/atlas_fit',
            over_18: true,
          },
          total_karma: 9500,
        },
      },
    }),
    '/xrpc/app.bsky.actor.searchActors': () => ({ json: { actors: [] } }),
    '/xrpc/app.bsky.actor.getProfiles': () => ({ json: { profiles: [] } }),
    '/xrpc/app.bsky.feed.searchPosts': (req, res, url) => {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (q.includes('atlas_fit')) {
        return {
          json: {
            posts: [
              {
                uri: 'at://did:plc:bskycollab/app.bsky.feed.post/3kcollab',
                cid: 'cid1',
                author: {
                  did: 'did:plc:bskycollab',
                  handle: 'bskycollab.bsky.social',
                  displayName: 'Bsky Collab',
                  description: 'Gay photographer 18+',
                },
                record: {
                  text: 'New shoot with @atlas_fit! Check out https://onlyfans.com/atlas_fit #gay #muscle',
                  createdAt: '2026-10-10T12:00:00Z',
                },
              },
            ],
          },
        };
      }
      return { json: { posts: [] } };
    },
    // Brave Web, Image, and Video Search endpoints
    '/res/v1/web/search': (req, res, url) => {
      const q = url.searchParams.get('q') || '';
      return {
        json: {
          web: {
            results: [
              {
                url: 'https://x.com/atlas_fit',
                title: 'Atlas Fit (@atlas_fit) / X',
                description: 'Gay athlete 18+ · onlyfans.com/atlas_fit',
              },
              {
                url: 'https://bento.me/atlas_fit',
                title: 'Atlas Fit on Bento',
                description: 'All my official links and workouts',
              },
              {
                url: 'https://coomer.su/onlyfans/user/atlas_fit',
                title: 'Leaked archive',
                description: 'onlyfans leak',
              },
              {
                url: 'https://onlyfans.com/atlas_fit',
                title: 'OnlyFans direct',
                description: 'paywalled page',
              },
            ],
          },
          query: { original: q },
        },
      };
    },
    '/res/v1/images/search': () => ({
      json: {
        results: [
          {
            title: 'Atlas Fitposing on X',
            url: 'https://x.com/atlas_fit/status/18000000001',
            source: 'x.com',
            properties: { url: 'https://pbs.twimg.com/media/AtlasImg1.jpg', width: 1080, height: 1350 },
            thumbnail: { src: 'https://pbs.twimg.com/media/AtlasImg1_thumb.jpg', width: 300, height: 375 },
          },
          {
            title: 'Leaked image on fapello',
            url: 'https://fapello.com/atlas_fit/1/',
            properties: { url: 'https://fapello.com/content/a/t/atlas_fit/1000/atlas_fit_0001.jpg' },
          },
          {
            title: 'Paywalled image on OnlyFans',
            url: 'https://onlyfans.com/atlas_fit',
            properties: { url: 'https://public.onlyfans.com/files/x/y/z.jpg' },
          },
        ],
      },
    }),
    '/res/v1/videos/search': () => ({
      json: {
        results: [
          {
            title: 'Atlas Fit Workout Clip on RedGIFs',
            url: 'https://www.redgifs.com/watch/atlasworkout1',
            description: 'Male fitness motivation with @atlas_fit',
            video: { duration: '00:24', views: 12400, publisher: 'RedGIFs' },
            thumbnail: { src: 'https://thumbs4.redgifs.com/atlasworkout1-mobile.jpg' },
          },
          {
            title: 'Leak video on thothub',
            url: 'https://thothub.to/videos/1234/atlas-fit-leaked/',
            description: 'leaked onlyfans video',
            thumbnail: { src: 'https://thothub.to/thumb.jpg' },
          },
        ],
      },
    }),
    // DuckDuckGo HTML fallback endpoint
    '/html/': () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `
        <html><body>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://x.com/ddg_athlete')}">DDG Athlete (@ddg_athlete) on X</a>
            <a class="result__snippet">Gay swimmer 18+ · fansly.com/ddg_athlete</a>
          </div>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://bunkr.si/a/leakedpack')}">Leaked bunker</a>
            <a class="result__snippet">Full OF leak pack</a>
          </div>
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://fansly.com/ddg_athlete')}">Fansly page</a>
            <a class="result__snippet">Direct paywall link</a>
          </div>
        </body></html>
      `,
    }),
    // Web pages for opt-out / tombstone / link-hub / rich media tests
    '/page-noindex': () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `
        <html><head>
          <meta name="robots" content="index, noimageindex">
          <meta property="og:image" content="https://cdn.example.com/should-not-scrape.jpg">
        </head><body><img src="https://cdn.example.com/should-not-scrape2.jpg"></body></html>
      `,
    }),
    '/page-header-optout': () => ({
      status: 200,
      headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex, nofollow' },
      body: `
        <html><head><meta property="og:image" content="https://cdn.example.com/blocked-by-header.jpg"></head>
        <body><img src="https://cdn.example.com/blocked-by-header.jpg"></body></html>
      `,
    }),
    '/page-451': () => ({
      status: 451,
      headers: { 'content-type': 'text/html' },
      body: `<html><body>Unavailable For Legal Reasons</body></html>`,
    }),
    '/page-dmca': () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `
        <html><head><title>Post Removed</title>
        <meta property="og:image" content="https://cdn.example.com/dmca-residual.jpg"></head>
        <body><p>This media has been removed in response to a DMCA takedown notice by the copyright owner.</p></body></html>
      `,
    }),
    '/page-rich': () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `
        <html>
        <head>
          <title>Marco Swim Portfolio</title>
          <meta property="og:description" content="Male physique swimmer portfolio 18+">
          <meta property="og:image" content="https://cdn.example.com/marco-og-1.jpg">
          <meta property="og:image:secure_url" content="https://cdn.example.com/marco-og-2.jpg">
          <meta property="og:video:secure_url" content="https://cdn.example.com/marco-reel.mp4">
          <link rel="alternate" type="application/rss+xml" title="Marco RSS" href="/marco/feed.xml">
          <link rel="alternate" type="application/atom+xml" title="Marco Atom" href="/marco/atom.xml">
          <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Person",
                "name": "Marco Swim",
                "sameAs": [
                  "https://x.com/marcoswim",
                  "https://bsky.app/profile/marcoswim.bsky.social",
                  "https://onlyfans.com/marcoswim"
                ]
              },
              {
                "@type": "VideoObject",
                "name": "Poolside Session",
                "contentUrl": "https://cdn.example.com/marco-jsonld-video.mp4",
                "thumbnailUrl": "https://cdn.example.com/marco-jsonld-thumb.jpg",
                "duration": "PT45S"
              },
              {
                "@type": "SocialMediaPosting",
                "headline": "Morning laps",
                "image": {
                  "@type": "ImageObject",
                  "contentUrl": "https://cdn.example.com/marco-jsonld-image.jpg",
                  "width": 1200,
                  "height": 1600
                }
              }
            ]
          }
          </script>
        </head>
        <body>
          <picture>
            <source srcset="https://cdn.example.com/marco-pic-640.jpg 640w, https://cdn.example.com/marco-pic-1440.jpg 1440w" type="image/jpeg">
            <img src="https://cdn.example.com/marco-pic-640.jpg" alt="Marco poolside">
          </picture>
        </body>
        </html>
      `,
    }),
    '/linkhub-nextdata': () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `
        <html>
        <head>
          <title>@kyle_flex | Linktree</title>
          <meta property="og:description" content="Gay fitness creator 18+">
        </head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "account": {
                  "username": "kyle_flex",
                  "pageTitle": "Kyle Flex",
                  "description": "Gay muscle model 18+",
                  "profilePictureUrl": "https://cdn.example.com/kyle-avatar.jpg",
                  "links": [
                    { "id": "1", "title": "My VIP Page (Free trial)", "url": "https://onlyfans.com/kyle_flex" },
                    { "id": "2", "title": "Fansly Backup", "url": "https://fansly.com/kyle_flex" },
                    { "id": "3", "title": "Twitter / X", "url": "https://x.com/kyle_flex" },
                    { "id": "4", "title": "RedGIFs Clips", "url": "https://www.redgifs.com/users/kyle_flex" },
                    { "id": "5", "title": "Bluesky", "url": "https://bsky.app/profile/kyleflex.bsky.social" },
                    { "id": "6", "title": "Leak site should be ignored", "url": "https://coomer.su/onlyfans/user/kyle_flex" }
                  ]
                }
              }
            }
          }
          </script>
        </body>
        </html>
      `,
    }),
  });

  prepareEnv({
    BSKY_BASE_URL: mock.url,
    REDGIFS_BASE_URL: mock.url,
    REDDIT_BASE_URL: mock.url,
    BRAVE_BASE_URL: `${mock.url}/res/v1`,
    BRAVE_SEARCH_KEY: 'test-brave-key',
    DDG_HTML_URL: `${mock.url}/html/`,
    SEARXNG_URL: '',
    SEARCH_PROVIDERS: 'brave',
    AGE_GATE_ENFORCE: 'true',
  });

  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  discovery = require('../src/engine/discovery');
  lookup = require('../src/engine/lookup');
  takedowns = require('../src/lib/takedowns');
  brave = require('../src/lib/brave');
  webSource = require('../src/sources/web');
  links = require('../src/lib/links');

  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  if (mock) await mock.close();
});

// ============================================================================
// 1. First-class Creator Takedown & Opt-Out Honoring
// ============================================================================
describe('1. Creator Takedowns & Opt-Out Honoring', () => {
  test('checkHtmlOptOut detects robots noindex/noimageindex, pinterest nopin, X-Robots-Tag, HTTP 451, and DMCA/creator tombstones', () => {
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<meta name="robots" content="index, noimageindex">', {}, 200),
      { optedOut: true, reason: 'meta-robots:noimageindex' },
    );
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<meta content="noindex" name="googlebot">', {}, 200),
      { optedOut: true, reason: 'meta-robots:noindex' },
    );
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<meta name="pinterest" content="nopin">', {}, 200),
      { optedOut: true, reason: 'meta-pinterest:nopin' },
    );
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<html></html>', { 'x-robots-tag': 'none' }, 200),
      { optedOut: true, reason: 'x-robots-tag:none' },
    );
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<html></html>', {}, 451),
      { optedOut: true, reason: 'http-451-legal' },
    );
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<p>This image was removed in response to a DMCA notice.</p>', {}, 200),
      { optedOut: true, reason: 'tombstone:dmca' },
    );
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<p>Content removed at the request of the creator.</p>', {}, 200),
      { optedOut: true, reason: 'tombstone:creator-request' },
    );
    assert.deepEqual(
      takedowns.checkHtmlOptOut('<html><body>Normal male model portfolio</body></html>', {}, 200),
      { optedOut: false, reason: null },
    );
  });

  test('webAdapter and linkInBioAdapter skip pages with meta opt-outs, X-Robots-Tag, HTTP 451, or DMCA tombstones', async () => {
    for (const path of ['/page-noindex', '/page-header-optout', '/page-451', '/page-dmca']) {
      const feed = { id: `f-${path}`, platform: 'web', kind: 'page', target: `${mock.url}${path}` };
      const res = await webSource.webAdapter.fetch(feed);
      assert.equal(res.items.length, 0, `Expected 0 items from ${path}, got ${res.items.length}`);
      assert.ok(res.optedOut, `Expected optedOut reason on ${path}`);
    }
    const bioRes = await webSource.linkInBioAdapter.fetch({
      id: 'bio-optout',
      platform: 'linkinbio',
      kind: 'page',
      target: `${mock.url}/page-noindex`,
    });
    assert.equal(bioRes.items.length, 0);
    assert.equal(bioRes.discovered.length, 0);
    assert.ok(bioRes.optedOut);
  });

  test('adding a takedown retroactively purges media, disables feeds, blocks creator, and drops future pipeline items', async () => {
    const creator = repo.creators.create({
      handle: 'optout_creator',
      displayName: 'OptOut Creator',
      bio: 'Gay fitness 18+ · onlyfans.com/optout_creator',
    });
    const innocentCreator = repo.creators.create({
      handle: 'optout_creator_2',
      displayName: 'Innocent Creator',
      bio: 'Gay fitness 18+',
      links: [{ platform: 'OnlyFans', handle: 'optout_creator_2', url: 'https://onlyfans.com/optout_creator_2' }],
    });
    const feed = repo.feeds.upsert({
      platform: 'x',
      kind: 'user',
      target: 'optout_creator',
      creatorId: creator.id,
      enabled: 1,
      trusted: 1,
    }).feed;

    const mediaId = repo.media.insert({
      creator_id: creator.id,
      feed_id: feed.id,
      platform: 'x',
      source_id: 'td-post-1',
      source_key: 'x:td-post-1:0',
      post_key: 'x:td-post-1',
      source_url: 'https://x.com/optout_creator/status/111',
      author: 'optout_creator',
      title: 'Gym selfie',
      media_type: 'image',
      media_url: 'https://pbs.twimg.com/media/optout1.jpg',
      hash: 'td-hash-1',
      scope: 'in',
      publish_state: 'published',
      posted_at: new Date().toISOString(),
    }, ['gay', 'gym']);

    assert.equal(repo.media.get(mediaId).publish_state, 'published');

    // Create takedown via POST /api/admin/takedowns
    const postRes = await fetch(`${base}/api/admin/takedowns`, {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ kind: 'handle', value: '@OptOut_Creator', reason: 'Creator requested opt-out' }),
    });
    assert.equal(postRes.status, 201);
    const postJson = await postRes.json();
    assert.equal(postJson.ok, true);
    assert.equal(postJson.takedown.kind, 'handle');
    assert.equal(postJson.takedown.value, 'optout_creator');
    assert.ok(postJson.purged >= 1, `Expected purged >= 1, got ${postJson.purged}`);

    // Verify retroactive purge & feed/creator state
    assert.equal(repo.media.get(mediaId).publish_state, 'removed');
    assert.equal(repo.media.get(mediaId).review_reason, 'takedown');
    assert.equal(repo.feeds.get(feed.id).enabled, 0);
    assert.equal(repo.creators.get(creator.id).status, 'blocked');
    assert.equal(repo.creators.get(innocentCreator.id).status, 'active', 'Prefix-similar creator links must not be collateral-blocked');
    assert.ok(repo.blocklist.has('hash', 'td-hash-1'));

    // Verify prospective pipeline drop with reason: 'takedown'
    const openFeed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1 }).feed;
    const droppedByAuthor = await pipeline.processItem(
      {
        sourceId: 'td-future-1',
        author: 'optout_creator',
        title: 'Repost of optout_creator',
        mediaType: 'image',
        mediaUrl: 'https://i.redd.it/future-optout.jpg',
        trusted: true,
      },
      openFeed,
      null,
      { probeUnknownHosts: false, hostReachability: false, imageFilter: false, dedupe: false },
    );
    assert.equal(droppedByAuthor.outcome, 'blocked');
    assert.equal(droppedByAuthor.reason, 'takedown');

    // Also dropped when someone else mentions their paid handle in description or links (with empty title)
    const droppedByPaidMention = await pipeline.processItem(
      {
        sourceId: 'td-future-2',
        author: 'some_reposter',
        title: '',
        description: 'Check out onlyfans.com/optout_creator hot pics',
        mediaType: 'image',
        mediaUrl: 'https://i.redd.it/future-optout2.jpg',
        trusted: true,
      },
      openFeed,
      null,
      { probeUnknownHosts: false, hostReachability: false, imageFilter: false, dedupe: false },
    );
    assert.equal(droppedByPaidMention.outcome, 'blocked');
    assert.equal(droppedByPaidMention.reason, 'takedown');

    // Verify GET /api/admin/takedowns and DELETE /api/admin/takedowns/:id
    const listRes = await fetch(`${base}/api/admin/takedowns`, { headers: ADMIN });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.ok(listJson.items.some((t) => t.id === postJson.takedown.id));

    // Domain takedown test
    const domTd = repo.takedowns.add({ kind: 'domain', value: 'https://NoScrapeStudio.com/gallery', reason: 'studio opt-out' });
    assert.equal(domTd.takedown.value, 'noscrapestudio.com');
    const droppedByDomain = await pipeline.processItem(
      {
        sourceId: 'td-dom-1',
        author: 'random_guy',
        title: 'Hot male model',
        permalink: 'https://sub.noscrapestudio.com/post/99',
        mediaType: 'image',
        mediaUrl: 'https://cdn.noscrapestudio.com/img1.jpg',
        trusted: true,
      },
      openFeed,
      null,
      { probeUnknownHosts: false, hostReachability: false, imageFilter: false, dedupe: false },
    );
    assert.equal(droppedByDomain.outcome, 'blocked');
    assert.equal(droppedByDomain.reason, 'takedown');

    const delRes = await fetch(`${base}/api/admin/takedowns/${domTd.takedown.id}`, { method: 'DELETE', headers: ADMIN });
    assert.equal(delRes.status, 200);
    assert.equal(repo.takedowns.get(domTd.takedown.id), null);
  });
});

// ============================================================================
// 2. Expanded Link-in-Bio & Public Web Scraping Capabilities
// ============================================================================
describe('2. Link-in-Bio & Rich Public Web Scraping', () => {
  test('links.js recognizes all modern link hubs and extracts handles', () => {
    const hubs = [
      ['https://linktr.ee/marco_fit', 'marco_fit'],
      ['https://beacons.ai/marco_fit', 'marco_fit'],
      ['https://allmylinks.com/marco_fit', 'marco_fit'],
      ['https://marcofit.carrd.co', 'marcofit'],
      ['https://campsite.bio/marco_fit', 'marco_fit'],
      ['https://solo.to/marco_fit', 'marco_fit'],
      ['https://bento.me/marco_fit', 'marco_fit'],
      ['https://direct.me/marco_fit', 'marco_fit'],
      ['https://milkshake.app/marco_fit', 'marco_fit'],
      ['https://hoo.be/marco_fit', 'marco_fit'],
      ['https://snipfeed.co/marco_fit', 'marco_fit'],
      ['https://lnk.bio/marco_fit', 'marco_fit'],
      ['https://taplink.cc/marco_fit', 'marco_fit'],
    ];
    for (const [url, expectedHandle] of hubs) {
      assert.equal(links.isLinkHubUrl(url), true, `Expected isLinkHubUrl(${url}) to be true`);
      assert.equal(links.linkHubHandle(url), expectedHandle, `Expected handle ${expectedHandle} for ${url}`);
      const parsed = links.parseProfile(url);
      assert.ok(parsed && parsed.platform === 'linkinbio' && parsed.kind === 'page', `Expected linkinbio profile for ${url}`);
    }
  });

  test('linkInBioAdapter extracts outbound social & paid links from __NEXT_DATA__ hydration JSON while dropping leak hosts', async () => {
    const res = await webSource.linkInBioAdapter.fetch({
      id: 'bio-nextdata',
      platform: 'linkinbio',
      kind: 'page',
      target: `${mock.url}/linkhub-nextdata`,
    });
    assert.ok(res.profile);
    const urls = res.discovered.map((d) => d.url);
    assert.ok(urls.some((u) => u === 'https://onlyfans.com/kyle_flex'), 'Extracts OnlyFans link from __NEXT_DATA__');
    assert.ok(urls.some((u) => u === 'https://fansly.com/kyle_flex'), 'Extracts Fansly link from __NEXT_DATA__');
    assert.ok(urls.some((u) => u === 'https://x.com/kyle_flex'), 'Extracts X link from __NEXT_DATA__');
    assert.ok(urls.some((u) => u === 'https://www.redgifs.com/users/kyle_flex'), 'Extracts RedGIFs link from __NEXT_DATA__');
    assert.ok(urls.some((u) => u === 'https://bsky.app/profile/kyleflex.bsky.social'), 'Extracts Bluesky link from __NEXT_DATA__');
    assert.ok(!urls.some((u) => /coomer\.su/i.test(u)), 'Drops leak host from __NEXT_DATA__ links');
  });

  test('extractPage extracts JSON-LD VideoObject/ImageObject/SocialMediaPosting/sameAs, <picture><source srcset>, multiple og:image/og:video, and RSS/Atom alternate feeds', async () => {
    const res = await webSource.webAdapter.fetch({
      id: 'web-rich',
      platform: 'web',
      kind: 'page',
      target: `${mock.url}/page-rich`,
    });
    const mediaUrls = res.items.map((i) => i.mediaUrl);
    // Multiple og:image + og:video:secure_url
    assert.ok(mediaUrls.includes('https://cdn.example.com/marco-og-1.jpg'));
    assert.ok(mediaUrls.includes('https://cdn.example.com/marco-og-2.jpg'));
    assert.ok(mediaUrls.includes('https://cdn.example.com/marco-reel.mp4'));
    // JSON-LD VideoObject & SocialMediaPosting ImageObject
    assert.ok(mediaUrls.includes('https://cdn.example.com/marco-jsonld-video.mp4'));
    assert.ok(mediaUrls.includes('https://cdn.example.com/marco-jsonld-image.jpg'));
    // <picture><source srcset> picks the highest-w candidate (1440w)
    assert.ok(mediaUrls.includes('https://cdn.example.com/marco-pic-1440.jpg'));

    // JSON-LD sameAs links discovered
    const discUrls = (res.discovered || []).map((d) => d.url);
    assert.ok(discUrls.includes('https://x.com/marcoswim'));
    assert.ok(discUrls.includes('https://bsky.app/profile/marcoswim.bsky.social'));
    assert.ok(discUrls.includes('https://onlyfans.com/marcoswim'));

    // RSS/Atom <link rel="alternate"> discovered
    assert.equal(res.feedUrl, `${mock.url}/marco/feed.xml`);
    assert.ok(Array.isArray(res.feeds) && res.feeds.length === 2);
  });
});

// ============================================================================
// 3. Brave Images/Videos, DDG Fallback & Creator Mention Search / Attribution
// ============================================================================
describe('3. Brave Images/Videos, DDG Fallback & Creator Mention Search', () => {
  test('brave.web, brave.images, and brave.videos keep paid / mirror results and filter only junk', async () => {
    const webRes = await brave.web('atlas_fit', { count: 10 });
    assert.ok(webRes.some((r) => r.url === 'https://x.com/atlas_fit'));
    assert.ok(webRes.some((r) => /coomer\.su/i.test(r.url)), 'Mirror hosts come back now');
    assert.ok(webRes.some((r) => /onlyfans\.com/i.test(r.url)), 'Paid pages come back now');

    const imgRes = await brave.images('atlas_fit', { count: 10 });
    assert.equal(imgRes.length, 3);
    assert.equal(imgRes[0].mediaUrl, 'https://pbs.twimg.com/media/AtlasImg1.jpg');
    assert.equal(imgRes[0].mediaType, 'image');
    assert.ok(imgRes.some((r) => /fapello/.test(r.mediaUrl)), 'Mirror-hosted images come back now');

    const vidRes = await brave.videos('atlas_fit', { count: 10 });
    assert.equal(vidRes.length, 2);
    assert.equal(vidRes[0].pageUrl, 'https://www.redgifs.com/watch/atlasworkout1');
    assert.equal(vidRes[0].mediaType, 'video');
    assert.equal(vidRes[0].duration, 24);
    assert.ok(vidRes.some((r) => /thothub/i.test(r.pageUrl || '')), 'Mirror-hosted videos come back now');
  });

  test('brave.web automatically falls back to DuckDuckGo HTML when BRAVE_SEARCH_KEY is not configured', async () => {
    const prevKey = process.env.BRAVE_SEARCH_KEY;
    process.env.BRAVE_SEARCH_KEY = '';
    try {
      const ddgRes = await brave.web('ddg_athlete', { count: 10 });
      assert.ok(ddgRes.some((r) => r.url === 'https://x.com/ddg_athlete'), JSON.stringify(ddgRes));
      assert.ok(ddgRes.some((r) => /bunkr\.si/i.test(r.url)), 'Mirror hosts come back in the DDG fallback now');
      assert.ok(ddgRes.some((r) => /fansly\.com/i.test(r.url)), 'Paid pages come back in the DDG fallback now');
    } finally {
      process.env.BRAVE_SEARCH_KEY = prevKey;
    }
  });

  test('pipeline attributes collab/promo posts mentioning a known creator (@handle or paid link) and enqueues the collab partner', async () => {
    const paid = require('../src/lib/paid');
    const atlas = repo.creators.create({
      handle: 'atlas_fit',
      displayName: 'Atlas Fit',
      bio: 'Gay bodybuilder 18+ · onlyfans.com/atlas_fit',
      origin: 'admin',
    });
    repo.creators.update(atlas.id, { scope: 'in' });
    repo.creators.enrich(atlas.id, { links: [paid.paidLink('OnlyFans', 'atlas_fit')] });
    repo.onlyfans.claim('atlas_fit', atlas.id, 'OnlyFans');
    repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'atlas_fit', creatorId: atlas.id, enabled: 1, trusted: 1 });

    const communityFeed = repo.feeds.upsert({
      platform: 'reddit',
      kind: 'community',
      target: 'gaybrosgonewild',
      trusted: 1,
    }).feed;

    const collabItem = {
      sourceId: 'collab-post-99',
      author: 'new_collab_buddy',
      authorName: 'New Collab Buddy',
      title: 'Hot gym session with @atlas_fit 🔥 check out onlyfans.com/atlas_fit',
      text: 'Collab post with @atlas_fit',
      mediaType: 'image',
      mediaUrl: 'https://i.redd.it/collab99.jpg',
      tags: ['gay', 'muscle'],
      trusted: true,
    };

    const res = await pipeline.processItem(collabItem, communityFeed, null, {
      probeUnknownHosts: false,
      hostReachability: false,
      imageFilter: false,
      dedupe: false,
      physiqueFilter: false,
    });
    assert.equal(res.outcome, 'added', JSON.stringify(res));
    assert.equal(res.creatorId, atlas.id, 'Post mentioning @atlas_fit / onlyfans.com/atlas_fit is attributed to Atlas Fit');
    const collabCand = repo.candidates.find('reddit', 'user', 'new_collab_buddy');
    assert.ok(collabCand, 'Collab poster is enqueued as a candidate');
    assert.ok(Array.isArray(collabCand.signals.mention) && collabCand.signals.mention.includes(atlas.id), 'Collab poster has mention signal');
  });

  test('discoverCreatorMentions searches across RedGIFs, Reddit, Bluesky, and web to surface collab accounts and link hubs', async () => {
    const r = await discovery.discoverCreatorMentions({ budget: 3 });
    assert.ok(r.checked >= 1, JSON.stringify(r));
    assert.ok(r.found >= 1, JSON.stringify(r));
    // RedGIFs collab partner discovered from RedGIFs search for atlas_fit
    const rgPartner = repo.candidates.find('redgifs', 'user', 'collab_partner');
    assert.ok(rgPartner, 'Collab partner on RedGIFs was enqueued as a candidate');
  });

  test('lookup (#/find) returns mediaHits and webLinks from Brave Images/Videos + RedGIFs + Reddit when searching a paid handle', async () => {
    const registry = require('../src/sources');
    const savedFetch = new Map();
    for (const a of registry.list()) {
      savedFetch.set(a.platform, a.fetch);
      a.fetch = async (feed) => {
        if (feed.platform === 'x' && feed.target === 'atlas_fit') {
          return {
            items: [{ sourceId: 'x1', title: 'Gym day', mediaType: 'image', mediaUrl: 'https://pbs.twimg.com/media/AtlasImg1.jpg', previewUrl: 'https://pbs.twimg.com/media/AtlasImg1.jpg' }],
            profile: { displayName: 'Atlas Fit', bio: 'Gay bodybuilder 18+ · https://onlyfans.com/atlas_fit', links: [] },
            via: 'mock',
          };
        }
        throw Object.assign(new Error('not found'), { status: 404 });
      };
    }
    try {
      const res = await lookup.run('https://onlyfans.com/atlas_fit', { imageCheck: false });
      assert.ok(Array.isArray(res.accounts));
      assert.ok(Array.isArray(res.mediaHits), 'lookup.run includes mediaHits array');
      assert.ok(res.mediaHits.length >= 2, `Expected >= 2 mediaHits, got ${res.mediaHits.length}`);
      assert.ok(
        res.mediaHits.some((m) => m.mediaUrl === 'https://pbs.twimg.com/media/AtlasImg1.jpg'),
        'Includes Brave Image hit',
      );
      assert.ok(
        res.mediaHits.some((m) => m.pageUrl === 'https://www.redgifs.com/watch/atlasworkout1' || m.mediaUrl === 'https://media.redgifs.com/RgCollab1.mp4'),
        'Includes Brave Video / RedGIFs hit',
      );
      assert.ok(
        res.mediaHits.some((m) => /fapello|thothub|coomer|onlyfans/i.test(m.mediaUrl || '')),
        'Surfaces paid / mirror media URLs now that the prohibition is gone',
      );
    } finally {
      for (const [plat, fn] of savedFetch.entries()) {
        registry.get(plat).fetch = fn;
      }
    }
  });
});
