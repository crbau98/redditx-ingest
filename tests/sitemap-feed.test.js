'use strict';
// Lane 5: studio sitemaps. A sitemap is a feed of pages, not of media, and two real shapes break the
// dumb path: cockyboys answers a redirect chain and an old urlset, gaywire answers the JavaScript shell
// with text/html although the URL says .xml. The root element decides, never the Content-Type; the
// pages are then read as web pages, capped, and the ones already tried are remembered.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let rss; let settings;

const page = (id, extra = '') => `<html><head><title>Scene ${id}</title>
<meta property="og:image" content="http://127.0.0.1:${mock.port}/img/${id}.jpg" /></head>
<body><img src="/img/${id}.jpg" width="800" height="1000" alt="Scene ${id}" />${extra}</body></html>`;

let sitemapBody;
let childHits;

before(async () => {
  mock = await start({
    '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } }),
    '/scene/11/first/': () => ({ body: page(11), headers: { 'content-type': 'text/html' } }),
    '/scene/12/second/': () => ({ body: page(12), headers: { 'content-type': 'text/html' } }),
    '/sitemap.xml': () => ({ body: sitemapBody, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    '/index.xml': () => ({ body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc><![CDATA[http://127.0.0.1:${mock.port}/old.xml]]></loc><lastmod>2024-01-01T00:00:00+00:00</lastmod></sitemap>
      <sitemap><loc><![CDATA[http://127.0.0.1:${mock.port}/new.xml]]></loc><lastmod>2026-11-05T00:00:00+00:00</lastmod></sitemap>
      <sitemap><loc><![CDATA[http://127.0.0.1:${mock.port}/gone.xml]]></loc><lastmod>2026-11-06T00:00:00+00:00</lastmod></sitemap>
    </sitemapindex>`, headers: { 'content-type': 'text/xml' } }),
    '/new/1/': () => ({ body: page('n1'), headers: { 'content-type': 'text/html' } }),
    '/new/2/': () => ({ body: page('n2'), headers: { 'content-type': 'text/html' } }),
    '/old/1/': () => ({ body: page('o1'), headers: { 'content-type': 'text/html' } }),
    '/old.xml': () => ({ body: `<urlset><url><loc>http://127.0.0.1:${mock.port}/old/1/</loc></url></urlset>`, headers: { 'content-type': 'text/xml' } }),
    '/new.xml': () => ({ body: `<urlset><url><loc>http://127.0.0.1:${mock.port}/new/1/</loc></url><url><loc>http://127.0.0.1:${mock.port}/new/2/</loc></url></urlset>`, headers: { 'content-type': 'text/xml' } }),
  });
  prepareEnv({});
  rss = require('../src/sources/rss');
  settings = require('../src/settings');
  const feedMod = require('../src/db/repo');
  feedMod.db.exec('select 1');
});

after(async () => { await mock.close(); });

const feed = (target) => ({ platform: 'rss', kind: 'feed', target: `${mock.url}${target}` });
const ctx = (cursor = {}) => ({ cursor, limit: 100, aborted: () => false });

test('a sitemap served as text/html is read as XML, never as an HTML page', async () => {
  sitemapBody = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>http://127.0.0.1:${mock.port}/tag/ignored/</loc></url>
    <url><loc>http://127.0.0.1:${mock.port}/scene/11/first/</loc></url>
    <url><loc>http://127.0.0.1:${mock.port}/scene/12/second/</loc></url>
  </urlset>`;
  mock.hits.length = 0;

  assert.equal(rss.looksLikeSitemap(sitemapBody), true, 'the root element decides');
  assert.equal(rss.looksLikeHtml(sitemapBody, 'text/html; charset=utf-8'), false, 'so it is not treated as a page');

  const out = await rss.fetch(feed('/sitemap.xml'), ctx());
  assert.equal(out.via, 'sitemap');
  assert.ok(out.items.length >= 2, 'the pages behind the sitemap were read');
  assert.ok(out.items.every((i) => /\/img\//.test(i.mediaUrl)), 'the media came from the pages');
  assert.ok(out.notes.some((n) => /^127\.0\.0\.1: \d+ items? from 3 pages?(, \d+ failed)?$/.test(n)), 'the studio yield is reported, failures included');
  assert.equal(out.cursor.seen.length, 3, 'the pages tried are remembered');
  assert.ok(!mock.hits.some((h) => h === 'GET /feed' || h === 'GET /rss'), 'no feed discovery was tried');
});

test('an index walks to the newest child that exists, and already-tried pages are skipped', async () => {
  mock.hits.length = 0;
  const out = await rss.fetch(feed('/index.xml'), ctx());
  assert.equal(out.via, 'sitemap');
  assert.ok(mock.hits.some((h) => h.includes('/gone.xml')), 'the newest child was tried');
  assert.ok(mock.hits.some((h) => h.includes('/new.xml')), 'and the next one answered');
  assert.ok(out.items.length >= 2, 'its pages were read');
  assert.ok(out.notes.some((n) => /gone\.xml — HTTP 404/.test(n)), 'the dead child is reported, not fatal');

  const second = await rss.fetch(feed('/index.xml'), { ...ctx(out.cursor) });
  assert.ok(!second.items.length, 'nothing is read twice');
  assert.ok(second.notes.some((n) => /no new pages/.test(n)));
});

test('the page cap is a real cap and 0 reads nothing', async () => {
  sitemapBody = `<urlset>${Array.from({ length: 9 }, (_, i) => `<url><loc>http://127.0.0.1:${mock.port}/c/${i + 1}/</loc></url>`).join('')}</urlset>`;
  settings.update({ sitemapPagesPerRun: 3 });
  mock.hits.length = 0;
  const out = await rss.fetch(feed('/sitemap.xml'), ctx());
  const pages = mock.hits.filter((h) => /\/c\/\d+/.test(h));
  assert.equal(pages.length, 3, 'three pages, no more');

  settings.update({ sitemapPagesPerRun: 0 });
  mock.hits.length = 0;
  const off = await rss.fetch(feed('/sitemap.xml'), ctx());
  assert.equal(off.items.length, 0);
  assert.equal(mock.hits.filter((h) => /\/c\/\d+/.test(h)).length, 0);
  assert.ok(off.notes.some((n) => /off/.test(n)));
  settings.update({ sitemapPagesPerRun: 4 });
});

test('a sitemap URL that answers the JavaScript shell falls back to the site feed, then reads its pages', async () => {
  const srv = await start({
    '/robots.txt': () => ({ body: 'User-agent: *\nAllow: /\n' }),
    '/sitemap.xml': () => ({ body: '<!DOCTYPE html><html><head><link rel="alternate" type="application/rss+xml" href="/feed" /></head><body><div id="root"></div></body></html>', headers: { 'content-type': 'text/html' } }),
    '/feed': () => ({ body: `<?xml version="1.0"?><rss><channel><title>Gaywire</title>
      <item><title>a</title><link>http://127.0.0.1:${srv.port}/scene/7/</link><pubDate>Thu, 05 Nov 2026 20:00:00 GMT</pubDate></item>
      <item><title>b</title><link>http://127.0.0.1:${srv.port}/scene/8/</link><pubDate>Thu, 05 Nov 2026 21:00:00 GMT</pubDate></item>
      </channel></rss>`, headers: { 'content-type': 'application/rss+xml' } }),
    '/scene/7/': () => ({ body: page('s7'), headers: { 'content-type': 'text/html' } }),
    '/scene/8/': () => ({ body: page('s8'), headers: { 'content-type': 'text/html' } }),
  });
  try {
    const out = await rss.fetch({ platform: 'rss', kind: 'feed', target: `${srv.url}/sitemap.xml` }, ctx());
    assert.equal(out.via, 'sitemap');
    const paths = new Set(out.items.map((i) => new URL(i.mediaUrl).pathname));
    assert.ok(paths.has('/img/s7.jpg') && paths.has('/img/s8.jpg'), 'both linked pages were read as pages');
    assert.ok(out.notes.some((n) => /JavaScript shell/.test(n)), 'the fallback is reported');
  } finally { await srv.close(); }
});

test('a real HTML page still goes down the feed-discovery path', async () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="/real.xml" /></head><body>x</body></html>`;
  const srv = await start({
    '/site': () => ({ body: html, headers: { 'content-type': 'text/html' } }),
    '/real.xml': () => ({ body: `<?xml version="1.0"?><rss><channel><title>t</title><item><title>a</title><link>https://example.org/a</link></item></channel></rss>`, headers: { 'content-type': 'application/rss+xml' } }),
  });
  try {
    const out = await rss.fetch({ platform: 'rss', kind: 'feed', target: `${srv.url}/site` }, ctx());
    assert.equal(out.via, 'feed-discovered');
    assert.equal(out.items.length, 0, 'an entry with no media yields no item');
  } finally { await srv.close(); }
});
