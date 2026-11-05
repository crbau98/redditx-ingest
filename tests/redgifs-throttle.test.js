'use strict';
// RedGIFs 429 recovery: a 10-minute platform hold, 30 minutes on a second strike, a 2 s spacing and a 40-item user page.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const net = require('../src/lib/net');
const limiter = require('../src/lib/limiter');
const { penaltyFor } = require('../src/sources/http');

const MIN = 60 * 1000;
const realFetchJSON = net.fetchJSON;
const realSchedule = limiter.schedule;
const realPenalize = limiter.penalize;
let scheduled; let penalties; let urls; let respond;

beforeEach(() => {
  scheduled = []; penalties = []; urls = [];
  // Pass-through spacing (no sleeps); record the interval each call asked for and every penalty applied.
  limiter.schedule = (key, ms, fn) => { scheduled.push({ key, ms }); return fn(); };
  limiter.penalize = (key, ms) => penalties.push({ key, ms });
  // The adapter captures net.fetchJSON when it loads, so the stub must be in place before the first require.
  net.fetchJSON = async (url) => { urls.push(url); return respond(url); };
});
afterEach(() => { net.fetchJSON = realFetchJSON; limiter.schedule = realSchedule; limiter.penalize = realPenalize; });

const rg = () => require('../src/sources/redgifs');
const err429 = () => Object.assign(new Error('HTTP 429'), { status: 429 });
const ok = (url) => (url.includes('/v2/auth/temporary') ? { token: 't' } : { gifs: [], pages: 1 });
const ctx = (limit) => ({ limit, aborted: () => false, cursor: {} });

test('penaltyFor: 10 minutes after a 429 with no Retry-After, 30 on a second strike inside the window', () => {
  const p = rg().REDGIFS_PENALTY; const state = { lastStrike: 0 };
  assert.equal(penaltyFor({}, p, state, 1_000_000), 10 * MIN);
  assert.equal(penaltyFor({}, p, state, 1_000_000 + 9 * MIN), 30 * MIN, 'second strike within 10 min');
  assert.equal(penaltyFor({}, p, state, 1_000_000 + 9 * MIN + 11 * MIN), 10 * MIN, 'outside the window it starts again at 10');
});

test('penaltyFor: a longer server Retry-After still wins; a shorter one does not shrink the floor', () => {
  const p = rg().REDGIFS_PENALTY;
  assert.equal(penaltyFor({ retryAfter: 60 * 1000 }, p, { lastStrike: 0 }, 5), 10 * MIN);
  assert.equal(penaltyFor({ retryAfter: 45 * MIN }, p, { lastStrike: 0 }, 5), 45 * MIN);
});

test('penaltyFor without a policy keeps the old behaviour (Retry-After or 30 s)', () => {
  assert.equal(penaltyFor({}, null, { lastStrike: 0 }), 30000);
  assert.equal(penaltyFor({ retryAfter: 5000 }, null, { lastStrike: 0 }), 5000);
});

test('a 429 on a user feed holds the redgifs platform 10 min, and 30 min on a second 429 within 10 min', async () => {
  respond = (url) => { if (url.includes('/v2/auth/temporary')) return { token: 't' }; throw err429(); };
  const r = rg();
  await assert.rejects(r.fetch({ kind: 'user', target: 'someone' }, ctx(40)), /429/);
  assert.deepEqual(penalties.map((p) => p.key), ['redgifs']);
  assert.equal(penalties[0].ms, 10 * MIN);
  await assert.rejects(r.fetch({ kind: 'user', target: 'someone' }, ctx(40)), /429/);
  assert.equal(penalties[1].ms, 30 * MIN, 'second strike');
});

test('redgifs calls are spaced 2000 ms apart', async () => {
  respond = ok;
  await rg().fetch({ kind: 'user', target: 'someone' }, ctx(40));
  assert.ok(scheduled.length >= 1);
  assert.ok(scheduled.every((s) => s.key === 'redgifs' && s.ms === 2000), JSON.stringify(scheduled));
});

test('the user per-search page is capped at 40 items; search and niche feeds keep 80', async () => {
  respond = ok;
  await rg().fetch({ kind: 'user', target: 'someone' }, ctx(80));
  assert.match(urls.find((u) => u.includes('/search?order=recent')), /count=40\b/);
  urls.length = 0;
  await rg().fetch({ kind: 'user', target: 'someone' }, ctx(15));
  assert.match(urls.find((u) => u.includes('/search?order=recent')), /count=15\b/, 'a smaller limit still wins');
  urls.length = 0;
  await rg().fetch({ kind: 'search', target: 'gay' }, ctx(80));
  assert.match(urls.find((u) => u.includes('/v2/gifs/search')), /count=80\b/);
});
