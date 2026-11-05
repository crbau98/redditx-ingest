'use strict';
// Reverse-image mirror candidates from the image-match pass: one Yandex sites lookup per creator, review-queue rows only,
// a paid page goes through registerPaidPage, the store host is never sent, and nothing is matched automatically.
// Local mock server only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

prepareEnv();
const config = require('../src/config');
const repo = require('../src/db/repo');
const yandex = require('../src/lib/yandex');
const imagematch = require('../src/engine/imagematch');

const sitesHtml = '<html><body><ul>'
  + '<li class="CbirSites-Item"><div class="CbirSites-ItemTitle"><a href="https://mirror-page.example.test/post/9">Mirror post</a></div></li>'
  + '<li class="CbirSites-Item"><div class="CbirSites-ItemTitle"><a href="https://fansly.com/mirror-creator-x">Paid mirror</a></div></li>'
  + '</ul></body></html>';
let mock;
before(async () => {
  mock = await start({
    '/images/search': (req, res, url) => {
      if (url.searchParams.get('cbir_page') === 'sites') return { body: sitesHtml };
      return { body: '<html><body><a href="/images/search?rpt=imageview&amp;url=x&amp;cbir_id=1&amp;cbir_page=sites">Sites</a></body></html>' };
    },
  });
  config.yandexImages = true;
  config.yandexBase = mock.url;
  repo.db.prepare("INSERT INTO creators (id, handle, display_name, scope, origin) VALUES ('cbir-creator', 'cbirhandle', 'Cbir Creator', 'in', 'test')").run();
  repo.db.prepare(`INSERT INTO media (id, platform, media_type, media_url, hash, creator_id, publish_state, phash, seq)
    VALUES ('cbir-ref', 'web', 'image', 'https://pictures.example.test/reference.jpg', 'h1', 'cbir-creator', 'published', '0123456789abcdef', 1)`).run();
  repo.db.prepare(`INSERT INTO media (id, platform, media_type, media_url, hash, creator_id, publish_state, phash, seq)
    VALUES ('cbir-store', 'web', 'image', 'https://media.prism.invalid/v/x.jpg', 'h2', 'cbir-creator', 'published', 'fedcba9876543210', 2)`).run();
});
after(async () => { await mock.close(); });

test('the reverse-image pass records mirror pages as review rows only, and sends the non-store picture', async () => {
  await imagematch.matchCreator({ id: 'cbir-creator', handle: 'cbirhandle', display_name: 'Cbir Creator' }, { budget: 0 });
  const rows = repo.db.prepare("SELECT page_url, status, match_kind FROM creator_web_matches WHERE creator_id = 'cbir-creator' AND match_kind = 'cbir'").all();
  assert.equal(rows.length, 2, 'two mirror candidates');
  assert.ok(rows.every((r) => r.status === 'review'), 'review queue only, never confirmed');
  assert.ok(rows.some((r) => r.page_url === 'https://fansly.com/mirror-creator-x'));
  assert.ok(mock.hits.some((h) => h.includes('rpt=imageview') && h.includes('reference.jpg')), 'the reference picture was sent');
  assert.equal(mock.hits.some((h) => h.includes('media.prism.invalid')), false, 'the store host is never sent');
});
