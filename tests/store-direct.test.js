'use strict';
/**
 * Stored media served from the bucket itself (presigned redirect) instead of through the proxy. Against the local S3 mock,
 * which verifies the query-string signature and the expiry like a real bucket:
 *   - the signer (AWS's documented example), the redirect, Range against the redirect target, expiry and caching rules
 *   - what must NOT be redirected: the watermarked download, files still on the data volume, disk mode, STORE_DIRECT=0
 *   - the CSP names exactly the bucket origin, /api/meta tells the client, STORE_DIRECT=0 removes both
 *   (the browser follows it for real in store-direct-browser.test.js)
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');
const { s3Server, ACCESS, SECRET, BUCKET } = require('./helpers/s3');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const VIDEO = Buffer.concat([Buffer.from('....ftypisom'), Buffer.alloc(5000, 7)]); // stands in for an mp4: the proxy and the bucket only look at bytes and the type
const CLIENT = () => import('../public/js/direct-media.js');

describe('presigned URL signer', () => {
  test('matches the signature in AWS\'s documentation for a presigned GET', () => {
    const { presign } = require('../src/lib/sigv4');
    const r = presign({ host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', expires: 86400, region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') });
    assert.equal(r.signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    assert.match(r.query, /^X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
  });
});

describe('server: stored media goes straight to the bucket', () => {
  let s3; let dir; let config; let store; let egress; let prev;
  before(async () => {
    prev = { DIRECT_MEDIA: process.env.DIRECT_MEDIA, STORE_DIRECT: process.env.STORE_DIRECT, STORE_URL_TTL_S: process.env.STORE_URL_TTL_S };
    s3 = await s3Server();
    dir = prepareEnv({ MEDIA_STORE_ENDPOINT: s3.url, MEDIA_STORE_BUCKET: BUCKET, MEDIA_STORE_ACCESS_KEY_ID: ACCESS, MEDIA_STORE_SECRET_ACCESS_KEY: SECRET, MEDIA_STORE_PREFIX: 'p/', AGE_GATE_ENFORCE: 'false', MEDIA_STORE: '' });
    delete process.env.STORE_DIRECT; delete process.env.STORE_URL_TTL_S; delete process.env.DIRECT_MEDIA;
    config = require('../src/config'); store = require('../src/lib/objectstore'); egress = require('../src/lib/egress');
    await store.put('t/pic.png', PNG, 'image/png');
    await store.put('t/clip.mp4', VIDEO, 'video/mp4');
  });
  after(async () => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await s3.close();
  });

  async function boot() {
    const s = require('../src/app').createApp().listen(0);
    await new Promise((r) => s.once('listening', r));
    return { s, url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
  }
  const proxyPath = (key, extra = '') => `/api/proxy?url=${encodeURIComponent(store.urlFor(key))}${extra}`;
  const noFollow = (url, headers = {}) => fetch(url, { redirect: 'manual', headers });

  test('a store URL is answered with a short-lived redirect to a presigned bucket URL, and no bytes are relayed', async () => {
    const app = await boot();
    try {
      const r = await noFollow(app.url + proxyPath('t/pic.png'));
      assert.equal(r.status, 307);
      assert.equal((await r.arrayBuffer()).byteLength, 0, 'an empty body: nothing is relayed');
      const loc = new URL(r.headers.get('location'));
      assert.equal(loc.origin, s3.url, 'the bucket endpoint, not PRISM');
      assert.equal(loc.pathname, `/${BUCKET}/p/t/pic.png`, 'path-style, with the configured prefix');
      for (const k of ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature']) assert.ok(loc.searchParams.has(k), k);
      assert.equal(loc.searchParams.get('X-Amz-Expires'), '3600', 'about an hour by default');
      assert.equal(loc.searchParams.get('X-Amz-SignedHeaders'), 'host');
      assert.match(r.headers.get('cache-control'), /^private, max-age=900$/, 'the redirect is cached for a quarter of the signature life');
      const got = await fetch(loc);
      assert.equal(got.status, 200, 'the bucket accepts the signature');
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
      assert.equal(got.headers.get('content-type'), 'image/png');
    } finally { await app.close(); }
  });

  test('Range requests work against the redirect target (video seeking)', async () => {
    const app = await boot();
    try {
      const r = await noFollow(app.url + proxyPath('t/clip.mp4'), { range: 'bytes=0-99' });
      assert.equal(r.status, 307, 'a ranged request is redirected too; the player repeats its Range header on the new URL');
      const part = await fetch(r.headers.get('location'), { headers: { range: 'bytes=100-199' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), `bytes 100-199/${VIDEO.length}`);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), VIDEO.subarray(100, 200));
      assert.equal(part.headers.get('content-type'), 'video/mp4');
    } finally { await app.close(); }
  });

  test('a cached redirect never outlives its signature, and a key keeps one URL for a while', () => {
    const url = store.urlFor('t/pic.png');
    const HOUR = 3600 * 1000; const t0 = Date.UTC(2026, 10, 16, 12, 0, 7);
    const signedAt = (u) => { const d = new URL(u).searchParams.get('X-Amz-Date'); return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15)); };
    const seen = new Set();
    for (let i = 0; i < 3 * 3600; i += 37) {
      const now = t0 + i * 1000; const d = store.directUrl(url, now);
      const from = signedAt(d.url); const expires = Number(new URL(d.url).searchParams.get('X-Amz-Expires')) * 1000;
      assert.ok(from <= now, 'never signed in the future');
      assert.ok(now + d.maxAge * 1000 < from + expires, `a redirect issued at +${i}s and cached for ${d.maxAge}s ends before the signature does`);
      assert.ok(now < from + expires, 'valid when issued');
      seen.add(d.url);
    }
    assert.ok(seen.size >= 5 && seen.size <= 8, `one URL per half-hour window, not one per request (${seen.size} in 3 h)`);
    assert.equal(store.directUrl(url, t0).url, store.directUrl(url, t0 + 1000).url, 'same URL within a window, so the browser cache keeps working');
  });

  test('an expired signature is refused by the bucket; STORE_URL_TTL_S changes the life', async () => {
    const old = store.directUrl(store.urlFor('t/pic.png'), Date.now() - 3 * 3600 * 1000);
    assert.equal((await fetch(old.url)).status, 403, 'expired');
    process.env.STORE_URL_TTL_S = '600';
    try {
      const d = store.directUrl(store.urlFor('t/pic.png'));
      assert.equal(new URL(d.url).searchParams.get('X-Amz-Expires'), '600');
      assert.equal(d.maxAge, 150);
      assert.equal((await fetch(d.url)).status, 200);
      process.env.STORE_URL_TTL_S = 'soon';
      assert.equal(new URL(store.directUrl(store.urlFor('t/pic.png')).url).searchParams.get('X-Amz-Expires'), '3600', 'junk keeps the default');
    } finally { delete process.env.STORE_URL_TTL_S; }
  });

  test('never redirected: the watermarked download, a file only on the data volume, disk mode, STORE_DIRECT=0', async () => {
    const app = await boot();
    try {
      // the watermarked download is built by PRISM: relayed (200 and a body), not redirected
      const marked = await noFollow(app.url + proxyPath('t/pic.png', '&mark=prism'));
      assert.notEqual(marked.status, 307, 'mark=prism stays on the proxy');
      assert.ok(marked.status === 200 || marked.status === 415 || marked.status === 502, `answered by the proxy itself (${marked.status})`);
      assert.equal(marked.headers.get('location'), null);

      // written to the volume before the bucket existed: the bucket has no copy, so it is relayed from the volume
      fs.mkdirSync(path.join(config.dataDir, 'store', 'old'), { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, 'store', 'old', 'legacy.png'), PNG);
      const legacy = await noFollow(app.url + proxyPath('old/legacy.png'));
      assert.equal(legacy.status, 200);
      assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), PNG);

      process.env.STORE_DIRECT = '0';
      const off = await noFollow(app.url + proxyPath('t/pic.png'));
      assert.equal(off.status, 200, 'STORE_DIRECT=0: every byte through the proxy again');
      assert.deepEqual(Buffer.from(await off.arrayBuffer()), PNG);
      delete process.env.STORE_DIRECT;

      const savedKind = config.store.kind; config.store.kind = 'disk';
      try {
        await store.put('d/disk.png', PNG, 'image/png');
        const disk = await noFollow(app.url + proxyPath('d/disk.png'));
        assert.equal(disk.status, 200, 'disk mode: nothing to redirect to');
      } finally { config.store.kind = savedKind; }
    } finally { delete process.env.STORE_DIRECT; await app.close(); }
  });

  test('an endpoint that only PRISM can reach, or plain http in production, is never handed to a browser', () => {
    const saved = { endpoint: config.store.endpoint, internal: config.internalHosts, isProd: config.isProd };
    try {
      config.internalHosts = [new URL(s3.url).hostname.toLowerCase()];
      assert.equal(store.directOrigin(), null, 'internal host');
      assert.equal(store.directUrl(store.urlFor('t/pic.png')), null);
      config.internalHosts = saved.internal; config.isProd = true;
      assert.equal(store.directOrigin(), null, 'http endpoint on an https site');
      config.store.endpoint = 'https://acct.r2.cloudflarestorage.com';
      assert.equal(store.directOrigin(), 'https://acct.r2.cloudflarestorage.com');
    } finally { config.store.endpoint = saved.endpoint; config.internalHosts = saved.internal; config.isProd = saved.isProd; }
  });

  test('redirects are counted by the egress counter as tiny responses', async () => {
    const app = await boot();
    try {
      egress._reset();
      for (let i = 0; i < 3; i++) await noFollow(app.url + proxyPath('t/pic.png'));
      await new Promise((r) => setTimeout(r, 100));
      const today = egress.summary().today;
      assert.ok(today, 'something was counted');
      assert.equal(today.other.requests, 3, 'three redirects, counted');
      assert.ok(today.other.miss > 0 && today.other.miss < 3 * 3000, `about 1.5 KB of headers each (security headers plus the signed URL), not the picture (${today.other.miss} bytes)`);
      assert.equal(today.image.requests + today.video.requests, 0, 'no media bytes went through PRISM');
    } finally { await app.close(); }
  });

  const csp = async (url) => Object.fromEntries((await fetch(`${url}/`)).headers.get('content-security-policy').split(';').map((d) => { const [k, ...v] = d.trim().split(/\s+/); return [k, v]; }));

  test('the CSP names exactly the bucket origin, /api/meta tells the client, STORE_DIRECT=0 removes both', async () => {
    const app = await boot();
    try {
      const c = await csp(app.url);
      assert.ok(c['img-src'].includes(s3.url) && c['media-src'].includes(s3.url), 'img-src and media-src have the bucket');
      assert.deepEqual(c['connect-src'], ["'self'", s3.url], 'and connect-src, for the service worker re-fetching a redirected picture');
      assert.equal(c['img-src'].filter((x) => x === s3.url).length, 1);
      assert.ok(!JSON.stringify(c).includes('*'), 'no wildcard');
      assert.deepEqual(c['script-src'], ["'self'"]);
      assert.equal((await (await fetch(`${app.url}/api/meta`)).json()).directMedia.store, config.storeHost);
      const dm = require('../src/lib/directmedia');
      assert.equal(dm.storeOrigin(), s3.url, 'one constant for the CSP and the redirect');
    } finally { await app.close(); }
    process.env.STORE_DIRECT = '0';
    const off = await boot();
    try {
      const c = await csp(off.url);
      assert.ok(!c['img-src'].includes(s3.url) && !c['media-src'].includes(s3.url));
      assert.deepEqual(c['connect-src'], ["'self'"]);
      assert.equal((await (await fetch(`${off.url}/api/meta`)).json()).directMedia.store, false);
    } finally { delete process.env.STORE_DIRECT; await off.close(); }
  });

  test('scripts/verify-store-direct.js (the post-deploy check) passes against a redirecting app and fails when STORE_DIRECT=0', async () => {
    const { execFile } = require('child_process'); const run = (url) => new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'verify-store-direct.js'), url, '--url', store.urlFor('t/pic.png'), '--allow-http'], (err, out) => resolve({ code: err ? err.code : 0, out })));
    const app = await boot();
    try {
      const ok = await run(app.url);
      assert.equal(ok.code, 0, ok.out);
      assert.match(ok.out, /PASS {2}the proxy answers with a redirect/);
      assert.match(ok.out, /PASS {2}CSP img-src names the bucket origin/);
      assert.match(ok.out, /OK: stored media is served straight from the bucket/);
    } finally { await app.close(); }
    process.env.STORE_DIRECT = '0';
    const off = await boot();
    try {
      const bad = await run(off.url);
      assert.equal(bad.code, 1);
      assert.match(bad.out, /FAIL {2}\/api\/meta says stored media is redirected/);
    } finally { delete process.env.STORE_DIRECT; await off.close(); }
  });

  test('STORE_DIRECT is independent of DIRECT_MEDIA', async () => {
    process.env.DIRECT_MEDIA = '0';
    const app = await boot();
    try {
      const c = await csp(app.url);
      assert.deepEqual(c['img-src'], ["'self'", 'data:', 'blob:', s3.url], 'only the bucket');
      const meta = (await (await fetch(`${app.url}/api/meta`)).json()).directMedia;
      assert.deepEqual(meta, { enabled: false, images: [], video: [], store: config.storeHost });
      assert.equal((await noFollow(app.url + proxyPath('t/pic.png'))).status, 307);
    } finally { delete process.env.DIRECT_MEDIA; await app.close(); }
  });
});

describe('client: a stored picture ends up on another origin', () => {
  const STORE = 'media.prism.invalid';
  const proxied = (u, extra = '') => `/api/proxy?url=${encodeURIComponent(u)}${extra}`;
  test('pixel readers skip it while the server redirects stored media, and only then', async () => {
    const M = await CLIENT();
    M.configureDirectMedia({ enabled: true, images: ['i.redd.it'], video: [], store: STORE });
    assert.equal(M.isCrossOriginSrc(proxied(`https://${STORE}/t/pic.png`)), true);
    assert.equal(M.isCrossOriginSrc(proxied(`https://${STORE}/t/pic.png`, '&mark=prism')), false, 'the watermarked download is relayed');
    assert.equal(M.isCrossOriginSrc(proxied('https://preview.example/a.jpg')), false, 'another host through the proxy is same-origin');
    assert.equal(M.isCrossOriginSrc('https://i.redd.it/a.jpg'), true, 'a direct CDN picture still is');
    assert.equal(M.isCrossOriginSrc('/demo/art/a.svg'), false);
    assert.equal(M.isCrossOriginSrc(undefined), false);
    assert.equal(M.isDirectSrc(proxied(`https://${STORE}/t/pic.png`)), false, 'a proxy URL is not "direct": the error fallback must not retry it');
    M.configureDirectMedia({ enabled: true, images: ['i.redd.it'], video: [], store: false });
    assert.equal(M.isCrossOriginSrc(proxied(`https://${STORE}/t/pic.png`)), false, 'STORE_DIRECT=0: same-origin again, readers work');
    M.configureDirectMedia({ enabled: false, images: [], video: [], store: STORE });
    assert.equal(M.isCrossOriginSrc(proxied(`https://${STORE}/t/pic.png`)), true, 'DIRECT_MEDIA=0 does not switch the store redirect off');
    M.configureDirectMedia(undefined);
    assert.equal(M.isCrossOriginSrc(proxied(`https://${STORE}/t/pic.png`)), false, 'before /api/meta arrives nothing is assumed');
  });

  test('the colour and backdrop readers use it', () => {
    const fx = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', 'fx.js'), 'utf8');
    assert.equal((fx.match(/isCrossOriginSrc\(src\)/g) || []).length, 2, 'dominantColor and ambientBackdrop');
    assert.doesNotMatch(fx, /isDirectSrc/);
  });
});
