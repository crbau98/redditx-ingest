'use strict';
// Pornhub model/pornstar adapter: URL parsing, the page readers, one fetch over a replaced HTTP
// client, the directory parse, the expiry refresh and the link parser. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const MODEL = 'https://www.pornhub.com/model/demo-man';
const VIDEO_1 = 'https://www.pornhub.com/view_video.php?viewkey=aaa111';
const VIDEO_2 = 'https://www.pornhub.com/view_video.php?viewkey=bbb222';

const card = ({ vkey, title, dur = '18:01', added = '3 weeks ago', views = '70.9K', segment = 'gay' }) => `
  <li class="pcVideoListItem js-pop videoblock videoBox  "
      id="v${vkey}"
      data-video-vkey="${vkey}"
      data-segment="${segment}"
      data-entrycode="VidPg-premVid">
    <div class="wrap flexibleHeight gayPorn">
      <a href="/view_video.php?viewkey=${vkey}" title="${title}">
        <img src="https://pix-fl.phncdn.com/c6531/videos/${vkey}/320x180.jpg" alt="${title}" />
        <div class="marker-overlays"><var class="duration">${dur}</var></div>
      </a>
      <div class="videoDetailsBlock"><div><span class="views"><var>${views}</var> views</span></div>
        <var class="added">${added}</var></div>
    </div>
  </li>`;

const modelHtml = (cards) => `<html><head><title>Demo Man Gay Porn Videos</title></head><body>
  <div class="topProfileHeader"><div id="avatarPicture"><img id="getAvatar" src="https://ei.phncdn.com/avatar-demo.jpg" /></div>
  <div class="name"><h1 itemprop="name"> Demo Man </h1></div></div>
  <ul class="videoList">${cards.join('')}</ul></body></html>`;

const videoHtml = ({ title, dur = 1081, hls = 'https://ev-h.phncdn.com/hls/1080P.mp4/master.m3u8?h=x', info = '2 weeks ago' }) => `<html><head>
  <title>${title} - Pornhub Gay</title></head><body>
  <div class="videoInfo">${info}</div>
  <script>var flashvars_492128815 = ${JSON.stringify({
    video_title: title,
    video_duration: dur,
    image_url: 'https://pix-cdn77.phncdn.com/poster.jpg',
    mediaDefinitions: [
      { format: 'mp4', quality: '[]', videoUrl: 'https://www.pornhub.com/video/get_media?s=abc' },
      { format: 'hls', quality: '240', videoUrl: 'https://ev-h.phncdn.com/hls/240P.mp4/master.m3u8?h=x' },
      { format: 'hls', quality: '1080', videoUrl: hls, height: 1080, width: 1920 },
    ],
  })};</script></body></html>`;

const net = require('../src/lib/net');
const pornhub = require('../src/sources/pornhub');
const pages = new Map();
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

test('parse: a model or pornstar page is a feed; sub-pages and video links are not', () => {
  assert.equal(pornhub.parse(MODEL).target, MODEL);
  assert.equal(pornhub.parse('https://www.pornhub.com/pornstar/demo-man').platform, 'pornhub');
  assert.equal(pornhub.parse('https://www.pornhub.com/model/demo-man/videos'), null, 'robots.txt disallows /model/<slug>/<sub>');
  assert.equal(pornhub.parse('https://www.pornhub.com/model/demo-man/live'), null);
  assert.equal(pornhub.parse('https://www.pornhub.com/view_video.php?viewkey=abc'), null);
  assert.equal(pornhub.parse('https://www.pornhub.com/gay/pornstars'), null);
  assert.equal(pornhub.parse('https://example.com/model/demo-man'), null);
});

