'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let keenable; let websearch; let repo; const seen = [];
let mode = 'ok';

const TEXT = [
  'Title: Pup Bandit - Bluesky Profile\nURL: https://debya.com/bluesky/did:plc:abc\nAcquired: 2026-05-05\nSnippets:\nbandit.bsky.social Hung. #gayonlyfans linktr.ee/bandit_atlpup',
  'Title: Wes - Bluesky Profile\nURL: https://debya.com/bluesky/did:plc:def\nAcquired: 2026-09-01\nSnippets:\nwesleytyler.bsky.social Gay, vegan\n[...]\nmore text',
  'Title: no url block\nSnippets:\nignored',
].join('\n\n---\n\n');

before(async () => {
  mock = await start({
    '/mcp': (req) => {
      const body = JSON.parse(req.bodyText);
      seen.push({ key: req.headers['x-api-key'], body });
      if (mode === 'unauthorized') return { status: 401, json: { error: 'bad key' } };
      if (mode === 'rpcerror') return { json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } } };
      return { json: { result: { _meta: {}, content: [{ type: 'text', text: TEXT }] } } };
    },
  });
  prepareEnv({ KEENABLE_BASE_URL: `${mock.url}/mcp`, KEENABLE_API_KEY: 'keen_test_key', SEARCH_PROVIDERS: 'keenable,brave' });
  keenable = require('../src/lib/keenable'); websearch = require('../src/lib/websearch'); repo = require('../src/db/repo');
});
after(async () => { await mock.close(); });

describe('Keenable search', () => {
  test('one stateless JSON-RPC call; the key goes in X-API-Key; text blocks become {url,title,description}', async () => {
    const r = await keenable.search('gay fitness model bluesky', { site: 'debya.com' });
    assert.equal(r.length, 2, 'blocks without a URL are dropped');
    assert.deepEqual(r[0], { url: 'https://debya.com/bluesky/did:plc:abc', title: 'Pup Bandit - Bluesky Profile', description: 'bandit.bsky.social Hung. #gayonlyfans linktr.ee/bandit_atlpup' });
    assert.equal(seen[0].key, 'keen_test_key');
    assert.equal(seen[0].body.method, 'tools/call');
    assert.equal(seen[0].body.params.name, 'search_web_pages');
    assert.deepEqual(seen[0].body.params.arguments, { query: 'gay fitness model bluesky', site: 'debya.com' });
  });
  test('daily budget is enforced', async () => {
    repo.settings.set('keenable.usage', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 3, total: 3 }));
    await assert.rejects(() => keenable.search('x', { budget: 3 }), (e) => e.budget === true);
    repo.settings.set('keenable.usage', '{}');
  });
  test('a rejected key is a configuration skip, an RPC error is an error', async () => {
    mode = 'unauthorized';
    await assert.rejects(() => keenable.search('q1'), (e) => e.skip === true && /rejected the API key/.test(e.message));
    mode = 'rpcerror';
    await assert.rejects(() => keenable.search('q2'), (e) => /boom/.test(e.message));
    mode = 'ok';
  });
  test('websearch uses Keenable first and caches', async () => {
    websearch._clear();
    const a = await websearch.search('performer name one');
    assert.equal(a.provider, 'keenable'); assert.equal(a.length, 2);
    const n = seen.length;
    await websearch.search('performer name one');
    assert.equal(seen.length, n, 'served from the 10-minute cache');
    assert.equal(websearch.status().keenable.configured, true);
  });
});
