'use strict';
/**
 * Oxylabs Web API client (lib/oxylabs.js) against a mocked transport, per the integration checklist on
 * https://developers.oxylabs.io/products/web-api/for-agents.md, plus its two uses: a challenged gayforfans/JustTheGays page read
 * through /v1/scrape, and the keyless X search engine.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

const DUMMY_KEY = 'test-dummy-oxylabs-key-0000';
prepareEnv({ OXYLABS_WEB_API_KEY: DUMMY_KEY, SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: '' });

// gff reads pages through http.forPlatform: stub it before the adapter loads (every direct read is refused).
const http = require('../src/sources/http');
const web = require('../src/sources/web');
const originalHttp = http.forPlatform;
const originalRobots = web.robotsAllows;
const direct = [];
http.forPlatform = () => ({ text: async (url) => { direct.push(url); throw Object.assign(new Error('Forbidden'), { status: 403 }); } });
web.robotsAllows = async () => true;
const gff = require('../src/sources/gff');
http.forPlatform = originalHttp;
web.robotsAllows = originalRobots;

const oxylabs = require('../src/lib/oxylabs');
const websearch = require('../src/lib/websearch');

const calls = [];
let answers = [];
const reply = (status, json) => ({ status, headers: {}, body: Buffer.from(json === undefined ? '' : JSON.stringify(json)) });
oxylabs.setRequester(async (url, opts) => {
  calls.push({ url, opts, payload: JSON.parse(opts.body) });
  const next = answers.shift();
  if (!next) throw new Error('no answer queued');
  if (next instanceof Error) throw next;
  return typeof next === 'function' ? next(url, opts) : next;
});
oxylabs.setSleep(async () => {});
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

beforeEach(() => { calls.length = 0; answers = []; warnings.length = 0; direct.length = 0; oxylabs._clear(); websearch._clear(); });

const searchOk = (rid = 'rid-search-1') => reply(200, { state: 'done', results: [{ title: 'Post', outline: ['a post'], url: 'https://x.com/jock/status/123' }], related_questions: [], related_searches: [], metadata: { request_id: rid } });

test('search sends the Bearer key, caps max_results at 20, and accepts any 2xx', async () => {
  answers = [{ ...searchOk(), status: 201 }];
  const out = await oxylabs.search('jock site:x.com', { count: 50 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/search$/);
  assert.equal(calls[0].opts.headers.authorization, `Bearer ${DUMMY_KEY}`);
  assert.equal(calls[0].opts.timeout, 150000);
  assert.deepEqual(calls[0].payload, { query: 'jock site:x.com', max_results: 20 });
  assert.deepEqual(out, [{ url: 'https://x.com/jock/status/123', title: 'Post', description: 'a post' }]);
  assert.equal(oxylabs.usage().count, 1);
});

test('408, 429 and 5xx are retried with backoff, up to three attempts', async () => {
  answers = [reply(503, { title: 'UPSTREAM' }), reply(408, { title: 'TIMEOUT' }), searchOk()];
  const out = await oxylabs.search('q');
  assert.equal(calls.length, 3);
  assert.equal(out.length, 1);

  calls.length = 0;
  answers = [reply(429, { title: 'RATE_LIMITED', metadata: { request_id: 'rid-429' } }), reply(429, { title: 'RATE_LIMITED', metadata: { request_id: 'rid-429' } }), reply(429, { title: 'RATE_LIMITED', metadata: { request_id: 'rid-429' } })];
  await assert.rejects(oxylabs.search('q'), (e) => e.status === 429 && e.budget === true);
  assert.equal(calls.length, 3, 'stops after three attempts');
});

test('a transport timeout is retried; another transport error is not', async () => {
  answers = [Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }), searchOk()];
  assert.equal((await oxylabs.search('q')).length, 1);
  assert.equal(calls.length, 2);
  calls.length = 0;
  answers = [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })];
  await assert.rejects(oxylabs.search('q'));
  assert.equal(calls.length, 1);
});

test('400 is surfaced with the field and not retried', async () => {
  answers = [reply(400, { status: 400, title: 'VALIDATION_ERROR', detail: 'fix it', metadata: { request_id: 'rid-400' }, errors: [{ pointer: '#/max_results', detail: 'Input should be less than or equal to 20' }] })];
  await assert.rejects(oxylabs.search('q'), (e) => e.status === 400 && /#\/max_results/.test(e.message) && /VALIDATION_ERROR/.test(e.message));
  assert.equal(calls.length, 1);
});

test('401 is surfaced with a clear message, not retried, and the key never appears in errors or logs', async () => {
  answers = [reply(401, { title: 'UNAUTHORIZED', detail: `bad key ${DUMMY_KEY}`, metadata: { request_id: 'rid-401' } })];
  let err;
  await oxylabs.search('q').catch((e) => { err = e; });
  assert.equal(calls.length, 1);
  assert.equal(err.status, 401);
  assert.match(err.message, /rejected the API key/);
  assert.ok(!err.message.includes(DUMMY_KEY));
  assert.ok(warnings.some((w) => /request_id rid-401/.test(w)), 'request_id logged');
  assert.ok(!warnings.some((w) => w.includes(DUMMY_KEY)), 'key never logged');
});

test('the request_id of a failure is logged, and a 4xx error body that echoes the key is redacted', async () => {
  answers = [reply(404, { title: 'NOT_FOUND', detail: `Bearer ${DUMMY_KEY}`, metadata: { request_id: 'rid-404' } })];
  await assert.rejects(oxylabs.search('q'), (e) => !e.message.includes(DUMMY_KEY));
  assert.ok(warnings.some((w) => /\/v1\/search -> 404 \(request_id rid-404\)/.test(w)));
  assert.ok(!warnings.some((w) => w.includes(DUMMY_KEY)));
});

test('the daily budget stops a call before it is sent', async () => {
  const settings = require('../src/settings');
  settings.update({ oxylabsDailyBudget: 1 });
  try {
    answers = [searchOk()];
    await oxylabs.search('q');
    await assert.rejects(oxylabs.search('other'), (e) => e.budget === true);
    assert.equal(calls.length, 1);
  } finally { settings.update({ oxylabsDailyBudget: 100 }); }
});

test('the cap is strict: 99 of 100 used lets one call through, 100 of 100 blocks it before it is sent', async () => {
  const repo = require('../src/db/repo');
  const day = new Date().toISOString().slice(0, 10);
  repo.settings.set('oxylabs.usage', JSON.stringify({ day, count: 99, total: 99 }));
  answers = [searchOk()];
  await oxylabs.search('q');
  assert.equal(calls.length, 1);
  assert.equal(oxylabs.usage().count, 100);
  await assert.rejects(oxylabs.search('q2'), (e) => e.budget === true);
  assert.equal(calls.length, 1, 'nothing sent at 100/100');
});

test('concurrent calls and retries never end the day over the cap', async () => {
  const repo = require('../src/db/repo');
  const day = new Date().toISOString().slice(0, 10);
  repo.settings.set('oxylabs.usage', JSON.stringify({ day, count: 98, total: 98 }));
  // three calls at once with two units left, and the first one answered 503 then 200 (a retry)
  answers = [reply(503, {}), searchOk(), searchOk(), searchOk()];
  const out = await Promise.allSettled([oxylabs.search('a'), oxylabs.search('b'), oxylabs.search('c')]);
  assert.equal(calls.length, 2, 'only two requests ever left PRISM');
  assert.equal(oxylabs.usage().count, 100);
  assert.ok(out.filter((r) => r.status === 'rejected').every((r) => r.reason.budget === true));
});

test('scrape asks for html, retries once with run_js on a block page, and caches by URL', async () => {
  answers = [reply(200, { results: [{ html: '<title>Just a moment...</title>', url: 'https://example.com/p' }], metadata: { request_id: 'r1' } }), reply(200, { results: [{ html: '<html><h1>Real</h1></html>', url: 'https://example.com/p' }], metadata: { request_id: 'r2' } })];
  const r = await oxylabs.scrape('https://example.com/p');
  assert.equal(r.blocked, false);
  assert.match(r.html, /Real/);
  assert.deepEqual(calls.map((c) => c.payload), [{ url: 'https://example.com/p', output: ['html'] }, { url: 'https://example.com/p', output: ['html'], run_js: true }]);
  await oxylabs.scrape('https://example.com/p');
  assert.equal(calls.length, 2, 'the same URL is not scraped again');
});

test('a challenged gayforfans performer page is read through Oxylabs /v1/scrape and parses into items', async () => {
  const videos = ['video-alpha', 'video-beta'];
  const ld = { '@context': 'https://schema.org', '@type': 'CollectionPage', mainEntity: { '@type': 'ItemList', itemListElement: videos.map((v, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'VideoObject', name: v, url: `https://gayforfans.com/video/${v}`, contentUrl: `https://cdn.example.test/${v}.m3u8`, uploadDate: '2026-11-01T00:00:00Z' } })) } };
  const page = `<html><h1>Test Person</h1><link rel="canonical" href="https://gayforfans.com/performer/test-person-123">${videos.map((v) => `<a href="/video/${v}">v</a>`).join('')}<script type="application/ld+json">${JSON.stringify(ld)}</script></html>`;
  // JustTheGays has no page under this slug (the scrape of it answers an empty page); gayforfans is read through Oxylabs.
  answers = [
    (url, opts) => reply(200, { results: [{ html: '', url: JSON.parse(opts.body).url }], metadata: { request_id: 'jtg-1' } }),
    (url, opts) => reply(200, { results: [{ html: '', url: JSON.parse(opts.body).url }], metadata: { request_id: 'jtg-2' } }),
    (url, opts) => reply(200, { results: [{ html: page, url: JSON.parse(opts.body).url }], metadata: { request_id: 'gff-1' } }),
  ];
  const r = await gff.fetch({ platform: 'gff', kind: 'user', target: 'https://gayforfans.com/performer/test-person-123' }, { cursor: {}, limit: 50, aborted: () => false });
  assert.deepEqual(r.items.map((it) => it.sourceId), ['gff-video-alpha', 'gff-video-beta']);
  assert.equal(r.items[0].mediaUrl, 'https://cdn.example.test/video-alpha.m3u8');
  assert.equal(r.items[0].author, 'Test Person');
  assert.ok(calls.some((c) => c.payload.url === 'https://gayforfans.com/performer/test-person-123' && c.payload.output[0] === 'html'));
  assert.ok(r.notes.some((n) => /through Oxylabs/.test(n)));
});

test('a refused performer page with no Oxylabs answer is still reported as the bot check', async () => {
  answers = [reply(500, {}), reply(500, {}), reply(500, {}), reply(500, {}), reply(500, {}), reply(500, {}), reply(500, {}), reply(500, {}), reply(500, {})];
  await assert.rejects(gff.fetch({ platform: 'gff', kind: 'user', target: 'https://justthegays.tv/performer/test-person-123' }, { cursor: {}, limit: 50, aborted: () => false }), (e) => e.challenged === true);
});

test('keyless X search: Oxylabs answers only when a caller asks for it, as the last engine', async () => {
  await assert.rejects(websearch.search('"jock"', { site: 'x.com/jock', count: 30 }));
  assert.equal(calls.length, 0, 'not used by ordinary searches');
  answers = [searchOk('rid-x')];
  const out = await websearch.search('"jock"', { site: 'x.com/jock', count: 30, also: ['oxylabs'] });
  assert.equal(out.provider, 'oxylabs');
  assert.equal(out[0].url, 'https://x.com/jock/status/123');
  assert.deepEqual(calls[0].payload, { query: '"jock" site:x.com/jock', max_results: 20 });
});

test.after(() => { console.warn = realWarn; });
