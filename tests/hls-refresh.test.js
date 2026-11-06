'use strict';
// /api/hls: a signed playlist that went stale is re-minted at the source before the viewer sees an
// error, and Pornhub's hotlink rule (its own site as the Referer) holds for playlists too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hls-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const net = require('../src/lib/net');
const playback = require('../src/engine/playback');
const repo = require('../src/db/repo');
const router = require('../src/routes/proxy');

const EXPIRED = 'https://hv-h.phncdn.com/hls/c1/videos/2026/master.m3u8?h=old&e=1';
const FRESH = 'https://hv-h.phncdn.com/hls/c1/videos/2026/master.m3u8?h=new&e=9999999999';
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4477372,RESOLUTION=1920x1080\nindex-v1-a1.m3u8?h=new\n';

function fakeRes() {
  const out = { code: 200, headers: {}, body: null };
  const res = {
    headersSent: false,
    status(code) { out.code = code; return res; },
    json(body) { out.body = body; res.headersSent = true; return res; },
    set(headers) { Object.assign(out.headers, headers); return res; },
    send(body) { out.body = body; res.headersSent = true; return res; },
  };
  return { res, out };
}

const hlsRoute = router.stack.find((l) => l.route && l.route.path === '/hls');
const hlsHandler = hlsRoute.route.stack[hlsRoute.route.stack.length - 1].handle;

test('a stale signed playlist is re-minted before the viewer sees an error', async () => {
  repo.hosts.add(EXPIRED);
  const seen = [];
  net.request = async (url, opts = {}) => {
    seen.push({ url, referer: opts.headers && opts.headers.referer });
    if (url === EXPIRED) return { status: 403, headers: {}, body: Buffer.from('expired'), url };
    return { status: 200, headers: {}, body: Buffer.from(MASTER), url: FRESH };
  };
  playback.refresh = async (url) => (url === EXPIRED ? FRESH : null);

  const { res, out } = fakeRes();
  await hlsHandler({ query: { url: EXPIRED }, headers: {} }, res);
  assert.equal(out.code, 200);
  assert.match(String(out.body), /^#EXTM3U/);
  assert.match(String(out.body), /\/api\/hls\?url=/, 'variant links are rewritten through us');
  assert.equal(seen[0].url, EXPIRED);
  assert.equal(seen[0].referer, 'https://www.pornhub.com/', 'phncdn answers 412 to any other Referer');
  assert.equal(seen[1].url, FRESH);
  assert.equal(seen[1].referer, 'https://www.pornhub.com/');
});

test('a dead playlist with no fresh link still reports the upstream error', async () => {
  net.request = async (url) => ({ status: 403, headers: {}, body: Buffer.from('expired'), url });
  playback.refresh = async () => null;
  const { res, out } = fakeRes();
  await hlsHandler({ query: { url: EXPIRED }, headers: {} }, res);
  assert.equal(out.code, 502);
  assert.equal(out.body.error, 'Upstream error');
});
