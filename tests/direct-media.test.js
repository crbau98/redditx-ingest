'use strict';
/**
 * Direct-from-CDN media (cuts Railway egress). Two layers:
 *   1. the client helper's choice (direct vs proxy) and its fallback URL, with no browser
 *   2. the server: one host list drives the CSP and /api/meta, and DIRECT_MEDIA=0 empties both
 *   (the real-browser checks are in direct-media-browser.test.js: a separate process, so it gets its own database)
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

const loadClient = () => import('../public/js/direct-media.js');
const HOSTS = ['i.redd.it', 'preview.redd.it', 'cf.preview.redd.it', 'i.imgur.com', 'cdn.bsky.app', 'pbs.twimg.com', 'img.coomer.st', 'media.redgifs.com'];
const CFG = { enabled: true, images: HOSTS, video: ['media.redgifs.com'] };
const PROXY = (u) => `/api/proxy?url=${encodeURIComponent(u)}`;

describe('client helper', () => {
  test('a listed host loads directly; everything else goes through the proxy', async () => {
    const M = await loadClient();
    M.configureDirectMedia(CFG);
    assert.equal(M.mediaSrc('https://i.redd.it/a.jpg'), 'https://i.redd.it/a.jpg');
    assert.equal(M.mediaSrc('https://cdn.bsky.app/img/avatar/plain/did:plc:x/y@jpeg'), 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/y@jpeg');
    assert.equal(M.mediaSrc('https://preview.redd.it/a.jpg?width=640&s=1'), 'https://preview.redd.it/a.jpg?width=640&s=1', 'probed: serves with no Referer');
    assert.equal(M.mediaSrc('https://cf.preview.redd.it/a.jpg?width=640'), 'https://cf.preview.redd.it/a.jpg?width=640');
    assert.equal(M.mediaSrc('https://v.redd.it/abc/DASH_480.mp4'), PROXY('https://v.redd.it/abc/DASH_480.mp4'), 'not probed (no sample), so proxied');
    assert.equal(M.mediaSrc('https://external-preview.redd.it/a.jpg'), PROXY('https://external-preview.redd.it/a.jpg'), 'a sibling host is not the listed host');
    assert.equal(M.mediaSrc('https://cdn.gff.network/a.jpg'), PROXY('https://cdn.gff.network/a.jpg'), 'needs a Referer');
    assert.equal(M.mediaSrc('https://example.com/a.jpg'), PROXY('https://example.com/a.jpg'));
    assert.equal(M.mediaSrc('https://i.redd.it.evil.com/a.jpg'), PROXY('https://i.redd.it.evil.com/a.jpg'), 'a lookalike host is not the listed host');
    assert.equal(M.mediaSrc('https://i.redd.it:8443/a.jpg'), PROXY('https://i.redd.it:8443/a.jpg'), 'a non-default port is not what the CSP allows');
    assert.equal(M.mediaSrc('https://i.redd.it:443/a.jpg'), 'https://i.redd.it/a.jpg'.replace('https://i.redd.it/','https://i.redd.it:443/'), 'an explicit default port is still the default port');
    assert.equal(M.mediaSrc('https://user:pw@i.redd.it/a.jpg'), PROXY('https://user:pw@i.redd.it/a.jpg'), 'no credentials in a direct URL');
  });

  test('never direct: http, a playlist, a video file on an images-only host, local paths pass through', async () => {
    const M = await loadClient();
    M.configureDirectMedia(CFG);
    assert.equal(M.mediaSrc('http://i.redd.it/a.jpg'), PROXY('http://i.redd.it/a.jpg'));
    assert.equal(M.mediaSrc('https://media.redgifs.com/x.m3u8'), PROXY('https://media.redgifs.com/x.m3u8'), 'HLS goes through the rewriting proxy');
    assert.equal(M.mediaSrc('https://i.imgur.com/a.mp4'), PROXY('https://i.imgur.com/a.mp4'), 'imgur is listed for pictures only');
    assert.equal(M.mediaSrc('https://i.imgur.com/a.gifv'), PROXY('https://i.imgur.com/a.gifv'));
    assert.equal(M.mediaSrc('https://media.redgifs.com/Clip-mobile.mp4'), 'https://media.redgifs.com/Clip-mobile.mp4', 'redgifs is listed for video');
    assert.equal(M.mediaSrc('/demo/art/a.svg'), '/demo/art/a.svg');
    assert.equal(M.mediaSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    assert.equal(M.mediaSrc(''), '');
  });

  test('before the list arrives, with no list, or switched off, everything goes through the proxy', async () => {
    const M = await loadClient();
    for (const cfg of [undefined, null, {}, { enabled: false, images: HOSTS, video: [] }, { enabled: true, images: [], video: [] }]) {
      M.configureDirectMedia(cfg);
      assert.equal(M.mediaSrc('https://i.redd.it/a.jpg'), PROXY('https://i.redd.it/a.jpg'), JSON.stringify(cfg));
    }
  });

  test('the retry URL is the proxy form of the failed direct URL, and a proxy URL is never retried again', async () => {
    const M = await loadClient();
    M.configureDirectMedia(CFG);
    const direct = M.mediaSrc('https://i.redd.it/a.jpg');
    assert.equal(M.isDirectSrc(direct), true);
    assert.equal(M.viaProxy(direct), PROXY('https://i.redd.it/a.jpg'));
    const proxied = M.viaProxy(direct);
    assert.equal(M.isDirectSrc(proxied), false, 'so a failing proxy load cannot loop');
    assert.equal(M.viaProxy('/demo/x.svg'), '/demo/x.svg');
  });
});

describe('the i.redd.it missing-file stub', () => {
  test('only a direct i.redd.it picture of exactly 130x60 counts as the 404 stub', async () => {
    const M = await loadClient();
    assert.equal(M.isMissingStub('https://i.redd.it/a.jpg', 130, 60), true);
    assert.equal(M.isMissingStub('https://i.redd.it/a.jpg', 130, 61), false);
    assert.equal(M.isMissingStub('https://i.redd.it/a.jpg', 640, 60), false);
    assert.equal(M.isMissingStub('https://cdn.bsky.app/a', 130, 60), false, 'another host: a real 130x60 picture');
    assert.equal(M.isMissingStub('https://i.redd.it.evil.com/a.jpg', 130, 60), false);
    assert.equal(M.isMissingStub('/api/proxy?url=x', 130, 60), false);
    assert.equal(M.isMissingStub(undefined, 130, 60), false);
  });

  test('probeImage treats the stub as a failed direct load and tries the proxy; a real picture is left alone', async () => {
    const M = await loadClient();
    M.configureDirectMedia(CFG);
    const made = [];
    globalThis.Image = class { constructor() { made.push(this); } set src(v) { this._src = v; } get src() { return this._src; } };
    try {
      const log = [];
      M.probeImage('https://i.redd.it/a.jpg', () => log.push('fail'), (alt) => log.push(`proxy:${alt}`));
      const [first] = made; first.naturalWidth = 130; first.naturalHeight = 60; first.onload();
      assert.equal(made.length, 2, 'the proxy copy was requested');
      assert.equal(made[1].src, PROXY('https://i.redd.it/a.jpg'));
      made[1].onload();
      assert.deepEqual(log, [`proxy:${PROXY('https://i.redd.it/a.jpg')}`]);
      made.length = 0; log.length = 0;
      M.probeImage('https://i.redd.it/b.jpg', () => log.push('fail'), () => log.push('proxy'));
      made[0].naturalWidth = 640; made[0].naturalHeight = 480; made[0].onload();
      assert.equal(made.length, 1, 'a real picture needs no retry');
      assert.deepEqual(log, []);
    } finally { delete globalThis.Image; }
  });
});

describe('source contracts', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  test('a direct video failure is retried through the proxy before the item is reported broken', () => {
    const v = read('public', 'js', 'components', 'video.js');
    const set = v.match(/const setMp4 = \(url\) => \{[\s\S]*?\n  \};/);
    assert.ok(set, 'setMp4 exists');
    assert.match(set[0], /isDirectSrc\(src\) && !v\.dataset\.directFb/);
    assert.match(set[0], /viaProxy\(src\)/);
    assert.ok(set[0].indexOf('viaProxy(src)') < set[0].lastIndexOf('dead()'), 'the proxy retry comes first, dead() only after it');
    assert.doesNotMatch(v, /v\.src = proxied\(mp4\)/, 'no other path sets the mp4 without the retry');
  });

  test('the download link and the watermark always go through the server', () => {
    const l = read('public', 'js', 'components', 'lightbox.js');
    const dl = l.match(/function downloadLink\(it\) \{[\s\S]*?\n\}/)[0];
    assert.match(dl, /isDirectSrc\(proxied\(it\.media_url\)\) \? viaProxy\(it\.media_url\)/);
    assert.match(dl, /mark=prism/);
  });

  test('the viewer loads the full-size file only after a dwell, cancels it on leaving, and warms the preview, not the full file', () => {
    const l = read('public', 'js', 'components', 'lightbox.js');
    assert.match(l, /const FULL_DWELL_MS = 700/);
    assert.match(l, /S\.fullTimer = setTimeout\(loadFull, FULL_DWELL_MS\)/);
    assert.match(l, /function cancelFull\(\)/);
    assert.match(l, /S\.index = i;\n  cancelFull\(\);/, 'moving to another item cancels the pending load');
    assert.match(l, /onChange: \(sc\) => \{ if \(sc > 1 && S && S\.fullNow\) S\.fullNow\(\); \}/, 'zooming loads it at once');
    assert.doesNotMatch(l, /pre\.src = proxied\(n\.media_url\)/, 'the next full file is no longer preloaded');
    assert.match(l, /const still = n\.preview_url \|\| n\.thumbnail_url \|\| n\.media_url;/);
  });

  test('Reels buffers the next clip with metadata only, and the active clip normally', () => {
    const r = read('public', 'js', 'views', 'reels.js');
    assert.match(r, /v\.preload = 'metadata'/);
    assert.match(r, /v\.preload = 'auto'; \/\/ now on screen/);
  });
});

describe('server: one list for the CSP and the client', () => {
  let server; let base; let prev;
  before(async () => {
    prev = process.env.DIRECT_MEDIA;
    prepareEnv({});
  });
  after(() => { if (prev === undefined) delete process.env.DIRECT_MEDIA; else process.env.DIRECT_MEDIA = prev; });

  async function boot() {
    const s = require('../src/app').createApp().listen(0);
    await new Promise((r) => s.once('listening', r));
    return { s, url: `http://127.0.0.1:${s.address().port}` };
  }
  const csp = async (url) => Object.fromEntries((await fetch(`${url}/`)).headers.get('content-security-policy').split(';').map((d) => { const [k, ...v] = d.trim().split(/\s+/); return [k, v]; }));

  test('the CSP allows exactly the listed hosts, and /api/meta carries the same list', async () => {
    delete process.env.DIRECT_MEDIA;
    ({ s: server, url: base } = await boot());
    try {
      const c = await csp(base);
      assert.deepEqual(c['img-src'], ["'self'", 'data:', 'blob:', ...HOSTS.map((h) => `https://${h}`)]);
      assert.deepEqual(c['media-src'], ["'self'", 'blob:', 'https://media.redgifs.com'], 'video only where it was probed');
      assert.ok(!JSON.stringify(c).includes('*'), 'no wildcard sources');
      assert.deepEqual(c['connect-src'], ["'self'"], 'fetch stays same-origin');
      assert.deepEqual(c['script-src'], ["'self'"]);
      const meta = await (await fetch(`${base}/api/meta`)).json();
      assert.deepEqual(meta.directMedia, { enabled: true, images: HOSTS, video: ['media.redgifs.com'] });
      const dm = require('../src/lib/directmedia');
      assert.deepEqual(dm.cspSources().img, HOSTS.map((h) => `https://${h}`), 'the CSP is built from the same constant');
    } finally { await new Promise((r) => server.close(r)); }
  });

  test('DIRECT_MEDIA=0 puts everything back through the proxy: empty list, CSP back to self', async () => {
    process.env.DIRECT_MEDIA = '0';
    ({ s: server, url: base } = await boot());
    try {
      const c = await csp(base);
      assert.deepEqual(c['img-src'], ["'self'", 'data:', 'blob:']);
      assert.deepEqual(c['media-src'], ["'self'", 'blob:']);
      const meta = await (await fetch(`${base}/api/meta`)).json();
      assert.deepEqual(meta.directMedia, { enabled: false, images: [], video: [] });
    } finally { await new Promise((r) => server.close(r)); delete process.env.DIRECT_MEDIA; }
  });

  test('the listed hosts are all ones the proxy knows, and none needs a Referer', () => {
    const dm = require('../src/lib/directmedia');
    const proxySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'proxy.js'), 'utf8');
    for (const { host } of dm.HOSTS) {
      const root = host.split('.').slice(-2).join('.');
      assert.ok(proxySrc.includes(`'${root}'`), `${host} is a known proxy host (${root})`);
      assert.doesNotMatch(proxySrc.match(/const REFERER_BY_HOST = \{[\s\S]*?\};/)[0], new RegExp(host.replace(/\./g, '\\.')), `${host} has no Referer entry`);
    }
    for (const needsReferer of ['cdn.gff.network', 'phncdn.com']) assert.ok(!dm.HOSTS.some((h) => h.host.endsWith(needsReferer)), `${needsReferer} stays on the proxy`);
  });
});
