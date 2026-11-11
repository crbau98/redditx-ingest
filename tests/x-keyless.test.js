'use strict';
/**
 * X without X_BEARER_TOKEN: searches and empty profiles find x.com posts through web search and read each one through
 * fxtwitter (X's embed API as the fallback); X links in Reddit posts load their media; web search reports failing engines.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let x; let websearch; let reddit; let repo; let pipeline;
const searx = { results: [], unresponsive: [] };
const fxHits = []; const embedHits = [];

const fxTweet = (id, handle, text) => ({ code: 200, tweet: { id, url: `https://x.com/${handle}/status/${id}`, text, author: { screen_name: handle, name: handle.toUpperCase(), avatar_url: 'https://pbs.twimg.com/a.jpg' }, likes: 5, retweets: 1, created_timestamp: 1791000000, media: { all: [{ type: 'photo', url: `https://pbs.twimg.com/media/${id}.jpg`, width: 1000, height: 1250 }] } } });

before(async () => {
  mock = await start({
    '/search': () => ({ json: { results: searx.results, unresponsive_engines: searx.unresponsive } }),
    '/status/1001': () => { fxHits.push('1001'); return { json: fxTweet('1001', 'jockfit', 'gay jock gym pump') }; },
    '/status/1002': () => { fxHits.push('1002'); return { json: fxTweet('1002', 'otherguy', 'gay muscle') }; },
    '/status/1003': () => { fxHits.push('1003'); return { status: 404, json: { code: 404, message: 'NOT_FOUND' } }; },
    '/tweet-result': (req, res, url) => {
      embedHits.push(url.searchParams.get('id'));
      return { json: { __typename: 'Tweet', id_str: url.searchParams.get('id'), text: 'gay jock', created_at: '2026-10-10T10:00:00.000Z', user: { screen_name: 'jockfit', name: 'Jock' },
        mediaDetails: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/v.jpg', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/lo.mp4' }, { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/hi.mp4' }] } }] } };
    },
    '/2/tweets/search/recent': () => ({ status: 402, json: { title: 'CreditsDepleted' } }),
    '/srv/timeline-profile/screen-name/jockfit': () => ({ body: '<html>Rate limit exceeded</html>' }),
    '/srv/timeline-profile/screen-name/rate_limited_guy': () => ({ status: 429, headers: { 'retry-after': '1800' }, body: 'Rate limit exceeded' }),
    '/srv/timeline-profile/screen-name/another_guy': () => ({ status: 429, headers: { 'retry-after': '1800' }, body: 'Rate limit exceeded' }),
    '/srv/timeline-profile/screen-name/syndguy': () => ({ body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries: [{ type: 'tweet', content: { tweet: { id_str: '2001', full_text: 'gay gym', created_at: 'Wed Oct 01 10:00:00 +0000 2026', user: { screen_name: 'syndguy' }, extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/2001.jpg' }] } } } }] } } } })}</script>` }),
    '/jockfit': () => ({ json: { code: 200, user: { screen_name: 'jockfit', name: 'Jock Fit', description: 'gym. more at linktr.ee/jockfit', avatar_url: 'https://pbs.twimg.com/p_normal.jpg' } } }),
  });
  prepareEnv({ SEARXNG_URL: mock.url, SEARCH_PROVIDERS: 'searxng', FXTWITTER_BASE_URL: mock.url, X_EMBED_URL: mock.url, X_SYNDICATION_URL: mock.url, X_BASE_URL: mock.url, X_BEARER_TOKEN: '' });
  x = require('../src/sources/x');
  websearch = require('../src/lib/websearch');
  reddit = require('../src/sources/reddit');
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
});
after(async () => { await mock.close(); });

const ctx = (cursor = {}) => ({ cursor, force: false, aborted: () => false });

describe('keyless X', () => {
  test('finds posts and profiles in web results', () => {
    const r = x.postsInResults([
      { url: 'https://x.com/jockfit/status/1001?s=20' }, { url: 'https://twitter.com/jockfit/status/1001' },
      { url: 'https://mobile.twitter.com/otherguy/status/1002' }, { url: 'https://x.com/i/status/5555' },
      { url: 'https://x.com/newcreator' }, { url: 'https://x.com/search?q=a' }, { url: 'https://example.com/x.com/a/status/1' },
    ]);
    assert.deepEqual(r.posts, [{ handle: 'jockfit', id: '1001' }, { handle: 'otherguy', id: '1002' }]);
    assert.deepEqual(r.profiles, ['newcreator']);
  });

  test('search feeds work without a token and are reported as configured', async () => {
    assert.equal(x.isConfigured('search').ok, true);
    searx.results = [{ url: 'https://x.com/jockfit/status/1001', title: 'a' }, { url: 'https://x.com/otherguy/status/1002', title: 'b' }];
    const r = await x.fetch({ kind: 'search', target: 'gay jock' }, ctx());
    assert.equal(r.via, 'websearch:searxng');
    assert.deepEqual(r.items.map((it) => it.sourceId).sort(), ['1001', '1002']);
    assert.equal(r.items[0].query, 'gay jock');
    assert.deepEqual(r.cursor.seen.sort(), ['1001', '1002']);
    // the next run reads only posts it has not seen
    fxHits.length = 0;
    websearch._clear();
    const again = await x.fetch({ kind: 'search', target: 'gay jock' }, ctx(r.cursor));
    assert.equal(again.items.length, 0); assert.equal(fxHits.length, 0);
  });

  test('a post fxtwitter cannot read comes from X\'s embed API', async () => {
    const items = await x.fetchTweet('1003');
    assert.deepEqual(embedHits, ['1003']);
    assert.equal(items[0].mediaUrl, 'https://video.twimg.com/hi.mp4'); assert.equal(items[0].mediaType, 'video');
    assert.equal(x.embedToken('1003'), ((1003 / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
  });

  test('a profile whose embed timeline is blocked falls back to web search for that handle only', async () => {
    websearch._clear();
    searx.results = [{ url: 'https://x.com/jockfit/status/1001' }, { url: 'https://x.com/otherguy/status/1002' }];
    const r = await x.fetch({ kind: 'user', target: 'jockfit' }, { ...ctx(), needProfile: true });
    assert.equal(r.via, 'websearch:searxng');
    assert.deepEqual(r.items.map((it) => it.sourceId), ['1001']);
    assert.match(r.notes[0], /embed timeline failed/);
    assert.equal(r.profile.displayName, 'Jock Fit'); assert.match(r.profile.avatarUrl, /_400x400/);
    assert.ok(r.profile.links.some((l) => /linktr/.test(l.target || l.url || '')));
  });

  test('a syndication 429 parks the embed timeline, and parked profiles are still read through the keyless search', async () => {
    const limiter = require('../src/lib/limiter');
    x.syndState.parkedUntil = 0; x.syndState.reason = null;
    websearch._clear();
    const before = x.webUsage().count;
    searx.results = [{ url: 'https://x.com/another_guy/status/1001' }];
    try {
      const r = await x.fetch({ kind: 'user', target: 'another_guy' }, ctx());
      assert.equal(x.syndParked(), true);
      assert.match(r.via, /^syndication:parked\+websearch/);
      assert.deepEqual(r.items.map((it) => it.sourceId), ['1001'], 'the keyless search parsed the post');
      assert.match(r.notes[0], /429/);
      assert.equal(r.rateLimited, undefined, 'a run with items is a normal run');
      assert.equal(x.webUsage().count, before + 1, 'the keyless search is counted');
      // still parked: the next profile does not ask syndication again, it goes straight to the search
      websearch._clear();
      searx.results = [{ url: 'https://x.com/thirdguy/status/1002' }];
      const hitsBefore = mock.hits.filter((h) => h.includes('timeline-profile/screen-name/thirdguy')).length;
      await x.fetch({ kind: 'user', target: 'thirdguy' }, ctx());
      assert.equal(mock.hits.filter((h) => h.includes('timeline-profile/screen-name/thirdguy')).length, hitsBefore, 'syndication stays parked');
      assert.equal(x.webUsage().count, before + 2);
    } finally {
      // The 429 also held the shared X HTTP limiter; clear it so later tests can still read posts.
      x.syndState.parkedUntil = 0; x.syndState.reason = null;
      limiter.reset();
    }
  });

  test('parked syndication with a keyless search that finds nothing finishes the run as skipped (rate limited), not empty', async () => {
    const limiter = require('../src/lib/limiter');
    const engine = require('../src/engine/engine');
    x.syndState.parkedUntil = Date.now() + 30 * 60000; x.syndState.reason = 'X syndication rate-limited (429); parked 30 min';
    websearch._clear();
    searx.results = [];
    try {
      // no search results at all: the run cannot read anything
      await assert.rejects(x.fetch({ kind: 'user', target: 'quietguy' }, ctx()), (e) => e.cooldown === true && /parked/.test(e.message));
      // results, but no post by this account: an empty answer that is rate limited, with the search's cursor kept
      websearch._clear();
      searx.results = [{ url: 'https://example.com/quietguy', title: 'quietguy elsewhere' }];
      const direct = await x.fetch({ kind: 'user', target: 'quietguy' }, ctx());
      assert.equal(direct.rateLimited, true);
      assert.equal(direct.items.length, 0);
      assert.ok(direct.cursor && direct.cursor.noHitAt, 'the 7-day miss is kept so the budget is not spent again');
      searx.results = [];
      websearch._clear();
      const feed = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'quietguy2', trusted: 1, origin: 'admin' }).feed;
      const run = await engine.runFeed(feed, 'manual');
      assert.equal(run.status, 'skipped');
      const row = repo.feeds.get(feed.id);
      assert.equal(row.last_status, 'skipped');
      assert.match(row.last_error, /rate limited/);
      assert.ok(Date.parse(row.next_run_at) - Date.now() > 25 * 60000, 'comes back after the park');
      // over the keyless budget as well: still skipped (rate limited), never an empty success
      repo.settings.set('x.websearch', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 100000 }));
      const feed3 = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'quietguy3', trusted: 1, origin: 'admin' }).feed;
      const run3 = await engine.runFeed(feed3, 'manual');
      assert.equal(run3.status, 'skipped');
      assert.match(repo.feeds.get(feed3.id).last_error, /rate limited/);
    } finally {
      repo.settings.set('x.websearch', '{}');
      x.syndState.parkedUntil = 0; x.syndState.reason = null;
      limiter.reset();
    }
  });

  test('with the park clear, a profile is read through syndication first and spends no search', async () => {
    x.syndState.parkedUntil = 0; x.syndState.reason = null;
    const before = x.webUsage().count;
    const r = await x.fetch({ kind: 'user', target: 'syndguy' }, ctx());
    assert.equal(r.via, 'syndication');
    assert.deepEqual(r.items.map((it) => it.sourceId), ['2001']);
    assert.equal(x.webUsage().count, before);
  });

  test('blocked search engines are named instead of reading as "no results", and do not count as X failing', async () => {
    websearch._clear();
    searx.results = []; searx.unresponsive = [['google', 'CAPTCHA'], ['duckduckgo', 'access denied']];
    await assert.rejects(() => x.fetch({ kind: 'search', target: 'gay muscle' }, ctx()), (e) => e.skip === true && /google \(CAPTCHA\)/.test(e.message));
    const st = websearch.status();
    const sx = st.providers.find((p) => p.name === 'searxng');
    assert.match(sx.lastError, /CAPTCHA/); assert.equal(st.working, false);
    searx.unresponsive = [];
  });

  test('keyless searches stop at the daily cap', async () => {
    websearch._clear();
    repo.settings.set('x.websearch', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 100000 }));
    // out of today's searches: a cooldown until after the daily reset (not a skip that retries every ~45 min)
    await assert.rejects(() => x.fetch({ kind: 'search', target: 'gay jock' }, ctx()), (e) => e.cooldown && e.budget && /web searches are used/.test(e.message) && e.retryAfter > 0);
    repo.settings.set('x.websearch', '{}');
  });
});

describe('X links in other posts', () => {
  test('a Reddit link post to an X post is marked for resolving', () => {
    const post = { id: 'rx1', title: 'gym day, gay jock', author: 'jockfit', subreddit: 'gaybrosgonewild', score: 3, over_18: true, created_utc: 1791000000, permalink: '/r/gaybrosgonewild/comments/rx1/x/', url: 'https://x.com/jockfit/status/1001' };
    const items = reddit.parsePost({ data: post });
    assert.equal(items.length, 1); assert.equal(items[0].resolve, 'x');
  });

  test('the pipeline reads the X post\'s media', async () => {
    const feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
    const r = await pipeline.processItem({ sourceId: 'rx2', title: 'gym day, gay jock', author: 'jockfit', community: 'gaybrosgonewild', mediaType: 'image', mediaUrl: 'https://twitter.com/jockfit/status/1001', resolve: 'x', trusted: true },
      feed, null, { probeUnknownHosts: false, scopeMode: 'open' });
    assert.ok(['added', 'review'].includes(r.outcome), JSON.stringify(r));
    const row = repo.db.prepare('SELECT media_url FROM media WHERE id = ?').get(r.mediaId);
    assert.equal(row.media_url, 'https://pbs.twimg.com/media/1001.jpg');
  });
});

describe('a token X refuses', () => {
  test('402 parks the API and the same run falls back to keyless', async () => {
    const config = require('../src/config');
    config.creds.xBearer = 'paid-plan-missing';
    websearch._clear();
    searx.results = [{ url: 'https://x.com/jockfit/status/1001' }];
    const r = await x.fetch({ kind: 'search', target: 'gay jock 402' }, ctx());
    assert.match(r.via, /^websearch/); assert.equal(r.items[0].sourceId, '1001');
    assert.equal(x.apiAvailable(), false);
    assert.match(x.isConfigured('search').note, /402/);
    config.creds.xBearer = '';
  });
});
