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
    assert.throws(() => guard.load(shapes.fmtB), (e) => e.markupGuard && /more than 50 ms/.test(e.message));
    assert.ok(Date.now() - t < 2000);
  } finally { delete process.env.MARKUP_PREFLIGHT_MS; }
});
