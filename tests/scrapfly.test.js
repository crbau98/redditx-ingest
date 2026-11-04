'use strict';
// Scrapfly unblocker: the gate runs before any request, parameters are built as documented, both budgets and the
// monthly cap stop a call, errors are mapped, block pages are not content, and the key never reaches an error message.
// No network: the HTTP call is replaced by a stub (scrapfly.setRequester), and browser4.assertAllowed is stubbed where a
// public URL must pass the gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scrapfly-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';
process.env.SCRAPFLY_API_KEY = 'TESTKEY-0123456789abcdef';

const repo = require('../src/db/repo');
const settings = require('../src/settings');
const browser4 = require('../src/lib/browser4');
const scrapfly = require('../src/lib/scrapfly');

const realAssert = browser4.assertAllowed;
const PUBLIC = 'https://gayforfans.example.net/performer/someone';

function stubAllowed() { browser4.assertAllowed = async () => {}; }
function restoreAllowed() { browser4.assertAllowed = realAssert; }
function answer(body, headers = {}, status = 200) {
  return { status, headers: { 'x-scrapfly-api-cost': '1', 'x-scrapfly-remaining-api-credit': '900', ...headers }, body: Buffer.from(JSON.stringify(body)) };
}
function resetUsage() { repo.settings.set('scrapfly.usage', ''); }

test('the local gate refuses takedowns, private hosts and non-http(s) URLs before any request is made', async () => {
  let calls = 0;
  scrapfly.setRequester(async () => { calls++; return answer({}); });
  restoreAllowed();
  repo.takedowns.add({ kind: 'domain', value: 'taken-down.example', reason: 'asked' });
  for (const url of ['https://taken-down.example/x', 'http://127.0.0.1/admin', 'file:///etc/passwd', 'https://user:pw@example.org/']) {
    await assert.rejects(scrapfly.scrape(url, {}), (e) => e.skip === true, url);
  }
  assert.equal(calls, 0, 'no request left the machine');
  scrapfly.setRequester(null);
});

test('parameters: unblocker, cost_budget and the datacenter pool by default; render_js and optional fields only when set', () => {
  const p = scrapfly.buildParams('https://example.org/a?b=1', { unblocker: true, renderJs: false, costBudget: 30 }, 'K');
  assert.equal(p.get('url'), 'https://example.org/a?b=1');
  assert.equal(p.get('key'), 'K');
  assert.equal(p.get('unblocker'), 'true');
  assert.equal(p.get('cost_budget'), '30');
  assert.equal(p.get('proxy_pool'), 'public_datacenter_pool');
  assert.equal(p.get('render_js'), null);
  assert.equal(p.get('country'), null);
  const js = scrapfly.buildParams('https://example.org/', { unblocker: true, renderJs: true, costBudget: 30, country: 'us', renderWaitMs: 2500 }, 'K');
  assert.equal(js.get('render_js'), 'true');
  assert.equal(js.get('rendering_wait'), '2500');
  assert.equal(js.get('country'), 'us');
});

test('a successful call returns the target status and HTML and records the cost from the header', async () => {
  resetUsage();
  stubAllowed();
  scrapfly.setRequester(async () => answer({ result: { content: '<html><body><video src="https://cdn.example.org/a.mp4"></video></body></html>', status_code: 200, headers: {} } }, { 'x-scrapfly-api-cost': '6' }));
  const r = await scrapfly.scrape(PUBLIC, {});
  assert.equal(r.status, 200);
  assert.equal(r.blocked, false);
  assert.equal(r.cost, 6);
  assert.equal(scrapfly.usage().credits, 6);
  assert.equal(scrapfly.usage().count, 1);
  restoreAllowed();
  scrapfly.setRequester(null);
});