test('a model URL pasted anywhere becomes an ingestible feed (lib/links)', () => {
  const links = require('../src/lib/links');
  const p = links.parseProfile(MODEL);
  assert.equal(p.platform, 'pornhub');
  assert.equal(p.ingestable, true);
  assert.equal(p.target, MODEL);
  assert.equal(links.parseProfile('https://www.pornhub.com/pornstar/demo-man').kind, 'user');
  assert.notEqual(links.parseProfile('https://www.pornhub.com/view_video.php?viewkey=abc').platform, 'pornhub');
});

test('the model page yields the man and the gay cards, keeping the page order', () => {
  const page = pornhub._modelPage(modelHtml([
    card({ vkey: 'aaa111', title: 'Newest', added: '2 days ago', views: '1.2M' }),
    card({ vkey: 'bbb222', title: 'Older', added: '3 weeks ago' }),
    card({ vkey: 'ccc333', title: 'A straight scene', segment: 'straight' }),
  ]));
  assert.equal(page.name, 'Demo Man');
  assert.equal(page.avatar, 'https://ei.phncdn.com/avatar-demo.jpg');
  assert.deepEqual(page.videos.map((v) => v.title), ['Newest', 'Older'], 'only the gay segment is read');
  assert.equal(page.videos[0].url, VIDEO_1);
  assert.equal(page.videos[0].views, 1200000);
  assert.equal(page.videos[0].duration, 1081, '18:01');
  assert.match(pornhub._relativeIso('3 weeks ago'), /^20\d\d-/);
  assert.equal(pornhub._relativeIso('56 years ago'), null, 'the site\'s age bug is not a 1970 date');
});

test('the profile picture falls back to og:image when the avatar markup is gone', () => {
  const html = `<html><head><meta property="og:image" content="https://ei.phncdn.com/og-man.jpg" /></head><body><h1>Og Man</h1></body></html>`;
  assert.equal(pornhub._modelPage(html).avatar, 'https://ei.phncdn.com/og-man.jpg');
});

test('the video page picks the best HLS playlist and reads the date and poster', () => {
  const page = pornhub._videoPage(videoHtml({ title: 'Demo Clip' }));
  assert.equal(page.title, 'Demo Clip');
  assert.equal(page.duration, 1081);
  assert.equal(page.hls, 'https://ev-h.phncdn.com/hls/1080P.mp4/master.m3u8?h=x');
  assert.equal(page.thumb, 'https://pix-cdn77.phncdn.com/poster.jpg');
  assert.match(page.postedAt, /^20\d\d-/);
});

test('one fetch: reads the latest video pages, marks items trusted, remembers what it saw', async () => {
  const cards = [
    card({ vkey: 'aaa111', title: 'One', added: '2 days ago' }),
    card({ vkey: 'bbb222', title: 'Two', added: '3 weeks ago' }),
  ];
  pages.set(MODEL, modelHtml(cards));
  pages.set(VIDEO_1, videoHtml({ title: 'One', hls: 'https://ev-h.phncdn.com/hls/one/master.m3u8' }));
  pages.set(VIDEO_2, videoHtml({ title: 'Two', hls: 'https://ev-h.phncdn.com/hls/two/master.m3u8' }));

  const feed = { platform: 'pornhub', kind: 'user', target: MODEL };
  const r = await pornhub.fetch(feed, {});
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].sourceId, 'pornhub-aaa111');
  assert.equal(r.items[0].mediaUrl, 'https://ev-h.phncdn.com/hls/one/master.m3u8');
  assert.equal(r.items[0].hlsUrl, r.items[0].mediaUrl);
  assert.equal(r.items[0].mediaType, 'video');
  assert.equal(r.items[0].author, 'Demo Man');
  assert.equal(r.items[0].trusted, true, 'the site labels the segment gay; the hard female words still exclude');
  assert.equal(r.items[0].permalink, VIDEO_1);
  assert.match(r.items[0].postedAt, /^20\d\d-/);
  assert.equal(r.profile.displayName, 'Demo Man');
  assert.deepEqual(r.cursor.seen.sort(), ['aaa111', 'bbb222']);

  const again = await pornhub.fetch(feed, { cursor: r.cursor });
  assert.equal(again.items.length, 0);
  assert.match(again.notes.join(' '), /no new videos/);
});

