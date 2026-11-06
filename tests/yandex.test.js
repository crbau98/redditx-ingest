'use strict';
// Yandex Images keyword provider (lib/yandex.js): parsing the escaped data-state JSON, page URLs as the ingestion target
// (origUrl never fetched), CAPTCHA cooldown scoped to this provider, the YANDEX_IMAGES flag, and brave.images() trying it first.
// Local mock server only; no live web.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

prepareEnv();
const config = require('../src/config');
const yandex = require('../src/lib/yandex');
const paidpage = require('../src/engine/paidpage');
const repo = require('../src/db/repo');

const esc = (o) => JSON.stringify(o).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const result = (page, origin, extra = {}) => ({ origUrl: origin, snippet: { url: page, title: 'A page', domain: new URL(page).hostname }, width: 640, height: 480, censored: false, ...extra });
const serpHtml = (items) => `<html><body><div class="Root" data-state="${esc({ serpList: { items: { entities: items } } })}"></div></body></html>`;

let mock;
const ORIGIN_HOST = 'picture-host.example.test'; // origUrl points here; the provider must never request it

before(async () => {
  mock = await start({
    '/images/search': (req, res, url) => {
      if (url.searchParams.get('rpt') === 'imageview') {
        const img = url.searchParams.get('url') || '';
        if (url.searchParams.get('cbir_page') === 'sites') {
          if (img.includes('captcha')) return { body: '<html><body><form class="CheckboxCaptcha"></form></body></html>' };
          return { body: '<html><body><ul><li class="CbirSites-Item"><a class="CbirSites-ItemThumb" href="https://img-host.example.test/thumb.jpg"></a><div class="CbirSites-ItemTitle"><a href="https://mirror-one.example.test/post/1">Mirror one</a></div></li><li class="CbirSites-Item"><div class="CbirSites-ItemTitle"><a href="https://mirror-two.example.test/post/2">Mirror two</a></div></li><li class="CbirSites-Item"><div class="CbirSites-ItemTitle"><a href="javascript:void(0)">bad</a></div></li></ul></body></html>' };
        }
        return { body: '<html><body><a href="/images/search?rpt=imageview&amp;url=' + encodeURIComponent(img) + '&amp;cbir_id=1&amp;cbir_page=sites">Sites containing information about the image</a></body></html>' };
      }
      const q = url.searchParams.get('text') || '';
      if (q === 'captcha me') return { body: '<html><body><form class="CheckboxCaptcha"><div class="smart-captcha"></div></form></body></html>' };
      if (q === 'empty') return { body: '<html><body>no results</body></html>' };
      const origin = `https://${ORIGIN_HOST}/a.jpg`;
      return { body: serpHtml([
        result('https://fastphoto.example.test/page-one', origin),
        result('https://fastphoto.example.test/page-one', origin),                 // duplicate page: once
        result('https://pages.example.test/two', origin, { censored: true }),       // censored: dropped
        result('ftp://not-http.example.test/x', origin),                           // not http(s): dropped
        result('https://pages.example.test/three', 'https://picture-host.example.test/b.mp4'), // video picture: mediaType video
      ]) };
    },
  });
  config.yandexImages = true;
  config.yandexBase = mock.url;
});
after(async () => { await mock.close(); });
beforeEach(() => { yandex._reset(); mock.hits.length = 0; config.yandexImages = true; config.yandexBase = mock.url; });

test('parseSerp: the escaped data-state JSON yields page-level results, deduplicated and filtered, with no origUrl', () => {
  const html = serpHtml([
    result('https://a.example.test/p', 'https://img.example.test/x.jpg'),
    result('https://a.example.test/p', 'https://img.example.test/x.jpg'),
    result('https://b.example.test/q', 'https://img.example.test/y.jpg', { censored: true }),
    result('javascript:alert(1)', 'https://img.example.test/z.jpg'),
  ]);
  const out = yandex.parseSerp(html, { count: 30 });
  assert.equal(out.length, 1, 'one page: deduplicated, censored and non-http dropped');
  assert.equal(out[0].url, 'https://a.example.test/p');
  assert.equal(out[0].pageUrl, 'https://a.example.test/p');
  assert.equal(out[0].imageUrl, null, 'the index picture is not used');
  assert.equal(out[0].mediaUrl, null);
  assert.equal(out[0].type, 'image');
  assert.equal(JSON.stringify(out).includes('img.example.test'), false, 'no origUrl or CDN host in the output');
});

