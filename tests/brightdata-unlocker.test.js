'use strict';
/**
 * The web and link-in-bio adapters with Bright Data's unblocking switched on (setting brightdataUnlocker = fallback):
 * WHEN it fires (only a refusal: 403 / 429 / 503, or a bot-challenge for the local browser) and, as important, when it must
 * not (login walls, missing pages, legal blocks, robots.txt, opt-outs, an exhausted budget, a host that never pays).
 * Bright Data is a mock; the local browser is the fake CLI (tests/helpers/fake-browser4.js).
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');

const b4dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-b4-unlock-'));
const fake = path.join(__dirname, 'helpers', 'fake-browser4.js');
let site; let bd; let registry; let settingsStore; let hoststrategy; let repo; let brightdata;
const bdState = { requests: [], html: null };

const imgs = (n, from = 1) => Array.from({ length: n }, (_, i) => `<img src="/img/${from + i}.jpg" width="900" height="900" alt="Gay gym ${from + i}">`).join('');
const page = (body, head = '') => `<!doctype html><html><head><title>Gallery</title>${head}</head><body>${body}</body></html>`;
const setRoutes = (routes) => { fs.writeFileSync(path.join(b4dir, 'routes.json'), JSON.stringify(routes)); for (const f of ['calls.jsonl', 'netroutes.txt']) fs.rmSync(path.join(b4dir, f), { force: true }); };
const calls = () => (fs.existsSync(path.join(b4dir, 'calls.jsonl')) ? fs.readFileSync(path.join(b4dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const web = (target) => registry.get('web').fetch({ platform: 'web', kind: 'page', target, origin: 'admin' }, {});
const hub = (target) => registry.get('linkinbio').fetch({ platform: 'linkinbio', kind: 'page', target }, {});
const on = (extra = {}) => settingsStore.update({ brightdataUnlocker: 'fallback', brightdataUnlockBudget: 100, browser4Mode: 'off', ...extra });

before(async () => {
  bd = await start({ '/request': (req) => { const b = JSON.parse(req.bodyText); bdState.requests.push(b); return { headers: { 'content-type': 'text/html' }, body: bdState.html(b.url) }; } });
  site = await start({
    '/robots.txt': () => ({ headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' }),
    '/refused': () => ({ status: 403, body: 'no' }), '/limited': () => ({ status: 429, body: 'slow down' }), '/overloaded': () => ({ status: 503, body: 'busy' }),
    '/login-wall': () => ({ status: 401, body: 'login' }), '/gone': () => ({ status: 404, body: 'gone' }), '/gone2': () => ({ status: 410, body: 'gone' }), '/legal': () => ({ status: 451, body: 'legal' }),
    '/private/refused': () => ({ status: 403, body: 'no' }),
    '/shell': () => ({ headers: { 'content-type': 'text/html' }, body: page('<div id="app"></div>') }),
    '/hub-refused': () => ({ status: 403, body: 'no' }),
    '/taken-down': () => ({ status: 403, body: 'no' }),
  });
  prepareEnv({ BROWSER4_ENABLED: '1', BROWSER4_CLI: fake, FAKE_B4_DIR: b4dir, BROWSER4_TIMEOUT_MS: '3000',
    BRIGHTDATA_API_TOKEN: 'bd-token', BRIGHTDATA_UNLOCKER_ZONE: 'zone1', BRIGHTDATA_BASE_URL: bd.url,
    BRIGHTDATA_BROWSER_WSS: 'wss://brd-customer-c1-zone-z:s3cret@brd.superproxy.io:9222' });
  repo = require('../src/db/repo'); registry = require('../src/sources'); settingsStore = require('../src/settings');
  hoststrategy = require('../src/engine/hoststrategy'); brightdata = require('../src/lib/brightdata');
});
after(async () => { await site.close(); await bd.close(); await require('../src/lib/browser4').close(); });
beforeEach(() => {
  bdState.requests = []; bdState.html = () => page(imgs(5));
  repo.settings.set('brightdata.unlock.usage', '{}'); hoststrategy._reset(); require('../src/lib/browser4')._reset();
  setRoutes({});
  on();
});

describe('what triggers an unlock', () => {
  for (const [path_, status] of [['/refused', 403], ['/limited', 429], ['/overloaded', 503]]) {
    test(`HTTP ${status}: the page is fetched through the Web Unlocker`, async () => {
      const url = `${site.url}${path_}`;
      const r = await web(url);
      assert.deepEqual(bdState.requests, [{ zone: 'zone1', url, format: 'raw' }]);
      assert.equal(r.via, 'brightdata-unlocker');
      assert.equal(r.items.length, 5);
      assert.equal(r.items[0].mediaUrl, `${site.url}/img/1.jpg`, 'relative sources resolve against the PAGE, not Bright Data');
      assert.match(r.info.join(' '), /Web Unlocker got past the refusal: 5 media/);
    });
  }

  for (const [path_, why] of [['/login-wall', '401 login wall'], ['/gone', '404 gone'], ['/gone2', '410 gone'], ['/legal', '451 legal block']]) {
    test(`${why}: NOT a refusal to work around, so nothing is unlocked`, async () => {
      const r = await web(`${site.url}${path_}`);
      assert.deepEqual(bdState.requests, []);
      assert.equal(r.via, 'html'); assert.deepEqual(r.items, []);
    });
  }

  test('a healthy page is never unlocked', async () => {
    site.hits.length = 0;
    const r = await web(`${site.url}/shell`);
    assert.deepEqual(bdState.requests, []); assert.equal(r.via, 'html');
  });

  test('it is ON by default: with credentials and nothing stored, a refused page is unlocked', async () => {
    repo.db.prepare("DELETE FROM settings WHERE key IN ('brightdataUnlocker', 'brightdataUnlockBudget', 'browser4Mode')").run(); // factory settings
    assert.equal(settingsStore.get().brightdataUnlocker, 'fallback');
    const r = await web(`${site.url}/refused`);
    assert.equal(bdState.requests.length, 1);
    assert.equal(r.via, 'brightdata-unlocker'); assert.equal(r.items.length, 5);
  });

  test('with the setting switched off nothing is ever sent to Bright Data', async () => {
    settingsStore.update({ brightdataUnlocker: 'off' });
    const r = await web(`${site.url}/refused`);
    assert.deepEqual(bdState.requests, []); assert.deepEqual(r.items, []);
  });

  test('with a zero budget nothing is sent either', async () => {
    on({ brightdataUnlockBudget: 0 });
    await web(`${site.url}/refused`);
    assert.deepEqual(bdState.requests, []);
  });

  test('a bot-challenge answering the LOCAL browser triggers an unlock of that page', async () => {
    const url = `${site.url}/shell`;
    setRoutes({ [url]: { html: '<html>Just a moment...</html>', challenge: true } });
    on({ browser4Mode: 'fallback' });
    const r = await web(url);
    assert.equal(bdState.requests.length, 1, 'the local browser was challenged, then the unlocker was asked');
    assert.equal(r.via, 'brightdata-unlocker'); assert.equal(r.items.length, 5);
    assert.ok(hoststrategy.get(`127.0.0.1`).challenged_until, 'and the local browser now leaves that host alone for a while');
  });
});

describe('what stays out of bounds even when a page refuses', () => {
  test('robots.txt is respected: a disallowed page is neither fetched nor unlocked', async () => {
    await assert.rejects(web(`${site.url}/private/refused`), (e) => e.skip === true);
    assert.deepEqual(bdState.requests, []);
  });

  test('the link-in-bio adapter does not consult robots.txt itself, so the unlock path does', async () => {
    const r = await hub(`${site.url}/private/refused`);
    assert.deepEqual(bdState.requests, [], 'robots.txt disallowed it');
    assert.match(r.info.join(' '), /robots\.txt disallows/);
  });

  test('an opt-out inside the unlocked page is honoured (noindex)', async () => {
    bdState.html = () => page(imgs(5), '<meta name="robots" content="noindex">');
    const r = await web(`${site.url}/refused`);
    assert.equal(r.optedOut, true); assert.deepEqual(r.items, []);
  });

  test('an unlocked answer that is a block page changes nothing: no items, a note, no pretence of success', async () => {
    bdState.html = () => '<html><title>Just a moment...</title>Checking your browser</html>';
    const r = await web(`${site.url}/refused`);
    assert.deepEqual(r.items, []); assert.equal(r.via, 'html');
    assert.match(r.notes.join(' '), /Bright Data: .*block page/);
  });

  test('a takedown on the page stops it before anything is sent', async () => {
    repo.takedowns.add({ kind: 'url', value: `${site.url}/taken-down`, reason: 'asked' }); // its own URL: takedowns outlive the test
    const r = await web(`${site.url}/taken-down`);
    assert.deepEqual(bdState.requests, []); assert.deepEqual(r.items, []);
  });
});

describe('it learns, and spends carefully', () => {
  test('a host where unlocking finds nothing is backed off: the next refusal does not cost a request', async () => {
    bdState.html = () => page('<p>nothing here</p>');
    const url = `${site.url}/refused`;
    await web(url);
    assert.equal(bdState.requests.length, 1);
    const r2 = await web(url);
    assert.equal(bdState.requests.length, 1, 'no second paid request');
    assert.match(r2.info.join(' '), /Bright Data not used: unlocking 127\.0\.0\.1 found nothing 1x in a row/);
  });

  test('a host where it pays keeps being unlocked', async () => {
    const url = `${site.url}/refused`;
    await web(url); await web(url); await web(url);
    assert.equal(bdState.requests.length, 3);
    assert.equal(hoststrategy.get('127.0.0.1').unlock_wins, 3);
  });

  test('the daily budget ends it mid-day, with a note rather than an exception', async () => {
    on({ brightdataUnlockBudget: 1 });
    await web(`${site.url}/refused`);
    hoststrategy._reset();
    const r = await web(`${site.url}/limited`);
    assert.equal(bdState.requests.length, 1);
    assert.match(r.notes.join(' '), /Bright Data: .*budget reached/);
    assert.deepEqual(r.items, []);
  });
});

describe('link-in-bio hubs', () => {
  test('a hub that refuses us is read through the unlocker', async () => {
    bdState.html = () => page('<a href="https://x.com/zedfit">X</a> <a href="https://t.me/zedchannel">TG</a>');
    const r = await hub(`${site.url}/hub-refused`);
    assert.equal(r.via, 'brightdata-unlocker');
    assert.deepEqual(r.discovered.map((l) => l.platform).sort(), ['telegram', 'x']);
  });
});

describe('admin status', () => {
  test('reports what is configured and spent - and never a secret', async () => {
    const { createApp } = require('../src/app');
    const srv = createApp().listen(0); await new Promise((r) => srv.once('listening', r));
    try {
      await web(`${site.url}/refused`); // spend one, so usage is non-zero
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/browser4`, { headers: { 'x-admin-key': 'test-key' } });
      const text = await res.text(); const j = JSON.parse(text);
      assert.equal(j.brightdata.unlocker.configured, true); assert.equal(j.brightdata.unlocker.browserApi, true); assert.equal(j.brightdata.unlocker.mode, 'fallback');
      assert.equal(j.brightdata.unlocker.usage.count, 1);
      assert.equal(j.brightdata.discover.configured, true);
      assert.ok(j.strategy.hosts >= 1);
      for (const secret of ['bd-token', 's3cret', 'customer-c1', 'zone1', 'brd.superproxy.io']) assert.ok(!text.includes(secret), `the response must not contain ${secret}`);
    } finally { await new Promise((r) => srv.close(r)); }
  });
});

describe('the remote Browser API (for pages that need JavaScript AND refuse us)', () => {
  const calls_ = () => calls().filter((c) => ['attach', 'goto', 'close'].includes(c.cmd));

  test('an unlocked page that is an empty JavaScript shell is run in the remote browser', async () => {
    const url = `${site.url}/refused`;
    bdState.html = () => page('<div id="app"></div>');
    setRoutes({ [url]: { html: page(imgs(8)) } });
    const r = await web(url);
    assert.equal(bdState.requests.length, 1, 'the unlocker was asked first (cheapest)');
    assert.equal(r.via, 'brightdata-browser'); assert.equal(r.items.length, 8);
    const seq = calls_().map((c) => c.cmd);
    assert.deepEqual(seq, ['attach', 'goto', 'close'], 'attach, one navigation, close');
    assert.equal(calls().find((c) => c.cmd === 'attach').session, 'prism-ingest-brd', 'a session of its own, apart from the local browser');
    assert.equal(brightdata.unlockUsage().count, 2, 'the unlock and the remote render both spend from the daily budget');
  });

  test('every page of the remote browser gets a fresh connection (Bright Data allows one navigation per connection)', async () => {
    const p1 = `${site.url}/refused`; const p2 = `${site.url}/refused?page=2`;
    bdState.html = () => page('<div id="app"></div>');
    setRoutes({ [p1]: { html: page(imgs(4)), next: p2 }, [p2]: { html: page(imgs(4, 5)) } });
    settingsStore.update({ browser4Pages: 3 });
    const r = await web(p1);
    assert.equal(r.items.length, 8);
    assert.deepEqual(calls_().map((c) => c.cmd), ['attach', 'goto', 'close', 'attach', 'goto', 'close']);
  });

  test('the endpoint\'s credentials never reach a note, even when attaching fails', async () => {
    const url = `${site.url}/refused`;
    bdState.html = () => page('<div id="app"></div>');
    setRoutes({ [url]: { html: page(imgs(3)) }, __attachFail: true });
    const r = await web(url);
    assert.deepEqual(r.items, []);
    assert.match(r.notes.join(' '), /Bright Data: .*\*\*\*@brd\.superproxy\.io/);
    assert.doesNotMatch(r.notes.join(' '), /s3cret|customer-c1/);
  });
});
