'use strict';
// Public Reddit allows about one request a minute and refuses the .json transports from this IP with a
// 403 challenge page. Without OAuth the ladder must ask the archive first, and a 429 on a later page must
// not throw away the page that already worked. No network and no real waiting: net.fetchJSON /
// net.fetchText are stubbed and the limiter runs calls immediately.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-public-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const limiter = require('../src/lib/limiter');
limiter.schedule = async (key, ms, fn) => fn();
limiter.coolingDown = () => 0;

const net = require('../src/lib/net');
const settings = require('../src/settings');
const realGet = settings.get;
settings.get = () => ({ ...realGet(), redditEnabled: true });

const BASE = 'https://www.reddit.com';
const ARCHIVE = 'https://arctic-shift.photon-reddit.com';
const ATOM = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">'
  + '<title>newest submissions</title><entry><id>t3_abc</id><title>Gay jock at the gym</title>'
  + '<author><name>/u/busy</name></author><link href="https://www.reddit.com/r/gaybrosgonewild/comments/abc/x/"/>'
  + '<published>2026-11-06T05:00:00+00:00</published>'
  + '<content type="html">&lt;a href="https://i.redd.it/abc.jpg"&gt;x&lt;/a&gt;</content>'
  + '<media:content url="https://i.redd.it/abc.jpg" type="image/jpeg" /></entry></feed>';
const child = (id) => ({ kind: 't3', data: { id, subreddit: 'gaybrosgonewild', author: 'busy', title: 't', url: `https://i.redd.it/${id}.jpg`, created_utc: 1793940000, over_18: true, score: 3 } });

let calls;
const challenge = () => { const e = new Error('Unexpected token \'<\''); e.status = 403; e.body = '<html>challenge</html>'; throw e; };
const rate = () => { const e = new Error('HTTP 429 for reddit'); e.status = 429; e.retryAfter = 60000; throw e; };
const archive = (rows) => ({ data: rows });

before(() => {
  net.fetchText = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (!/\.rss/.test(url)) challenge();
    return ATOM;
  };
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (/arctic-shift/.test(url)) return archive([child('a1'), child('a2')]);
    if (/\/about/.test(url) || /\.json/.test(url)) challenge();
    challenge();
  };
});
after(() => { settings.get = realGet; });

const feed = (kind, target) => ({ platform: 'reddit', kind, target });

test('without credentials the archive is asked first and the refused JSON transports stay unrequested', async () => {
  calls = [];
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('user', 'busy'), { cursor: {}, limit: 25, aborted: () => false });
  assert.equal(out.via, 'archive');
  assert.equal(out.items.filter((i) => i.mediaUrl).length, 2, 'the archive rows are read');
  assert.equal(calls[0].url.startsWith(`${ARCHIVE}/api/posts/search?`), true, 'the archive answers the fresh read');
  assert.equal(calls.filter((c) => /submitted\.json/.test(c.url)).length, 0, 'no doomed www JSON request');
  assert.equal(calls.filter((c) => /submitted\.rss/.test(c.url)).length, 0, 'no doomed RSS request');
});

test('an empty archive falls through the public transports to the RSS feed', async () => {
  calls = [];
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (/arctic-shift/.test(url)) return archive([]);
    challenge();
  };
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('user', 'busy'), { cursor: {}, limit: 25, aborted: () => false });
  assert.ok(out.items.some((i) => /abc\.jpg$/.test(i.mediaUrl)), 'the feed is still read');
  assert.equal(out.via, 'rss');
  assert.ok(calls.some((c) => c.url.startsWith(`${ARCHIVE}/api/posts/search?`)), 'the archive was tried first');
  assert.ok(calls.some((c) => /submitted\.rss/.test(c.url)), 'RSS is the fallback that answers');
  assert.equal(calls.find((c) => /submitted\.rss/.test(c.url)).opts.maxCooldownWaitMs, 70000, 'a 429 waits the minute out');
});

test('a first run from the archive reads one page, not the same page twice (top and hot)', async () => {
  calls = [];
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (/arctic-shift/.test(url)) return archive([child('a1'), child('a2')]);
    challenge();
  };
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: {}, limit: 100, aborted: () => false });
  assert.equal(calls.filter((c) => /arctic-shift/.test(c.url)).length, 1, 'one archive call for both passes');
  assert.deepEqual(out.items.map((i) => i.sourceId), ['a1', 'a2'], 'no duplicates');
  assert.ok(out.notes.some((n) => /archive read once/.test(n)));
});

const fullPage = (from, n = 100) => Array.from({ length: n }, (_, i) => ({ ...child(`f${from + i}`).data, created_utc: 1793940000 + from + i }));
const penalties = [];
limiter.penalize = (key, ms) => { penalties.push({ key, ms }); };

test('a rate-limited archive page (200 with an error) keeps the items already read, adds a note and holds the platform', async () => {
  calls = []; penalties.length = 0;
  let hits = 0;
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (!/arctic-shift/.test(url)) challenge();
    hits++;
    return hits === 1 ? archive(fullPage(0)) : { error: 'Timeout. Maybe slow down a bit' };
  };
  net.fetchText = async (url) => { calls.push({ url: String(url) }); challenge(); };
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: { newestAt: '2026-11-01T00:00:00.000Z' }, limit: 100, aborted: () => false });
  assert.equal(out.items.filter((i) => i.mediaUrl).length, 100, 'the answered page is returned');
  assert.ok(out.notes.some((n) => /stopped early after 100 items: .*rate limiting/.test(n)), 'the rate limit is reported, not thrown');
  assert.deepEqual(penalties.map((p) => p.key), ['reddit'], 'the reddit limiter is held');
  assert.ok(penalties[0].ms >= 60000, 'with the same penalty as a Reddit 429');
});

