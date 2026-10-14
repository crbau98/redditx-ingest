'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let tumblr; let links; let host;
const rssFeed = (items) => `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>gymbro</title>${items}</channel></rss>`;
const entry = (id, title, html, at, extra = '') => `<item><guid>https://gymbro.tumblr.com/post/${id}</guid><link>https://gymbro.tumblr.com/post/${id}/x</link><title>${title}</title><pubDate>${at}</pubDate><dc:creator>gymbro</dc:creator>${extra}<description><![CDATA[${html}]]></description></item>`;

before(async () => {
  const xml = rssFeed(
    entry(1, 'Leg day', '<p><img src="https://64.media.tumblr.com/abc/def-12/s500x750/ghi.jpg"/></p><p>gay gym bros</p>', 'Mon, 05 Oct 2026 10:00:00 GMT') +
    entry(2, 'Old style', '<img src="https://66.media.tumblr.com/xyz/tumblr_abc_500.jpg"/>', 'Mon, 05 Oct 2026 09:00:00 GMT') +
    entry(3, 'Reblog', '<p><a class="tumblr_blog" href="https://other.tumblr.com/post/9">other</a>:</p><blockquote><img src="https://64.media.tumblr.com/r/r/s500x750/r.jpg"/></blockquote>', 'Mon, 05 Oct 2026 08:00:00 GMT').replace('<p><a class="tumblr_blog" href="https://other.tumblr.com/post/9">other</a>:</p>', '<p>other: <a href="https://other.tumblr.com/post/9">x</a></p>') +
    entry(4, 'Text', '<p>just words</p>', 'Mon, 05 Oct 2026 07:00:00 GMT'));
  mock = await start({
    '/rss': () => ({ headers: { 'content-type': 'application/rss+xml', etag: '"v1"' }, body: xml }),
    '/tagged/gay+muscle/rss': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: xml }),
    '/dead/rss': () => ({ status: 404, body: 'nope' }),
  });
  host = `127.0.0.1:${mock.port}`;
  prepareEnv({ TUMBLR_BASE_URL: mock.url });
  tumblr = require('../src/sources/tumblr');
  links = require('../src/lib/links');
});
after(async () => { await mock.close(); });

const ctx = (o = {}) => ({ cursor: {}, limit: 40, aborted: () => false, ...o });

test('blog feed: images upgraded to the largest size, text posts skipped, reblogs credited to the original blog, creator = blog', async () => {
  const r = await tumblr.fetch({ kind: 'user', target: host }, ctx());
  const own = r.items.filter((i) => !i.repostOf);
  assert.deepEqual(own.map((i) => i.mediaUrl).sort(), ['https://64.media.tumblr.com/abc/def-12/s1280x1920/ghi.jpg', 'https://66.media.tumblr.com/xyz/tumblr_abc_1280.jpg']);
  assert.ok(r.items.every((i) => i.mediaType === 'image' && i.nsfw === 'explicit'));
  assert.equal(own[0].author, host);
  const reblog = r.items.find((i) => i.repostOf);
  assert.equal(reblog.mediaUrl, 'https://64.media.tumblr.com/r/r/s1280x1920/r.jpg');
  assert.equal(reblog.author, 'other', 'a reblog belongs to the blog it was reblogged from');
  assert.deepEqual(reblog.repostOf, { platform: 'tumblr', handle: 'other', via: host });
  assert.equal(r.cursor.etag, '"v1"');
  assert.equal(r.profile.displayName, 'gymbro');
});

test('tag feeds are per blog (site-wide tag feeds no longer exist) and every item carries the tag as its query', async () => {
  const r = await tumblr.fetch({ kind: 'tag', target: `gay muscle@${host}` }, ctx());
  assert.ok(r.items.length >= 2);
  assert.ok(r.items.every((i) => i.query === 'gay muscle' && i.tags.includes('gay muscle')));
  await assert.rejects(() => tumblr.fetch({ kind: 'tag', target: 'gay muscle' }, ctx()), (e) => e.skip === true && /site-wide/.test(e.message));
});

test('unchanged feeds and dead blogs', async () => {
  const first = await tumblr.fetch({ kind: 'user', target: host }, ctx());
  const again = await tumblr.fetch({ kind: 'user', target: host }, ctx({ cursor: first.cursor }));
  assert.equal(again.items.length, 0, 'cursor skips already-seen entries');
  await assert.rejects(() => tumblr.fetch({ kind: 'tag', target: `nosuchtag@${host}` }, ctx()), (e) => e.status === 404);
});

test('feed urls and link parsing', () => {
  assert.equal(tumblr.upgradeImage('https://example.com/a_500.jpg'), 'https://example.com/a_500.jpg', 'only Tumblr hosts are rewritten');
  const p = (u) => { const x = links.parseProfile(u); return x && `${x.platform}|${x.kind}|${x.target}`; };
  assert.equal(p('https://gymbro.tumblr.com/'), 'tumblr|user|gymbro');
  assert.equal(p('https://www.tumblr.com/tagged/gay+muscle'), 'tumblr|tag|gay muscle');
  assert.equal(p('https://www.tumblr.com/gymbro'), 'tumblr|user|gymbro');
  assert.equal(p('https://64.media.tumblr.com/a/b.jpg'), null, 'CDN hosts are not blogs');
  assert.equal(links.profileUrl('tumblr', 'user', 'gymbro'), 'https://gymbro.tumblr.com');
});
