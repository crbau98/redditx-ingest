'use strict';
/** Crucible BLOCKER (Wave 11): a hostile feed or page must be refused fast, not parsed for tens of seconds on the main thread. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const guard = require('../src/lib/markup-guard');
const rss = require('../src/sources/rss');
const web = require('../src/sources/web');
const { classify } = require('../src/engine/errorclass');

const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const timed = (fn) => { const t = process.hrtime.bigint(); let err = null; let out; try { out = fn(); } catch (e) { err = e; } return { ms: Number(process.hrtime.bigint() - t) / 1e6, err, out }; };

test('unclosed <item><title> (Crucible: 64 KB took 33 s) is refused in well under 200 ms', () => {
  for (const kb of [64, 256, 3072]) {
    const r = timed(() => rss.parseFeed(`<rss><channel>${rep('<item><title>a', kb * 1024)}`, 'https://example.com/feed'));
    assert.ok(r.err && r.err.markupGuard, `${kb} KB refused`);
    assert.ok(r.ms < 200, `${kb} KB took ${r.ms} ms`);
  }
});

test('deeply nested XML and a 3 MB nested document are refused quickly', () => {
  const r = timed(() => rss.parseFeed(rep('<a>', 256 * 1024), 'https://example.com/feed'));
  assert.ok(r.err && r.err.markupGuard && r.ms < 200, `${r.ms} ms`);
});

test('HTML: nested tables, divs and anchors (Crucible: 9 to 40 s) are refused in under 200 ms', () => {
  const bodies = {
    table: '<html><body>' + rep('<table><tr><td>', 128 * 1024),
    tableBig: '<html><body>' + rep('<table><tr><td>', 1024 * 1024),
    divs: '<html><body>' + rep('<div><a href="/p/1"><img src="/i/1.jpg">', 1024 * 1024),
    nestedA: '<html><body>' + rep('<a href="/x">', 1024 * 1024),
  };
  for (const [name, html] of Object.entries(bodies)) {
    const r = timed(() => web.extractPage(html, 'https://example.com/page', {}));
    assert.ok(r.err && r.err.markupGuard, `${name} refused`);
    assert.ok(r.ms < 200, `${name} took ${r.ms} ms`);
  }
});

test('a page over the byte limit is refused before parsing', () => {
  const r = timed(() => web.extractPage('<html><body>' + rep('<img src="/i/1.jpg" alt="a">', 3 * 1024 * 1024), 'https://example.com/p', {}));
  assert.ok(r.err && /KB is over/.test(r.err.message) && r.ms < 200);
});

test('the refusal classifies as error_kind "parse"', () => {
  const r = timed(() => rss.parseFeed(`<rss><channel>${rep('<item><title>a', 64 * 1024)}`, 'https://example.com/feed'));
  assert.equal(classify(r.err).kind, 'parse');
  assert.equal(classify(timed(() => web.extractPage(rep('<div>', 100000), 'https://x.example/', {})).err).kind, 'parse');
});

test('ordinary feeds and pages still parse: RSS, Atom, tables, unclosed p/li/td, scripts holding "<"', () => {
  const rssDoc = '<rss><channel><title>T</title>' + '<item><title>One</title><link>https://e.com/1</link><description><![CDATA[<p>hi<img src="https://e.com/a.jpg"></p>]]></description></item>'.repeat(20) + '</channel></rss>';
  assert.equal(rss.parseFeed(rssDoc, 'https://e.com/feed').entries.length, 20);
  const atom = '<feed><title>A</title><entry><title>x</title><id>1</id><link href="https://e.com/1"/><content type="html">&lt;img src="https://e.com/b.jpg"&gt;</content></entry></feed>';
  assert.equal(rss.parseFeed(atom, 'https://e.com/feed').entries.length, 1);
  const page = '<html><head><title>P</title><script>if (a<b && c>d) { x = "<div><div>"; }</script></head><body><table>' + '<tr><td>cell<td>cell'.repeat(2000) + '</table><ul>' + '<li>item'.repeat(2000) + '</ul><p>one<p>two' + '<p>x'.repeat(5000) + '<img src="/a.jpg"><br><br></body></html>';
  const meta = guard.assertParseable(page, 'html');
  assert.ok(meta.maxDepth < 20, `depth ${meta.maxDepth}`);
  assert.ok(web.extractPage(page, 'https://e.com/', {}));
});

test('a legitimately deep page (60 levels of div) is accepted', () => {
  const html = '<html><body>' + '<div>'.repeat(60) + 'x' + '</div>'.repeat(60) + '</body></html>';
  assert.equal(guard.assertParseable(html, 'html').maxDepth, 62);
});

test('a valid feed with thousands of entries is cut to the newest FEED_MAX_ENTRIES, not refused', () => {
  const doc = '<rss><channel>' + '<item><title>t</title><link>https://e.com/1</link><description>d</description></item>'.repeat(4000) + '</channel></rss>';
  const r = timed(() => rss.parseFeed(doc, 'https://e.com/feed'));
  assert.equal(r.err, null);
  assert.equal(r.out.entries.length, guard.FEED_MAX_ENTRIES);
});

test('a feed over the byte limit is cut after its last whole entry and still yields items', () => {
  const entry = '<item><title>' + 'x'.repeat(900) + '</title><link>https://e.com/1</link></item>';
  const doc = '<rss><channel>' + entry.repeat(2600) + '</channel></rss>'; // about 2.4 MB, over the 1.5 MB limit
  assert.ok(doc.length > guard.LIMITS.xml.maxBytes);
  const r = timed(() => rss.parseFeed(doc, 'https://e.com/feed'));
  assert.equal(r.err, null);
  assert.ok(r.out.entries.length > 0 && r.out.entries.length <= 1700, `${r.out.entries.length} entries`);
});

test('a hostile entry description is skipped (no media, tags stripped), the rest of the feed is read', () => {
  const hostile = rep('<div><a href="https://e.com/x"><img src="https://e.com/y.jpg">', 200000);
  const doc = `<rss><channel><item><title>bad</title><link>https://e.com/1</link><description><![CDATA[${hostile}]]></description></item>` +
    '<item><title>good</title><link>https://e.com/2</link><description><![CDATA[<img src="https://e.com/ok.jpg">]]></description></item></channel></rss>';
  const r = timed(() => rss.parseFeed(doc, 'https://e.com/feed'));
  assert.equal(r.err, null);
  assert.ok(r.ms < 1000, `${r.ms} ms`);
  const good = r.out.entries.find((e) => e.title === 'good');
  assert.ok(good && good.media.some((m) => m.url === 'https://e.com/ok.jpg'));
  assert.deepEqual(r.out.entries.find((e) => e.title === 'bad').media, []);
});

test('the guard is one linear pass: a million "<" characters with no tag cost almost nothing', () => {
  const r = timed(() => guard.assertParseable('<'.repeat(1_000_000), 'html'));
  assert.ok(r.ms < 100, `${r.ms} ms`);
  const r2 = timed(() => guard.assertParseable(rep('<a ', 1_900_000), 'html')); // tags that never close
  assert.ok(r2.ms < 100, `${r2.ms} ms`);
});
