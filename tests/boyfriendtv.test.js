'use strict';
// BoyfriendTV catalogue adapter: URL parsing, the two page readers, one fetch over a replaced HTTP
// client (fresh RSS first, then a resumable sitemap walk under a hard daily cap), robots and 451, and
// the playback hook. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bftv-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const HOME = 'https://www.boyfriendtv.in/';
const RSS = 'https://www.boyfriendtv.in/rss/videos.xml';
const INDEX = 'https://cdn77.boyfriendtv.in/sitemaps/boyfriendtv.in/sitemaps.xml';
const child = (n) => `https://cdn77.boyfriendtv.in/sitemaps/boyfriendtv.in/sitemap_videos_${n}.xml`;
const video = (id) => `https://www.boyfriendtv.in/videos/${id}/demo/`;
const embedUrl = (id) => `https://www.boyfriendtv.in/embed/${id}/49877/600/338/`;

const pageHtml = (id, { title = `Video ${id}`, poster = `https://cdn77-t.boyfriendtv.com/${id}.jpg` } = {}) => `<html><head>
<title>${title} | BoyFriendTV</title>
<meta property="og:title" content="${title}" />
<meta property="og:image" content="${poster}" />
<meta property="og:video:duration" content="754" />
<script type="application/ld+json">{"@type":"VideoObject","uploadDate":"2026-11-06T06:09:03+00:00","duration":"PT12M34S"}</script>
</head><body>
<a class="model-card user-uploader" href="/profiles/1/" title="Demo Uploader"><img src="https://x/u.jpg" /></a>
<a href="/tags/anal/">anal</a><a href="/tags/threesome/">threesome</a>
<a href="/pornstars/demo-man-4085/">Demo Man</a>
<iframe src="${embedUrl(id)}"></iframe>
</body></html>`;

const embedHtml = (id) => `<html><body><script>
  player.setup({ sources: {"hlsAuto":"https:\\/\\/cdn.boyfriendtv.in\\/key=abc,end=1793952928\\/media=hls4A\\/multi=854x480:${id}\\/2026-11\\/_TPL_.mp4"},
    poster: 'https://cdn77-t.boyfriendtv.com/${id}.jpg' });
</script></body></html>`;

