'use strict';
// Two-tier cost ceiling: a COST_BUDGET_LIMIT answer is retried once at 80 only when the caps can cover it, the caps are checked
// against the cost_budget actually sent, and our own ceiling errors never rest a host. No network (stubbed requester).
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
const withSettings = (over) => { settings.get = () => ({ ...realGet(), scrapflyBudget: 20, scrapflyCreditBudget: 100, scrapflyMonthlyBudget: 300, scrapflyMonthlyCreditBudget: 400, ...over }); };
const reset = () => repo.settings.set('scrapfly.usage', '');
const ok = (content, cost) => ({ status: 200, headers: { 'x-scrapfly-api-cost': String(cost), 'x-scrapfly-remaining-api-credit': '400' }, body: Buffer.from(JSON.stringify({ result: { content, status_code: 200, headers: {} } })) });
const ceilingRefusal = () => ({ status: 422, headers: { 'x-scrapfly-reject-code': 'ERR::SCRAPE::COST_BUDGET_LIMIT', 'x-scrapfly-api-cost': '0' }, body: Buffer.from('{}') });
const PAGE = '<html><body><video src="https://cdn.example.org/a.mp4"></video></body></html>';

test('a COST_BUDGET_LIMIT answer is retried once at 80, and the second attempt sends cost_budget=80', async () => {
  reset(); stubAllowed(); withSettings({});
  const budgets = [];
  scrapfly.setRequester(async (endpoint) => {
    const cb = new URL(endpoint).searchParams.get('cost_budget');
    budgets.push(cb);
    return cb === '30' ? ceilingRefusal() : ok(PAGE, 40);
  });
  const r = await scrapfly.scrape('https://gayforfans.example.net/performer/x', {});
  assert.deepEqual(budgets, ['30', '80']);
  assert.equal(r.blocked, false);
  assert.equal(r.costBudget, 80);
  restore();
});

test('the escalated retry is refused when the daily credit cap cannot cover 80', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyCreditBudget: 60 });
  const budgets = [];
  scrapfly.setRequester(async (endpoint) => { budgets.push(new URL(endpoint).searchParams.get('cost_budget')); return ceilingRefusal(); });
  await assert.rejects(scrapfly.scrape('https://gayforfans.example.net/performer/y', {}), (e) => e.budget === true, 'the escalation is refused by the caps');
  assert.deepEqual(budgets, ['30'], 'no second request was sent');
  restore();
});

test('the escalated retry is refused when the monthly credit cap cannot cover 80', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyMonthlyCreditBudget: 50 });
  const budgets = [];
  scrapfly.setRequester(async (endpoint) => { budgets.push(new URL(endpoint).searchParams.get('cost_budget')); return ceilingRefusal(); });
  await assert.rejects(scrapfly.scrape('https://gayforfans.example.net/performer/z', {}), (e) => e.budget === true, 'the escalation is refused by the caps');
  assert.deepEqual(budgets, ['30']);
  restore();
});

test('the caps are checked against the budget each attempt sends: a 30-credit reserve passes where an 80 would not', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyCreditBudget: 40 });
  scrapfly.setRequester(async () => ok(PAGE, 1));
  const r = await scrapfly.scrape('https://gayforfans.example.net/performer/w', {});
  assert.equal(r.costBudget, 30);
  reset();
  scrapfly.setRequester(async () => { throw new Error('must not be called'); });
  await assert.rejects(scrapfly.scrape('https://gayforfans.example.net/performer/w', { costBudget: 80 }), (e) => e.budget === true);
  restore();
});

test('a COST_BUDGET_LIMIT that stays unresolved does not rest the host; a real refusal does', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyCreditBudget: 60 });
  const host = 'ceiling-host.example.net';
  scrapfly.setRequester(async () => ceilingRefusal());
  await assert.rejects(scrapfly.read('https://ceiling-host.example.net/p', { host, json: true }));
  assert.equal(scrapfly.decide(host).ok, true, 'our ceiling must not rest the host');

  reset(); withSettings({});
  scrapfly.setRequester(async () => ({ status: 403, headers: {}, body: Buffer.from('{}') }));
  await assert.rejects(scrapfly.read('https://ceiling-host.example.net/q', { host, json: true }));
  assert.equal(scrapfly.decide(host).ok, true, '403 is a permission error on our account, not the page refusing us');
  restore();
});

test('account errors (402, 429) are ours and never rest the host', async () => {
  reset(); stubAllowed(); withSettings({});
  const host = 'account-host.example.net';
  for (const status of [402, 429]) {
    scrapfly.setRequester(async () => ({ status, headers: {}, body: Buffer.from('{}') }));
    await assert.rejects(scrapfly.read('https://account-host.example.net/p', { host, json: true }));
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
