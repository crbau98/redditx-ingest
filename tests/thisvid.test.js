'use strict';
/** ThisVid member public-videos adapter: parse, page readers, one fetch over a replaced HTTP client. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const MEMBER = 'https://thisvid.com/members/636468/public_videos/';
const VIDEO = 'https://thisvid.com/videos/demo-clip/';

const memberHtml = ({ name, videos, maxPage = 1 }) => {
  const links = videos.map((slug) => `<a href="https://thisvid.com/videos/${slug}/">${slug}</a>`).join('\n');
  const pages = maxPage > 1
    ? Array.from({ length: maxPage - 1 }, (_, i) => `<a href="/members/636468/public_videos/${i + 2}/">${i + 2}</a>`).join('')
    : '';
  return `<html><head><title>${name}'s Public Videos</title></head><body>
<img src="//static.thisvid.com/contents/avatars/1/1.jpg"/>
${links}${pages}</body></html>`;
};

const videoHtml = ({ id, title, mp4, poster }) => `<html><head>
<meta property="og:title" content="${title} - ThisVid.com"/>
<meta property="og:image" content="${poster}"/>
</head><body><script>
var flashvars = {
  video_id: '${id}',
  video_title: '${title}',
  video_categories: 'gay',
  video_tags: 'muscle, amateur',
  video_url: '${mp4}',
  preview_url: '${poster}',
};
</script>
<a class="author" href="https://thisvid.com/members/636468/">Happymouth</a>
</body></html>`;

const net = require('../src/lib/net');
const thisvid = require('../src/sources/thisvid');
const pages = new Map();
function response(url) {
  if (/\/robots\.txt$/.test(url)) {
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nDisallow: /members/\nAllow: /videos/\n') };
  }
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

test('parse: member id and public_videos URL are feeds; categories are not', () => {
  const p = thisvid.parse(MEMBER);
  assert.equal(p.platform, 'thisvid');
  assert.equal(p.kind, 'user');
  assert.equal(p.target, '636468');
  assert.equal(p.ingestable, true);
  assert.equal(thisvid.parse('636468').target, '636468');
  assert.equal(thisvid.parse('https://thisvid.com/categories/gay/'), null);
  assert.equal(thisvid.parse('https://thisvid.com/videos/demo-clip/'), null);
});

test('a member URL pasted anywhere becomes an ingestible feed (lib/links)', () => {
  const links = require('../src/lib/links');
  const p = links.parseProfile(MEMBER);
  assert.equal(p.platform, 'thisvid');
  assert.equal(p.ingestable, true);
  assert.equal(p.target, '636468');
  assert.notEqual(links.parseProfile('https://thisvid.com/categories/gay/').platform, 'thisvid');
});

test('member page lists videos newest-as-listed and reads the display name', () => {
  const page = thisvid._memberPage(memberHtml({ name: 'Happymouth', videos: ['a', 'b', 'c'], maxPage: 3 }));
  assert.equal(page.name, 'Happymouth');
  assert.deepEqual(page.videos.map((v) => v.slug), ['a', 'b', 'c']);
  assert.equal(page.maxPage, 3);
  assert.match(page.avatar, /avatars/);
});

test('video page reads the signed MP4 and poster from flashvars', () => {
  const page = thisvid._videoPage(videoHtml({
    id: '14966293', title: 'Demo Clip',
    mp4: 'https://thisvid.com/get_file/5/abc/14966293.mp4/?v-acctoken=tok',
    poster: 'https://static.thisvid.com/contents/videos_screenshots/1/preview.jpg',
  }));
  assert.equal(page.videoId, '14966293');
  assert.equal(page.title, 'Demo Clip');
  assert.match(page.mediaUrl, /get_file/);
  assert.match(page.poster, /preview\.jpg/);
  assert.deepEqual(page.tags, ['muscle', 'amateur']);
});

test('fetch: reads the member list then each allowed video page', async () => {
  pages.clear();
  pages.set(MEMBER, memberHtml({ name: 'Happymouth', videos: ['demo-clip', 'other'] }));
  pages.set(VIDEO, videoHtml({
    id: '99', title: 'Demo Clip',
    mp4: 'https://thisvid.com/get_file/5/abc/99.mp4/?v-acctoken=tok',
    poster: 'https://static.thisvid.com/preview.jpg',
  }));
  pages.set('https://thisvid.com/videos/other/', videoHtml({
    id: '100', title: 'Other',
    mp4: 'https://thisvid.com/get_file/5/def/100.mp4/?v-acctoken=tok',
    poster: 'https://static.thisvid.com/other.jpg',
  }));
  const r = await thisvid.fetch({ target: '636468', kind: 'user' }, { limit: 2 });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].sourceId, 'thisvid-99');
  assert.match(r.items[0].mediaUrl, /get_file/);
  assert.equal(r.profile.displayName, 'Happymouth');
  assert.equal(r.via, 'thisvid-html');
});
