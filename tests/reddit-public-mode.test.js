'use strict';
// Public Reddit allows about one request a minute and refuses the .json transports from this IP with a
// 403 challenge page. The ladder must still end on the RSS transport, and a 429 on a later page must not
// throw away the page that already worked. No network and no real waiting: net.fetchJSON / net.fetchText
// are stubbed and the limiter runs calls immediately.
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

before(() => {
  net.fetchText = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (!/\.rss/.test(url)) challenge();
    return ATOM;
  };
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (/\/about/.test(url) || /\.json/.test(url)) challenge();
    challenge();
  };
});
after(() => { settings.get = realGet; });

const feed = (kind, target) => ({ platform: 'reddit', kind, target });

test('the public ladder falls through the 403 JSON transports to the RSS feed', async () => {
  calls = [];
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('user', 'busy'), { cursor: {}, limit: 25, aborted: () => false });
  assert.ok(out.items.some((i) => /abc\.jpg$/.test(i.mediaUrl)), 'the feed is read');
  assert.equal(out.via, 'rss');
  assert.ok(calls.some((c) => c.url.startsWith(`${BASE}/user/busy/submitted.json?`)), 'JSON is tried first');
  assert.ok(calls.some((c) => /submitted\.rss/.test(c.url)), 'RSS is the answer');
  assert.equal(calls.find((c) => /submitted\.rss/.test(c.url)).opts.maxCooldownWaitMs, 70000, 'a 429 waits the minute out');
});

test('a 429 on a later page keeps the items already read and only adds a note', async () => {
  calls = [];
  let jsonHits = 0;
  net.fetchJSON = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (/\/about/.test(url)) challenge();
    jsonHits++;
    if (jsonHits === 1) return { data: { children: [child('p1'), child('p2')], after: 't3_next' } };
    rate();
  };
  net.fetchText = async (url) => { calls.push({ url: String(url) }); challenge(); };
  const reddit = require('../src/sources/reddit');
  const out = await reddit.fetch(feed('community', 'gaybrosgonewild'), { cursor: { newestAt: '2026-01-01T00:00:00.000Z' }, limit: 100, aborted: () => false });
  const parsed = out.items.filter((i) => i.mediaUrl);
  assert.equal(parsed.length, 2, 'both items from the answered page are returned');
  assert.ok(out.notes.some((n) => /stopped early after 2 items: .*429/.test(n)), 'the rate limit is reported, not thrown');
});

test('a run that never got a page still fails', async () => {
  net.fetchJSON = async () => { rate(); };
  net.fetchText = async () => { rate(); };
  const reddit = require('../src/sources/reddit');
  await assert.rejects(reddit.fetch(feed('user', 'busy'), { cursor: {}, limit: 25, aborted: () => false }), /429/);
});
