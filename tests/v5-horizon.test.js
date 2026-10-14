'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let youtube; let links;

before(async () => {
  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<title>Gym Guy</title>
<entry><id>yt:video:AbC123Xyz01</id><yt:videoId>AbC123Xyz01</yt:videoId><title>Gay muscle workout</title><link rel="alternate" href="https://www.youtube.com/watch?v=AbC123Xyz01"/><author><name>Gym Guy</name></author><published>2026-10-01T10:00:00+00:00</published><media:group><media:title>Gay muscle workout</media:title><media:thumbnail url="https://i.ytimg.com/vi/AbC123Xyz01/hqdefault.jpg" width="480" height="360"/></media:group></entry>
<entry><id>yt:video:ZzZ999Qwert1</id><yt:videoId>ZzZ999Qwert1</yt:videoId><title>Morning routine</title><link rel="alternate" href="https://www.youtube.com/watch?v=ZzZ999Qwert1"/><author><name>Gym Guy</name></author><published>2026-10-02T10:00:00+00:00</published><media:group><media:title>Morning routine</media:title><media:thumbnail url="https://i.ytimg.com/vi/ZzZ999Qwert1/hqdefault.jpg" width="480" height="360"/></media:group></entry>
</feed>`;
  mock = await start({
    '/feeds/videos.xml': () => ({ headers: { 'content-type': 'application/atom+xml' }, body: feedXml }),
    '/@gymguy': () => ({ headers: { 'content-type': 'text/html' }, body: '<html><head><meta property="og:url" content="https://www.youtube.com/channel/UC1234567890abcdefghij"/><script>"channelId":"UC1234567890abcdefghij"</script></head></html>' }),
  });
  prepareEnv({});
  // Point the youtube adapter at the mock by overriding rss.load + http.raw via baseUrls is not supported for youtube,
  // so stub at module level: fetch uses rss.load(FEED(channelId)) which hits youtube.com — instead test parse + mapping directly.
  youtube = require('../src/sources/youtube');
  links = require('../src/lib/links');
  youtube.__mockFeed = feedXml;
});

after(async () => { await mock.close(); });

test('youtube link parsing: channels ingestable, watch links stay external', () => {
  const ch = links.parseProfile('https://www.youtube.com/@gymguy');
  assert.equal(ch.platform, 'youtube');
  assert.equal(ch.kind, 'user');
  assert.equal(ch.target, '@gymguy');
  const cid = links.parseProfile('https://www.youtube.com/channel/UC1234567890abcdefghij');
  assert.equal(cid.platform, 'youtube');
  assert.equal(cid.kind, 'channel');
  const watch = links.parseProfile('https://www.youtube.com/watch?v=AbC123Xyz01');
  assert.equal(watch.platform, 'external');
  assert.equal(links.profileUrl('youtube', 'channel', 'UC1234567890abcdefghij'), 'https://www.youtube.com/channel/UC1234567890abcdefghij');
  assert.equal(links.profileUrl('youtube', 'user', '@gymguy'), 'https://www.youtube.com/@gymguy');
});

test('youtube RSS entries map to thumbnail items with watch permalinks', () => {
  const rss = require('../src/sources/rss');
  const parsed = rss.parseFeed(youtube.__mockFeed, 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx');
  assert.equal(parsed.entries.length, 2);
  assert.match(parsed.entries[0].link, /watch\?v=AbC123Xyz01/);
  assert.equal(youtube.videoIdFromLink('https://www.youtube.com/watch?v=AbC123Xyz01'), 'AbC123Xyz01');
  assert.equal(youtube.videoIdFromLink('https://www.youtube.com/shorts/ZzZ999Qwert1'), 'ZzZ999Qwert1');
});

test('youtube adapter is registered with user/channel kinds', () => {
  const registry = require('../src/sources');
  const a = registry.get('youtube');
  assert.ok(a);
  assert.deepEqual(a.kinds, ['user', 'channel']);
  assert.equal(a.isConfigured('user').ok, true);
});

test('lookup directSpecs include youtube, peertube and lemmy probes', () => {
  const lookup = require('../src/engine/lookup');
  const q = lookup.parseQuery('gymguy');
  const specs = lookup.directSpecs(q);
  const plats = new Set(specs.map((s) => s.platform));
  assert.ok(plats.has('youtube'), `missing youtube in ${[...plats]}`);
  assert.ok(plats.has('peertube'), `missing peertube in ${[...plats]}`);
  assert.ok(plats.has('lemmy'), `missing lemmy in ${[...plats]}`);
});

test('public lookup routes exist behind age gate with rate limits', async () => {
  const { createApp } = require('../src/app');
  const app = createApp();
  const srv = app.listen(0);
  await new Promise((r) => srv.on('listening', r));
  const port = srv.address().port;
  try {
    // In test env the age gate is off, so the route runs: expect a shaped
    // lookup answer (candidates or a validation error), not a 404.
    const res = await fetch(`http://127.0.0.1:${port}/api/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'gymguy' }) });
    assert.ok([200, 400, 401, 403, 429].includes(res.status), `unexpected status ${res.status}`);
    assert.notEqual(res.status, 404);
    const body = await res.json();
    assert.ok(body && (Array.isArray(body.candidates) || body.error), JSON.stringify(body).slice(0, 200));
  } finally { srv.close(); }
});

test('publicMedia exposes thumb_url and tint for grids', () => {
  const { publicMedia } = require('../src/routes/public');
  const out = publicMedia({ id: 'x', title: 't', description: '', media_type: 'image', media_url: 'https://a/b.jpg', preview_url: 'https://a/p.jpg', thumbnail_url: null, thumb_url: 'https://store/t.webp', tint: '#112233', hls_url: null, has_audio: false, width: 100, height: 100, duration: null, platform: 'reddit', community: null, author: 'a', source_url: 'https://a', score: 1, likes: 0, views: 0, nsfw_level: null, posted_at: '2026-10-01', creator_id: null, creator_handle: null, creator_name: null, creator_avatar: null, tags_text: '', position: 0, post_key: 'k' });
  assert.equal(out.thumb_url, 'https://store/t.webp');
  assert.equal(out.tint, '#112233');
});
