'use strict';
/**
 * Browser4 rendering inside the web / link-in-bio adapters, against a mock site and a fake `browser4-cli`
 * (tests/helpers/fake-browser4.js), so no Chrome is needed. The real browser is exercised by browser4.live.test.js.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');
const { start, prepareEnv } = require('./helpers/mock');

const b4dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-b4-'));
const fake = path.join(__dirname, 'helpers', 'fake-browser4.js');
prepareEnv({ BROWSER4_ENABLED: '1', BROWSER4_CLI: fake, FAKE_B4_DIR: b4dir, BROWSER4_TIMEOUT_MS: '1500' });

const repo = require('../src/db/repo');
const registry = require('../src/sources');
const settingsStore = require('../src/settings');
const browser4 = require('../src/lib/browser4');
const expand = require('../src/engine/expand');
const hoststrategy = require('../src/engine/hoststrategy');
const { createApp } = require('../src/app');

let site; let api; let apiBase;
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const adm = async (p, { method = 'GET', body, headers = ADMIN } = {}) => {
  const res = await fetch(`${apiBase}/api/admin${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};
const setRoutes = (routes) => { fs.writeFileSync(path.join(b4dir, 'routes.json'), JSON.stringify(routes)); fs.rmSync(path.join(b4dir, 'calls.jsonl'), { force: true }); };
const calls = () => (fs.existsSync(path.join(b4dir, 'calls.jsonl')) ? fs.readFileSync(path.join(b4dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const gotos = () => calls().filter((c) => c.cmd === 'goto').map((c) => c.url);
const imgs = (from, to, w = 900) => Array.from({ length: to - from + 1 }, (_, i) => `<img src="/img/${from + i}.jpg" width="${w}" height="${w}" alt="Gay gym ${from + i}">`).join('');
const page = (body, head = '') => `<!doctype html><html><head><title>Gallery</title>${head}</head><body>${body}</body></html>`;
const fetchWeb = (target, extra = {}) => registry.get('web').fetch({ platform: 'web', kind: 'page', target, origin: 'admin', ...extra }, { limit: 100 });

before(async () => {
  site = await start({
    '/shell': () => ({ headers: { 'content-type': 'text/html' }, body: page('<div id="app"></div><script src="/app.js"></script>') }),
    '/static': () => ({ headers: { 'content-type': 'text/html' }, body: page(imgs(1, 3)) }),
    '/forbidden': () => ({ status: 403, headers: { 'content-type': 'text/html' }, body: 'no' }),
    '/hub': () => ({ headers: { 'content-type': 'text/html' }, body: page('<div id="root"></div>') }),
    '/robots.txt': () => ({ headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' }),
  });
  api = createApp().listen(0);
  await new Promise((r) => api.once('listening', r));
  apiBase = `http://127.0.0.1:${api.address().port}`;
});
after(async () => { await new Promise((r) => api.close(r)); await site.close(); await browser4.close(); });
beforeEach(() => {
  settingsStore.update({ browser4Mode: 'fallback', browser4Scrolls: 8, browser4Pages: 3, browser4AutoExpand: false, browser4ExpandPerRun: 5 });
  browser4._reset(); hoststrategy._reset();
});

describe('web pages', () => {
  test('a JavaScript-built page (no media in the plain download) is read in the browser', async () => {
    const url = `${site.url}/shell`;
    setRoutes({ [url]: { html: page(imgs(1, 12)) } });
    const r = await fetchWeb(url);
    assert.equal(r.via, 'browser4');
    assert.equal(r.items.length, 12);
    assert.equal(r.items[0].mediaUrl, `${site.url}/img/1.jpg`, 'relative src resolved against the page');
    assert.deepEqual(r.items.map((i) => i.position), r.items.map((_, i) => i));
    assert.match(r.info.join(' '), /Browser4 read 1 page, scrolled 2×, found 12 media/);
    assert.deepEqual(r.notes, [], 'a good render is not an error note (the engine stores notes[0] as last_error)');
    const seq = calls().map((c) => c.cmd);
    assert.deepEqual(seq, ['open', 'goto', 'page-info', 'wait', 'eval', 'eval'], 'open, navigate, challenge check, settle, scroll, read');
    assert.ok(calls().find((c) => c.cmd === 'open').rest.includes('--headless'), 'headless unless BROWSER4_HEADED');
    assert.ok(calls().filter((c) => c.cmd === 'eval')[0].scroll && calls()[4].await, 'the scroll script is awaited');
  });

  test('"next page" links on the same site are followed, up to the setting', async () => {
    const p1 = `${site.url}/shell`; const p2 = `${site.url}/shell?page=2`; const p3 = `${site.url}/shell?page=3`;
    setRoutes({
      [p1]: { html: page(imgs(1, 4)), next: p2 },
      [p2]: { html: page(imgs(5, 8)), next: p3 },
      [p3]: { html: page(imgs(9, 12)), next: 'https://elsewhere.example/page4' },
    });
    settingsStore.update({ browser4Pages: 2 });
    const r2 = await fetchWeb(p1);
    assert.equal(r2.items.length, 8, 'two pages, as configured');
    assert.deepEqual(gotos(), [p1, p2]);

    settingsStore.update({ browser4Pages: 10 });
    setRoutes({ ...JSON.parse(fs.readFileSync(path.join(b4dir, 'routes.json'), 'utf8')) });
    const r3 = await fetchWeb(p1);
    assert.equal(r3.items.length, 12);
    assert.ok(gotos().every((u) => new URL(u).hostname === '127.0.0.1'), 'a next link to another site is never followed');
    assert.equal(gotos().length, 3, 'exactly the three pages of the site');
  });

  test('a follow-up page that robots.txt disallows is not fetched', async () => {
    const p1 = `${site.url}/shell`; const blocked = `${site.url}/private/page2`;
    setRoutes({ [p1]: { html: page(imgs(1, 3)), next: blocked }, [blocked]: { html: page(imgs(4, 6)) } });
    const r = await fetchWeb(p1);
    assert.equal(r.items.length, 3);
    assert.deepEqual(gotos(), [p1]);
    assert.match(r.notes.join(' '), /next page not allowed/);
  });

  test('fallback mode leaves a page alone when the plain download already shows media', async () => {
    const url = `${site.url}/static`;
    setRoutes({ [url]: { html: page(imgs(1, 30)) } });
    const r = await fetchWeb(url);
    assert.equal(r.via, 'html');
    assert.equal(r.items.length, 3);
    assert.deepEqual(calls(), [], 'no browser process was started');
  });

  test('"always" renders every page, and keeps the richer result', async () => {
    const url = `${site.url}/static`;
    setRoutes({ [url]: { html: page(imgs(1, 30)) } });
    settingsStore.update({ browser4Mode: 'always' });
    const r = await fetchWeb(url);
    assert.equal(r.via, 'browser4');
    assert.equal(r.items.length, 30);
    // a render that finds less than the plain page did does not replace it
    setRoutes({ [url]: { html: page(imgs(1, 1)) } });
    const r2 = await fetchWeb(url);
    assert.equal(r2.via, 'html');
    assert.equal(r2.items.length, 3);
  });

  test('"off" never starts a browser', async () => {
    setRoutes({ [`${site.url}/shell`]: { html: page(imgs(1, 5)) } });
    settingsStore.update({ browser4Mode: 'off' });
    const r = await fetchWeb(`${site.url}/shell`);
    assert.equal(r.items.length, 0);
    assert.deepEqual(calls(), []);
  });

  test('a refusal is not a rendering problem: a 403 is never retried through the browser', async () => {
    setRoutes({ [`${site.url}/forbidden`]: { html: page(imgs(1, 5)) } });
    settingsStore.update({ browser4Mode: 'always' }); // even when every page is rendered
    const r = await fetchWeb(`${site.url}/forbidden`);
    assert.equal(r.via, 'html');
    assert.deepEqual(r.items, []);
    assert.deepEqual(calls(), [], 'the browser is for pages that loaded but are empty, not for getting past a 403');
  });

  test('the rendered page can opt out, and the opt-out wins', async () => {
    const url = `${site.url}/shell`;
    setRoutes({ [url]: { html: page(imgs(1, 5), '<meta name="robots" content="noindex">') } });
    const r = await fetchWeb(url);
    assert.equal(r.optedOut, true);
    assert.equal(r.items.length, 0);
  });

  test('when the browser fails the plain result stands, with a note instead of an exception', async () => {
    const url = `${site.url}/shell`;
    setRoutes({ [url]: { fail: 'createDevTools' } });
    const r = await fetchWeb(url);
    assert.equal(r.via, 'html');
    assert.deepEqual(r.items, []);
    assert.match(r.notes[0], /^Browser4: browser4-cli goto/);
  });

  test('a hung browser call times out, is reported, and the next render starts a fresh session', async () => {
    const slow = `${site.url}/shell`;
    setRoutes({ [slow]: { html: page(imgs(1, 2)), delayMs: 4000 } });
    const t0 = Date.now();
    const r = await fetchWeb(slow);
    assert.ok(Date.now() - t0 < 3500, 'cut off at the 1.5 s call timeout, not the 4 s page');
    assert.match(r.notes[0], /timed out/);
    setRoutes({ [slow]: { html: page(imgs(1, 2)) } });
    const again = await fetchWeb(slow);
    assert.equal(again.via, 'browser4');
    assert.equal(calls().filter((c) => c.cmd === 'open').length, 1);
  });

  test('renders never overlap: one browser session, one page at a time', async () => {
    const a = `${site.url}/a`; const b = `${site.url}/b`;
    setRoutes({ [a]: { html: page(imgs(1, 2)), delayMs: 200 }, [b]: { html: page(imgs(3, 4)) } });
    await Promise.all([browser4.renderPages(a, { scrolls: 0 }), browser4.renderPages(b, { scrolls: 0 })]);
    const seq = calls().map((c) => (c.cmd === 'goto' ? `goto ${c.url.slice(-1)}` : c.cmd));
    assert.deepEqual(seq, ['open', 'goto a', 'page-info', 'wait', 'eval', 'goto b', 'page-info', 'wait', 'eval']);
  });
});

describe('expansion honours robots.txt for every page it renders', () => {
  test('a depth-2 frontier page that robots.txt disallows is never loaded in the browser', async () => {
    const seed = `${site.url}/home2`; const open = `${site.url}/open/b`; const hidden = `${site.url}/private/a`; const deep = `${site.url}/deep/1`;
    setRoutes({
      [seed]: { html: page('<a href="/private/a">hidden</a><a href="/open/b">open</a>') },
      [open]: { html: page('<a href="/deep/1">deeper</a>') },
      [hidden]: { html: page('<a href="/never/1">secret</a>') },
      [deep]: { html: page('') },
    });
    const r = await expand.run(seed, { depth: 2, limit: 10 });
    assert.deepEqual(gotos(), [seed, open], 'the seed and its allowed child are rendered; the disallowed child never is');
    assert.ok(repo.feeds.find('web', 'page', deep), 'the allowed child\'s own links are adopted as feeds (not rendered: that would be depth 3)');
    assert.ok(r.notes.some((n) => n.startsWith(hidden) && /robots\.txt/.test(n)));
    assert.equal(repo.feeds.find('web', 'page', `${site.url}/never/1`), null, 'nothing was mined from it');
  });
});

describe('a busy browser', () => {
  test('a render that waited too long for the shared browser is skipped, not failed', async () => {
    const config = require('../src/config');
    const a = `${site.url}/a`; const b = `${site.url}/b`;
    setRoutes({ [a]: { html: page(imgs(1, 2)), delayMs: 600 }, [b]: { html: page(imgs(3, 4)) } });
    config.browser4.maxQueueWaitMs = 100;
    try {
      const [ra, rb] = await Promise.allSettled([browser4.renderPages(a, { scrolls: 0 }), browser4.renderPages(b, { scrolls: 0 })]);
      assert.equal(ra.status, 'fulfilled');
      assert.equal(rb.status, 'rejected');
      assert.equal(rb.reason.skip, true);
      assert.match(rb.reason.message, /busy/);
      assert.deepEqual(gotos(), [a], 'the waiting page never reached the browser');
    } finally { config.browser4.maxQueueWaitMs = 40000; }
  });
});

describe('the browser is only spent where it pays (learned per host)', () => {
  test('"always" stops starting the browser on a host where rendering never beats the plain read', async () => {
    const url = `${site.url}/static`;
    setRoutes({ [url]: { html: page(imgs(1, 3)) } }); // the render finds exactly what the plain page already shows
    settingsStore.update({ browser4Mode: 'always' });
    for (let i = 0; i < hoststrategy.EXPLORE; i++) await fetchWeb(url);
    assert.equal(gotos().length, hoststrategy.EXPLORE, 'each of the exploring runs rendered');
    const r = await fetchWeb(url);
    assert.equal(gotos().length, hoststrategy.EXPLORE, 'the next run did not start the browser');
    assert.equal(r.via, 'html'); assert.equal(r.items.length, 3, 'and lost nothing');
    assert.match(r.info.join(' ') + hoststrategy.decide('127.0.0.1', { mode: 'always', found: 3 }).why, /only 0\/3 runs/);
  });

  test('a host where rendering finds MORE keeps being rendered in "always" mode', async () => {
    const url = `${site.url}/static`;
    setRoutes({ [url]: { html: page(imgs(1, 20)) } });
    settingsStore.update({ browser4Mode: 'always' });
    for (let i = 0; i < hoststrategy.EXPLORE + 2; i++) await fetchWeb(url);
    assert.equal(gotos().length, hoststrategy.EXPLORE + 2, 'every run rendered: it keeps paying off');
  });

  test('a host that answers the browser with a bot-challenge is left alone afterwards - nothing is retried', async () => {
    const url = `${site.url}/shell`;
    setRoutes({ [url]: { html: '<html>Just a moment...</html>', challenge: true } });
    const r1 = await fetchWeb(url);
    assert.match(r1.notes.join(' '), /bot-challenge/);
    assert.equal(gotos().length, 1);
    const r2 = await fetchWeb(url);
    assert.equal(gotos().length, 1, 'the second run never opened the page');
    assert.match(r2.info.join(' '), /Browser4 not used: .*bot-challenge; resting it until/);
  });

  test('a host where renders keep coming back empty is rested, so the browser is not started for nothing', async () => {
    const url = `${site.url}/shell`;
    setRoutes({ [url]: { html: page('<p>nothing</p>') } });
    await fetchWeb(url);
    assert.equal(gotos().length, 1);
    const r = await fetchWeb(url);
    assert.equal(gotos().length, 1);
    assert.match(r.info.join(' '), /found nothing 1x in a row/);
  });
});

describe('expansion ranks links by how much they look like content', () => {
  const doc = (html, url) => ({ $: cheerio.load(html), url });
  test('thumbnail cards, gallery paths and listings of siblings come before navigation and paging', () => {
    const html = `<a href="/tag/muscle">tag</a> <a href="/page/2">older</a> <a href="/shoots/rooftop"><img src="/t1.jpg"></a> <a href="/misc">misc</a>
      <a href="/set/a">a</a> <a href="/set/b">b</a> <a href="/set/c">c</a> <a href="/archive/2024">archive</a> <a href="/gallery/summer"><picture><img src="/t2.jpg"></picture></a> <a href="/gallery/summer">summer again</a>`;
    const ranked = expand.rankLinks([doc(html, 'https://example.org/start')], 'https://example.org/start');
    const order = ranked.map((l) => l.url.replace('https://example.org', ''));
    assert.deepEqual(order.slice(0, 2).sort(), ['/gallery/summer', '/shoots/rooftop'], 'the two thumbnail cards lead');
    assert.deepEqual(order.slice(2, 5), ['/set/a', '/set/b', '/set/c'], 'then the listing of siblings, in page order');
    assert.ok(order.indexOf('/misc') < order.indexOf('/tag/muscle') && order.indexOf('/misc') < order.indexOf('/archive/2024') && order.indexOf('/misc') < order.indexOf('/page/2'), 'navigation and paging come last');
    assert.equal(order.filter((u) => u === '/gallery/summer').length, 1, 'a page linked twice is one candidate, and any thumbnail counts');
  });
  test('the feed budget goes to the best pages, not the first ones in the document', () => {
    const html = `<a href="/tag/a">t</a><a href="/tag/b">t</a><a href="/page/2">p</a><a href="/gallery/one"><img src="/1.jpg"></a><a href="/gallery/two"><img src="/2.jpg"></a>`;
    const seed = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://rank.example/start', origin: 'admin' }).feed;
    const a = expand.adoptLinks(seed, [doc(html, seed.target)], settingsStore.get(), { limit: 2 });
    assert.deepEqual(a.urls.sort(), ['https://rank.example/gallery/one', 'https://rank.example/gallery/two']);
  });
});

describe('link-in-bio hubs', () => {
  test('a hub built by JavaScript yields its profile links through the browser', async () => {
    const url = `${site.url}/hub`;
    setRoutes({ [url]: { html: page('<a href="https://x.com/zedfit">X</a> <a href="https://www.redgifs.com/users/zedgifs">RG</a> <a href="https://t.me/zedchannel">TG</a>') } });
    const r = await registry.get('linkinbio').fetch({ platform: 'linkinbio', kind: 'page', target: url }, {});
    assert.equal(r.via, 'browser4');
    assert.deepEqual(r.discovered.map((l) => l.platform).sort(), ['redgifs', 'telegram', 'x']);
    assert.ok(calls().filter((c) => c.cmd === 'eval')[0].scroll, 'scrolled (a short pass)');
  });
});

describe('site expansion', () => {
  const doc = (html, url) => ({ $: cheerio.load(html), url });

  test('takes same-site page links only, without noise, files, tracking or duplicates', () => {
    const html = `<a href="/set/alpha?utm_source=x&id=2">a</a> <a href="/set/alpha?id=2&utm_medium=y">dup</a> <a href="/set/beta/">b</a>
      <a href="/login">no</a> <a href="/cart">no</a> <a href="/img/1.jpg">file</a> <a href="/clip.mp4">file</a> <a href="mailto:a@b.c">m</a> <a href="javascript:void 0">j</a>
      <a href="https://www.example.org/set/gamma#top">www is the same site</a> <a href="https://other.example/set/x">other site</a> <a href="/">home</a> <a href="/feed">feed</a>`;
    const urls = expand.candidateLinks([doc(html, 'https://example.org/gallery')], 'https://example.org/gallery');
    assert.deepEqual(urls, ['https://example.org/set/alpha?id=2', 'https://example.org/set/beta/', 'https://www.example.org/set/gamma']);
  });

  test('adds untrusted web feeds, never over the budget, never twice, never past policy', () => {
    repo.takedowns.add({ kind: 'domain', value: 'gone.example.net', reason: 'asked' });
    const html = ['one', 'two', 'three', 'four', 'five'].map((n) => `<a href="/p/${n}">${n}</a>`).join('');
    const seed = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://example.net/gallery', trusted: 1, origin: 'admin' }).feed;
    const a = expand.adoptLinks(seed, [doc(html, seed.target)], settingsStore.get(), { limit: 3 });
    assert.equal(a.created, 3);
    assert.equal(a.skipped.cap, 2);
    for (const id of a.ids) {
      const f = repo.feeds.get(id);
      assert.equal(f.platform, 'web'); assert.equal(f.kind, 'page'); assert.equal(f.origin, 'expand'); assert.equal(f.trusted, 0, 'untrusted: every item still needs a male-focus signal');
    }
    const b = expand.adoptLinks(seed, [doc(html, seed.target)], settingsStore.get(), { limit: 10 });
    assert.equal(b.created, 2, 'only the two that are new');
    assert.equal(b.skipped.existing, 3);
    // a takedown on the site is respected for same-site links
    const t = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://gone.example.net/gallery', origin: 'admin' }).feed;
    const c = expand.adoptLinks(t, [doc('<a href="/p/x">x</a>', t.target)], settingsStore.get(), { limit: 10 });
    assert.equal(c.created, 0);
    assert.equal(c.skipped.policy, 1);
  });

  test('links belong to the same creator as the page they were found on', () => {
    const creator = repo.creators.create({ handle: 'zedsite', displayName: 'Zed', origin: 'admin' });
    const seed = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://zed.example/', creatorId: creator.id, origin: 'admin' }).feed;
    const a = expand.adoptLinks(seed, [doc('<a href="/shoots/1">1</a>', seed.target)], settingsStore.get(), { limit: 5 });
    assert.equal(repo.feeds.get(a.ids[0]).creator_id, creator.id);
  });

  test('auto-expand (opt-in): a run adds feeds; a feed made by expansion never expands again', async () => {
    const url = `${site.url}/shell`;
    const links = Array.from({ length: 8 }, (_, i) => `<a href="${site.url}/auto/${i}">p${i}</a>`).join('');
    setRoutes({ [url]: { html: page(imgs(1, 3) + links) } });

    const before = repo.feeds.list({ platform: 'web', limit: 1000 }).total;
    await fetchWeb(url); // setting off
    assert.equal(repo.feeds.list({ platform: 'web', limit: 1000 }).total, before, 'off by default');

    settingsStore.update({ browser4AutoExpand: true, browser4ExpandPerRun: 4 });
    const r = await fetchWeb(url);
    assert.match(r.info.join(' '), /auto-expand added 4 same-site page feeds/);
    assert.equal(repo.feeds.list({ platform: 'web', limit: 1000 }).total, before + 4, 'capped by "new feeds per run"');

    const grandchild = repo.feeds.find('web', 'page', `${site.url}/auto/0`);
    assert.equal(grandchild.origin, 'expand');
    setRoutes({ [grandchild.target]: { html: page(imgs(1, 3) + `<a href="${site.url}/deeper/1">d</a>`) } });
    await fetchWeb(grandchild.target, { origin: 'expand' });
    assert.equal(repo.feeds.find('web', 'page', `${site.url}/deeper/1`), null, 'no recursive growth');
  });
});

describe('admin API', () => {
  test('status needs the admin key and reports what is installed', async () => {
    assert.ok([401, 403].includes((await adm('/browser4', { headers: {} })).status));
    const r = await adm('/browser4');
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, true);
    assert.equal(r.json.ok, true);
    assert.match(r.json.version, /fake/);
    assert.equal(r.json.mode, 'fallback');
    assert.equal(r.json.expand.running, false);
  });

  test('expand runs in the background: 202 at once, one at a time, the outcome is in the status', async () => {
    const seed = `${site.url}/home`;
    setRoutes({ [seed]: { html: page('<a href="/g/1">one</a><a href="/g/2">two</a><a href="/login">login</a>'), delayMs: 700 } });
    const started = await adm('/browser4/expand', { method: 'POST', body: { url: seed, depth: 1, limit: 10 } });
    assert.equal(started.status, 202);
    const again = await adm('/browser4/expand', { method: 'POST', body: { url: seed } });
    assert.equal(again.status, 409, 'a second expansion waits for the first');
    assert.equal((await adm('/browser4')).json.expand.running, true);

    let last;
    for (let i = 0; i < 60; i++) { last = (await adm('/browser4')).json.expand; if (!last.running) break; await new Promise((r) => setTimeout(r, 200)); }
    assert.equal(last.running, false);
    assert.equal(last.last.status, 'done');
    assert.equal(last.last.created, 2);
    assert.deepEqual(last.last.urls.map((u) => u.replace(site.url, '')).sort(), ['/g/1', '/g/2']);
    assert.ok(repo.feeds.find('web', 'page', seed), 'the starting page is a feed too');
    assert.equal(repo.feeds.find('web', 'page', `${site.url}/g/1`).trusted, 0);
  });
});
