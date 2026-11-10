'use strict';
/**
 * Reddit and X incremental cursors keep a post posted in the same second as the newest stored one
 * (dedupe by sourceId happens downstream), and X image URLs never get a second `?`.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');
const F = require('./fixtures/reddit');

const SEC = F.t0;
const AT = 'Wed Oct 01 10:00:00 +0000 2026';
let redditRows = [];
let xTweets = [];
let mock; let reddit; let x;

const tweet = (id) => ({ type: 'tweet', content: { tweet: { id_str: id, full_text: `post ${id}`, created_at: AT, user: { screen_name: 'samesec' }, extended_entities: { media: [{ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${id}.jpg` }] } } } });

before(async () => {
  mock = await start({
    '/api/posts/search': () => ({ json: { data: redditRows } }),
    '/r/samesec/new.json': () => ({ json: F.listing(redditRows.map((d) => ({ kind: 't3', data: d }))) }),
    '/srv/timeline-profile/screen-name/samesec': () => ({ body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries: xTweets.map(tweet) } } } })}</script>` }),
  });
  prepareEnv({ REDDIT_BASE_URL: mock.url, REDDIT_ARCHIVE_URL: mock.url, X_SYNDICATION_URL: mock.url, X_BASE_URL: mock.url, X_BEARER_TOKEN: '' });
  require('../src/settings').update({ redditEnabled: true });
  reddit = require('../src/sources/reddit');
  x = require('../src/sources/x');
});
after(async () => { await mock.close(); });

const ctx = (cursor) => ({ cursor, limit: 100, aborted: () => false });

test('reddit: two posts in the same second as the cursor are both built on the next fetch', async () => {
  const feed = { platform: 'reddit', kind: 'community', target: 'samesec' };
  redditRows = [F.post({ id: 'p1', created_utc: SEC }).data];
  const first = await reddit.fetch(feed, ctx({}));
  assert.ok(first.cursor && first.cursor.newestAt);
  redditRows = [F.post({ id: 'p2', title: 'Second', url: 'https://i.redd.it/p2.jpg', created_utc: SEC }).data, F.post({ id: 'p1', created_utc: SEC }).data];
  const second = await reddit.fetch(feed, ctx(first.cursor));
  const ids = second.items.map((it) => it.sourceId).sort();
  assert.deepEqual(ids, ['p1', 'p2'], 'the late post from the same second is not dropped');
});

test('x: two posts in the same second as the cursor are both built on the next fetch', async () => {
  const feed = { platform: 'x', kind: 'user', target: 'samesec' };
  xTweets = ['101'];
  const first = await x.fetch(feed, ctx({}));
  assert.ok(first.cursor && first.cursor.newestAt);
  xTweets = ['102', '101'];
  const second = await x.fetch(feed, ctx(first.cursor));
  assert.deepEqual(second.items.map((it) => it.sourceId).sort(), ['101', '102']);
});

test('x: an image URL that already has a query keeps one query string and ends with name=orig', () => {
  const out = x._sized('https://pbs.twimg.com/media/abc?format=jpg', 'orig');
  assert.equal(out, 'https://pbs.twimg.com/media/abc?format=jpg&name=orig');
  assert.equal(out.split('?').length, 2);
  assert.equal(x._sized('https://pbs.twimg.com/media/abc?format=jpg&name=small', 'orig'), 'https://pbs.twimg.com/media/abc?format=jpg&name=orig');
  assert.equal(x._sized('https://pbs.twimg.com/media/abc.jpg', 'medium'), 'https://pbs.twimg.com/media/abc.jpg?name=medium');
});
