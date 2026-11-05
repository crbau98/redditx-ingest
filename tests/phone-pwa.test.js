'use strict';
// Phone + install guarantees that need no browser: the web app manifest, the service worker's file list and caching
// rules (run in a vm with an in-memory Cache API), and the stylesheet rules the phone audit found (no 100vh without a
// dvh/svh fallback, content-visibility always with a size estimate, nothing but touch-safe gestures).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { staticGraph } = require('../src/lib/assets');

const pub = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');
const manifest = JSON.parse(read('manifest.webmanifest'));
const html = read('index.html');

/** Width x height of a PNG from its IHDR chunk. */
const pngSize = (file) => { const b = fs.readFileSync(file); assert.equal(b.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const onDisk = (src) => path.join(pub, src.replace(/^\//, ''));

describe('web app manifest', () => {
  test('is installable: names, start url, standalone display, scope', () => {
    assert.equal(manifest.name, 'PRISM');
    assert.ok(manifest.short_name && manifest.short_name.length <= 12, 'short_name fits under an icon');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.id, 'a stable id survives a changed start_url');
  });
  test('icons: 192 and 512 "any", a separate 512 "maskable", all real PNGs of the stated size', () => {
    const find = (size, purpose) => manifest.icons.find((i) => i.sizes === size && i.purpose === purpose && i.type === 'image/png');
    for (const [size, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) assert.ok(find(size, purpose), `${size} ${purpose} icon`);
    for (const i of manifest.icons.filter((x) => x.type === 'image/png')) {
      const [w, h] = i.sizes.split('x').map(Number);
      assert.deepEqual(pngSize(onDisk(i.src)), [w, h], `${i.src} is ${i.sizes}`);
    }
    // one icon must not claim both purposes: a maskable crop of a rounded tile cuts the mark
    for (const i of manifest.icons) assert.ok(!/any maskable|maskable any/.test(i.purpose || ''), `${i.src} purpose is single`);
    assert.ok(fs.existsSync(path.join(pub, 'icons', 'apple-touch-icon.png')) && /apple-touch-icon\.png/.test(html), 'iOS home-screen icon is linked');
  });
  test('theme_color and background_color match the dark token and the <meta name="theme-color"> default', () => {
    const tokens = read('css', 'tokens.css');
    const bg = /:root\s*\{[^}]*--bg:\s*(#[0-9a-f]{6})/i.exec(tokens)[1].toLowerCase();
    assert.equal(manifest.background_color.toLowerCase(), bg);
    assert.equal(manifest.theme_color.toLowerCase(), bg);
    assert.equal(/<meta name="theme-color" content="(#[0-9a-f]{6})"/i.exec(html)[1].toLowerCase(), bg);
  });
  test('the light theme recolours the browser chrome (theme-init before paint, pwa.js on change)', () => {
    const light = /\[data-theme='light'\]\s*\{[^}]*--bg:\s*(#[0-9a-f]{6})/i.exec(read('css', 'tokens.css'))[1].toLowerCase();
    assert.ok(read('js', 'theme-init.js').toLowerCase().includes(light), 'theme-init.js sets the light colour');
    assert.ok(read('js', 'components', 'pwa.js').toLowerCase().includes(light), 'pwa.js repaints it on a theme change');
  });
  test('shortcuts: Top creators and Following, with real icons, inside the scope', () => {
    const byName = Object.fromEntries(manifest.shortcuts.map((s) => [s.name, s]));
    assert.equal(byName['Top creators'].url, '/#/creators');
    assert.equal(byName.Following.url, '/#/following');
    assert.ok(manifest.shortcuts.length <= 10);
    for (const s of manifest.shortcuts) {
      assert.ok(s.url.startsWith('/'), `${s.name} is in scope`);
      for (const i of s.icons || []) assert.ok(fs.existsSync(onDisk(i.src)), `${s.name} icon ${i.src}`);
    }
  });
  test('the page links the manifest, covers the notch and lets the keyboard resize the layout', () => {
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    const vp = /<meta name="viewport" content="([^"]+)"/.exec(html)[1];
    assert.match(vp, /viewport-fit=cover/);
    assert.match(vp, /interactive-widget=resizes-content/);
    assert.doesNotMatch(vp, /user-scalable=no|maximum-scale/, 'pinch zoom stays available');
  });
});

describe('service worker: files', () => {
  const sw = read('sw.js');
  const SHELL = JSON.parse(/const SHELL = (\[[^\]]*\]);/.exec(sw)[1].replace(/'/g, '"'));
  test('every SHELL entry is a real file (or the shell route) and the shell has an offline page', () => {
    for (const u of SHELL) { if (u === '/') continue; assert.ok(fs.existsSync(onDisk(u)), `${u} exists in public/`); }
    assert.ok(SHELL.includes('/offline.html') && SHELL.includes('/'));
    assert.ok(SHELL.includes('/manifest.webmanifest') && manifest.icons.filter((i) => i.type === 'image/png').every((i) => SHELL.includes(i.src)), 'the install icons are precached');
  });
  test('the stylesheets in SHELL are the ones the page loads, and admin stays out', () => {
    for (const css of html.match(/href="(\/css\/[^"]+)"/g).map((m) => m.slice(6, -1))) assert.ok(SHELL.includes(css), `${css} precached`);
    assert.ok(!SHELL.some((u) => /admin/.test(u)));
  });
  test('VERSION is a bumped prism-shell-vN and the offline page works under the CSP (no inline script)', () => {
    const v = /const VERSION = 'prism-shell-v(\d+)'/.exec(sw);
    assert.ok(v && Number(v[1]) >= 9, 'bumped past v8 (the previous shell)');
    assert.doesNotMatch(read('offline.html'), /<script(?![^>]*\ssrc=)[^>]*>/i, 'offline.html has no inline <script> (script-src is self)');
    assert.ok(fs.existsSync(path.join(pub, 'offline.js')));
  });
  test('the new client modules are in the main.js module graph (modulepreload) and wired', () => {
    const names = staticGraph(path.join(pub, 'js'), 'main.js').map((f) => path.basename(f));
    assert.ok(names.includes('pwa.js') && names.includes('scroll-chrome.js'));
    const main = read('js', 'main.js');
    assert.match(main, /initPwa\(\)/); assert.match(main, /initScrollChrome\(\)/);
    assert.doesNotMatch(main, /serviceWorker\.register/, 'registration lives in pwa.js only');
    assert.match(read('js', 'components', 'pwa.js'), /You’re offline — showing saved/);
  });
});

/* ------------------------------------------------------------------------------------------------------------------
 * The worker's caching rules, run for real: sw.js evaluated in a vm with an in-memory CacheStorage and a scripted fetch.
 */
function worker({ origin = 'http://prism.test' } = {}) {
  const handlers = {}; const stores = new Map(); const net = { online: true, calls: [], bodies: {} }; let clock = 1_000_000;
  const key = (r) => (typeof r === 'string' ? new URL(r, origin).href : r.url);
  const makeCache = (name) => {
    const m = new Map();
    return {
      name, map: m,
      match: async (r) => { const hit = m.get(key(r)); return hit ? hit.clone() : undefined; },
      put: async (r, res) => { m.set(key(r), res); }, add: async (r) => { const res = await ctx.fetch(r); if (!res.ok) throw new Error('add failed'); m.set(key(r), res); },
      delete: async (r) => m.delete(key(r)), keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  const caches = {
    open: async (n) => { if (!stores.has(n)) stores.set(n, makeCache(n)); return stores.get(n); },
    delete: async (n) => stores.delete(n), keys: async () => [...stores.keys()],
    match: async (r, o = {}) => { for (const [n, c] of stores) { if (o.cacheName && o.cacheName !== n) continue; const hit = await c.match(r); if (hit) return hit; } return undefined; },
  };
  class FakeDate extends Date { static now() { return clock; } }
  // a worker resolves relative URLs against its own location
  class WorkerRequest extends Request { constructor(u, o) { super(typeof u === 'string' ? new URL(u, origin).href : u, o); } }
  const ctx = vm.createContext({
    self: { location: { origin }, addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches, URL, Response, Request: WorkerRequest, Headers, Promise, Date: FakeDate, setTimeout, clearTimeout, console, Error, Map, Set, Array, Number, String, JSON, Math,
    fetch: async (r) => {
      const url = key(r); net.calls.push(url);
      if (!net.online) throw new TypeError('offline');
      const body = net.bodies[new URL(url).pathname];
      if (body === undefined) return new Response('nope', { status: 404 });
      return new Response(body.data, { status: 200, headers: { 'content-type': body.type } });
    },
  });
  vm.runInContext(fs.readFileSync(path.join(pub, 'sw.js'), 'utf8'), ctx);
  const req = (p, o = {}) => ({ url: new URL(p, origin).href, method: o.method || 'GET', mode: o.mode || 'cors', destination: o.destination || '', headers: new Headers(o.headers || {}) });
  /** Dispatches a fetch event; resolves to the Response the worker answered with, or null when it did not handle it. */
  const fetchEvent = async (p, o) => {
    let answer = null; const waits = [];
    handlers.fetch({ request: req(p, o), respondWith: (x) => { answer = x; }, waitUntil: (x) => waits.push(x) });
    const res = answer ? await answer : null;
    await Promise.all(waits); await new Promise((r) => setTimeout(r, 5)); // let the un-awaited cache writes finish
    return res;
  };
  const lifecycle = async (t, extra = {}) => { const waits = []; handlers[t]({ ...extra, waitUntil: (x) => waits.push(x) }); await Promise.all(waits); };
  return { net, stores, caches, fetchEvent, lifecycle, handlers, advance: (ms) => { clock += ms; }, req };
}
const json = (o) => ({ type: 'application/json', data: JSON.stringify(o) });

describe('service worker: caching rules', () => {
  test('install precaches the shell and the hashed /v/ files the page names; an offline start then works', async () => {
    const w = worker();
    w.net.bodies['/'] = { type: 'text/html', data: '<link rel="stylesheet" href="/v/abc123/css/bundle.css"><script type="module" src="/v/abc123/js/main.js"></script>' };
    for (const p of ['/offline.html', '/offline.js', '/css/tokens.css', '/css/app.css', '/css/ux.css', '/css/v6.css', '/css/aurora.css', '/js/main.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/v/abc123/css/bundle.css', '/v/abc123/js/main.js']) w.net.bodies[p] = { type: 'text/plain', data: p };
    await w.lifecycle('install');
    const shell = w.stores.get([...w.stores.keys()].find((k) => k.startsWith('prism-shell-v')));
    assert.ok(shell.map.has('http://prism.test/v/abc123/js/main.js') && shell.map.has('http://prism.test/v/abc123/css/bundle.css'), 'hashed files precached');
    w.net.online = false;
    const nav = await w.fetchEvent('/', { mode: 'navigate' });
    assert.match(await nav.text(), /bundle\.css/, 'offline navigation gets the cached shell');
    const asset = await w.fetchEvent('/v/abc123/js/main.js', { destination: 'script' });
    assert.equal(await asset.text(), '/v/abc123/js/main.js', 'hashed asset is cache-first');
  });
  test('activate removes caches of old shell versions but keeps the api and image caches', async () => {
    const w = worker();
    for (const n of ['prism-shell-v8', 'prism-shell-v9', 'prism-api-v1', 'prism-img-v1']) await w.caches.open(n);
    await w.lifecycle('activate');
    assert.deepEqual([...w.stores.keys()].sort(), ['prism-api-v1', 'prism-img-v1', 'prism-shell-v9']);
  });
  test('navigation offline with nothing cached shows /offline.html', async () => {
    const w = worker();
    w.net.bodies['/offline.html'] = { type: 'text/html', data: '<h1>You’re offline</h1>' };
    await w.lifecycle('install'); // "/" is not served, so only the offline page is cached
    w.net.online = false;
    assert.match(await (await w.fetchEvent('/', { mode: 'navigate' })).text(), /offline/);
  });
  test('api reads are stale-while-revalidate: fresh copy served at once and refreshed, stale copy only when offline', async () => {
    const w = worker();
    w.net.bodies['/api/creators'] = json({ items: ['a'] });
    assert.deepEqual(await (await w.fetchEvent('/api/creators?limit=2')).json(), { items: ['a'] });
    assert.equal(w.net.calls.length, 1);
    w.net.bodies['/api/creators'] = json({ items: ['b'] });
    w.advance(10_000); // inside the 60 s fresh window: the copy answers, the network refreshes behind it
    assert.deepEqual(await (await w.fetchEvent('/api/creators?limit=2')).json(), { items: ['a'] });
    assert.equal(w.net.calls.length, 2, 'refreshed in the background');
    w.advance(5 * 60_000); // past the window: network first, so the new data shows
    assert.deepEqual(await (await w.fetchEvent('/api/creators?limit=2')).json(), { items: ['b'] });
    w.net.online = false; w.advance(60 * 60_000); // offline an hour later: the last answer beats an error
    assert.deepEqual(await (await w.fetchEvent('/api/creators?limit=2')).json(), { items: ['b'] });
    w.advance(25 * 60 * 60_000); // a day old is dropped: the app shows its own offline state instead
    await assert.rejects(w.fetchEvent('/api/creators?limit=2'));
  });
  test('/api/meta (it carries "age verified") is never answered from a copy while online', async () => {
    const w = worker();
    w.net.bodies['/api/meta'] = json({ ageGate: { verified: false } });
    await w.fetchEvent('/api/meta');
    w.net.bodies['/api/meta'] = json({ ageGate: { verified: true } });
    w.advance(5_000);
    assert.deepEqual(await (await w.fetchEvent('/api/meta')).json(), { ageGate: { verified: true } });
    w.net.online = false;
    assert.deepEqual(await (await w.fetchEvent('/api/meta')).json(), { ageGate: { verified: true } }, 'but offline the last one is used');
  });
  test('admin, live stream, age, hls, lookup and non-GET requests are never cached; a write empties the api cache', async () => {
    const w = worker();
    for (const p of ['/api/admin/stats', '/api/stream', '/api/age/confirm', '/api/hls?u=x', '/api/lookup?q=x']) assert.equal(await w.fetchEvent(p), null, `${p} is not handled`);
    assert.equal(await w.fetchEvent('/api/x', { headers: { accept: 'text/event-stream' } }), null);
    w.net.bodies['/api/media'] = json({ ok: 1 });
    await w.fetchEvent('/api/media');
    assert.equal(w.stores.get('prism-api-v1').map.size, 1);
    assert.equal(await w.fetchEvent('/api/follow', { method: 'POST' }), null);
    assert.equal(w.stores.get('prism-api-v1')?.map.size || 0, 0, 'a POST dropped the cached reads');
    assert.ok(![...w.stores.get('prism-api-v1')?.map.keys() || []].some((k) => /admin/.test(k)));
  });
  test('api cache is capped; only JSON, only status 200', async () => {
    const w = worker();
    for (let i = 0; i < 95; i++) { w.net.bodies[`/api/p${i}`] = json({ i }); await w.fetchEvent(`/api/p${i}`); }
    assert.ok(w.stores.get('prism-api-v1').map.size <= 80, `capped at 80 (has ${w.stores.get('prism-api-v1').map.size})`);
    w.net.bodies['/api/html'] = { type: 'text/html', data: '<p>x</p>' };
    await w.fetchEvent('/api/html');
    assert.ok(![...w.stores.get('prism-api-v1').map.keys()].some((k) => /api\/html/.test(k)), 'non-JSON is not stored');
    await w.fetchEvent('/api/missing'); // 404
    assert.ok(![...w.stores.get('prism-api-v1').map.keys()].some((k) => /api\/missing/.test(k)), 'errors are not stored');
  });
  test('proxy pictures are cache-first with a size cap; video, ranges and HLS are left alone', async () => {
    const w = worker();
    for (let i = 0; i < 160; i++) { w.net.bodies['/api/proxy'] = { type: 'image/jpeg', data: `img${i}` }; await w.fetchEvent(`/api/proxy?url=${i}`, { destination: 'image' }); }
    const imgs = w.stores.get('prism-img-v1').map;
    assert.ok(imgs.size <= 150 && imgs.size >= 140, `capped at 150 (has ${imgs.size})`);
    const before = w.net.calls.length;
    const hit = await w.fetchEvent('/api/proxy?url=159', { destination: 'image' });
    assert.equal(await hit.text(), 'img159'); assert.equal(w.net.calls.length, before, 'second view is from the cache');
    assert.equal(await w.fetchEvent('/api/proxy?url=v', { destination: 'video' }), null);
    assert.equal(await w.fetchEvent('/api/proxy?url=r', { destination: 'image', headers: { range: 'bytes=0-9' } }), null);
    w.net.bodies['/api/proxy'] = { type: 'video/mp4', data: 'vid' };
    await w.fetchEvent('/api/proxy?url=notimg', { destination: 'image' });
    assert.ok(![...imgs.keys()].some((k) => /notimg/.test(k)), 'only image/* responses are stored');
  });
  test('"clear history" empties what the worker kept', async () => {
    const w = worker();
    w.net.bodies['/api/media'] = json({ a: 1 });
    await w.fetchEvent('/api/media');
    await w.lifecycle('message', { data: { type: 'prism-clear-caches' } });
    assert.ok(!w.stores.has('prism-api-v1') && !w.stores.has('prism-img-v1'));
  });
});

/* ------------------------------------------------------------------------------------------------------------------ */
describe('stylesheets: phone rules', () => {
  const FILES = ['tokens.css', 'app.css', 'ux.css', 'v6.css', 'aurora.css'];
  /** Innermost { } blocks as { selector, decls: [[prop, value]] }, comments removed. */
  const blocks = (file) => {
    const css = read('css', file).replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ file, selector: m[1].trim().replace(/\s+/g, ' '), decls: m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]) });
    return out;
  };
  const all = FILES.flatMap(blocks);

  test('no vh height without a dvh/svh/lvh fallback of the same property in the same rule (the URL bar makes 100vh taller than the screen)', () => {
    const bad = [];
    for (const b of all) for (const [prop, value] of b.decls) {
      if (!/(^|-)height$/.test(prop) || !/\d(\.\d+)?vh\b/.test(value)) continue;
      const fixed = b.decls.some(([p, v]) => p === prop && /\d(\.\d+)?[dsl]vh\b/.test(v));
      if (!fixed) bad.push(`${b.file}: ${b.selector} { ${prop}: ${value} }`);
    }
    assert.deepEqual(bad, [], `vh without a dynamic-viewport fallback:\n${bad.join('\n')}`);
  });
  test('the dvh/svh declaration comes after the vh one (older browsers ignore it and keep the vh line)', () => {
    for (const b of all) for (const [prop, value] of b.decls) {
      if (!/(^|-)height$/.test(prop) || !/\d(\.\d+)?[dsl]vh\b/.test(value)) continue;
      const first = b.decls.findIndex(([p, v]) => p === prop && /\d(\.\d+)?vh\b/.test(v));
      const dyn = b.decls.findIndex(([p, v]) => p === prop && /\d(\.\d+)?[dsl]vh\b/.test(v));
      if (first >= 0) assert.ok(dyn > first, `${b.file}: ${b.selector} ${prop}`);
    }
  });
  test('content-visibility: auto always carries contain-intrinsic-size (else off-screen rows collapse to 0 and the scroll bar jumps)', () => {
    for (const b of all) if (b.decls.some(([p, v]) => p === 'content-visibility' && v === 'auto')) assert.ok(b.decls.some(([p]) => p === 'contain-intrinsic-size'), `${b.file}: ${b.selector}`);
    assert.ok(all.some((b) => b.decls.some(([p, v]) => p === 'content-visibility' && v === 'auto')), 'long lists use it');
  });
  test('scrolling panels do not chain scroll to the page, and no rule blocks vertical panning of the page', () => {
    const aurora = read('css', 'aurora.css');
    for (const sel of ['.lb-info', '.modal', '.suggest', '.palette-list']) assert.ok(new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{[^}]*overscroll-behavior: contain`).test(aurora), `${sel} contains overscroll`);
    assert.match(read('css', 'app.css'), /\.reels-track \{[^}]*overscroll-behavior: contain/, 'Reels keeps pull-to-refresh away');
    for (const b of all) for (const [p, v] of b.decls) if (p === 'touch-action' && v === 'none') assert.match(b.selector, /\.lb-stage/, `touch-action: none only where the viewer handles its own gestures (${b.file}: ${b.selector})`);
  });
  test('form fields are 16px on touch (iOS zooms the page on focus below that)', () => {
    const rule = all.find((b) => b.file === 'aurora.css' && /\.input\.sm/.test(b.selector) && b.decls.some(([p, v]) => p === 'font-size' && v === '16px'));
    assert.ok(rule, 'aurora.css sets font-size: 16px on inputs, selects and textareas');
  });
  test('fixed bars respect the safe areas: the tab bar, the app bar, the viewer dock and the toasts use env(safe-area-inset-*)', () => {
    const css = FILES.map((f) => read('css', f)).join('\n');
    assert.match(css, /\.bottomnav \{[^}]*safe-area-inset-bottom/);
    assert.match(css, /\.appbar \{[^}]*safe-area-inset-top/);
    assert.match(css, /\.lb-actions \{[^}]*safe-area-inset-bottom/);
    assert.match(css, /\.toast-stack \{[^}]*safe-area-inset-bottom/);
  });
  test('the filter bar hides through a class and a transform (compositor only), and reduced motion makes it instant', () => {
    const rule = all.find((b) => b.selector === '.filterbar.bar-hidden');
    assert.ok(rule && rule.decls.some(([p, v]) => p === 'transform' && /translateY/.test(v)));
    assert.match(read('css', 'tokens.css'), /prefers-reduced-motion: reduce\)\s*\{\s*:root \{ --dur-quick: 0ms; --dur-base: 0ms/, 'the transition duration token collapses to 0 under reduced motion');
  });
  test('the display dialog labels its checkboxes in sentence case (the section-heading style must not reach them)', () => {
    assert.match(read('css', 'app.css'), /\.display-row > label:not\(\.row\)/);
  });
});
