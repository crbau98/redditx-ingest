'use strict';
// unlockedRead() end to end with stubs: Bright Data is tried before Scrapfly, Scrapfly's own budget refusal is not a host
// rest, and a Scrapfly unlock reports its cost. No network: the robots.txt fetch and Bright Data's HTTP are stubbed, and the
// Scrapfly call goes through scrapfly.setRequester.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'web-unlock-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';
process.env.SCRAPFLY_API_KEY = 'TESTKEY-aabbccddeeff0011';

// robots.txt: a 404 means "no rules". Replace the HTTP call BEFORE web.js loads (its client captures net.request at load).
const net = require('../src/lib/net');
net.request = async () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') });

const settings = require('../src/settings');
const repo = require('../src/db/repo');
const brightdata = require('../src/lib/brightdata');
const browser4 = require('../src/lib/browser4');
const scrapfly = require('../src/lib/scrapfly');
const web = require('../src/sources/web');

const realGet = settings.get;
const realBd = { configured: brightdata.unlockerConfigured, unlock: brightdata.unlock, browser: brightdata.browserConfigured };
const realAllowed = browser4.assertAllowed;
const TARGET = 'https://refused.example.net/performer/someone';
const PAGE = '<html><head><title>Someone</title></head><body><video src="https://cdn.example.org/clip.mp4"></video></body></html>';

function withSettings(over) {
  settings.get = () => ({ ...realGet(), brightdataUnlocker: 'fallback', brightdataUnlockBudget: 100, scrapflyUnlocker: 'fallback', scrapflyAllowlist: 'creator-allow', scrapflyBudget: 20, scrapflyCreditBudget: 100, scrapflyMonthlyBudget: 300, scrapflyMonthlyCreditBudget: 400, ...over });
}
function restore() {
  settings.get = realGet;
  brightdata.unlockerConfigured = realBd.configured;
  brightdata.unlock = realBd.unlock;
  brightdata.browserConfigured = realBd.browser;
  browser4.assertAllowed = realAllowed;
  scrapfly.setRequester(null);
}
const scrapflyAnswer = (html, cost) => ({
  status: 200,
  headers: { 'x-scrapfly-api-cost': String(cost), 'x-scrapfly-remaining-api-credit': '400' },
  body: Buffer.from(JSON.stringify({ result: { content: html, status_code: 200, headers: {} } })),
});
const reset = () => repo.settings.set('scrapfly.usage', '');
const feed = { platform: 'web', kind: 'page', target: TARGET, creator_id: 'creator-allow' };

test('Bright Data is tried first; when it gives nothing, Scrapfly reads the page and the cost is reported', async () => {
  reset(); withSettings({}); browser4.assertAllowed = async () => {};
  const order = [];
  brightdata.unlockerConfigured = () => true;
  brightdata.browserConfigured = () => false;
  brightdata.unlock = async () => { order.push('brightdata'); throw Object.assign(new Error('Bright Data could not fetch the page (HTTP 503)'), { status: 503 }); };
  scrapfly.setRequester(async () => { order.push('scrapfly'); return scrapflyAnswer(PAGE, 1); });
  const u = await web._unlockedRead(feed, 'media');
  assert.deepEqual(order, ['brightdata', 'scrapfly']);
  assert.equal(u.via, 'scrapfly-unlocker');
  assert.equal(u.page.media.length, 1);
  assert.equal(u.cost, 1, 'the run note gets the credit cost');
  restore();
});

test('a Bright Data success stops the chain: Scrapfly is not called', async () => {
  reset(); withSettings({}); browser4.assertAllowed = async () => {};
  const okFeed = { platform: 'web', kind: 'page', target: 'https://bd-ok.example.net/page', creator_id: 'creator-allow' }; // its own host: the first test rested refused.example.net
  brightdata.unlockerConfigured = () => true;
  brightdata.browserConfigured = () => false;
  brightdata.unlock = async () => ({ html: PAGE, status: 200 });
  let scrapflyCalls = 0;
  scrapfly.setRequester(async () => { scrapflyCalls++; return scrapflyAnswer(PAGE, 1); });
  const u = await web._unlockedRead(okFeed, 'media');
  assert.equal(u.via, 'brightdata-unlocker');
  assert.equal(scrapflyCalls, 0);
  restore();
});

test('Scrapfly budget refusal is reported as a budget skip and does not rest the host', async () => {
  reset(); withSettings({ scrapflyCreditBudget: 0 }); browser4.assertAllowed = async () => {};
  brightdata.unlockerConfigured = () => false;
  brightdata.browserConfigured = () => false;
  let scrapflyCalls = 0;
  scrapfly.setRequester(async () => { scrapflyCalls++; return scrapflyAnswer(PAGE, 1); });
  const u = await web._unlockedRead(feed, 'media');
  assert.equal(scrapflyCalls, 0, 'refused before any request');
  assert.ok(u && u.error && u.error.budget === true, 'the refusal is our budget, not the site');
  assert.equal(scrapfly.decide(new URL(TARGET).hostname).ok, true, 'host is not rested by our budget');
  restore();
});

test('with Scrapfly off and no Bright Data, the unlock is not used at all', async () => {
  reset(); withSettings({ scrapflyUnlocker: 'off', brightdataUnlocker: 'off' }); browser4.assertAllowed = async () => {};
  let scrapflyCalls = 0;
  scrapfly.setRequester(async () => { scrapflyCalls++; return scrapflyAnswer(PAGE, 1); });
  const u = await web._unlockedRead(feed, 'media');
  assert.equal(u, null);
  assert.equal(scrapflyCalls, 0);
  restore();
});
