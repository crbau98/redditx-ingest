'use strict';
/** Bunkr album/file adapter: parse, HTML readers, resolve payload, one fetch over replaced HTTP. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const ALBUM = 'https://bunkr.cr/a/snOgRJpi';
const FILE1 = 'https://bunkr.cr/f/iV6HO90I5mQ12';
const FILE2 = 'https://bunkr.cr/f/FubShCveif3dB';

const albumHtml = `<html><head><title>MissTeela | Bunkr</title></head><body>
<a href="/f/iV6HO90I5mQ12">one</a>
<a href="/f/FubShCveif3dB">two</a>
</body></html>`;

const fileHtml = (id, title) => `<html><head>
<title>${title} | Bunkr</title>
<meta property="og:image" content="https://static.scdn.st/thumbs/${id}.png"/>
</head><body>
<script defer data-file-id="${id}" src="../js/lv.js"></script>
<div id="fileTracker" data-file-id="${id}"></div>
</body></html>`;

const net = require('../src/lib/net');
const bunkr = require('../src/sources/bunkr');
const pages = new Map();
const apis = new Map();

function response(url, opts = {}) {
  if (String(url).includes('/api/_001_v2')) {
    let id = null;
    try { id = JSON.parse(opts.body || '{}').id; } catch { /* */ }
    const payload = apis.get(String(id));
    if (!payload) return { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"no"}') };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(payload)) };
  }
  const html = pages.get(url);
  if (!html) return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>gone</html>') };
  return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
}
net.request = async (url, opts = {}) => response(url, opts);
net.fetchText = async (url, opts = {}) => {
  const r = response(url, opts);
  if (r.status >= 400) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.body.toString('utf8');
};

test('parse: album and file URLs are feeds; search paths are not', () => {
  const a = bunkr.parse(ALBUM);
  assert.equal(a.platform, 'bunkr');
  assert.equal(a.kind, 'album');
  assert.equal(a.target, ALBUM);
  const f = bunkr.parse(FILE1);
  assert.equal(f.kind, 'file');
  assert.equal(bunkr.parse('https://bunkr.cr/'), null);
  assert.equal(bunkr.parse('https://bunkr.cr/search?q=gay'), null);
  assert.ok(bunkr.parse('https://bunkr.si/a/snOgRJpi'));
});

test('a bunkr album URL pasted anywhere becomes an ingestible feed (lib/links)', () => {
  const links = require('../src/lib/links');
  const p = links.parseProfile(ALBUM);
  assert.equal(p.platform, 'bunkr');
  assert.equal(p.kind, 'album');
  assert.equal(p.ingestable, true);
  assert.equal(links.parseProfile(FILE1).kind, 'file');
  // Unlisted TLDs must not become dead bunkr feeds (adapter HOSTS is the source of truth).
  assert.notEqual(links.parseProfile('https://bunkr.xyz/a/snOgRJpi').platform, 'bunkr');
});

test('album page lists file slugs; file page exposes numeric id', () => {
  const page = bunkr._albumPage(albumHtml, 'bunkr.cr');
  assert.equal(page.title, 'MissTeela');
  assert.deepEqual(page.files.map((f) => f.slug), ['iV6HO90I5mQ12', 'FubShCveif3dB']);
  const meta = bunkr._filePage(fileHtml('53972354', 'clip.mp4'));
  assert.equal(meta.id, '53972354');
  assert.equal(meta.title, 'clip.mp4');
});

test('mediaFromResolve builds the CDN URL', () => {
  const m = bunkr._mediaFromResolve({
    mediafiles: 'https://c4ta-b.cdn.cr/',
    path: '/storage/media/abc.mp4',
    original: 'clip.mp4',
  });
  assert.equal(m.url, 'https://c4ta-b.cdn.cr/storage/media/abc.mp4?n=clip.mp4');
  assert.equal(m.name, 'clip.mp4');
  assert.equal(bunkr._mediaFromResolve({}), null);
});

test('fetch: album → file pages → resolve API → items', async () => {
  pages.clear(); apis.clear();
  pages.set(ALBUM, albumHtml);
  pages.set(FILE1, fileHtml('53972354', 'missteela_395e.mp4'));
  pages.set(FILE2, fileHtml('53971982', 'cecerosee_635.mp4'));
  apis.set('53972354', { mediafiles: 'https://c4ta-b.cdn.cr', original: 'missteela_395e.mp4', path: '/storage/media/a.mp4' });
  apis.set('53971982', { mediafiles: 'https://c4ta-b.cdn.cr', original: 'cecerosee_635.mp4', path: '/storage/media/b.mp4' });
  const r = await bunkr.fetch({ target: ALBUM, kind: 'album' }, { limit: 2 });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].sourceId, 'bunkr-53972354');
  assert.equal(r.items[0].mediaType, 'video');
  assert.match(r.items[0].mediaUrl, /c4ta-b\.cdn\.cr\/storage\/media\/a\.mp4/);
  assert.equal(r.profile.displayName, 'MissTeela');
  assert.equal(r.items[0].trusted, false, 'album items stay untrusted for the male gate');
});
