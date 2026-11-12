'use strict';
/**
 * "Find more across the web" on a creator page. Every visitor sees the control. A visitor's start goes to
 * POST /api/creators/:id/pull (rate-limited, 10-minute cooldown). An admin session starts a forced sweep on the admin
 * endpoint. A sweep that is already running opens its banner by itself, the four stages and the live counts show while
 * it runs, and a second click while it runs does nothing.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let server; let base; let repo; let deepsearch; let engine;
let release; let searches = 0;

before(async () => {
  repo = require('../src/db/repo');
  deepsearch = require('../src/engine/deepsearch');
  engine = require('../src/engine/engine');
  require('../src/settings').update({ imageMatch: false });
  // The pull's web searches are mocked: the first one waits until the test lets it go, so "running" can be observed.
  deepsearch._setSearchers(async () => {
    searches++;
    if (searches === 1) await new Promise((r) => { release = r; });
    return [{ url: 'https://example.com/unrelated', title: 'unrelated page', description: '' }];
  }, async () => []);
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { deepsearch._resetSearchers(); engine.shutdown(); await new Promise((r) => server.close(r)); });

const load = () => import('../public/js/components/deep-pull.js');

/** A minimal DOM stand-in for the control. */
function fakeH(tag, props, ...children) {
  const el = { tag, props: props || {}, children: children.filter(Boolean), textContent: '', disabled: false, hidden: !!(props && props.hidden), isConnected: true, listeners: {} };
  el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
  el.remove = () => { el.isConnected = false; };
  el.replaceChildren = (...nodes) => { el.children = nodes.flat().filter(Boolean); };
  return el;
}
const button = (wrap) => wrap.children.find((c) => c.tag === 'button');
const note = (wrap) => wrap.children.find((c) => c.props.class === 'muted sm deep-pull-note');
const banner = (wrap) => wrap.children.find((c) => c.props.class === 'deep-pull-banner');
const live = (wrap) => wrap.children.find((c) => c.props.class === 'dp-sr');
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };
const tick = () => new Promise((r) => setTimeout(r, 10));

/**
 * The real server over fetch (only the transport is real; no browser). Admin calls are recorded relative to /api/admin,
 * as they always were; the visitor's status read and start are recorded by their full path.
 */
function adminApi(key) {
  const calls = [];
  const send = async (method, url, body, headers) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status });
    return data;
  };
  const call = (method, path, body) => { calls.push(`${method} ${path}`); return send(method, `/api/admin${path}`, body, { 'x-admin-key': key }); };
  const visitor = (method, full, body) => { calls.push(`${method} ${full}`); return send(method, full, body, {}); };
  return {
    calls,
    adminGet: (p) => call('GET', p),
    adminPost: (p, b) => call('POST', p, b),
    getStatus: (full) => visitor('GET', full),
    post: (full, b) => visitor('POST', full, b),
  };
}

test('a visitor sees the control; nothing starts until a click, and the click goes to the visitor route', async () => {
  const { deepPullControl } = await load();
  const reads = []; const starts = [];
  const wrap = deepPullControl({ creatorId: 'c1', h: fakeH,
    getStatus: async (p) => { reads.push(p); return {}; },
    post: async (p, b) => { starts.push([p, b]); return { ok: true, started: false, reason: 'cooldown' }; } });
  assert.ok(wrap, 'rendered for a visitor (no admin key)');
  assert.equal(deepPullControl({ creatorId: '', h: fakeH, getStatus: async () => ({}), post: async () => ({}) }), null, 'no creator, no control');
  await tick();
  assert.deepEqual(reads, ['/api/creators/c1/pull'], 'one silent status read on mount');
  assert.deepEqual(starts, [], 'nothing is started on mount');
  await button(wrap).listeners.click();
  assert.deepEqual(starts, [['/api/creators/c1/pull', {}]]);
  assert.equal(note(wrap).textContent, 'Searched recently. Try again in a few minutes.');
  assert.equal(button(wrap).disabled, false);
});

test('a key the server rejects removes the control when an admin starts a sweep', async () => {
  const { deepPullControl } = await load();
  const creator = repo.creators.create({ handle: 'pull_reject', displayName: 'Pull Reject' });
  const api = adminApi('wrong-key');
  const wrap = deepPullControl({ creatorId: creator.id, adminKey: 'wrong-key', h: fakeH, ...api });
  await tick();
  assert.equal(wrap.isConnected, true, 'the status read is public, so the control stays until a start is refused');
  await button(wrap).listeners.click();
  await until(() => wrap.isConnected === false);
});

test('a visitor can start a deep pull on the public route', async () => {
  const creator = repo.creators.create({ handle: 'pull_public', displayName: 'Pull Public' });
  const res = await fetch(`${base}/api/creators/${creator.id}/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.started, true, JSON.stringify(body));
  assert.equal(typeof body.job.postsAdded, 'number');
  // This file parks the first search. Let this pull finish, then arm the park again for the admin test.
  if (release) { const go = release; release = null; go(); }
  await until(() => deepsearch.status(creator.id).done === true);
  searches = 0;
});

test('an admin click starts the pull, shows progress while it runs, ignores a second click, and shows the result', async () => {
  const { deepPullControl } = await load();
  const creator = repo.creators.create({ handle: 'pull_admin', displayName: 'Pull Admin' });
  const api = adminApi('test-key');
  const timers = [];
  const wrap = deepPullControl({ creatorId: creator.id, adminKey: 'test-key', h: fakeH, ...api, every: 20,
    setTimer: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; }, clearTimer: clearInterval });
  try {
    assert.match(button(wrap).props.class, /\bbtn\b/);
    await until(() => api.calls.length >= 1); // the initial status read
    await button(wrap).listeners.click();
    assert.ok(api.calls.includes(`POST /creators/${creator.id}/pull`));
    await until(() => deepsearch.status(creator.id).running);
    assert.match(live(wrap).textContent, /step 1 of 4/, 'the first stage is shown while the first search runs');
    assert.ok(banner(wrap).hidden === false, 'the banner is open while the sweep runs');
    assert.equal(button(wrap).disabled, true);
    const posts = api.calls.filter((c) => c.startsWith('POST')).length;
    await button(wrap).listeners.click();
    assert.equal(api.calls.filter((c) => c.startsWith('POST')).length, posts, 'a second click sends nothing');
    // the server refuses a second start too
    const again = await api.adminPost(`/creators/${creator.id}/pull`, { force: true });
    assert.equal(again.started, false);
    assert.equal(again.reason, 'already running');
    release();
    await until(() => /^Done:/.test(live(wrap).textContent));
    assert.match(live(wrap).textContent, /new posts? pulled/);
    assert.equal(button(wrap).disabled, false);
    assert.ok(api.calls.filter((c) => c.startsWith('GET')).length >= 2, 'progress came from the status endpoint');
  } finally { timers.forEach(clearInterval); if (release) release(); }
});
