'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let peertube; let links; let host; const calls = [];

before(async () => {
  const acct = { name: 'gymguy', host: '', displayName: 'Gym Guy', avatars: [{ width: 120, path: '/lazy-static/avatars/a.png' }] };
  const video = (uuid, name, at) => ({ uuid, name, publishedAt: at, nsfw: true, duration: 30, views: 500, likes: 20, account: acct, channel: { name: 'gymguy_channel', displayName: 'Gym Guy' }, previewPath: `/lazy-static/previews/${uuid}.jpg`, thumbnailPath: `/lazy-static/thumbnails/${uuid}.jpg`, tags: ['gay'] });
  const detail = (uuid) => ({
    uuid, description: 'gay muscle workout', aspectRatio: 1.7, isLive: false,
    files: [{ resolution: { id: 720 }, fileUrl: `/static/webseed/${uuid}-720.mp4`, width: 1280 }, { resolution: { id: 1440 }, fileUrl: `/static/webseed/${uuid}-1440.mp4`, width: 2560 }, { resolution: { id: 0 }, fileUrl: `/static/webseed/${uuid}-audio.mp4` }],
  });
  mock = await start({
    '/api/v1/search/videos': (req, res, url) => { calls.push(url.search); return { json: { total: 2, data: [{ ...video('u1', 'Gay gym session', '2026-10-05T10:00:00.000Z'), url: `http://${req.headers.host}/videos/watch/u1`, account: { ...acct, host: req.headers.host } }] } }; },
    '/api/v1/videos/u1': () => ({ json: detail('u1') }),
    '/api/v1/videos': (req, res, url) => { calls.push(url.search); return { json: { total: 1, data: [{ ...video('u2', 'Gay tag video', '2026-10-04T10:00:00.000Z'), account: { ...acct, host: req.headers.host } }] } }; },
    '/api/v1/videos/u2': () => ({ json: { ...detail('u2'), files: [], streamingPlaylists: [{ playlistUrl: '/static/streaming-playlists/hls/u2/master.m3u8', files: [{ resolution: { id: 480 }, width: 854 }] }] } }),
  });
  host = `127.0.0.1:${mock.port}`;
  prepareEnv({ PEERTUBE_SEARCH_URL: mock.url, PEERTUBE_INSTANCES: host });
  peertube = require('../src/sources/peertube');
  links = require('../src/lib/links');
});
after(async () => { await mock.close(); });

const ctx = (o = {}) => ({ cursor: {}, limit: 40, aborted: () => false, ...o });

test('search index: video becomes an item with the best MP4 up to 1080p (not the 1440p, not audio-only)', async () => {
  const r = await peertube.fetch({ kind: 'search', target: 'gay muscle' }, ctx());
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.equal(it.mediaType, 'video');
  assert.match(it.mediaUrl, /u1-720\.mp4$/);
  assert.equal(it.height, 720);
  assert.equal(it.query, 'gay muscle');
  assert.equal(it.nsfw, 'explicit');
  assert.ok(it.author.startsWith('gymguy@'));
  assert.ok(calls.some((q) => /nsfw=true/.test(q) && /search=gay\+muscle|search=gay%20muscle/.test(q)), calls.join());
  assert.ok(r.cursor.newestAt);
});

test('tag feed on an instance falls back to the HLS playlist when no MP4 exists', async () => {
  const r = await peertube.fetch({ kind: 'tag', target: 'gay' }, ctx());
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].mediaUrl, /master\.m3u8$/);
  assert.match(r.items[0].hlsUrl, /master\.m3u8$/);
});

test('the cursor skips already-seen videos', async () => {
  const first = await peertube.fetch({ kind: 'search', target: 'gay muscle' }, ctx());
  const again = await peertube.fetch({ kind: 'search', target: 'gay muscle' }, ctx({ cursor: first.cursor }));
  assert.equal(again.items.length, 0);
});

test('link parsing and profile urls', () => {
  const p = (u) => { const x = links.parseProfile(u); return x && `${x.platform}|${x.kind}|${x.target}`; };
  assert.equal(p('peertube:gymguy@tube.example.org'), 'peertube|user|gymguy@tube.example.org');
  assert.equal(p('https://tube.example.org/a/gymguy'), 'peertube|user|gymguy@tube.example.org');
  assert.equal(p('https://tube.example.org/video-channels/gymguy_channel'), 'peertube|channel|gymguy_channel@tube.example.org');
  assert.equal(links.profileUrl('peertube', 'channel', 'chan@tube.example.org'), 'https://tube.example.org/c/chan');
});
