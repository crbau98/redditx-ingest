'use strict';
/**
 * The real parser decides for larger HTML (Crucible v4.21 gate, second round): shapes the text scan cannot model (abrupt
 * comments, "/>" on non-void tags, raw text in svg/math, misnested formatting) are refused within the budget instead of
 * freezing the server inside cheerio.load. Ordinary pages still load.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/lib/markup-guard');
const preflight = require('../src/lib/markup-preflight');

after(() => preflight.stop());
const H = (b) => `<html><body>${b}`;
const N = 20000;
const shapes = {
  commentAbrupt: H(`<!-->${'<div>'.repeat(N)}-->`),
  selfClose: H('<div/>'.repeat(N)),
  attrSlash: H('<div a=b/>'.repeat(N)),
  svgScript: H(`<svg><script>${'<div>'.repeat(N)}</script></svg>`),
  svgTitle: H(`<svg><title>${'<div>'.repeat(N)}</title></svg>`),
  mathTitle: H(`<math><title>${'<div>'.repeat(N)}</title></math>`),
  fmtB: H('<b><div></b>'.repeat(N)),
  fmtA: H('<a><div></a>'.repeat(N)),
};

for (const [name, html] of Object.entries(shapes)) {
  test(`${name} is refused quickly`, () => {
    const t = Date.now();
    assert.throws(() => guard.load(html), (e) => e.markupGuard === true && /hostile markup/.test(e.message));
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  });
}

test('an ordinary large page loads, and small documents skip the worker', () => {
  let body = '';
  for (let i = 0; i < 2000; i++) body += `<div class="card"><a href="https://x.example/p/${i}"><img src="https://cdn.example/${i}.jpg"></a><p>caption ${i} <b>bold</b></p></div>`;
  const before = preflight.stats().checked;
  const $ = guard.load(`<!doctype html><html><body>${body}</body></html>`);
  assert.equal($('.card').length, 2000);
  assert.equal(preflight.stats().checked, before + 1);
  guard.load('<html><body><p>small</p></body></html>');
  assert.equal(preflight.stats().checked, before + 1, 'under PREFLIGHT_MIN: no worker round trip');
});

test('the budget comes from MARKUP_PREFLIGHT_MS', () => {
  process.env.MARKUP_PREFLIGHT_MS = '50';
  try {
    const t = Date.now();
    // a fresh document (refusals are remembered); budget = 50 + 300 ms per MB, so well under 200 ms here
    assert.throws(() => guard.load(`${shapes.fmtB}<!-- budget -->`), (e) => e.markupGuard && /more than (\d+) ms/.test(e.message) && Number(/more than (\d+) ms/.exec(e.message)[1]) < 200);
    assert.ok(Date.now() - t < 2000);
  } finally { delete process.env.MARKUP_PREFLIGHT_MS; }
});

test('feeds go through the preflight too: an abrupt comment hiding deep nesting is refused, a flat 90k-item feed parses fast', () => {
  const X = (b) => `<rss><channel>${b}</channel></rss>`;
  assert.throws(() => guard.load(X(`<!-->${'<item>'.repeat(N)}-->`), 'xml'), (e) => e.markupGuard);
  const rss = require('../src/sources/rss');
  const t = Date.now();
  const feed = rss.parseFeed(X('<item/>'.repeat(90000)), 'https://feed.example/');
  assert.ok(Date.now() - t < 2000, `flat feed took ${Date.now() - t} ms`);
  assert.equal(feed.entries.length <= guard.FEED_MAX_ENTRIES, true);
});

test('a document refused once is refused again from memory, without waiting on the worker', () => {
  guard.load('<p>warm</p>'.repeat(2000)); // start the worker
  const html = shapes.selfClose;
  assert.throws(() => guard.load(html), (e) => e.markupGuard);
  const before = preflight.stats().refusedRemembered;
  const t = Date.now();
  assert.throws(() => guard.load(html), (e) => e.markupGuard);
  assert.ok(Date.now() - t < 100, `second refusal took ${Date.now() - t} ms`);
  assert.equal(preflight.stats().refusedRemembered, before + 1);
});

test('the budget grows with the document: 400 ms plus 300 ms per MB', () => {
  assert.equal(preflight.budgetMs(0), 400);
  assert.equal(preflight.budgetMs(2 * 1048576), 1000);
});

test('a worker that cannot start costs one short wait, then the text scan guards alone until the retry window passes', () => {
  const path = require('path');
  preflight._reset({ workerFile: path.join(__dirname, 'fixtures', 'preflight-never-ready.js') });
  try {
    const page = `<html><body>${'<p>ordinary</p>'.repeat(3000)}</body></html>`;
    let t = Date.now();
    guard.load(page);
    const first = Date.now() - t;
    assert.ok(first < 1600, `first failed start took ${first} ms`);
    t = Date.now();
    for (let i = 0; i < 5; i++) guard.load(`${page}<!-- ${i} -->`);
    assert.ok(Date.now() - t < 500, `later loads waited ${Date.now() - t} ms`);
    assert.ok(preflight.stats().unavailable >= 6);
  } finally { preflight._reset({ workerFile: require('path').join(__dirname, '..', 'src', 'lib', 'markup-preflight-worker.js') }); }
});