test('a block page or a refused target is reported as blocked, not as content', async () => {
  resetUsage();
  stubAllowed();
  scrapfly.setRequester(async () => answer({ result: { content: '<html><title>Just a moment...</title><body>Checking your browser</body></html>', status_code: 200, headers: {} } }));
  assert.equal((await scrapfly.scrape(PUBLIC, {})).blocked, true);
  scrapfly.setRequester(async () => answer({ result: { content: '<html>gone</html>', status_code: 403, headers: {} } }));
  assert.equal((await scrapfly.scrape(PUBLIC, {})).blocked, true);
  restoreAllowed();
  scrapfly.setRequester(null);
});

test('the request cap, the credit cap and the monthly cap each stop the call before it is made', async () => {
  stubAllowed();
  let calls = 0;
  scrapfly.setRequester(async () => { calls++; return answer({ result: { content: '<html>x</html>', status_code: 200, headers: {} } }, { 'x-scrapfly-api-cost': '1' }); });
  const real = settings.get;
  try {
    resetUsage();
    settings.get = () => ({ ...real(), scrapflyBudget: 1, scrapflyCreditBudget: 100, scrapflyMonthlyBudget: 800 });
    await scrapfly.scrape(PUBLIC, {});
    await assert.rejects(scrapfly.scrape(PUBLIC, {}), (e) => e.budget === true);
    assert.equal(calls, 1, 'second call refused by the request cap');

    resetUsage();
    settings.get = () => ({ ...real(), scrapflyBudget: 100, scrapflyCreditBudget: 40, scrapflyMonthlyBudget: 800 });
    await assert.rejects(scrapfly.scrape(PUBLIC, { costBudget: 50 }), (e) => e.budget === true, 'worst-case reserve over the credit cap');
    assert.equal(calls, 1, 'refused before the request');

    resetUsage();
    settings.get = () => ({ ...real(), scrapflyBudget: 100, scrapflyCreditBudget: 100, scrapflyMonthlyBudget: 1 });
    await scrapfly.scrape(PUBLIC, {});
    await assert.rejects(scrapfly.scrape(PUBLIC, {}), (e) => e.budget === true && /monthly/.test(e.message));
  } finally {
    settings.get = real;
    restoreAllowed();
    scrapfly.setRequester(null);
    resetUsage();
  }
});

test('error mapping: bad key and permission skip, quota and payment are budget, a failed fetch is a target failure', () => {
  assert.equal(scrapfly.apiError(401).skip, true);
  assert.equal(scrapfly.apiError(403).skip, true);
  assert.equal(scrapfly.apiError(402).budget, true);
  assert.equal(scrapfly.apiError(429).budget, true);
  assert.equal(scrapfly.apiError(422, 'ERR::SCRAPE::BAD_PROTOCOL').target, true);
  assert.equal(scrapfly.apiError(503).transient, true);
});

test('the key never appears in an error message or in redacted output', async () => {
  stubAllowed();
  scrapfly.setRequester(async () => { throw Object.assign(new Error('socket hang up for https://api.scrapfly.io/scrape?url=x&key=TESTKEY-0123456789abcdef'), {}); });
  resetUsage();
  let msg = '';
  try { await scrapfly.scrape(PUBLIC, {}); } catch (e) { msg = e.message; }
  assert.ok(msg.length > 0);
  assert.equal(msg.includes('TESTKEY-0123456789abcdef'), false);
  assert.equal(scrapfly.redact('key=TESTKEY-0123456789abcdef&url=x').includes('TESTKEY'), false);
  restoreAllowed();
  scrapfly.setRequester(null);
});

test('per-host back-off: an empty outcome rests the host, a found outcome clears it', () => {
  const host = 'backoff-test.example';
  repo.settings.set(`scrapfly.host.${host}`, '');
  assert.equal(scrapfly.decide(host).ok, true);
  scrapfly.recordHost(host, { found: 0 });
  assert.equal(scrapfly.decide(host).ok, false);
  scrapfly.recordHost(host, { found: 3 });
  assert.equal(scrapfly.decide(host).ok, true);
});
