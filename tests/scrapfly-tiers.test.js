'use strict';
// Scrapfly policy: the allowlist gate, the 30-credit first read, the 80-credit escalation only after an empty first read and
// only when the caps cover it, opt-outs returned as skipped (not found), our own errors never rest a host, and the caps are
// checked against the budget each attempt sends. No network (stubbed requester).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scrapfly-tiers-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';
process.env.SCRAPFLY_API_KEY = 'TESTKEY-0011223344556677';

const repo = require('../src/db/repo');
const settings = require('../src/settings');
const browser4 = require('../src/lib/browser4');
const scrapfly = require('../src/lib/scrapfly');

const realAllowed = browser4.assertAllowed;
const realGet = settings.get;
const stubAllowed = () => { browser4.assertAllowed = async () => {}; };
const restore = () => { browser4.assertAllowed = realAllowed; settings.get = realGet; scrapfly.setRequester(null); };
const withSettings = (over) => { settings.get = () => ({ ...realGet(), scrapflyAllowlist: 'creator-allow', scrapflyBudget: 20, scrapflyCreditBudget: 200, scrapflyMonthlyBudget: 300, scrapflyMonthlyCreditBudget: 400, ...over }); };
const reset = () => repo.settings.set('scrapfly.usage', '');
const ok = (content, cost) => ({ status: 200, headers: { 'x-scrapfly-api-cost': String(cost), 'x-scrapfly-remaining-api-credit': '400' }, body: Buffer.from(JSON.stringify({ result: { content, status_code: 200, headers: {} } })) });
const ceilingRefusal = (cost = 1) => ({ status: 422, headers: { 'x-scrapfly-reject-code': 'ERR::SCRAPE::COST_BUDGET_LIMIT', 'x-scrapfly-api-cost': String(cost) }, body: Buffer.from('{}') });
const PAGE = '<html><body><video src="https://cdn.example.org/a.mp4"></video></body></html>';
const EMPTY = '<html><body>nothing here</body></html>';
const OPTED_OUT = '<html><head><meta name="robots" content="noindex"></head><body><video src="https://cdn.example.org/b.mp4"></video></body></html>';
const URL1 = 'https://gayforfans.example.net/performer/x';
const allowed = { platform: 'web', kind: 'page', target: URL1, creator_id: 'creator-allow' };
const readOpts = (extra = {}) => ({ host: 'gayforfans.example.net', allowed: true, parse: (html) => (/noindex/.test(html) ? { optedOut: true, media: [] } : { media: (html.match(/<video/g) || []).map(() => ({})) }), count: (v) => v.media.length, ...extra });

test('the allowlist: empty means never; a listed creator id or handle matches; anyone else does not', () => {
  withSettings({ scrapflyAllowlist: '' });
  assert.equal(scrapfly.allowedFor({ creator_id: 'creator-allow' }), false, 'empty list: never');
  withSettings({ scrapflyAllowlist: 'creator-allow\n@Some_Handle' });
  assert.equal(scrapfly.allowedFor({ creator_id: 'creator-allow' }), true);
  assert.equal(scrapfly.allowedFor({ creator_id: 'other' }), false);
  assert.equal(scrapfly.allowedFor({ kind: 'user', target: 'some_handle@example.org' }), true, 'user feed handle matches');
  restore();
});

test('read() refuses a creator not on the allowlist before any request is made', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyAllowlist: 'creator-allow' });
  let calls = 0;
  scrapfly.setRequester(async () => { calls++; return ok(PAGE, 1); });
  await assert.rejects(scrapfly.read(URL1, { host: 'gayforfans.example.net', allowed: false }), (e) => e.skip === true);
  assert.equal(calls, 0);
  restore();
});

test('first read at 30 credits; a clean read costs 1 and no escalation happens', async () => {
  reset(); stubAllowed(); withSettings({});
  const budgets = [];
  scrapfly.setRequester(async (endpoint) => { budgets.push(new URL(endpoint).searchParams.get('cost_budget')); return ok(PAGE, 1); });
  const r = await scrapfly.read(URL1, readOpts());
  assert.deepEqual(budgets, ['30']);
  assert.equal(r.value.media.length, 1);
  assert.equal(r.cost, 1);
  restore();
});

