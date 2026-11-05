'use strict';
/** Requests started while the page loads (theme-init.js), and api.js handing them to the code that asks for them. */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');
const esm = (file, bust = '') => import(`${pathToFileURL(path.join(PUBLIC_JS, file)).href}${bust}`);

describe('requests started while the page loads (theme-init.js + api.js)', () => {
  const themeInit = fs.readFileSync(path.join(PUBLIC_JS, 'theme-init.js'), 'utf8');
  /** Run theme-init.js as the browser does, for an address, and report the early requests it started. */
  const early = (hash, { fetchImpl } = {}) => {
    const started = [];
    const sandbox = {
      location: { hash }, localStorage: undefined,
      document: { documentElement: { dataset: {} }, head: { appendChild() {} }, createElement: () => ({}), currentScript: null },
      fetch: fetchImpl || ((url, opts) => { started.push({ url, opts }); return Promise.resolve({ ok: true, text: async () => '{}' }); }),
    };
    sandbox.window = sandbox;
    vm.runInNewContext(themeInit, sandbox);
    return { urls: started.map((s) => s.url), opts: started.map((s) => s.opts), sandbox };
  };

  test('home starts meta, discover and the first feed page; deep links only what their view needs', () => {
    assert.deepEqual(early('').urls, ['/api/meta', '/api/discover', '/api/media?sort=recent&page=0&limit=36']);
    assert.deepEqual(early('#/').urls, ['/api/meta', '/api/discover', '/api/media?sort=recent&page=0&limit=36']);
    assert.deepEqual(early('#/explore?tag=gym').urls, ['/api/meta']);
    assert.deepEqual(early('#/creator/abc').urls, ['/api/meta']);
    assert.deepEqual(early('#/browse').urls, ['/api/meta', '/api/tags?limit=200', '/api/communities', '/api/platforms', '/api/topics', '/api/creators?onlyfans=1&limit=1', '/api/media?paid=onlyfans&limit=1', '/api/creators?paid=fansly&limit=1']);
    assert.ok(early('#/').opts.every((o) => o.credentials === 'same-origin'));
  });

  test('the early URLs are exactly the ones the views build with api.js qs()', async () => {
    const { qs } = await esm('api.js', '?urls');
    const built = {
      home: [`/api/media${qs({ sort: 'recent', page: 0, limit: 36 })}`],
      browse: [`/api/tags${qs({ limit: 200 })}`, `/api/creators${qs({ onlyfans: '1', limit: 1 })}`, `/api/media${qs({ paid: 'onlyfans', limit: 1 })}`, `/api/creators${qs({ paid: 'fansly', limit: 1 })}`],
    };
    for (const u of built.home) assert.ok(early('#/').urls.includes(u), u);
    for (const u of built.browse) assert.ok(early('#/browse').urls.includes(u), u);
  });

  test('a browser without fetch, or a throwing fetch, leaves the page untouched', () => {
    assert.doesNotThrow(() => early('#/', { fetchImpl: () => { throw new Error('blocked'); } }));
    const sandbox = { location: { hash: '#/' }, document: { documentElement: { dataset: {} } } };
    sandbox.window = sandbox;
    assert.doesNotThrow(() => vm.runInNewContext(themeInit, sandbox));
    assert.equal(sandbox.__early, undefined);
  });

  describe('api.js takes them over', () => {
    let n = 0;
    const load = async ({ earlyEntries = {}, respond = async () => ({ ok: true, status: 200, text: async () => '{"fetched":true}' }) } = {}) => {
      const calls = [];
      globalThis.window = { __early: earlyEntries };
      globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); };
      const api = await esm('api.js', `?early${++n}`);
      return { api, calls };
    };
    after(() => { delete globalThis.window; delete globalThis.fetch; });

    test('an early answer is used once, parsed, and no second request is made', async () => {
      const { api, calls } = await load({ earlyEntries: { '/api/meta': { at: Date.now(), p: Promise.resolve('{"name":"early"}') } } });
      assert.deepEqual(await api.get('/api/meta'), { name: 'early' });
      assert.equal(calls.length, 0);
      assert.equal(globalThis.window.__early['/api/meta'], undefined, 'handed out once');
    });

    test('a failed, unparsable or old early answer falls back to the normal request', async () => {
      for (const entry of [
        { at: Date.now(), p: Promise.reject(new Error('403')) },
        { at: Date.now(), p: Promise.resolve('<html>not json') },
        { at: Date.now() - 60000, p: Promise.resolve('{"name":"old"}') },
      ]) {
        const { api, calls } = await load({ earlyEntries: { '/api/discover': entry } });
        assert.deepEqual(await api.get('/api/discover'), { fetched: true });
        assert.equal(calls.length, 1);
      }
    });

    test('prefetch() takes an early answer over too, and the get() after it reuses the same answer', async () => {
      const { api, calls } = await load({ earlyEntries: { '/api/media?sort=recent&page=0&limit=36': { at: Date.now(), p: Promise.resolve('{"items":[]}') } } });
      api.prefetch('/api/media', { sort: 'recent', page: 0, limit: 36 });
      assert.deepEqual(await api.get('/api/media', { sort: 'recent', page: 0, limit: 36 }), { items: [] });
      assert.equal(calls.length, 0);
    });

  });
});
