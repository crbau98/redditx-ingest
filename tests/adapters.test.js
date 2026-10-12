'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; const state = { jsonStatus: 403, oldStatus: 403 };

before(async () => {
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>r/gaybrosgonewild</title>
  <entry><id>t3_rss1</id><author><name>/u/rss_guy</name></author><link href="https://www.reddit.com/r/gaybrosgonewild/comments/rss1/post/"/><updated>2026-10-01T10:00:00+00:00</updated><title>From the feed</title>
    <media:thumbnail url="https://b.thumbs.redditmedia.com/t.jpg"/>
    <content type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;a href="https://www.reddit.com/r/x/comments/rss1/"&gt;&lt;img src="https://preview.redd.it/rss1.jpg?width=640&amp;amp;s=a"/&gt;&lt;/a&gt;&lt;/td&gt;&lt;td&gt;&lt;a href="https://i.redd.it/rss1.jpg"&gt;[link]&lt;/a&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content></entry>
  <entry><id>t3_rss2</id><author><name>/u/rss_guy</name></author><link href="https://www.reddit.com/r/gaybrosgonewild/comments/rss2/post/"/><updated>2026-10-01T11:00:00+00:00</updated><title>Redgifs one</title>
    <content type="html">&lt;a href="https://www.redgifs.com/watch/bluepony"&gt;[link]&lt;/a&gt;</content></entry>
  <entry><id>t3_rss3</id><author><name>/u/rss_guy</name></author><link href="https://www.reddit.com/r/gaybrosgonewild/comments/rss3/post/"/><updated>2026-10-01T12:00:00+00:00</updated><title>Text only</title><content type="html">just words</content></entry>
</feed>`;
  const archive = { data: [{ id: 'arc1', title: 'Archive post', author: 'arc_user', subreddit: 'gaybrosgonewild', score: 9, over_18: true, created_utc: 1760000000, permalink: '/r/gaybrosgonewild/comments/arc1/x/', url: 'https://i.redd.it/arc1.jpg' }] };
  mock = await start({
    '/r/laddertest/new.json': () => ({ status: state.jsonStatus, json: state.jsonStatus === 200 ? { data: { children: [] } } : { error: 'blocked' } }),
    '/r/laddertest/top.json': () => ({ status: state.jsonStatus, json: { error: 'blocked' } }),
    '/r/laddertest/hot.json': () => ({ status: state.jsonStatus, json: { error: 'blocked' } }),
    '/r/laddertest/new.rss': () => ({ headers: { 'content-type': 'application/atom+xml' }, body: atom }),
    '/r/laddertest/top.rss': () => ({ headers: { 'content-type': 'application/atom+xml' }, body: atom }),
    '/r/laddertest/hot.rss': () => ({ headers: { 'content-type': 'application/atom+xml' }, body: atom }),
    '/r/archonly/top.json': () => ({ status: 403, json: {} }), '/r/archonly/hot.json': () => ({ status: 403, json: {} }),
    '/r/archonly/top.rss': () => ({ status: 403, body: 'no' }), '/r/archonly/hot.rss': () => ({ status: 403, body: 'no' }),
    '/api/posts/search': (req, res, url) => ({ json: url.searchParams.get('subreddit') === 'banned' ? { data: [] } : archive }),
    '/r/edge404/top.json': () => ({ status: 403, json: {} }), '/r/edge404/hot.json': () => ({ status: 403, json: {} }),
    '/r/edge404/top.rss': () => ({ headers: { 'content-type': 'application/atom+xml' }, body: atom }), '/r/edge404/hot.rss': () => ({ headers: { 'content-type': 'application/atom+xml' }, body: atom }),
    '/r/banned/top.json': () => ({ status: 404, json: {} }), '/r/banned/hot.json': () => ({ status: 404, json: {} }),
  });
  prepareEnv({ REDDIT_BASE_URL: mock.url, REDDIT_ARCHIVE_URL: mock.url });
});
after(async () => { await mock.close(); });

describe('reddit transport ladder', () => {
  test('falls back from blocked JSON to RSS and still yields media', async () => {
    const reddit = require('../src/sources/reddit');
    const r = await reddit.fetch({ kind: 'community', target: 'laddertest' }, { cursor: {}, limit: 25, aborted: () => false });
    assert.equal(r.via, 'rss');
    assert.ok(r.notes.length >= 2, 'records why earlier transports failed: ' + r.notes);
    const ids = [...new Set(r.items.map((i) => i.sourceId))];
    assert.ok(ids.includes('rss1') && ids.includes('rss2'), ids.join());
    assert.ok(!ids.includes('rss3'), 'text-only entry skipped');
    const direct = r.items.find((i) => i.sourceId === 'rss1');
    assert.equal(direct.mediaUrl, 'https://i.redd.it/rss1.jpg');
    assert.equal(direct.author, 'rss_guy');
    assert.equal(direct.community, 'gaybrosgonewild');
    assert.equal(r.items.find((i) => i.sourceId === 'rss2').resolve, 'redgifs');
  });
  test('uses the archive when everything live is blocked', async () => {
    const reddit = require('../src/sources/reddit');
    const r = await reddit.fetch({ kind: 'community', target: 'archonly' }, { cursor: {}, limit: 25, aborted: () => false });
    assert.equal(r.via, 'archive');
    assert.equal(r.items[0].sourceId, 'arc1');
    assert.equal(r.items[0].mediaUrl, 'https://i.redd.it/arc1.jpg');
  });
  test('a community is "gone" only when EVERY transport says 404 (Reddit answers blocked requests with bare 404s too)', async () => {
    const reddit = require('../src/sources/reddit');
    mock.hits.length = 0;
    await assert.rejects(() => reddit.fetch({ kind: 'community', target: 'banned' }, { cursor: {}, limit: 25, aborted: () => false }), (e) => e.status === 404);
    assert.ok(mock.hits.some((h) => h.includes('/api/posts/search')), 'the archive is asked too before declaring it gone');
  });
  test('one transport answering 404 (edge block) does not condemn a community the others can read', async () => {
    const reddit = require('../src/sources/reddit');
    const r = await reddit.fetch({ kind: 'community', target: 'edge404' }, { cursor: {}, limit: 25, aborted: () => false });
    assert.equal(r.via, 'rss'); assert.ok(r.items.length >= 1);
  });
});

describe('RedGIFs', () => {
  const rg = () => require('../src/sources/redgifs');
  const gif = { id: 'abc', userName: 'creator1', createDate: 1760000000, likes: 40, views: 1000, tags: ['gay', 'muscle', 'gym'], type: 1, hasAudio: true, width: 720, height: 1280, duration: 9, niches: ['gaymuscle'], urls: { hd: 'https://media.redgifs.com/Abc.mp4', sd: 'https://media.redgifs.com/Abc-mobile.mp4', poster: 'https://media.redgifs.com/Abc-poster.jpg', thumbnail: 'https://media.redgifs.com/Abc-thumb.jpg' } };
  test('maps a gif to a video item with dimensions, audio and post time', () => {
    const it = rg().itemFromGif(gif, 'gay');
    assert.equal(it.mediaType, 'video'); assert.equal(it.mediaUrl, 'https://media.redgifs.com/Abc.mp4');
    assert.equal(it.author, 'creator1'); assert.equal(it.width, 720); assert.equal(it.hasAudio, true);
    assert.equal(it.postedAt, new Date(1760000000 * 1000).toISOString());
    assert.deepEqual(it.tags, ['gay', 'muscle', 'gym']); assert.equal(it.community, 'gaymuscle');
  });
  test('image-type gifs become images; gifs without urls are dropped', () => {
    assert.equal(rg().itemFromGif({ ...gif, type: 2, urls: { hd: 'https://media.redgifs.com/x.jpg' } }).mediaType, 'image');
    assert.equal(rg().itemFromGif({ id: 'z' }), null);
    assert.equal(rg().itemFromGif({ id: 'z', urls: {} }), null);
  });
});

describe('Bluesky', () => {
  const bsky = () => require('../src/sources/bluesky');
  const author = { did: 'did:plc:abc', handle: 'zed.bsky.social', displayName: 'Zed', avatar: 'https://cdn.bsky.app/img/avatar/x' };
  const imagesPost = { post: { uri: 'at://did:plc:abc/app.bsky.feed.post/3kabc', author, record: { text: 'Gym day #fitness', createdAt: '2026-10-02T10:00:00Z' }, likeCount: 10, repostCount: 2, labels: [{ val: 'porn' }],
    embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/img/feed_thumbnail/a', fullsize: 'https://cdn.bsky.app/img/feed_fullsize/a', alt: 'mirror', aspectRatio: { width: 3, height: 4 } }, { thumb: 'https://cdn.bsky.app/img/feed_thumbnail/b', fullsize: 'https://cdn.bsky.app/img/feed_fullsize/b' }] } } };
  test('images: one item per image, adult label -> explicit, hashtags extracted', () => {
    const items = bsky().parsePostView(imagesPost);
    assert.equal(items.length, 2);
    assert.equal(items[0].mediaUrl, 'https://cdn.bsky.app/img/feed_fullsize/a'); assert.equal(items[0].previewUrl, 'https://cdn.bsky.app/img/feed_thumbnail/a');
    assert.equal(items[0].nsfw, 'explicit'); assert.equal(items[0].author, 'zed.bsky.social');
    assert.equal(items[0].sourceId, 'did:plc:abc:3kabc'); assert.equal(items[1].position, 1);
    assert.ok(items[0].tags.includes('#fitness')); assert.equal(items[0].score, 14);
    assert.equal(items[0].permalink, 'https://bsky.app/profile/zed.bsky.social/post/3kabc');
  });
  test('video: HLS playlist is kept as hlsUrl and flagged for audio', () => {
    const [v] = bsky().parsePostView({ post: { ...imagesPost.post, labels: [], embed: { $type: 'app.bsky.embed.video#view', playlist: 'https://video.bsky.app/watch/did/cid/playlist.m3u8', thumbnail: 'https://video.bsky.app/watch/did/cid/thumbnail.jpg', aspectRatio: { width: 9, height: 16 } } } });
    assert.equal(v.mediaType, 'video'); assert.equal(v.hlsUrl, 'https://video.bsky.app/watch/did/cid/playlist.m3u8'); assert.equal(v.hasAudio, true);
    assert.equal(v.nsfw, 'suggestive', 'no adult label -> suggestive');
  });
  test('recordWithMedia (quote posts with images) is unwrapped; reposts and text posts are skipped', () => {
    const quote = { post: { ...imagesPost.post, embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: imagesPost.post.embed } } };
    assert.equal(bsky().parsePostView(quote).length, 2);
    assert.equal(bsky().parsePostView({ ...imagesPost, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }).length, 0);
    assert.equal(bsky().parsePostView({ post: { ...imagesPost.post, embed: undefined } }).length, 0);
    assert.equal(bsky().parsePostView({ post: { ...imagesPost.post, embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://x.com', thumb: 'https://t' } } } }).length, 0);
  });
  test('search kind reports missing credentials instead of failing', () => {
    assert.equal(bsky().isConfigured('search').ok, false);
    assert.equal(bsky().isConfigured('user').ok, true);
  });
});

describe('Mastodon', () => {
  const m = () => require('../src/sources/mastodon');
  const status = { id: '111', created_at: '2026-10-03T08:00:00.000Z', url: 'https://mastodon.social/@zed/111', content: '<p>Post-workout <a href="#">#gym</a></p>', sensitive: true, favourites_count: 5, reblogs_count: 1, tags: [{ name: 'gym' }],
    account: { acct: 'zed', display_name: 'Zed', avatar: 'https://files.mastodon.social/a.png' },
    media_attachments: [{ type: 'image', url: 'https://files.mastodon.social/1.jpg', preview_url: 'https://files.mastodon.social/1s.jpg', description: 'alt', meta: { original: { width: 1000, height: 1500 } } }, { type: 'gifv', url: 'https://files.mastodon.social/2.mp4', preview_url: 'https://files.mastodon.social/2.png' }, { type: 'audio', url: 'https://files.mastodon.social/a.mp3' }] };
  test('image + gifv become items, audio is skipped, account is qualified with its host', () => {
    const items = m().parseStatus(status, 'mastodon.social');
    assert.equal(items.length, 2);
    assert.equal(items[0].author, 'zed@mastodon.social'); assert.equal(items[0].mediaType, 'image'); assert.equal(items[0].width, 1000);
    assert.equal(items[1].mediaType, 'video'); assert.equal(items[0].nsfw, 'explicit'); assert.equal(items[0].text, 'Post-workout #gym');
    assert.equal(items[0].score, 7); assert.deepEqual(items[0].tags, ['gym']);
  });
  test('boosts are ignored (the original poster owns the media)', () => {
    assert.equal(m().parseStatus({ ...status, reblog: { id: '1' } }, 'mastodon.social').length, 0);
  });
});

describe('Lemmy', () => {
  const l = () => require('../src/sources/lemmy');
  const pv = { post: { id: 5, name: 'Beach', url: 'https://lemmynsfw.com/pictrs/image/abc.jpg', url_content_type: 'image/jpeg', thumbnail_url: 'https://lemmynsfw.com/pictrs/image/abc.jpg?thumbnail=512', published: '2026-10-04T10:00:00Z', ap_id: 'https://lemmynsfw.com/post/5', nsfw: true, body: 'hi' },
    creator: { name: 'zed', actor_id: 'https://lemmynsfw.com/u/zed', display_name: 'Zed' }, community: { name: 'gaynsfw', actor_id: 'https://lemmynsfw.com/c/gaynsfw' }, counts: { score: 33 } };
  test('image posts map with qualified author/community names', () => {
    const [it] = l().parsePostView(pv);
    assert.equal(it.mediaType, 'image'); assert.equal(it.author, 'zed@lemmynsfw.com'); assert.equal(it.community, 'gaynsfw@lemmynsfw.com'); assert.equal(it.score, 33); assert.equal(it.nsfw, 'explicit');
  });
  test('video detection, and non-media / removed posts are skipped', () => {
    assert.equal(l().parsePostView({ ...pv, post: { ...pv.post, url: 'https://x.org/c.mp4', url_content_type: 'video/mp4' } })[0].mediaType, 'video');
    assert.equal(l().parsePostView({ ...pv, post: { ...pv.post, url: 'https://news.site/article', url_content_type: 'text/html' } }).length, 0);
    assert.equal(l().parsePostView({ ...pv, post: { ...pv.post, removed: true } }).length, 0);
  });
});

describe('X', () => {
  const x = () => require('../src/sources/x');
  test('v2 API: photos use ?name=orig, videos pick the best mp4 variant', () => {
    const json = { data: [{ id: '900', text: 'gym #fit', author_id: 'u1', created_at: '2026-10-05T12:00:00.000Z', possibly_sensitive: true, public_metrics: { like_count: 10, retweet_count: 2 }, attachments: { media_keys: ['m1', 'm2'] }, entities: { hashtags: [{ tag: 'fit' }] } }],
      includes: { users: [{ id: 'u1', username: 'zedx', name: 'Zed' }], media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1200, height: 1600 }, { media_key: 'm2', type: 'video', preview_image_url: 'https://pbs.twimg.com/p.jpg', variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' }, { content_type: 'video/mp4', bit_rate: 256000, url: 'https://video.twimg.com/low.mp4' }, { content_type: 'video/mp4', bit_rate: 2176000, url: 'https://video.twimg.com/high.mp4' }] }] } };
    const items = x().parseApi(json);
    assert.equal(items.length, 2);
    assert.equal(items[0].mediaUrl, 'https://pbs.twimg.com/media/a.jpg?name=orig'); assert.equal(items[0].nsfw, 'explicit'); assert.equal(items[0].author, 'zedx');
    assert.equal(items[1].mediaUrl, 'https://video.twimg.com/high.mp4'); assert.equal(items[1].mediaType, 'video'); assert.equal(items[0].score, 14);
  });
  test('syndication timeline: parses embedded JSON, skips retweets', () => {
    const tweet = { id_str: '1', full_text: 'hello', created_at: 'Mon Oct 05 12:00:00 +0000 2026', user: { screen_name: 'zedx' }, extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/z.jpg', original_info: { width: 800, height: 1000 } }] } };
    const page = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries: [{ type: 'tweet', content: { tweet } }, { type: 'tweet', content: { tweet: { ...tweet, id_str: '2', retweeted_status: {} } } }, { type: 'cursor' }] } } } })}</script></html>`;
    const items = x().parseSyndication(page).flatMap(x().parseLegacyTweet);
    assert.equal(items.length, 1); assert.equal(items[0].mediaUrl, 'https://pbs.twimg.com/media/z.jpg?name=orig'); assert.equal(items[0].width, 800);
    assert.throws(() => x().parseSyndication('<html>blocked</html>'), /rate limited or changed/);
  });
  test('search without a token is reported as not configured (skipped, not failed)', () => {
    assert.equal(x().isConfigured('search').ok, false);
    assert.equal(x().isConfigured('user').ok, true);
  });
});

