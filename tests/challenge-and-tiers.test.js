'use strict';
// Free unblock tiers, offline: the Anubis proof of work and the challenge detector (lib/challenge.js), the TikTok embed
// parser (sources/tiktok.js), the Jina reader's "still blocked" answer (lib/jina.js) and the CDP browser's next-page rule
// (lib/chrome.js). No network, no Chrome: every HTTP call is replaced by a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-tiers-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const challenge = require('../src/lib/challenge');
const net = require('../src/lib/net');
const jina = require('../src/lib/jina');
const chrome = require('../src/lib/chrome');
const tiktok = require('../src/sources/tiktok');

const realRequest = net.request;
const restoreRequest = () => { net.request = realRequest; };

test.afterEach(() => restoreRequest());

/* ------------------------------------------------------------------ the detector */

test('detect names the gate that is actually there and leaves real pages alone', () => {
  assert.equal(challenge.detect({ status: 200, html: '<script id="anubis_challenge" type="application/json">{"x":1}</script>' }).kind, 'anubis');
  assert.equal(challenge.detect({ status: 503, html: '<title>Just a moment...</title><div id="challenge-platform">' }).kind, 'cloudflare');
  assert.equal(challenge.detect({ status: 403, html: '<h1>Request forbidden by administrative rules.</h1>' }).kind, 'cloudflare-waf');
  assert.equal(challenge.detect({ status: 200, html: '<div class="cf-turnstile" data-sitekey="abc"></div>' }).kind, 'captcha');
  assert.equal(challenge.detect({ status: 200, html: '<html><body><h1>An article about captchas</h1><p>' + 'x'.repeat(500000) + '</p></body></html>' }), null);
  assert.equal(challenge.detect({ status: 404, html: '<h1>Not found</h1>' }), null);
  assert.equal(challenge.detect({ status: 403, html: '<h1>No.</h1>' }).kind, 'refused');
  assert.equal(challenge.isChallenge('refused'), false);
  assert.equal(challenge.isChallenge('anubis'), true);
});

test('a big cleared page that embeds a Turnstile widget is content, not a gate', () => {
  const big = '<title>nowsecure.nl</title>' + '<div>real page</div>'.repeat(8000) + '<input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-x_response">';
  assert.ok(big.length > 120000);
  assert.equal(challenge.detect({ status: 200, html: big }), null);
});

/* --------------------------------------------------------------- proof of work */

test('proofOfWork finds the nonce the Anubis worker would find', () => {
  const sol = challenge.proofOfWork('deadbeef', 3);
  const hash = crypto.createHash('sha256').update(`deadbeef${sol.nonce}`).digest('hex');
  assert.equal(hash, sol.hash);
  assert.ok(challenge.leadingZeros(hash) >= 3);
  assert.equal(sol.nonce, String(Number(sol.nonce)));
});

test('anubisChallenge reads the challenge, the rule and the base prefix from the page', () => {
  const html = `<script id="anubis_version" type="application/json">"v1.28.2"</script>
    <script id="anubis_challenge" type="application/json">${JSON.stringify({ rules: { algorithm: 'fast', difficulty: 2 }, challenge: { id: 'abc', randomData: 'ff00' } })}</script>
    <script id="anubis_base_prefix" type="application/json">"/gate/"</script>`;
  const got = challenge.anubisChallenge(html);
  assert.equal(got.id, 'abc');
  assert.equal(got.difficulty, 2);
  assert.equal(got.algorithm, 'fast');
  assert.equal(got.supported, true);
  assert.equal(got.basePrefix, '/gate');
  assert.equal(challenge.anubisChallenge('<p>no gate</p>'), null);
  const wasm = challenge.anubisChallenge('<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"argon2id","difficulty":4},"challenge":{"id":"x","randomData":"00"}}</script>');
  assert.equal(wasm.supported, false, 'only the SHA-256 algorithms are computed here');
});

/* --------------------------------------------------- Anubis, three hops, stubbed */

