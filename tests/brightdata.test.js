'use strict';
/**
 * lib/brightdata.js against a mock of Bright Data's API: Discover (intent-ranked search, trigger + poll) as a search
 * provider, and the Web Unlocker. The unlocker tests check what is NOT sent as much as what is.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let bd; let repo; let config; let brightdata; let websearch;
const state = { discoverBodies: [], polls: 0, requests: [], auth: [], mode: 'ok', unlockStatus: 200, unlockBody: '<html><body><img src="/a.jpg" width="900"></body></html>' };

before(async () => {
  bd = await start({
    '/discover': (req) => {
      state.auth.push(req.headers.authorization);
      if (req.method === 'POST') {
        state.discoverBodies.push(JSON.parse(req.bodyText));
        if (state.mode === 'denied') return { status: 403, json: { error: 'discover disabled' } };
        if (state.mode === 'quota') return { status: 429, json: {} };
        return { json: { status: 'ok', task_id: 't1' } };
      }
      state.polls++;
      if (state.mode === 'failed') return { json: { status: 'failed', error: 'upstream timeout' } };
      if (state.mode === 'never') return { json: { status: 'processing' } };
      if (state.polls % 2 === 1) return { json: { status: 'processing' } };
      return { json: { status: 'done', results: [
        { link: 'https://creator.example/gallery', title: 'Creator gallery', description: '  A public\n gallery ', relevance_score: 0.61 },
        { link: 'https://linktr.ee/zed', title: 'Zed links', description: 'link in bio', relevance_score: 0.92 },
        { link: 'https://coomer.su/onlyfans/user/zed', title: 'leak', description: 'x', relevance_score: 0.99 },
        { link: 'https://onlyfans.com/zed', title: 'paywalled', description: 'x', relevance_score: 0.95 },
        { link: 'https://linktr.ee/zed', title: 'dup', description: 'x', relevance_score: 0.5 },
        { link: 'not a url', title: 'junk', relevance_score: 0.9 },
        { link: 'https://low.example/x', title: 'meh', description: 'x', relevance_score: 0.1 },
      ] } };
    },
    '/request': (req) => {
      state.requests.push(JSON.parse(req.bodyText));
      state.auth.push(req.headers.authorization);
      return { status: state.unlockStatus, headers: { 'content-type': 'text/html' }, body: state.unlockBody };
    },
  });
  prepareEnv({ BRIGHTDATA_API_TOKEN: 'bd-secret-token', BRIGHTDATA_UNLOCKER_ZONE: 'my_unlocker', BRIGHTDATA_BASE_URL: bd.url, BRIGHTDATA_POLL_MS: '20', BRIGHTDATA_TIMEOUT_MS: '600' });
  config = require('../src/config'); repo = require('../src/db/repo');
  brightdata = require('../src/lib/brightdata'); websearch = require('../src/lib/websearch');
});
after(async () => { await bd.close(); });
beforeEach(() => {
  Object.assign(state, { discoverBodies: [], polls: 0, requests: [], auth: [], mode: 'ok', unlockStatus: 200, unlockBody: '<html><body><img src="/a.jpg" width="900"></body></html>' });
  repo.settings.set('brightdata.usage', '{}'); repo.settings.set('brightdata.unlock.usage', '{}');
  config.brightdata.minRelevance = 0;
});

describe('Discover', () => {
  test('triggers with the intent, polls until done, and returns the best first', async () => {
    const r = await brightdata.search('gay muscle creator linktree', { count: 5 });
    const body = state.discoverBodies[0];
    assert.equal(body.query, 'gay muscle creator linktree');
    assert.match(body.intent, /Public creator profiles/);
    assert.match(body.intent, /Not paywalled/i);
    assert.equal(body.mode, 'standard'); assert.equal(body.num_results, 5);
    assert.ok(state.auth.every((a) => a === 'Bearer bd-secret-token'));
    assert.ok(state.polls >= 2, 'it waited for "processing" to turn into "done"');
    assert.deepEqual(r.map((x) => x.url), ['https://linktr.ee/zed', 'https://creator.example/gallery', 'https://low.example/x']);
    assert.equal(r[1].description, 'A public gallery', 'whitespace tidied');
  });
  test('leak sites, paywalled hosts, duplicates and non-URLs never come out', async () => {
    const urls = (await brightdata.search('q')).map((x) => x.url);
    assert.ok(!urls.some((u) => /coomer|onlyfans|not a url/.test(u)));
    assert.equal(urls.filter((u) => u === 'https://linktr.ee/zed').length, 1);
  });
  test('a minimum relevance drops weak results', async () => {
    config.brightdata.minRelevance = 0.5;
    const urls = (await brightdata.search('q')).map((x) => x.url);
    assert.deepEqual(urls, ['https://linktr.ee/zed', 'https://creator.example/gallery']);
  });
  test('a per-query intent replaces the default', async () => {
    await brightdata.search('q', { intent: 'official artist pages' });
    assert.equal(state.discoverBodies[0].intent, 'official artist pages');
  });
  test('the daily budget is enforced and only accepted requests are counted', async () => {
    await brightdata.search('one', { budget: 1 });
    assert.equal(brightdata.usage().count, 1);
    await assert.rejects(brightdata.search('two', { budget: 1 }), (e) => e.budget === true && /budget reached/.test(e.message));
    assert.equal(state.discoverBodies.length, 1, 'the second search never reached the API');
  });
  test('a rejected token is a skip (and costs nothing); a quota answer is a budget error', async () => {
    state.mode = 'denied';
    await assert.rejects(brightdata.search('q'), (e) => e.skip === true && /rejected the token/.test(e.message));
    assert.equal(brightdata.usage().count, 0, 'a rejected key must not burn the budget');
    state.mode = 'quota';
    await assert.rejects(brightdata.search('q'), (e) => e.budget === true);
  });
  test('a failed or never-finishing task is an error, not an empty answer', async () => {
    state.mode = 'failed';
    await assert.rejects(brightdata.search('q'), /search failed: upstream timeout/);
    state.mode = 'never';
    await assert.rejects(brightdata.search('q'), (e) => e.status === 504 && /did not finish/.test(e.message));
  });
  test('it is a search provider: websearch.search falls to it and says so', async () => {
    config.searchProviders = ['brightdata'];
    websearch._clear();
    const r = await websearch.search('fresh query one', { count: 3 });
    assert.equal(r.provider, 'brightdata');
    assert.equal(r[0].url, 'https://linktr.ee/zed');
    const st = websearch.status();
    assert.equal(st.brightdata.configured, true);
    assert.equal(st.providers.find((p) => p.name === 'brightdata').ok, 1);
  });
});

describe('Web Unlocker', () => {
  test('sends zone, url and raw format with the token, and returns the page', async () => {
    const u = await brightdata.unlock('https://creator.example/gallery', { budget: 10 });
    assert.deepEqual(state.requests, [{ zone: 'my_unlocker', url: 'https://creator.example/gallery', format: 'raw' }]);
    assert.equal(state.auth[0], 'Bearer bd-secret-token');
    assert.match(u.html, /<img/);
    assert.equal(brightdata.unlockUsage().count, 1);
  });

  test('NOTHING is sent for a leak site, a paywalled host, a takedown or a non-http(s) / credentialed URL (private addresses: see browser4.policy.test.js)', async () => {
    repo.takedowns.add({ kind: 'domain', value: 'opted-out.example', reason: 'asked' });
    for (const url of ['https://coomer.su/x', 'https://www.onlyfans.com/zed', 'https://fansly.com/zed', 'http://opted-out.example/page', 'file:///etc/passwd', 'https://user:pw@creator.example/']) {
      await assert.rejects(brightdata.unlock(url), (e) => e.skip === true, url);
    }
    assert.deepEqual(state.requests, [], 'not one of them reached Bright Data');
    assert.equal(brightdata.unlockUsage().count, 0);
  });

  test('the budget is a hard stop', async () => {
    await brightdata.unlock('https://creator.example/a', { budget: 1 });
    await assert.rejects(brightdata.unlock('https://creator.example/b', { budget: 1 }), (e) => e.budget === true);
    assert.equal(state.requests.length, 1);
  });

  test('a block page is an error, never content; errors and quota are told apart', async () => {
    state.unlockBody = '<html><title>Just a moment...</title><body>Checking your browser</body></html>';
    await assert.rejects(brightdata.unlock('https://creator.example/a'), /block page/);
    state.unlockStatus = 502; state.unlockBody = 'bad gateway';
    await assert.rejects(brightdata.unlock('https://creator.example/a'), (e) => e.status === 502);
    state.unlockStatus = 402;
    await assert.rejects(brightdata.unlock('https://creator.example/a'), (e) => e.budget === true);
    state.unlockStatus = 401;
    await assert.rejects(brightdata.unlock('https://creator.example/a'), (e) => e.skip === true);
  });

  test('a long real page that merely mentions "captcha" is not mistaken for a block page', () => {
    assert.equal(brightdata.looksBlocked(`<html><body>${'<p>real content</p>'.repeat(600)} we use a captcha on login</body></html>`), false);
    assert.equal(brightdata.looksBlocked('<html>Access Denied</html>'), true);
  });

  test('credentials are redacted from anything that may be logged', () => {
    assert.equal(brightdata.redact('cannot attach to wss://brd-customer-hl_1-zone-x:s3cret@brd.superproxy.io:9222 now'), 'cannot attach to wss://***@brd.superproxy.io:9222 now');
    assert.equal(brightdata.redact('Authorization: Bearer abc.def'), 'Authorization: Bearer ***');
  });
});