test('a COST_BUDGET_LIMIT first read escalates to 80, and the cost of the refused attempt is counted', async () => {
  reset(); stubAllowed(); withSettings({});
  const budgets = [];
  scrapfly.setRequester(async (endpoint) => {
    const cb = new URL(endpoint).searchParams.get('cost_budget');
    budgets.push(cb);
    return cb === '30' ? ceilingRefusal(1) : ok(PAGE, 40);
  });
  const r = await scrapfly.read(URL1, readOpts());
  assert.deepEqual(budgets, ['30', '80']);
  assert.equal(r.value.media.length, 1);
  assert.equal(r.cost, 41, 'the refused attempt (1) plus the escalated one (40)');
  assert.equal(scrapfly.usage().monthCredits, 41, 'the refused attempt was billed 1 credit and is in the monthly count');
  restore();
});

test('the escalation is refused when the daily credit cap cannot cover 80 (no second request)', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyCreditBudget: 30 });
  const budgets = [];
  scrapfly.setRequester(async (endpoint) => { budgets.push(new URL(endpoint).searchParams.get('cost_budget')); return ceilingRefusal(0); });
  await assert.rejects(scrapfly.read(URL1, readOpts()), (e) => e.budget === true);
  assert.deepEqual(budgets, ['30']);
  restore();
});

test('the escalation is refused when the monthly credit cap cannot cover 80', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyMonthlyCreditBudget: 50 });
  const budgets = [];
  scrapfly.setRequester(async (endpoint) => { budgets.push(new URL(endpoint).searchParams.get('cost_budget')); return ceilingRefusal(0); });
  await assert.rejects(scrapfly.read(URL1, readOpts()), (e) => e.budget === true);
  assert.deepEqual(budgets, ['30']);
  restore();
});

test('the caps are checked against the budget each attempt sends', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyCreditBudget: 40 });
  scrapfly.setRequester(async () => ok(PAGE, 1));
  const r = await scrapfly.scrape(URL1, {});
  assert.equal(r.costBudget, 30);
  reset();
  scrapfly.setRequester(async () => { throw new Error('must not be called'); });
  await assert.rejects(scrapfly.scrape(URL1, { costBudget: 80 }), (e) => e.budget === true);
  restore();
});

test('an opt-out (noindex) is skipped exactly like the plain read: not found, and it does not rest the host', async () => {
  reset(); stubAllowed(); withSettings({});
  const host = 'optout-host.example.net';
  scrapfly.setRequester(async () => ok(OPTED_OUT, 1));
  const r = await scrapfly.read('https://optout-host.example.net/p', readOpts({ host }));
  assert.equal(r.optedOut, true);
  assert.equal(r.value.optedOut, true);
  assert.equal(scrapfly.decide(host).ok, true, 'an opt-out is not a refusal and is not recorded as found or empty');
  restore();
});

test('a COST_BUDGET_LIMIT that stays unresolved does not rest the host; a real refusal does', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyCreditBudget: 30 });
  const host = 'ceiling-host.example.net';
  scrapfly.setRequester(async () => ceilingRefusal(0));
  await assert.rejects(scrapfly.read('https://ceiling-host.example.net/p', readOpts({ host })));
  assert.equal(scrapfly.decide(host).ok, true, 'our ceiling must not rest the host');

  reset(); withSettings({});
  const host2 = 'real-refusal.example.net';
  scrapfly.setRequester(async () => ok(EMPTY, 1));
  const empty = await scrapfly.read('https://real-refusal.example.net/p', readOpts({ host: host2, escalate: false }));
  assert.equal(empty.value.media.length, 0, 'the answer is read and holds nothing');
  assert.equal(scrapfly.decide(host2).ok, false, 'an empty answer that is not our fault rests the host');
  restore();
});

test('account errors (402, 429) and 403 are ours and never rest the host', async () => {
  reset(); stubAllowed(); withSettings({});
  const host = 'account-host.example.net';
  for (const status of [402, 429, 403]) {
    scrapfly.setRequester(async () => ({ status, headers: {}, body: Buffer.from('{}') }));
    await assert.rejects(scrapfly.read('https://account-host.example.net/p', readOpts({ host })));
  }
  assert.equal(scrapfly.decide(host).ok, true);
  restore();
});

test('the 422 ceiling error is marked as ours and as a ceiling, not as a target failure', () => {
  const e = scrapfly.apiError(422, 'ERR::SCRAPE::COST_BUDGET_LIMIT');
  assert.equal(e.costLimit, true);
  assert.equal(e.ours, true);
  assert.equal(scrapfly.apiError(422, 'ERR::SCRAPE::BAD_PROTOCOL').target, true);
});