test('solveAnubis trades the proof of work for the cookie and returns the page behind it', async () => {
  const now = Date.now();
  const calls = [];
  net.request = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      assert.equal(url, 'https://social.example/api/v1/x');
      const html = `<script id="anubis_challenge" type="application/json">${JSON.stringify({ rules: { algorithm: 'fast', difficulty: 1 }, challenge: { id: 'ch-1', randomData: 'abcd' } })}</script>`;
      return { status: 200, url, headers: { 'set-cookie': ['techaro.lol-anubis-cookie-verification-x=1; Path=/; HttpOnly'] }, body: Buffer.from(html) };
    }
    if (calls.length === 2) {
      assert.match(url, /^https:\/\/social\.example\/\.within\.website\/x\/cmd\/anubis\/api\/pass-challenge\?/);
      assert.match(url, /id=ch-1/);
      assert.match(url, /response=[0-9a-f]{64}/);
      assert.match(opts.headers.cookie, /cookie-verification/);
      return { status: 302, url, headers: { 'set-cookie': ['techaro.lol-anubis-auth-x=JWT; Path=/; Secure', 'techaro.lol-anubis-cookie-verification-x=2; Path=/'] }, body: Buffer.from('') };
    }
    assert.match(opts.headers.cookie, /anubis-auth-x=JWT/);
    return { status: 200, url, headers: {}, body: Buffer.from('{"id":"1"}') };
  };
  const got = await challenge.solveAnubis('https://social.example/api/v1/x', { headers: { accept: 'application/json' }, accept: 'application/json' });
  assert.equal(got.status, 200);
  assert.equal(got.html, '{"id":"1"}');
  assert.match(got.cookie, /anubis-auth-x=JWT/);
  assert.ok(got.ms >= 0);
  // cached, so a second call on the same host can send it without solving again
  assert.equal(challenge.cachedCookie('social.example'), got.cookie);
  challenge.forgetCookie('social.example');
  assert.equal(challenge.cachedCookie('social.example'), null);
});

test('solveAnubis returns null when the page is not behind Anubis', async () => {
  net.request = async (url) => ({ status: 200, url, headers: {}, body: Buffer.from('<html>a normal page</html>') });
  assert.equal(await challenge.solveAnubis('https://plain.example/'), null);
});

test('solveAnubis refuses an algorithm it cannot compute', async () => {
  net.request = async (url) => ({
    status: 200, url, headers: {},
    body: Buffer.from('<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"argon2id","difficulty":4},"challenge":{"id":"z","randomData":"00"}}</script>'),
  });
  await assert.rejects(challenge.solveAnubis('https://hard.example/'), (e) => e.unsupported === true);
});

/* ------------------------------------------------------------------ TikTok embed */

const EMBED_STATE = {
  source: { data: { '/embed/@noahwaybabes': {
    userInfo: { uniqueId: 'noahwaybabes', nickname: 'noah', signature: 'LA', avatarThumbUrl: 'https://cdn/a.jpg', followerCount: 263800, verified: false },
    videoList: [
      { id: '7701891855251672333', desc: '', playAddr: 'https://v45.tiktokcdn-us.com/x.mp4', originCoverUrl: 'https://p19.cdn/c.jpg', playCount: 53400, width: 720, height: 1280, privateItem: false },
      { id: '7689614232056384781', desc: 'second', playAddr: 'https://v45.tiktokcdn-us.com/y.mp4', coverUrl: 'https://p19.cdn/d.jpg', playCount: 1, privateItem: false },
      { id: '7000000000000000000', desc: 'private', playAddr: '', coverUrl: '', privateItem: true },
    ],
  } } },
};