test('the archive rate limit as HTTP 422 ("Timeout. Maybe slow down") is read as a 429: items kept, platform held', async () => {
  calls = []; penalties.length = 0;
  let hits = 0;
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (!/arctic-shift/.test(url)) challenge();
    hits++;
    if (hits === 1) return archive(fullPage(0));
    // What net.fetchJSON throws for a non-2xx answer: an HttpError-shaped error with the archive's JSON body.
    const e = new Error('HTTP 422 for https://arctic-shift.photon-reddit.com/api/posts/search');
    e.status = 422; e.body = '{"data":null,"error":"Timeout. Maybe slow down a bit"}';
    throw e;
  };
  net.fetchText = async (url) => { calls.push({ url: String(url) }); challenge(); };
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: { newestAt: '2026-11-01T00:00:00.000Z' }, limit: 100, aborted: () => false });
  assert.equal(out.items.filter((i) => i.mediaUrl).length, 100, 'the page answered before the limit is returned');
  assert.ok(out.notes.some((n) => /stopped early after 100 items: .*rate limiting/.test(n)), 'the 422 rate limit is reported, not thrown as a hard error');
  assert.deepEqual(penalties.map((p) => p.key), ['reddit'], 'the reddit limiter is held');
  assert.ok(penalties[0].ms >= 60000, 'with the same penalty as a Reddit 429');
});

test('an archive 422 that is not a rate limit still surfaces as an error', async () => {
  calls = []; penalties.length = 0;
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (!/arctic-shift/.test(url)) challenge();
    const e = new Error('HTTP 422 for https://arctic-shift.photon-reddit.com/api/posts/search');
    e.status = 422; e.body = '{"error":"Invalid sort"}';
    throw e;
  };
  net.fetchText = async (url) => { calls.push({ url: String(url) }); challenge(); };
  const reddit = require('../src/sources/reddit');
  await assert.rejects(() => reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: {}, limit: 100, aborted: () => false }));
  assert.equal(penalties.length, 0, 'a real 422 does not hold the limiter as a rate limit');
});

test('an incremental run asks the archive after the cursor second, oldest first, and pages forward up to the cap', async () => {
  calls = [];
  const cursorAt = '2026-11-01T00:00:00.000Z';
  const sec = Date.parse(cursorAt) / 1000;
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (!/arctic-shift/.test(url)) challenge();
    const after = Number(new URL(url).searchParams.get('after'));
    return archive(fullPage(after - 1793940000 + 1));
  };
  net.fetchText = async (url) => { calls.push({ url: String(url) }); challenge(); };
  const reddit = require('../src/sources/reddit');
  await reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: { newestAt: cursorAt }, limit: 100, aborted: () => false });
  const asked = calls.map((c) => new URL(c.url));
  assert.equal(asked.length, 2, 'two pages at most on an incremental run');
  assert.equal(asked[0].searchParams.get('after'), String(sec - 1), 'starts at the cursor second (after is exclusive)');
  assert.equal(asked[0].searchParams.get('sort'), 'asc');
  assert.ok(Number(asked[1].searchParams.get('after')) > sec, 'the next page continues after the last row');
  assert.ok(!calls.some((c) => /reddit\.com\/r\/.*\.json/.test(c.url)), 'www/old never asked');
});

test('an incremental run with nothing after the cursor is an honest empty answer, not a failure', async () => {
  calls = [];
  net.fetchJSON = async (url, opts = {}) => { calls.push({ url: String(url), opts }); if (/arctic-shift/.test(url)) return archive([]); challenge(); };
  net.fetchText = async (url) => { calls.push({ url: String(url) }); challenge(); };
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: { newestAt: '2026-11-01T00:00:00.000Z' }, limit: 100, aborted: () => false });
  assert.equal(out.via, 'archive');
  assert.equal(out.items.length, 0);
  assert.equal(calls.length, 1, 'no fallback requests');
});

test('with OAuth credentials the OAuth leg still goes first', async () => {
  const config = require('../src/config');
  const saved = { id: config.creds.redditClientId, secret: config.creds.redditClientSecret };
  config.creds.redditClientId = 'test-id'; config.creds.redditClientSecret = 'test-secret';
  calls = [];
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (/access_token/.test(url)) return { access_token: 'tok', expires_in: 3600 };
    if (/oauth\.reddit\.com/.test(url)) return { data: { children: [child('o1')], after: null } };
    challenge();
  };
  try {
    const reddit = require('../src/sources/reddit');
    const out = await reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: { newestAt: '2026-01-01T00:00:00.000Z' }, limit: 100, aborted: () => false });
    assert.equal(out.via, 'oauth');
    assert.ok(/access_token/.test(calls[0].url), 'the token comes first');
    assert.ok(/oauth\.reddit\.com/.test(calls[1].url), 'then the OAuth listing');
    assert.ok(!calls.some((c) => /arctic-shift/.test(c.url)), 'the archive is not asked when OAuth answers');
  } finally { config.creds.redditClientId = saved.id; config.creds.redditClientSecret = saved.secret; }
});

test('a run that never got a page still fails', async () => {
  net.fetchJSON = async () => { rate(); };
  net.fetchText = async () => { rate(); };
  const reddit = require('../src/sources/reddit');
  await assert.rejects(reddit.fetch(feed('user', 'busy'), { cursor: {}, limit: 25, aborted: () => false }), /429/);
});