describe('RSS / Atom / JSON Feed', () => {
  const rss = () => require('../src/sources/rss');
  test('RSS 2.0: enclosures, media:content and inline images, with junk filtered', () => {
    const xml = `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Zed's gallery</title><image><url>https://zed.example/logo.png</url></image>
      <item><title>Set 1</title><link>https://zed.example/set1</link><guid>g1</guid><pubDate>Fri, 03 Oct 2026 10:00:00 GMT</pubDate><dc:creator>Zed</dc:creator><category>gym</category>
        <enclosure url="https://zed.example/full1.jpg" type="image/jpeg"/>
        <content:encoded><![CDATA[<p>text</p><img src="/emoji/smile.png" width="16" height="16"><img src="https://zed.example/inline2.jpg" width="900" height="1200"><a href="https://zed.example/big3.jpg"><img src="https://zed.example/thumb3.jpg"></a><video src="https://zed.example/clip.mp4" poster="https://zed.example/poster.jpg"></video>]]></content:encoded></item>
      <item><title>Media content</title><link>https://zed.example/set2</link><guid>g2</guid><pubDate>Sat, 04 Oct 2026 10:00:00 GMT</pubDate><media:content url="https://zed.example/m.mp4" type="video/mp4"/><media:thumbnail url="https://zed.example/m.jpg"/></item></channel></rss>`;
    const feed = rss().parseFeed(xml, 'https://zed.example/feed');
    assert.equal(feed.title, "Zed's gallery"); assert.equal(feed.entries.length, 2);
    const urls = feed.entries[0].media.map((m) => m.url);
    assert.ok(urls.includes('https://zed.example/full1.jpg') && urls.includes('https://zed.example/inline2.jpg') && urls.includes('https://zed.example/big3.jpg') && urls.includes('https://zed.example/clip.mp4'), urls.join());
    assert.ok(!urls.some((u) => /emoji/.test(u)), 'tiny emoji filtered');
    assert.equal(feed.entries[0].media.find((m) => m.url.endsWith('big3.jpg')).preview, 'https://zed.example/thumb3.jpg', 'linked full-size image preferred over its thumb');
    assert.equal(feed.entries[1].media[0].type, 'video'); assert.equal(feed.entries[1].media[0].preview, 'https://zed.example/m.jpg');
    const items = rss().entryToItems(feed.entries[0], feed);
    assert.ok(items.every((i) => i.probe === true), 'unknown hosts are verified before publishing');
    assert.equal(items[0].author, 'Zed'); assert.equal(items[0].postedAt, '2026-10-03T10:00:00.000Z');
  });
  test('Atom feeds', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><logo>https://b.example/logo.png</logo><entry><id>tag:1</id><title>Post</title><link rel="alternate" href="https://b.example/p1"/><link rel="enclosure" type="image/png" href="https://b.example/e.png"/><published>2026-10-01T00:00:00Z</published><author><name>Ann</name></author><content type="html">&lt;img src="https://b.example/c.jpg" width="800"/&gt;</content></entry></feed>`;
    const f = rss().parseFeed(xml, 'https://b.example/atom');
    assert.equal(f.entries[0].link, 'https://b.example/p1'); assert.equal(f.entries[0].author, 'Ann');
    assert.deepEqual(f.entries[0].media.map((m) => m.url).sort(), ['https://b.example/c.jpg', 'https://b.example/e.png']);
  });
  test('JSON Feed', () => {
    const f = rss().parseFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'JF', items: [{ id: '1', url: 'https://j.example/1', title: 'One', image: 'https://j.example/i.jpg', date_published: '2026-10-01T00:00:00Z', attachments: [{ url: 'https://j.example/v.mp4', mime_type: 'video/mp4' }] }] }), 'https://j.example/feed.json');
    assert.deepEqual(f.entries[0].media.map((m) => m.type), ['image', 'video']);
  });
  test('malformed XML never throws', () => {
    assert.doesNotThrow(() => rss().parseFeed('<rss><channel><item><title>broken', 'https://x.example/'));
    assert.equal(rss().parseFeed('', 'https://x.example/').entries.length, 0);
  });
});

