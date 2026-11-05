'use strict';
/**
 * Failure classification (engine/errorclass) and where it is used: the library sweep must not switch off a feed because its
 * last error text happened to contain "unavailable" or "404" (a 503 outage is not a missing target).
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let maintenance; let classify;
before(() => {
  prepareEnv();
  repo = require('../src/db/repo');
  maintenance = require('../src/engine/maintenance');
  ({ classify } = require('../src/engine/errorclass'));
});

test('classify: the status decides first, then the wording', () => {
  const k = (e) => classify(e).kind;
  assert.equal(k('HTTP 429 for https://x/y'), 'rate_limited');
  assert.equal(k(Object.assign(new Error('Telegram rate limit: wait 30s'), { status: 429, retryAfter: 30000 })), 'rate_limited');
  assert.equal(k(Object.assign(new Error('rss is rate-limited: cooling down for 600 s'), { cooldown: true, status: 429 })), 'rate_limited');
  assert.equal(k('HTTP 404 for https://x/y'), 'not_found');
  assert.equal(k('User not found'), 'not_found');
  assert.equal(k('account suspended'), 'not_found');
  assert.equal(k(Object.assign(new Error('user_banned'), { status: 403 })), 'not_found', 'a banned target beats the 403');
  // a site-wide refusal says nothing about the target: it can recover, so it is a block and never ends the feed
  for (const m of ['API access suspended', 'this IP is banned', 'Your IP address has been banned', 'application suspended by the platform', 'token suspended'])
    assert.equal(k(m), 'blocked', m);
  assert.equal(classify('API access suspended').permanent, false);
  assert.equal(k(Object.assign(new Error('this IP is banned'), { status: 403 })), 'blocked');
  assert.equal(k('HTTP 403 for https://x/y'), 'blocked');
  assert.equal(k(Object.assign(new Error('Bot-protection page instead of JSON from u'), { code: 'BOT_CHALLENGE' })), 'blocked');
  assert.equal(k('mastodon.example requires sign-in for this request (HTTP 401)'), 'blocked');
  assert.equal(k('HTTP 503 Service Unavailable for https://x'), 'server');
  assert.equal(k('Reddit unavailable for r/x on every transport: 502'), 'server');
  assert.equal(k('Invalid JSON from https://x/api'), 'parse');
  assert.equal(k('https://x is a web page, not a feed, and advertises no RSS/Atom/JSON feed'), 'parse');
  assert.equal(k(Object.assign(new Error('Not a valid feed: x'), { status: 422 })), 'parse');
  assert.equal(k('rss/feed:https://x timed out after 150s'), 'timeout');
  assert.equal(k(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'network');
  assert.equal(k('getaddrinfo ENOTFOUND nope.example'), 'network');
  assert.equal(k(Object.assign(new Error('X API token missing'), { skip: true })), 'config');
  assert.equal(k('something odd'), 'other');
  assert.equal(k(null), 'other');
});

test('classify: transient kinds never end a feed, only a missing target does', () => {
  for (const m of ['HTTP 429 for u', 'HTTP 403 for u', 'HTTP 502 for u', 'rss timed out after 150s', 'read ECONNRESET']) assert.equal(classify(m).transient, true, m);
  for (const m of ['HTTP 404 for u', 'channel is private']) assert.equal(classify(m).permanent, true, m);
  for (const m of ['Invalid JSON from u', 'something odd']) { const c = classify(m); assert.equal(c.transient || c.permanent, false, m); }
  // our own SSRF guard is a refusal about the target, not an outage that will pass
  assert.equal(classify('Blocked host: a resolves to a private address').transient, false);
});

test('classify: a "private address" refusal is not read as a private channel', () => {
  assert.notEqual(classify('Blocked host: x resolves to a private address').kind, 'not_found');
});

let n = 0;
function failing(failures, lastError) {
  const f = repo.feeds.upsert({ platform: 'rss', kind: 'feed', target: `https://sweep.example/${++n}.xml`, origin: 'discovered', enabled: 1 }).feed;
  repo.db.prepare('UPDATE feeds SET consecutive_failures = ?, last_error = ? WHERE id = ?').run(failures, lastError, f.id);
  return f;
}
const on = (f) => repo.feeds.get(f.id).enabled;

test('the library sweep keeps a feed whose last error was an outage, a challenge or a rate limit', async () => {
  const outage = failing(3, 'HTTP 503 Service Unavailable for https://site.example/feed.xml');
  const walled = failing(6, 'HTTP 403 for https://site.example/feed.xml');
  const limited = failing(7, 'HTTP 429 for https://site.example/feed.xml');
  const digits = failing(3, 'HTTP 500 for https://site.example/item/1404.xml');
  await maintenance.sweep({ limit: 0 });
  for (const f of [outage, walled, limited, digits]) assert.equal(on(f), 1, repo.feeds.get(f.id).last_error);
});

test('the library sweep still switches off a feed whose target is gone, or that never answers with anything readable', async () => {
  const gone = failing(3, 'HTTP 404 for https://site.example/feed.xml');
  const missing = failing(3, 'User not found');
  const junk = failing(5, 'Invalid JSON from https://site.example/api');
  const young = failing(2, 'HTTP 404 for https://site.example/feed.xml');
  await maintenance.sweep({ limit: 0 });
  assert.equal(on(gone), 0); assert.equal(on(missing), 0); assert.equal(on(junk), 0);
  assert.equal(on(young), 1, 'two failures are not enough');
});