test('the TikTok embed parser keeps real videos, drops private ones and reads the profile', () => {
  const { user, videos } = tiktok.parseEmbed(EMBED_STATE);
  assert.equal(user.uniqueId, 'noahwaybabes');
  assert.equal(videos.length, 2);
  const item = tiktok.videoToItem(videos[0], 'noahwaybabes', user);
  assert.equal(item.sourceId, 'tiktok-7701891855251672333');
  assert.equal(item.mediaType, 'video');
  assert.equal(item.mediaUrl, 'https://v45.tiktokcdn-us.com/x.mp4');
  assert.equal(item.thumbnailUrl, 'https://p19.cdn/c.jpg');
  assert.equal(item.permalink, 'https://www.tiktok.com/@noahwaybabes/video/7701891855251672333');
  assert.equal(item.author, 'noah');
  assert.equal(item.trusted, true);
});

test('the TikTok adapter accepts handles and profile URLs, and refuses anything else', () => {
  assert.equal(tiktok.handleOf('@noahwaybabes'), 'noahwaybabes');
  assert.equal(tiktok.handleOf('noahwaybabes'), 'noahwaybabes');
  assert.equal(tiktok.handleOf('https://www.tiktok.com/@noahwaybabes?lang=en'), 'noahwaybabes');
  assert.throws(() => tiktok.handleOf('https://example.com/x'), (e) => e.status === 422);
});

test('a TikTok answer that is not the embed is reported, not mistaken for an empty profile', async () => {
  net.request = async (url) => ({ status: 200, url, headers: {}, body: Buffer.from('<html>login</html>') });
  await assert.rejects(tiktok.fetch({ target: '@noahwaybabes' }, { limit: 10 }), (e) => e.status === 502 && /no embed state/.test(e.message));
});

test('a TikTok handle pasted as a link becomes a feed, and one video collapses to its profile', () => {
  const links = require('../src/lib/links');
  const a = links.parseProfile('https://www.tiktok.com/@noahwaybabes');
  assert.equal(a.platform, 'tiktok');
  assert.equal(a.kind, 'user');
  assert.equal(a.target, 'noahwaybabes');
  const b = links.parseProfile('https://www.tiktok.com/@noahwaybabes/video/7641807423975476494');
  assert.equal(b.target, 'noahwaybabes');
  assert.equal(links.profileUrl('tiktok', 'user', '@noahwaybabes'), 'https://www.tiktok.com/@noahwaybabes');
});

/* ------------------------------------------------------------------- Jina reader */

test('the Jina reader reports a refusal as blocked instead of passing the challenge page on', async () => {
  net.request = async () => ({
    status: 200, headers: {},
    body: Buffer.from('Title: Just a moment...\n\nWarning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.\n'),
  });
  const r = await jina.read('https://gayforfans.example/performer/x', { budget: 10 });
  assert.equal(r.blocked, true);
  assert.equal(r.bytes > 0, true);
});

test('the Jina reader sends the page as HTML and never a paid platform', async () => {
  let seen = null;
  net.request = async (url, opts) => { seen = { url, opts }; return { status: 200, headers: {}, body: Buffer.from('<html>' + 'x'.repeat(4000) + '</html>') }; };
  const r = await jina.read('https://justthegays.example/', { budget: 10 });
  assert.equal(seen.url, `https://r.jina.ai/https://justthegays.example/`);
  assert.equal(seen.opts.headers['x-respond-with'], 'html');
  assert.equal(r.blocked, false);
  assert.match(r.html, /^<html>/);
  await assert.rejects(jina.read('https://onlyfans.com/someone', { budget: 10 }), (e) => e.skip === true);
});

/* --------------------------------------------------------------- Chrome next page */

test('the CDP browser follows a rel=next link only on the same site', () => {
  const html = '<link rel="next" href="/page/2">';
  assert.equal(chrome.nextLink(html, 'https://site.example/page/1'), 'https://site.example/page/2');
  assert.equal(chrome.nextLink('<a rel="next" href="https://other.example/p2">', 'https://site.example/p1'), null);
  assert.equal(chrome.nextLink('<p>no next</p>', 'https://site.example/p1'), null);
  assert.equal(chrome.nextLink(html, 'not a url'), null);
});
