'use strict';
/**
 * The same RedGIFs clip is linked from many Reddit posts (crossposts, several communities in one run). Each link used to cost one
 * API call (2 s apart, and a 429 risk) although the answer is the same; resolutions are now remembered for a few minutes.
 * The playback refresh (a link that stopped working) always asks again.
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const net = require('../src/lib/net');
const limiter = require('../src/lib/limiter');
const realFetchJSON = net.fetchJSON;
const realSchedule = limiter.schedule;
let calls; let respond;

beforeEach(() => {
  calls = [];
  limiter.schedule = (key, ms, fn) => fn(); // no spacing in tests
  // the adapter captures net.fetchJSON when it loads: stub before the first require
  net.fetchJSON = async (url) => { calls.push(url); return respond(url); };
  delete require.cache[require.resolve('../src/sources/redgifs')];
  delete require.cache[require.resolve('../src/sources/http')];
});
afterEach(() => { net.fetchJSON = realFetchJSON; limiter.schedule = realSchedule; });

const gif = (id) => ({ gif: { id, urls: { hd: `https://media.redgifs.com/${id}.mp4`, poster: `https://media.redgifs.com/${id}-poster.jpg` }, userName: 'zed', tags: ['Gay'], width: 720, height: 1280, duration: 8 } });
const ok = (url) => (url.includes('/v2/auth/temporary') ? { token: 't' } : gif(url.split('/gifs/')[1]));
const apiCalls = () => calls.filter((u) => u.includes('/v2/gifs/')).length;
const rg = () => require('../src/sources/redgifs');

test('the same clip linked twice is resolved with one API call', async () => {
  respond = ok;
  const r = rg();
  const a = await r.resolve('https://www.redgifs.com/watch/FitMaleAthlete');
  const b = await r.resolve('https://www.redgifs.com/ifr/fitmaleathlete');
  assert.equal(apiCalls(), 1);
  assert.equal(a.mediaUrl, 'https://media.redgifs.com/fitmaleathlete.mp4');
  assert.deepEqual(b, a);
  assert.notEqual(b, a, 'a caller changing its copy does not change the next one');
  await r.resolve('https://www.redgifs.com/watch/another');
  assert.equal(apiCalls(), 2, 'a different clip is a different call');
});

test('{fresh: true} (a link that stopped working) always asks again and updates the answer', async () => {
  let version = 1;
  respond = (url) => (url.includes('/v2/auth/temporary') ? { token: 't' } : { gif: { id: 'x', urls: { hd: `https://media.redgifs.com/x-v${version}.mp4` } } });
  const r = rg();
  assert.match((await r.resolve('https://www.redgifs.com/watch/x')).mediaUrl, /x-v1/);
  version = 2;
  assert.match((await r.resolve('https://www.redgifs.com/watch/x')).mediaUrl, /x-v1/, 'cached');
  assert.match((await r.resolve('https://www.redgifs.com/watch/x', { fresh: true })).mediaUrl, /x-v2/);
  assert.match((await r.resolve('https://www.redgifs.com/watch/x')).mediaUrl, /x-v2/, 'the fresh answer is what is remembered now');
});

test('a gif that is gone (404) is remembered as gone; a rate limit or an outage is not remembered', async () => {
  let status = 404;
  respond = (url) => { if (url.includes('/v2/auth/temporary')) return { token: 't' }; throw Object.assign(new Error(`HTTP ${status}`), { status }); };
  const r = rg();
  await assert.rejects(r.resolve('https://www.redgifs.com/watch/deadgif'), /404/);
  await assert.rejects(r.resolve('https://www.redgifs.com/watch/deadgif'), /404/);
  assert.equal(apiCalls(), 1, 'the second ask is answered from memory');
  status = 429;
  await assert.rejects(r.resolve('https://www.redgifs.com/watch/busy'), /429/);
  await assert.rejects(r.resolve('https://www.redgifs.com/watch/busy'), /429/);
  assert.equal(apiCalls(), 3, 'a 429 is asked again');
});