test('a dead video page is remembered, not retried on every run', async () => {
  pages.set(MODEL, modelHtml([
    card({ vkey: 'ddd444', title: 'Gone' }),
    card({ vkey: 'eee555', title: 'Live' }),
  ]));
  pages.delete('https://www.pornhub.com/view_video.php?viewkey=ddd444');
  pages.set('https://www.pornhub.com/view_video.php?viewkey=eee555', videoHtml({ title: 'Live' }));
  const r = await pornhub.fetch({ platform: 'pornhub', kind: 'user', target: MODEL }, {});
  assert.deepEqual(r.items.map((i) => i.sourceId), ['pornhub-eee555']);
  assert.equal(r.cursor.seen.includes('ddd444'), true, 'the dead id is in the cursor');
});

test('a page with no gay cards is a clean empty read, not an error', async () => {
  pages.set('https://www.pornhub.com/model/straight-guy', modelHtml([card({ vkey: 'fff666', title: 'Straight', segment: 'straight' })]));
  const r = await pornhub.fetch({ platform: 'pornhub', kind: 'user', target: 'https://www.pornhub.com/model/straight-guy' }, {});
  assert.equal(r.items.length, 0);
  assert.match(r.notes.join(' '), /no gay videos/);
});

test('the gay directory yields each performer once, and discovery is wired to it', () => {
  const html = `<html><body><ul>
    <li class="modelLi performerCard"><div class="wrap">
      <a href="/model/demo-man"><img alt="Demo Man" data-thumb_url="https://ei.phncdn.com/avatar.jpg" /></a>
      <div class="performerVideosViewsCount"><span class="videosNumber performerCount">178 Videos</span>
      <span class="viewsNumber performerCount">14.4M Views</span></div></div></li>
    <li class="modelLi performerCard"><div class="wrap">
      <a href="/model/demo-man"><img alt="Demo Man again" /></a></div></li>
    <li class="modelLi performerCard"><div class="wrap">
      <a href="/pornstar/other-man"><img alt="Other Man" /></a></div></li>
  </ul></body></html>`;
  const list = pornhub.modelsFromDirectory(html);
  assert.deepEqual(list.map((c) => c.slug), ['demo-man', 'other-man']);
  assert.equal(list[0].url, 'https://www.pornhub.com/model/demo-man');
  assert.equal(list[0].views, 14400000);
  assert.equal(list[1].kind, 'pornstar');
  const discovery = require('../src/engine/discovery');
  assert.equal(typeof discovery.pornhubDiscovery, 'function', 'the directory step is part of the discovery run');
});

test('expired Pornhub playlists are refreshed at the video page (engine/playback)', () => {
  const playback = require('../src/engine/playback');
  assert.equal(playback.canRefresh('ev-h.phncdn.com'), true);
  assert.equal(playback.canRefresh('pix-cdn77.phncdn.com'), true);
  assert.equal(playback.canRefresh('i.redd.it'), false);
});

test('the media proxy sends Pornhub as the Referer for every phncdn.com node', () => {
  const proxy = require('../src/routes/proxy');
  assert.equal(proxy._refererFor('hv-h.phncdn.com'), 'https://www.pornhub.com/', 'a CDN-origin Referer is refused with 412');
  assert.equal(proxy._refererFor('ev-h.phncdn.com'), 'https://www.pornhub.com/');
  assert.equal(proxy._refererFor('pix-cdn77.phncdn.com'), 'https://www.pornhub.com/');
  assert.equal(proxy._refererFor('cdn.gff.network'), 'https://gayforfans.com/');
  assert.equal(proxy._refererFor('i.redd.it'), null, 'everything else keeps the generic origin referer');
});
