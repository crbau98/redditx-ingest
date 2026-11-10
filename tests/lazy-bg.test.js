'use strict';
/** Background images that only load near the screen (public/js/lazy-bg.js), used by creator cards and topic mosaics. */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const JS = path.join(__dirname, '..', 'public', 'js');
let n = 0;
const load = () => import(`${pathToFileURL(path.join(JS, 'lazy-bg.js')).href}?t${++n}`);
const el = () => ({ style: {} });

describe('lazyBackground', () => {
  after(() => { delete globalThis.IntersectionObserver; });

  test('nothing is requested until the element is near the viewport', async () => {
    const observers = [];
    globalThis.IntersectionObserver = class { constructor(cb, opts) { this.cb = cb; this.opts = opts; this.seen = new Set(); this.gone = new Set(); observers.push(this); } observe(e) { this.seen.add(e); } unobserve(e) { this.gone.add(e); } };
    const { lazyBackground } = await load();
    const a = el(); const b = el();
    assert.equal(lazyBackground(a, '/api/proxy?url=a'), a, 'returns the element');
    lazyBackground(b, '/api/proxy?url=b');
    assert.equal(observers.length, 1, 'one shared observer');
    const [io] = observers;
    assert.equal(io.opts.rootMargin, '300px 500px');
    assert.equal(a.style.backgroundImage, undefined);
    io.cb([{ target: a, isIntersecting: false }]);
    assert.equal(a.style.backgroundImage, undefined, 'scrolled past or far away: still nothing');
    io.cb([{ target: a, isIntersecting: true }]);
    assert.equal(a.style.backgroundImage, 'url("/api/proxy?url=a")');
    assert.ok(io.gone.has(a), 'done with it');
    assert.equal(b.style.backgroundImage, undefined, 'the other tile is still waiting');
  });

  test('no url means no observation; no IntersectionObserver means paint now', async () => {
    const observed = [];
    globalThis.IntersectionObserver = class { observe(e) { observed.push(e); } unobserve() {} };
    const { lazyBackground } = await load();
    lazyBackground(el(), null);
    lazyBackground(el(), '');
    assert.equal(observed.length, 0);
    delete globalThis.IntersectionObserver;
    const fresh = await load();
    const e = el();
    fresh.lazyBackground(e, '/x.jpg');
    assert.equal(e.style.backgroundImage, 'url("/x.jpg")');
  });

  test('creator cards and topic mosaics use it instead of an eager background-image', () => {
    for (const f of ['creator-card.js', 'topics.js']) {
      const src = fs.readFileSync(path.join(JS, 'components', f), 'utf8');
      assert.match(src, /lazyBackground\(/, f);
      assert.doesNotMatch(src, /backgroundImage/, `${f} must not set an eager background-image`);
    }
    const card = fs.readFileSync(path.join(JS, 'components', 'creator-card.js'), 'utf8');
    assert.match(card, /previewFalls/);
    const topics = fs.readFileSync(path.join(JS, 'components', 'topics.js'), 'utf8');
    assert.match(topics, /previewFalls/);
    assert.match(topics, /eager: i < 4/);
    const stage = fs.readFileSync(path.join(JS, 'views', 'creator.js'), 'utf8');
    assert.match(stage, /dataset\.fell/);
  });

  test('the fallback probe waits until the tile is painted, then steps once', async () => {
    const probes = [];
    globalThis.Image = class { set src(v) { this._src = v; probes.push(this); } get src() { return this._src; } };
    const observers = [];
    globalThis.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      unobserve() {}
    };
    const { lazyBackground } = await load();
    const waiting = el();
    lazyBackground(waiting, '/t.webp', false, '/p.jpg');
    assert.equal(probes.length, 0, 'offscreen tiles do not probe');
    assert.equal(waiting.style.backgroundImage, undefined);
    observers[0].cb([{ target: waiting, isIntersecting: true }]);
    assert.equal(waiting.style.backgroundImage, 'url("/t.webp")');
    assert.equal(probes.length, 1);
    waiting.isConnected = true;
    probes[0].onerror();
    assert.equal(waiting.style.backgroundImage, 'url("/p.jpg")');
    delete globalThis.Image;
  });
});
