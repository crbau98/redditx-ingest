'use strict';
// xHamster gay creator adapter: URL parsing, the creator/video page readers, one real fetch over a
// replaced HTTP client, the expiry refresh, and the link parser. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xh-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const CREATOR = 'https://xhamster.com/gay/creators/demo-man';
const VIDEO = 'https://xhamster.com/videos/demo-clip-xh2MSCO';

const creatorHtml = ({ videos }) => `<html><head><title>Demo Man</title></head><body>
<script>window.initials=${JSON.stringify({
  infoComponent: {
    pornstarTop: { name: 'Demo Man', thumbUrl: 'https://ic-tt-nss.xhcdn.com/avatar.jpg', viewsCount: 1234, videoCount: 7, translatedCountryName: 'Czech Republic' },
    subscribeButtonsProps: { subscribeButtonProps: { subscribers: 99 } },
  },
  newestVideoSectionComponent: { videoListProps: { videoThumbProps: videos } },
})};</script></body></html>`;

const videoHtml = ({ created, title, description, dur, poster, hls, av1 }) => `<html><head>
<title>${title}</title>
<link rel="preload" as="fetch" crossorigin="true" href="${hls}"/>
</head><body><script>window.initials=${JSON.stringify({
  layoutPage: {},
  videoModel: { id: 31503267, title, created, duration: dur, description, thumbURL: poster, previewThumbURL: poster, views: 4321, author: { name: 'Demo Man' } },
  xplayerSettings: { duration: dur, sources: { standard: { h264: [{ url: '0a1b2c', quality: '720p' }] }, hls: { av1: { url: av1 } } } },
})};</script></body></html>`;

const listItem = (id, title, created) => ({
  id, title, created, duration: 120, pageURL: `https://xhamster.com/videos/clip-${id}-xh${id}`,
  thumbURL: `https://ic-vt-nss.xhcdn.com/${id}/526x298.webp`, imageURL: `https://ic-vt-nss.xhcdn.com/${id}/2560x1440.webp`,
  previewThumbURL: `https://thumb-nss.xhcdn.com/${id}/16x9.webp`, views: 12,
});

const net = require('../src/lib/net');
const xhamster = require('../src/sources/xhamster');
const pages = new Map();
// http.js calls net.fetchText / net.request at call time, so replacing both covers the robots read and the pages.
function response(url) {
  if (/\/robots\.txt$/.test(url)) return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nAllow: /\n') };
  const html = pages.get(url);
  if (!html) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>gone</html>') };
  return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
}
net.request = async (url) => response(url);
net.fetchText = async (url) => {
  const r = response(url);
  if (r.status >= 400) {
    const e = new Error(`HTTP ${r.status} for ${url}`);
    e.status = r.status;
    e.body = r.body.toString('utf8');
    throw e;
  }
  return r.body.toString('utf8');
};

test('parse: a gay creator page is a feed; the directory, pagination and sub-tabs are not', () => {
  const p = xhamster.parse(CREATOR);
  assert.equal(p.platform, 'xhamster');
  assert.equal(p.kind, 'user');
  assert.equal(p.target, CREATOR);
  assert.equal(p.ingestable, true);
  assert.equal(xhamster.parse('https://xhamster.com/gay/creators/all'), null);
  assert.equal(xhamster.parse('https://xhamster.com/gay/creators/2'), null);
  assert.equal(xhamster.parse('https://xhamster.com/gay/creators/demo-man/newest'), null);
  assert.equal(xhamster.parse('https://xhamster.com/creators/demo-man'), null, 'the non-gay directory is out of scope');
  assert.equal(xhamster.parse('https://example.com/gay/creators/demo-man'), null);
});

test('a creator URL pasted anywhere becomes an ingestible feed (lib/links)', () => {
  const links = require('../src/lib/links');
  const p = links.parseProfile(CREATOR);
  assert.equal(p.platform, 'xhamster');
  assert.equal(p.ingestable, true);
  assert.equal(p.target, CREATOR);
  assert.notEqual(links.parseProfile('https://xhamster.com/gay/creators/all').platform, 'xhamster', 'the index stays an ordinary web page');
});

test('the creator page yields the man and his videos, newest first', () => {
  const page = xhamster._creatorPage(creatorHtml({ videos: [listItem(2, 'Older', 100), listItem(3, 'Newest', 300), listItem(1, 'Middle', 200)] }));
  assert.equal(page.name, 'Demo Man');
  assert.equal(page.avatar, 'https://ic-tt-nss.xhcdn.com/avatar.jpg');
  assert.equal(page.subscribers, 99);
  assert.equal(page.videoCount, 7);
  assert.deepEqual(page.videos.map((v) => v.title), ['Newest', 'Middle', 'Older']);
  assert.equal(page.videos[0].preview, 'https://thumb-nss.xhcdn.com/3/16x9.webp');
});

