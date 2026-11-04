'use strict';
// The shared Scrapfly helper (scrapfly.read) for HTML and JSON, and the Mastodon fallback that uses it.
// No network: the Scrapfly HTTP call is stubbed (scrapfly.setRequester); Mastodon's direct JSON download is stubbed by
// replacing net.fetchJSON before the adapter loads, and browser4.assertAllowed is stubbed for the public test hosts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scrapfly-read-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';
process.env.SCRAPFLY_API_KEY = 'TESTKEY-fedcba9876543210';

const net = require('../src/lib/net');
const repo = require('../src/db/repo');
const settings = require('../src/settings');
const browser4 = require('../src/lib/browser4');
const scrapfly = require('../src/lib/scrapfly');

// Replace the direct JSON download BEFORE the Mastodon adapter is loaded (its HTTP client captures net.fetchJSON at load).
let directStatus = 403;
net.fetchJSON = async (url) => { throw Object.assign(new Error(`HTTP ${directStatus} for ${url}`), { status: directStatus }); };
const mastodon = require('../src/sources/mastodon');

const realAllowed = browser4.assertAllowed;
const realGet = settings.get;
const stubAllowed = () => { browser4.assertAllowed = async () => {}; };
const restoreAllowed = () => { browser4.assertAllowed = realAllowed; };
const withSettings = (over) => { settings.get = () => ({ ...realGet(), ...over }); };
const restoreSettings = () => { settings.get = realGet; };
const answer = (content, { status = 200, cost = 1 } = {}) => ({
  status: 200,
  headers: { 'x-scrapfly-api-cost': String(cost), 'x-scrapfly-remaining-api-credit': '500' },
  body: Buffer.from(JSON.stringify({ result: { content, status_code: status, headers: {} } })),
});
const reset = () => { repo.settings.set('scrapfly.usage', ''); };

test('read() returns parsed JSON from the answer and records the cost', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyBudget: 100, scrapflyCreditBudget: 100, scrapflyMonthlyBudget: 700 });
  scrapfly.setRequester(async () => answer(JSON.stringify({ acct: 'EricNSFW', id: '116957361408268479' }), { cost: 25 }));
  const r = await scrapfly.read('https://gayfr.example.net/api/v1/accounts/lookup?acct=EricNSFW', { json: true, host: 'gayfr.example.net' });
  assert.equal(r.value.acct, 'EricNSFW');
  assert.equal(r.cost, 25);
  assert.equal(scrapfly.usage().credits, 25);
  scrapfly.setRequester(null); restoreAllowed(); restoreSettings();
});

test('read() treats a block page as no answer, and a JS-built HTML page gets one rendered retry', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyBudget: 100, scrapflyCreditBudget: 100, scrapflyMonthlyBudget: 700 });
  const seen = [];
  scrapfly.setRequester(async (endpoint) => {
    const rendered = /render_js=true/.test(endpoint);
    seen.push(rendered);
    return answer(rendered ? '<html><body><a href="https://example.org/x">x</a></body></html>' : '<html><div id="root"></div></html>', { cost: rendered ? 6 : 1 });
  });
  const r = await scrapfly.read('https://links.example.net/page', { host: 'links.example.net', count: (h) => (h.includes('example.org') ? 1 : 0) });
  assert.deepEqual(seen, [false, true]);
  assert.equal(r.rendered, true);
  assert.equal(r.cost, 7);
  scrapfly.setRequester(null); restoreAllowed(); restoreSettings();
});

test('read() never sends a takedown or a private address to Scrapfly', async () => {
  reset(); restoreAllowed();
  let calls = 0;
  scrapfly.setRequester(async () => { calls++; return answer('{}'); });
  repo.takedowns.add({ kind: 'domain', value: 'taken-down-read.example', reason: 'asked' });
  await assert.rejects(scrapfly.read('https://taken-down-read.example/x', { json: true }), (e) => e.skip === true);
  await assert.rejects(scrapfly.read('http://10.0.0.5/api', { json: true }), (e) => e.skip === true);
  assert.equal(calls, 0);
  scrapfly.setRequester(null);
});

test('Mastodon: a refused lookup is read through Scrapfly when the fallback is on, and the cost is noted', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyUnlocker: 'fallback', scrapflyBudget: 100, scrapflyCreditBudget: 100, scrapflyMonthlyBudget: 700 });
  directStatus = 403;
  scrapfly.setRequester(async () => answer(JSON.stringify({ id: '1', acct: 'EricNSFW', username: 'EricNSFW' }), { cost: 25 }));
  const sink = [];
  const acct = await mastodon._getJson('https://gayfr.example.net/api/v1/accounts/lookup?acct=EricNSFW', 'gayfr.example.net', sink);
  assert.equal(acct.acct, 'EricNSFW');
  assert.match(sink[0], /Scrapfly unblocker \(25 credits\)/);
  scrapfly.setRequester(null); restoreAllowed(); restoreSettings();
});

test('Mastodon: with the fallback off, the refusal is still an error and Scrapfly is not called', async () => {
  reset(); stubAllowed(); withSettings({ scrapflyUnlocker: 'off' });
  directStatus = 403;
  let calls = 0;
  scrapfly.setRequester(async () => { calls++; return answer('{}'); });
  await assert.rejects(mastodon._getJson('https://gayfr.example.net/api/v1/accounts/lookup?acct=x', 'gayfr.example.net', []), (e) => e.status === 403);
  assert.equal(calls, 0);
  scrapfly.setRequester(null); restoreAllowed(); restoreSettings();
});

test('Mastodon: a 404 (no such account) is not a refusal and is never sent to Scrapfly', () => {
  assert.equal(mastodon._isRefusal({ status: 404, message: 'HTTP 404' }), false);
  assert.equal(mastodon._isRefusal({ status: 403, message: 'HTTP 403' }), true);
  assert.equal(mastodon._isRefusal({ status: 200, message: 'Invalid JSON from https://x/api' }), true);
});
