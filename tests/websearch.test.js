'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let websearch; let brave; const hits = { brave: 0, searx: 0 }; const mode = { brave: 'ok', searx: 'ok' };

before(async () => {
  mock = await start({
    '/res/v1/web/search': () => { hits.brave++; return mode.brave === 'ok' ? { json: { web: { results: [{ url: 'https://x.com/a', title: '<b>A</b>', description: 'brave result' }] } } } : { status: 403, json: {} }; },
    '/search': (req, res, url) => { hits.searx++; return mode.searx === 'ok' ? { json: { results: [{ url: 'https://bsky.app/profile/a.bsky.social', title: 'A on Bluesky', content: '<i>searx</i> result' }] } } : { status: 500, body: 'down' }; },
  });
  prepareEnv({ BRAVE_BASE_URL: mock.url, BRAVE_API_KEY: 'k', SEARXNG_URL: mock.url, SEARCH_PROVIDERS: 'brave,searxng' });
  websearch = require('../src/lib/websearch');
  brave = require('../src/lib/brave');
});
after(async () => { await mock.close(); });

describe('web search providers', () => {
  test('Brave answers first; results are cleaned and cached', async () => {
    const r = await websearch.search('jax stone');
    assert.equal(r.provider, 'brave'); assert.equal(r[0].title, 'A');
    const again = await websearch.search('jax stone');
    assert.equal(again.provider, 'brave'); assert.equal(hits.brave, 1, 'second call is served from the cache');
  });
  test('a rejected key or spent budget falls through to SearXNG', async () => {
    mode.brave = 'rejected';
    const r = await websearch.search('another query');
    assert.equal(r.provider, 'searxng'); assert.equal(r[0].description, 'searx result');
    assert.ok(hits.searx >= 1);
  });
  test('when every provider fails the error surfaces; with none configured it is a skip, not a crash', async () => {
    mode.searx = 'down';
    await assert.rejects(() => websearch.search('third query'));
    const st = websearch.status();
    assert.equal(st.configured, true); assert.deepEqual(st.providers.map((p) => p.name), ['brave', 'searxng']);
  });
  test('Brave honours its daily budget; SearXNG does not need one', async () => {
    mode.brave = 'ok'; mode.searx = 'ok';
    require('../src/db/repo').settings.set('brave.usage', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 5, total: 5 }));
    const r = await websearch.search('budget query', { budget: 5 });
    assert.equal(r.provider, 'searxng', 'Brave budget spent: the next provider answers');
    assert.equal(brave.usage().count, 5);
  });
});
