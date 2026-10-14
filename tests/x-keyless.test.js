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
    '/srv/timeline-profile/screen-name/jockfit': () => ({ body: '<html>Rate limit exceeded</html>' }),
    '/jockfit': () => ({ json: { code: 200, user: { screen_name: 'jockfit', name: 'Jock Fit', description: 'gym. more at linktr.ee/jockfit', avatar_url: 'https://pbs.twimg.com/p_normal.jpg' } } }),
  });
  prepareEnv({ SEARXNG_URL: mock.url, SEARCH_PROVIDERS: 'searxng', FXTWITTER_BASE_URL: mock.url, X_EMBED_URL: mock.url, X_SYNDICATION_URL: mock.url, X_BEARER_TOKEN: '' });
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
    await assert.rejects(() => x.fetch({ kind: 'search', target: 'gay jock' }, ctx()), (e) => e.skip && /web searches are used/.test(e.message));
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
