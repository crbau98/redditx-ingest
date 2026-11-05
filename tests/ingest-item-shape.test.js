'use strict';
/**
 * What the pipeline stores for width / height / duration, and where missing dimensions come from.
 * An adapter that reports 0, a negative number, a numeric string or NaN used to leak straight into the row (a 0x0 picture breaks
 * aspect-ratio layout and the duplicate index); and a picture with no dimensions kept none even after PRISM had downloaded it.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let repo; let pipeline; let feed; let thumbs; let sharp; let GOOD;
const settings = { probeUnknownHosts: false, scopeMode: 'open' };
let n = 0;
const item = (o) => ({
  sourceId: `shape${++n}`, title: 'Gym selfie', author: 'shapeguy', community: 'gaybrosgonewild', mediaType: 'image', trusted: true,
  mediaUrl: `https://i.redd.it/shape${n}.jpg`, ...o,
});

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  thumbs = require('../src/engine/thumbs');
  sharp = require('sharp');
  GOOD = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#aa5533' } }).jpeg().toBuffer();
  feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
});

async function stored(o) {
  const r = await pipeline.processItem(item(o), feed, null, settings);
  assert.equal(r.outcome, 'added', JSON.stringify(r));
  return repo.db.prepare('SELECT width, height, duration FROM media WHERE id = ?').get(r.mediaId);
}

test('zero, negative, NaN and absurd sizes and durations are stored as "unknown", not as numbers', async () => {
  assert.deepEqual(await stored({ width: 0, height: 0, mediaType: 'video', mediaUrl: 'https://i.redd.it/a.mp4', duration: 0 }), { width: null, height: null, duration: null });
  assert.deepEqual(await stored({ width: -5, height: NaN, duration: -1 }), { width: null, height: null, duration: null });
  assert.deepEqual(await stored({ width: 1e9, height: 1e9, duration: Infinity }), { width: null, height: null, duration: null });
});

test('a size reported as a numeric string, or with decimals, is kept as a whole number', async () => {
  assert.deepEqual(await stored({ width: '1080', height: 1349.6, mediaType: 'video', mediaUrl: 'https://i.redd.it/b.mp4', duration: '12.5' }), { width: 1080, height: 1350, duration: 12.5 });
});

test('a width without a height is not half-stored: both or neither', async () => {
  const row = await stored({ width: 800, height: null });
  assert.deepEqual([row.width, row.height], [null, null]);
});

function bareImage() {
  const id = crypto.randomUUID();
  repo.db.prepare(`INSERT INTO media (id, platform, source_key, post_key, media_type, media_url, hash, publish_state)
    VALUES (?, 'rss', ?, ?, 'image', 'https://pic.example/x.jpg', ?, 'published')`).run(id, `rss:s${++n}:0`, `rss:s${n}`, crypto.randomUUID().replace(/-/g, ''));
  return id;
}
const dims = (id) => repo.db.prepare('SELECT width, height FROM media WHERE id = ?').get(id);

test('the thumbnail pass fills in the dimensions of a picture that has none (it downloads the picture anyway)', async () => {
  const id = bareImage();
  await thumbs.sweep({ limit: 50, fetch: async () => ({ status: 200, buffer: GOOD }) });
  assert.deepEqual(dims(id), { width: 640, height: 360 });
});

test('it never overwrites dimensions a source reported, and leaves videos alone (a poster is not the video)', async () => {
  const known = bareImage(); repo.db.prepare('UPDATE media SET width = 1920, height = 1080 WHERE id = ?').run(known);
  const video = bareImage(); repo.db.prepare("UPDATE media SET media_type = 'video', media_url = 'https://pic.example/v.mp4', preview_url = 'https://pic.example/poster.jpg' WHERE id = ?").run(video);
  await thumbs.sweep({ limit: 50, fetch: async () => ({ status: 200, buffer: GOOD }) });
  assert.deepEqual(dims(known), { width: 1920, height: 1080 });
  assert.deepEqual(dims(video), { width: null, height: null });
});

test('RSS: a video enclosure takes the entry\'s media:thumbnail as its poster (it used to be published with none)', () => {
  const rss = require('../src/sources/rss');
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Clips</title>
    <item><title>A clip</title><link>https://v.example/w/1</link><guid>1</guid><pubDate>Fri, 03 Oct 2026 10:00:00 GMT</pubDate>
      <enclosure url="https://v.example/files/1.mp4" type="video/mp4" length="123456"/><media:thumbnail url="https://v.example/posters/1.jpg"/></item>
    <item><title>A photo</title><link>https://v.example/w/2</link><guid>2</guid><pubDate>Fri, 03 Oct 2026 11:00:00 GMT</pubDate>
      <enclosure url="https://v.example/files/2.jpg" type="image/jpeg" length="123456"/><media:thumbnail url="https://v.example/posters/2.jpg"/></item></channel></rss>`;
  const parsed = rss.parseFeed(xml, 'https://v.example/feed.xml');
  const items = parsed.entries.flatMap((e) => rss.entryToItems(e, parsed));
  const clip = items.find((i) => i.mediaType === 'video'); const photo = items.find((i) => i.mediaType === 'image');
  assert.equal(clip.previewUrl, 'https://v.example/posters/1.jpg');
  assert.equal(photo.previewUrl, 'https://v.example/files/2.jpg', 'a photo is its own preview');
});