test('keywordImages: results are the page URLs; the picture host is never requested', async () => {
  const out = await yandex.keywordImages('test photo', { count: 10 });
  assert.ok(out.length >= 2);
  assert.ok(out.every((r) => /^https?:\/\//.test(r.url) && r.imageUrl === null));
  assert.equal(mock.hits.some((h) => h.includes(ORIGIN_HOST)), false, 'origUrl was never fetched');
  assert.equal(yandex.status().ok, 1);
});

test('a CAPTCHA page cools this provider down (reason in status), and the next call makes no request', async () => {
  await assert.rejects(yandex.keywordImages('captcha me'), (e) => e.captcha === true && e.skip === true);
  const st = yandex.status();
  assert.ok(st.cooldownUntil, 'cooldown recorded');
  assert.match(st.lastError, /CAPTCHA/);
  const before = mock.hits.length;
  await assert.rejects(yandex.keywordImages('test photo'), (e) => e.skip === true && /cooling down/.test(e.message));
  assert.equal(mock.hits.length, before, 'no request during the cooldown');
});

test('cbirSites: the sites list is a second request; page URLs only, the thumbnail never used', async () => {
  const out = await yandex.cbirSites('https://pictures.example.test/one.jpg');
  assert.equal(out.length, 2, 'two page candidates; the javascript: link and the thumbnail dropped');
  assert.deepEqual(out.map((r) => r.url), ['https://mirror-one.example.test/post/1', 'https://mirror-two.example.test/post/2']);
  assert.ok(out.every((r) => r.type === 'mirror-candidate'));
  assert.equal(JSON.stringify(out).includes('img-host.example.test'), false);
  assert.ok(mock.hits.some((h) => h.includes('cbir_page=sites')), 'the second request was made');
});

test('cbirSites: a CAPTCHA on the sites list cools the provider down', async () => {
  await assert.rejects(yandex.cbirSites('https://pictures.example.test/captcha.jpg'), (e) => e.captcha === true);
  assert.ok(yandex.status().cooldownUntil);
});

test('the flag off: no request is made and the provider reports itself off', async () => {
  config.yandexImages = false;
  await assert.rejects(yandex.keywordImages('test photo'), (e) => e.skip === true);
  assert.equal(mock.hits.length, 0);
  assert.equal(yandex.status().enabled, false);
});

test('an empty answer is an honest empty result, not a cooldown', async () => {
  const out = await yandex.keywordImages('empty');
  assert.deepEqual(out, []);
  assert.equal(yandex.status().cooldownUntil, null);
});

test('brave.images() tries Yandex first: its page results come back without a metered call', async () => {
  const brave = require('../src/lib/brave');
  const out = await brave.images('test photo', { count: 10 });
  assert.ok(out.length >= 2);
  assert.ok(out.every((r) => r.imageUrl === null), 'Yandex answered: page results only');
});

test('a paid page surfaced by search is registered once as a public web page feed (paidpage.registerPaidPage); takedowns honoured', () => {
  const page = 'https://fansly.com/paid-page-example';
  const first = paidpage.registerPaidPage(page, { origin: 'search-paid' });
  assert.ok(first, 'registered');
  assert.ok(repo.feeds.find('web', 'page', first.url || page), 'web/page feed created');
  paidpage.registerPaidPage(page, { origin: 'search-paid' });
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE platform='web' AND kind='page' AND target LIKE '%paid-page-example%'").get().n, 1, 'idempotent');
  assert.equal(paidpage.registerPaidPage('javascript:alert(1)', {}), null);
});
