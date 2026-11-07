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
  const META = (gate) => JSON.stringify({ name: 'PRISM', ageGate: gate });
  const VERIFIED = { enforce: true, verified: true };
  /**
   * Run theme-init.js as the browser does, for an address, and report the early requests it started. /api/meta answers
   * with `gate`; the lists only start after that answer, so this waits for it.
   */
  const early = async (hash, { gate = VERIFIED, fetchImpl, storage } = {}) => {
    const started = [];
    const sandbox = {
      location: { hash }, localStorage: storage,
      document: { documentElement: { dataset: {} }, head: { appendChild() {} }, createElement: () => ({}), currentScript: null },
      fetch: fetchImpl || ((url, opts) => { started.push({ url, opts }); return Promise.resolve({ ok: true, text: async () => (url === '/api/meta' ? META(gate) : '{}') }); }),
    };
    sandbox.window = sandbox;
    vm.runInNewContext(themeInit, sandbox);
    await new Promise((r) => setImmediate(r)); // let the meta answer be read and the lists start
    return { urls: started.map((s) => s.url), opts: started.map((s) => s.opts), sandbox };
  };

  test('meta always starts; once it says the visitor is through, home starts discover and the first feed page and deep links what their view needs', async () => {
    assert.deepEqual((await early('')).urls, ['/api/meta', '/api/discover', '/api/media?sort=recent&page=0&limit=36']);
    assert.deepEqual((await early('#/')).urls, ['/api/meta', '/api/discover', '/api/media?sort=recent&page=0&limit=36']);
    assert.deepEqual((await early('#/explore')).urls, ['/api/meta'], 'Explore was measured with and without early requests: no difference beyond noise, so it asks for nothing early');
    assert.deepEqual((await early('#/explore?tag=gym')).urls, ['/api/meta']);
    assert.deepEqual((await early('#/creator/abc')).urls, ['/api/meta']);
    assert.deepEqual((await early('#/browse')).urls, ['/api/meta', '/api/tags?limit=200', '/api/communities', '/api/platforms', '/api/topics', '/api/creators?onlyfans=1&limit=1', '/api/media?paid=onlyfans&limit=1', '/api/creators?paid=fansly&limit=1']);
    assert.ok((await early('#/')).opts.every((o) => o.credentials === 'same-origin'));
  });

  test('reels starts its trending page early only for a visitor without taste', async () => {
    const url = '/api/media?type=video&sort=trending&page=0&limit=12';
    assert.deepEqual((await early('#/reels')).urls, ['/api/meta', url]);
    const fresh = { getItem: () => null };
    assert.deepEqual((await early('#/reels', { storage: fresh })).urls, ['/api/meta', url]);
    const picked = { getItem: () => JSON.stringify({ events: 4, t: { gym: 3 }, c: {}, seeds: {} }) };
    assert.deepEqual((await early('#/reels', { storage: picked })).urls, ['/api/meta'], 'a "For you" opener asks /api/recommend itself');
  });

  test('a visitor who has not passed the age gate gets no list requests (they would be 403s and console errors)', async () => {
    for (const hash of ['#/', '#/explore', '#/browse']) {
      assert.deepEqual((await early(hash, { gate: { enforce: true, verified: false } })).urls, ['/api/meta'], hash);
    }
  });

  test('with the gate switched off, or an old meta without it, the lists start', async () => {
    assert.equal((await early('#/', { gate: { enforce: false, verified: true } })).urls.length, 3);
    assert.equal((await early('#/', { gate: undefined })).urls.length, 3);
  });

  test('a failed or unreadable meta starts nothing else and throws nothing', async () => {
    const rejecting = (url) => Promise.resolve({ ok: false, text: async () => '' }).then((r) => { void url; return r; });
    const r = await early('#/', { fetchImpl: rejecting });
    assert.equal(r.sandbox.__early['/api/discover'], undefined);
    const garbage = await early('#/', { fetchImpl: () => Promise.resolve({ ok: true, text: async () => '<html>' }) });
    assert.equal(garbage.sandbox.__early['/api/discover'], undefined);
  });

  test('the early URLs are exactly the ones the views build with api.js qs()', async () => {
    const { qs } = await esm('api.js', '?urls');
    const built = {
      home: [`/api/media${qs({ sort: 'recent', page: 0, limit: 36 })}`],
      browse: [`/api/tags${qs({ limit: 200 })}`, `/api/creators${qs({ onlyfans: '1', limit: 1 })}`, `/api/media${qs({ paid: 'onlyfans', limit: 1 })}`, `/api/creators${qs({ paid: 'fansly', limit: 1 })}`],
    };
    for (const u of built.home) assert.ok((await early('#/')).urls.includes(u), u);
    for (const u of built.browse) assert.ok((await early('#/browse')).urls.includes(u), u);
  });

  test('a browser without fetch, or a throwing fetch, leaves the page untouched', async () => {
    await assert.doesNotReject(early('#/', { fetchImpl: () => { throw new Error('blocked'); } }));
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

describe('the early URLs and the views that consume them stay in step', () => {
  // theme-init.js hard-codes the first screen's URLs (it runs before any module). If a view asks for something else, the early
  // answer is never used (a wasted request per visit, and no error). These checks fail loudly when that drifts.
  const view = (f) => fs.readFileSync(path.join(PUBLIC_JS, 'views', f), 'utf8');
  const themeInit = fs.readFileSync(path.join(PUBLIC_JS, 'theme-init.js'), 'utf8');
  test('home asks for the discover payload and the first feed page exactly as theme-init.js starts them', () => {
    const home = view('home.js');
    assert.match(themeInit, /\/api\/discover/); assert.match(themeInit, /\/api\/media\?sort=recent&page=0&limit=36/);
    assert.match(home, /get\('\/api\/discover'\)/, 'views/home.js changed its discover request: update theme-init.js');
    assert.match(home, /prefetch\('\/api\/media', \{ sort: 'recent', page: 0, limit: 36 \}\)/, 'views/home.js changed its first feed page: update theme-init.js');
  });
  test('browse asks for the seven reads theme-init.js starts for it', () => {
    const browse = view('browse.js');
    for (const [early, needle] of [
      ['/api/tags?limit=200', "get('/api/tags', { limit: 200 })"], ['/api/communities', "get('/api/communities')"], ['/api/platforms', "get('/api/platforms')"],
      ['/api/creators?onlyfans=1&limit=1', "get('/api/creators', { onlyfans: '1', limit: 1 })"], ['/api/media?paid=onlyfans&limit=1', "get('/api/media', { paid: 'onlyfans', limit: 1 })"],
      ['/api/creators?paid=fansly&limit=1', "get('/api/creators', { paid: 'fansly', limit: 1 })"],
    ]) { assert.ok(themeInit.includes(early), `theme-init.js starts ${early}`); assert.ok(browse.includes(needle), `views/browse.js changed ${needle}: update theme-init.js`); }
    assert.ok(fs.readFileSync(path.join(PUBLIC_JS, 'components', 'topics.js'), 'utf8').includes("get('/api/topics')"), 'topics.js changed its request: update theme-init.js');
  });
});