describe('web pages and link-in-bio', () => {
  const web = () => require('../src/sources/web');
  test('page extraction: og:video, <video>, linked full-size images; ignores icons and ads', () => {
    const html = `<html><head><title>Zed</title><meta property="og:image" content="https://z.example/og.jpg"><meta property="og:video" content="https://z.example/v.mp4"><meta property="og:site_name" content="ZedSite"><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>
      <a href="/photos/1-full.jpg"><img src="/photos/1-thumb.jpg"></a><img src="/img/logo.png" width="300"><img data-src="/img/avatar.png"><img srcset="/p/2-640.jpg 640w, /p/2-1600.jpg 1600w" src="/p/2-640.jpg" width="640">
      <img src="/tiny.jpg" width="50" height="50"><video><source src="/clips/c.mp4"></video><img src="https://images.unsplash.com/stock.jpg" width="900"></body></html>`;
    const page = web().extractPage(html, 'https://z.example/gallery');
    const urls = page.media.map((m) => m.url);
    assert.ok(urls.includes('https://z.example/v.mp4') && urls.includes('https://z.example/photos/1-full.jpg') && urls.includes('https://z.example/p/2-1600.jpg') && urls.includes('https://z.example/clips/c.mp4'), urls.join());
    assert.ok(!urls.some((u) => /logo|avatar|tiny|unsplash/.test(u)), urls.join());
    assert.equal(page.feedUrl, 'https://z.example/feed.xml'); assert.equal(page.siteName, 'ZedSite');
    assert.equal(page.media.find((m) => m.url.endsWith('1-full.jpg')).preview, 'https://z.example/photos/1-thumb.jpg');
  });
  test('link-in-bio crawl: yields profile links, never media, and keeps paywalled links display-only', async () => {
    const m = await start({ '/zed': () => ({ headers: { 'content-type': 'text/html' }, body: `<html><head><title>Zed | Linktree</title><meta property="og:description" content="Model & coach"><meta property="og:image" content="https://cdn.example/zed.jpg"></head><body>
      <a href="https://x.com/zedfit">X</a><a href="https://onlyfans.com/zed">OF</a><a href="https://bsky.app/profile/zed.bsky.social">Bsky</a><a href="https://random-shop.example/buy">Shop</a><a href="https://www.redgifs.com/users/zedgifs">RG</a>
      <script id="__NEXT_DATA__">{"links":[{"url":"https:\\/\\/www.reddit.com\\/user\\/zed_reddit"}]}</script></body></html>` }) });
    try {
      const out = await web().linkInBioAdapter.fetch({ kind: 'page', target: `${m.url}/zed` });
      assert.equal(out.items.length, 0);
      const got = out.profile.links.map((l) => `${l.platform}:${l.target || ''}`);
      assert.ok(got.some((g) => g.startsWith('x:zedfit')) && got.some((g) => g.startsWith('bluesky:zed.bsky.social')) && got.some((g) => g.startsWith('redgifs:zedgifs')) && got.some((g) => g.startsWith('reddit:zed_reddit')), got.join());
      assert.ok(out.profile.links.some((l) => l.external && l.service === 'OnlyFans'), 'paywalled link retained for display');
      assert.ok(!got.some((g) => g.startsWith('web:')), 'arbitrary web links are not followed');
      assert.equal(out.profile.displayName, 'Zed'); assert.equal(out.profile.bio, 'Model & coach');
    } finally { await m.close(); }
  });
  test('robots.txt Disallow is honoured by the web adapter', async () => {
    const m = await start({ '/robots.txt': () => ({ body: 'User-agent: *\nDisallow: /private\n' }), '/private/page': () => ({ body: '<html></html>' }), '/public/page': () => ({ headers: { 'content-type': 'text/html' }, body: '<html><body><img src="/a.jpg" width="900"></body></html>' }) });
    try {
      await assert.rejects(() => web().webAdapter.fetch({ kind: 'page', target: `${m.url}/private/page` }, {}), (e) => e.skip === true && /robots/.test(e.message));
      const ok = await web().webAdapter.fetch({ kind: 'page', target: `${m.url}/public/page` }, {});
      assert.equal(ok.items.length, 1);
    } finally { await m.close(); }
  });
});
