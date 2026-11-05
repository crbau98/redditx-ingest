'use strict';
// Scrapfly follow-ups: (1) a page feed is covered by an allowlisted handle in its URL path (6+ characters only);
// (2) the gff performer page that answers with a bot check is read through the tier for allowlisted creators, and stays a
// challenge otherwise; opt-outs still win. No network: the HTTP clients are replaced before the adapters load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scrapfly-followups-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';
process.env.SCRAPFLY_API_KEY = 'TESTKEY-followups-0123456789';

const net = require('../src/lib/net');
const HttpError = net.HttpError;
// gff's HTTP client and the robots check capture these at load: replace them first.
let performerStatus = 403;
const performerHtml = '<html><head><title>Brett King</title></head><body><h1>Brett King - porn, OnlyFans</h1><a href="/video/abcdef-one">One</a><a href="/video/ghijkl-two">Two</a></body></html>';
net.fetchText = async (url) => {
  if (/\/performer\//.test(url)) throw new HttpError(`HTTP ${performerStatus} for ${url}`, { status: performerStatus, url });
  return '<html></html>';
};
net.request = async () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') });

const settings = require('../src/settings');
const realGet = settings.get;
const browser4 = require('../src/lib/browser4');
const realAllowed = browser4.assertAllowed;
const scrapfly = require('../src/lib/scrapfly');
const repo = require('../src/db/repo');
const gff = require('../src/sources/gff');

const withSettings = (over) => {
  settings.get = () => ({ ...realGet(), scrapflyUnlocker: 'fallback', scrapflyAllowlist: 'brett-king-test\nthegaygaston', scrapflyBudget: 50, scrapflyCreditBudget: 300, scrapflyMonthlyBudget: 500, scrapflyMonthlyCreditBudget: 500, ...over });
};
const restore = () => { settings.get = realGet; browser4.assertAllowed = realAllowed; scrapfly.setRequester(null); };
const answer = (html, cost = 1) => ({ status: 200, headers: { 'x-scrapfly-api-cost': String(cost), 'x-scrapfly-remaining-api-credit': '100' }, body: Buffer.from(JSON.stringify({ result: { content: html, status_code: 200, headers: {} } })) });
const PERFORMER = 'https://gayforfans.com/performer/brett-king-h7krv';

// ---- (1) page feeds: the allowlisted handle in the URL path

test('a page feed whose URL path contains an allowlisted handle (6+ characters) is allowed', () => {
  withSettings({ scrapflyAllowlist: 'thegaygaston' });
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://gayforfans.com/performer/thegaygaston-vbhwf' }), true);
  restore();
});

test('a page feed whose URL contains no allowlisted handle is refused', () => {
  withSettings({ scrapflyAllowlist: 'thegaygaston' });
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://gayforfans.com/performer/someone-else' }), false);
  restore();
});

test('an allowlisted entry shorter than 6 characters never matches a URL', () => {
  withSettings({ scrapflyAllowlist: 'logan' });
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://example.com/performer/logan-x' }), false);
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://example.com/logan' }), false);
  restore();
});

test('the host alone never matches: an allowlisted handle only in the host is refused', () => {
  withSettings({ scrapflyAllowlist: 'thegaygaston' });
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://thegaygaston.example.com/' }), false);
  restore();
});

// ---- (2) gff performer pages: a bot check is read through the tier for allowlisted creators only

test('gff: an allowlisted feed whose performer page is a bot check is read through Scrapfly, with the cost in the notes', async () => {
  withSettings({});
  performerStatus = 403;
  browser4.assertAllowed = async () => {};
  scrapfly.setRequester(async () => answer(performerHtml, 1));
  const notes = [];
  const page = await gff._unlockPerformer(PERFORMER, { platform: 'gff', kind: 'user', target: PERFORMER, creator_id: 'brett-king-test' }, notes);
  assert.equal(page.videos.length, 2, 'the performer page was read');
  assert.ok(notes.some((n) => /Scrapfly Unblocker read the performer page \(1 credits\)/.test(n)), notes.join(' | '));
  restore();
});

test('gff: a feed that is NOT on the allowlist gets no Scrapfly call and stays a challenge', async () => {
  withSettings({});
  let calls = 0;
  browser4.assertAllowed = async () => {};
  scrapfly.setRequester(async () => { calls++; return answer(performerHtml, 1); });
  const page = await gff._unlockPerformer(PERFORMER, { platform: 'gff', kind: 'user', target: PERFORMER, creator_id: 'someone-else' }, []);
  assert.equal(page, null);
  assert.equal(calls, 0);
  restore();
});

test('gff: with the tier off, an allowlisted feed gets no Scrapfly call', async () => {
  withSettings({ scrapflyUnlocker: 'off' });
  let calls = 0;
  browser4.assertAllowed = async () => {};
  scrapfly.setRequester(async () => { calls++; return answer(performerHtml, 1); });
  const page = await gff._unlockPerformer(PERFORMER, { platform: 'gff', kind: 'user', target: PERFORMER, creator_id: 'brett-king-test' }, []);
  assert.equal(page, null);
  assert.equal(calls, 0);
  restore();
});

test('gff: an opt-out (noindex) in the unlocked page is honoured, never returned as content', async () => {
  withSettings({});
  browser4.assertAllowed = async () => {};
  const optedOut = '<html><head><meta name="robots" content="noindex"></head><body><h1>Brett King</h1><a href="/video/abcdef-one">One</a></body></html>';
  scrapfly.setRequester(async () => answer(optedOut, 1));
  const notes = [];
  const r = await gff._unlockPerformer(PERFORMER, { platform: 'gff', kind: 'user', target: PERFORMER, creator_id: 'brett-king-test' }, notes);
  assert.deepEqual(r, { optedOut: true });
  assert.ok(notes.some((n) => /Skipped page/.test(n)));
  restore();
});

test('gff fetch: an allowlisted performer page that is a bot check is read by Scrapfly; a non-allowlisted one still throws the challenge', async () => {
  withSettings({});
  performerStatus = 403;
  browser4.assertAllowed = async () => {};
  scrapfly.setRequester(async () => answer(performerHtml, 1));
  const allowedFeed = { platform: 'gff', kind: 'user', target: PERFORMER, creator_id: 'brett-king-test', cursor: null };
  const r = await gff.fetch(allowedFeed, { aborted: () => false });
  assert.ok(r.notes.some((n) => /Scrapfly Unblocker read the performer page/.test(n)), r.notes.join(' | '));

  scrapfly.setRequester(null);
  const other = { platform: 'gff', kind: 'user', target: 'https://gayforfans.com/performer/nobody-here-zzzzz', creator_id: 'someone-else', cursor: null };
  await assert.rejects(gff.fetch(other, { aborted: () => false }), (e) => e.challenged === true);
  restore();
});

test('an escalation refused by our daily cap says so in words: the cap, the ceiling it needs, and the cost spent', async () => {
  withSettings({ scrapflyCreditBudget: 30 });
  repo.settings.set('scrapfly.usage', '');
  browser4.assertAllowed = async () => {};
  let calls = 0;
  scrapfly.setRequester(async () => { calls++; return { status: 422, headers: { 'x-scrapfly-reject-code': 'ERR::SCRAPE::COST_BUDGET_LIMIT', 'x-scrapfly-api-cost': '1' }, body: Buffer.from('{}') }; });
  await assert.rejects(scrapfly.scrape(PERFORMER, { escalate: true }), (e) => {
    assert.match(e.message, /escalation refused: the daily credit cap is 30, the escalated ceiling needs 80/);
    assert.equal(e.escalationRefused, true);
    assert.equal(e.budget, true);
    assert.equal(e.cost, 1);
    return true;
  });
  assert.equal(calls, 1, 'the 80-credit request was never sent');
  restore();
});