const rssXml = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.map((id) => `
  <item><title><![CDATA[Video ${id}]]></title><link>${video(id)}</link>
  <thumb>https://cdn77-t.boyfriendtv.com/${id}.jpg</thumb><duration>754</duration>
  <pubDate>Fri, 06 Nov 2026 06:09:03 +0000</pubDate></item>`).join('')}</channel></rss>`;

const sitemapIndex = (kids) => `<?xml version="1.0"?><sitemapindex>${kids.map((k) => `<sitemap><loc>${k}</loc></sitemap>`).join('')}</sitemapindex>`;
const urlset = (ids) => `<?xml version="1.0"?><urlset>${ids.map((id) => `<url><loc>${video(id)}</loc></url>`).join('')}</urlset>`;

const net = require('../src/lib/net');
const settings = require('../src/settings');
const boyfriendtv = require('../src/sources/boyfriendtv');

const pages = new Map();
const hits = [];
const robots = new Map();
let rss = rssXml([]);

function response(url) {
  if (/\/robots\.txt$/.test(url)) {
    const body = robots.get(new URL(url).origin) || 'User-agent: *\nAllow: /\n';
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body) };
  }
  const got = pages.get(url);
  hits.push(url);
  if (!got) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>gone</html>') };
  if (typeof got === 'object' && got.status) return got;
  return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(got) };
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

function seedPages(ids) {
  for (const id of ids) {
    pages.set(video(id), pageHtml(id));
    pages.set(embedUrl(id), embedHtml(id));
  }
}

function reset() {
  pages.clear();
  hits.length = 0;
  robots.clear();
  rss = rssXml([]);
  settings.update({ boyfriendtvPagesPerRun: 40, boyfriendtvDailyPages: 200 });
}

test('parse: the site root (either mirror) is the catalogue; a video page is not', () => {
  const p = boyfriendtv.parse(HOME);
  assert.equal(p.platform, 'boyfriendtv');
  assert.equal(p.kind, 'catalog');
  assert.equal(p.target, HOME);
  assert.equal(p.ingestable, true);
  assert.equal(boyfriendtv.parse('https://www.boyfriendtv.com/').target, HOME, 'the .com root normalises to the readable mirror');
  assert.equal(boyfriendtv.parse('https://www.boyfriendtv.in/rss/videos.xml').kind, 'catalog');
  assert.equal(boyfriendtv.parse(video(1)), null);
  assert.equal(boyfriendtv.parse('https://example.com/'), null);
});

test('a video page reads og:title, poster, uploader, tags, duration and its player frame', () => {
  const p = boyfriendtv._videoPage(pageHtml(7, { title: '3 WAY PLAY' }), video(7));
  assert.equal(p.title, '3 WAY PLAY');
  assert.equal(p.poster, 'https://cdn77-t.boyfriendtv.com/7.jpg');
  assert.equal(p.author, 'Demo Uploader');
  assert.deepEqual(p.tags, ['anal', 'threesome']);
  assert.equal(p.duration, 754);
  assert.equal(p.uploaded, '2026-11-06T06:09:03+00:00');
  assert.equal(p.embed, embedUrl(7));
});

test('the player frame yields its signed HLS master, unescaped', () => {
  assert.equal(boyfriendtv._hlsFromEmbed(embedHtml(9)),
    'https://cdn.boyfriendtv.in/key=abc,end=1793952928/media=hls4A/multi=854x480:9/2026-11/_TPL_.mp4');
  assert.equal(boyfriendtv._hlsFromEmbed('<html>no player</html>'), null);
});

test('resolve re-reads the stored permalink (encoded slug, no unicode redirect) for a fresh stream', async () => {
  reset();
  const slug = 'https://www.boyfriendtv.in/videos/1751970/gay-chinese-vietsub-coi-m%C3%A0-n%C6%B0ng-r%E1%BA%BFn-h%E1%BA%BFt/';
  pages.clear();
  pages.set(slug, pageHtml('1751970'));
  pages.set(embedUrl('1751970'), embedHtml('1751970'));
  const out = await boyfriendtv.resolve(slug);
  assert.equal(out.mediaUrl, 'https://cdn.boyfriendtv.in/key=abc,end=1793952928/media=hls4A/multi=854x480:1751970/2026-11/_TPL_.mp4');
  assert.equal(await boyfriendtv.resolve('https://www.boyfriendtv.in/videos/1751970/'), null, 'a bare-id URL is not used');
  assert.equal(await boyfriendtv.resolve('https://example.com/videos/1/x/'), null);
});

test('one fetch: the RSS list comes first, in its order, with the embed stream', async () => {
  reset();
  seedPages(['111', '222', '333']);
  rss = rssXml(['111', '222', '333']);
  pages.set(RSS, rss);
  const r = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, {});
  assert.deepEqual(r.items.map((i) => i.sourceId), ['bftv-111', 'bftv-222', 'bftv-333'].slice(0, 3));
  assert.equal(r.items[0].mediaUrl, 'https://cdn.boyfriendtv.in/key=abc,end=1793952928/media=hls4A/multi=854x480:111/2026-11/_TPL_.mp4');
  assert.equal(r.items[0].hlsUrl, r.items[0].mediaUrl);
  assert.equal(r.items[0].mediaType, 'video');
  assert.equal(r.items[0].trusted, true);
  assert.equal(r.items[0].permalink, video('111'));
  assert.equal(r.items[0].previewUrl, 'https://cdn77-t.boyfriendtv.com/111.jpg');
  assert.match(r.items[0].title, /Video 111/);
  assert.equal(r.items[0].author, 'Demo Uploader');
  assert.match(r.items[0].postedAt, /^2026-11-06/);
  assert.deepEqual(r.cursor.seen, ['111', '222', '333']);
});

test('the sitemap walk resumes at the stored offset and does not re-read what it saw', async () => {
  reset();
  pages.set(INDEX, sitemapIndex([child(1)]));
  pages.set(child(1), urlset(['1', '2', '3', '4', '5']));
  seedPages(['1', '2', '3', '4', '5']);
  settings.update({ boyfriendtvPagesPerRun: 2, boyfriendtvDailyPages: 200 });

  const first = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, {});
  assert.deepEqual(first.items.map((i) => i.sourceId), ['bftv-1', 'bftv-2']);
  assert.equal(first.cursor.child, child(1));
  assert.equal(first.cursor.offset, 2);

  hits.length = 0;
  const second = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, { cursor: first.cursor });
  assert.deepEqual(second.items.map((i) => i.sourceId), ['bftv-3', 'bftv-4'], 'continues where the cursor stopped');
  assert.equal(hits.filter((u) => /\/videos\/1\//.test(u)).length, 0, 'page 1 is not read again');
  assert.equal(second.cursor.offset, 4);
});

test('a finished sitemap moves the cursor to the next child', async () => {
  reset();
  pages.set(INDEX, sitemapIndex([child(1), child(2)]));
  pages.set(child(1), urlset(['10']));
  pages.set(child(2), urlset(['11']));
  seedPages(['10', '11']);
  const first = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, {});
  assert.deepEqual(first.items.map((i) => i.sourceId), ['bftv-10', 'bftv-11']);
  assert.equal(first.cursor.child, child(2));
  assert.equal(first.cursor.offset, 0, 'the last child is finished, so the cursor sits at its start');
});

test('the hard daily cap stops the run and survives into the cursor', async () => {
  reset();
  pages.set(INDEX, sitemapIndex([child(1)]));
  pages.set(child(1), urlset(['21', '22', '23', '24']));
  seedPages(['21', '22', '23', '24']);
  settings.update({ boyfriendtvPagesPerRun: 10, boyfriendtvDailyPages: 2 });

  const r = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, {});
  assert.equal(r.items.length, 2);
  assert.equal(r.cursor.pagesToday, 2);
  assert.match(r.notes.join(' '), /daily page cap reached/);

  hits.length = 0;
  const later = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, { cursor: r.cursor });
  assert.equal(later.items.length, 0);
  assert.equal(hits.filter((u) => /cdn77/.test(u)).length, 0, 'no sitemap read either');
  assert.match(later.notes.join(' '), /daily page cap/);
  assert.equal(later.cursor.pagesToday, 2);
});

test('a new day resets the daily counter', async () => {
  reset();
  pages.set(INDEX, sitemapIndex([child(1)]));
  pages.set(child(1), urlset(['31', '32']));
  seedPages(['31', '32']);
  settings.update({ boyfriendtvPagesPerRun: 5, boyfriendtvDailyPages: 1 });
  const r = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, {
    cursor: { seen: [], child: child(1), offset: 1, day: '2020-01-01', pagesToday: 99 },
  });
  assert.equal(r.items[0].sourceId, 'bftv-32');
  assert.equal(r.cursor.pagesToday, 1);
});

test('a page removed under 451 is remembered, not fatal', async () => {
  reset();
  pages.set(INDEX, sitemapIndex([child(1)]));
  pages.set(child(1), urlset(['41', '42']));
  pages.set(video('41'), { status: 451, headers: { 'content-type': 'text/html' }, body: Buffer.from('removed') });
  pages.set(video('42'), pageHtml('42'));
  pages.set(embedUrl('42'), embedHtml('42'));
  const r = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, {});
  assert.deepEqual(r.items.map((i) => i.sourceId), ['bftv-42']);
  assert.match(r.notes.join(' '), /41: removed \(HTTP 451\)/);
});

test('a robots.txt disallow on the page host skips the read', async () => {
  reset();
  robots.set('https://boyfriendtv.in', 'User-agent: *\nDisallow: /videos/\n');
  pages.set(INDEX, sitemapIndex([child(1)]));
  pages.set(child(1), urlset([]).replace('</urlset>', `<url><loc>https://boyfriendtv.in/videos/51/demo/</loc></url></urlset>`));
  pages.set('https://boyfriendtv.in/videos/51/demo/', pageHtml('51'));
  pages.set(embedUrl('51'), embedHtml('51'));
  const r = await boyfriendtv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: HOME }, {});
  assert.equal(r.items.length, 0);
  assert.match(r.notes.join(' '), /robots\.txt disallows/);
  assert.equal(r.cursor.pagesToday, 0, 'a robots skip costs no page budget');
});

test('expired signed playlists are refreshed at the video page (engine/playback)', () => {
  const playback = require('../src/engine/playback');
  assert.equal(playback.canRefresh('cdn.boyfriendtv.in'), true);
  assert.equal(playback.canRefresh('cdn.boyfriendtv.com'), true);
  assert.equal(playback.canRefresh('i.redd.it'), false);
});