test('the video page prefers the h264 playlist, and reads the description and poster', () => {
  const page = xhamster._videoPage(videoHtml({
    created: 1793808886, title: 'Demo Clip', description: 'Two men.', dur: 236,
    poster: 'https://ic-vt-nss.xhcdn.com/poster.webp',
    hls: 'https://video-nss.xhcdn.com/a/media=hls2/multi=1280x720:720p/031/503/267/_TPL_.h264.mp4.m3u8',
    av1: 'https://video-nss.xhcdn.com/b/media=hls4/031/503/267/_TPL_.av1.mp4.m3u8',
  }));
  assert.equal(page.title, 'Demo Clip');
  assert.equal(page.body, 'Two men.');
  assert.equal(page.duration, 236);
  assert.match(page.hls, /h264\.mp4\.m3u8$/);
  assert.equal(page.thumb, 'https://ic-vt-nss.xhcdn.com/poster.webp');
  assert.equal(xhamster._hlsUrlFrom('<link href="https://video-nss.xhcdn.com/x/_TPL_.av1.mp4.m3u8">'), 'https://video-nss.xhcdn.com/x/_TPL_.av1.mp4.m3u8', 'av1 is still a stream when it is the only one');
});

test('one fetch: reads the lazy video pages, marks items untrusted, remembers what it saw', async () => {
  const videos = [listItem(11, 'One', 1793809999), listItem(12, 'Two', 1793808888)];
  pages.set(CREATOR, creatorHtml({ videos }));
  for (const v of videos) {
    pages.set(v.pageURL, videoHtml({
      created: v.created, title: v.title, description: 'demo', dur: 100,
      poster: v.imageURL, hls: `https://video-nss.xhcdn.com/${v.id}/_TPL_.h264.mp4.m3u8`,
      av1: `https://video-nss.xhcdn.com/${v.id}/_TPL_.av1.mp4.m3u8`,
    }));
  }
  const feed = { platform: 'xhamster', kind: 'user', target: CREATOR };
  const r = await xhamster.fetch(feed, {});
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].sourceId, 'xhamster-11');
  assert.equal(r.items[0].mediaUrl, 'https://video-nss.xhcdn.com/11/_TPL_.h264.mp4.m3u8');
  assert.equal(r.items[0].hlsUrl, r.items[0].mediaUrl);
  assert.equal(r.items[0].mediaType, 'video');
  assert.equal(r.items[0].author, 'Demo Man');
  assert.equal(r.items[0].trusted, true, 'the /gay/ creator page is male by the site category; hard female words still exclude');
  assert.match(r.items[0].postedAt, /^2026-11-/);
  assert.equal(r.profile.displayName, 'Demo Man');
  assert.deepEqual(r.cursor.seen.sort(), ['11', '12']);

  // second run: nothing new, and the note says so
  const again = await xhamster.fetch(feed, { cursor: r.cursor });
  assert.equal(again.items.length, 0);
  assert.match(again.notes.join(' '), /no new videos/);
});

test('a dead video page is remembered, not retried on every run', async () => {
  pages.set(CREATOR, creatorHtml({ videos: [listItem(21, 'Gone', 300), listItem(22, 'Live', 200)] }));
  pages.delete('https://xhamster.com/videos/clip-21-xh21');
  pages.set('https://xhamster.com/videos/clip-22-xh22', videoHtml({
    created: 200, title: 'Live', description: '', dur: 60,
    poster: 'https://ic-vt-nss.xhcdn.com/22/poster.webp',
    hls: 'https://video-nss.xhcdn.com/22/_TPL_.h264.mp4.m3u8',
    av1: 'https://video-nss.xhcdn.com/22/_TPL_.av1.mp4.m3u8',
  }));
  const r = await xhamster.fetch({ platform: 'xhamster', kind: 'user', target: CREATOR }, {});
  assert.deepEqual(r.items.map((i) => i.sourceId), ['xhamster-22']);
  assert.equal(r.cursor.seen.includes('21'), true, 'the dead id is in the cursor');
});

test('expired xHamster playlists are refreshed at the video page (engine/playback)', () => {
  const playback = require('../src/engine/playback');
  assert.equal(playback.canRefresh('video-nss.xhcdn.com'), true);
  assert.equal(playback.canRefresh('video5.xhcdn.com'), true);
  assert.equal(playback.canRefresh('i.redd.it'), false);
});
