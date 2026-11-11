'use strict';
/**
 * "Find more across the web": the admin-only deep pull. The control renders (and requests) nothing without an admin
 * session; with one it starts the pull on the real admin endpoint, shows inline progress from the status endpoint, and
 * a second click while it runs does nothing. The public pull route is gone (deep pulls spend paid credits).
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
  const el = { tag, props: props || {}, children: children.filter(Boolean), textContent: '', disabled: false, isConnected: true, listeners: {} };
  el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
  el.remove = () => { el.isConnected = false; };
  return el;
}
const button = (wrap) => wrap.children.find((c) => c.tag === 'button');
const line = (wrap) => wrap.children.find((c) => c.tag === 'span');

/** The admin API calls, sent to the real server (only fetch's transport is real; no browser). */
function adminApi(key) {
  const calls = [];
  const call = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    const res = await fetch(`${base}/api/admin${path}`, { method, headers: { 'x-admin-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status });
    return data;
  };
  return { calls, adminGet: (p) => call('GET', p), adminPost: (p, b) => call('POST', p, b) };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('the progress line names the phase and the result counts', async () => {
  const { pullLine } = await load();
  assert.equal(pullLine({ running: true, phase: 'text' }), 'Searching the web… 1/3 phases');
  assert.equal(pullLine({ running: true, phase: 'image' }), 'Matching pictures and reverse image… 3/3 phases');
  assert.equal(pullLine({ running: false, done: true, found: { feeds: 2, pictures: 1, results: 14 } }), 'Done: 2 new pages, 1 picture matched, 14 results read');
});

test('without an admin session there is no button and no request', async () => {
  const { deepPullControl } = await load();
  let requests = 0;
  const api = () => { requests++; return Promise.resolve({}); };
  assert.equal(deepPullControl({ creatorId: 'c1', adminKey: '', h: fakeH, adminGet: api, adminPost: api }), null);
  assert.equal(deepPullControl({ creatorId: 'c1', adminKey: undefined, h: fakeH, adminGet: api, adminPost: api }), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests, 0);
});

test('a key the server rejects removes the control', async () => {
  const { deepPullControl } = await load();
  const creator = repo.creators.create({ handle: 'pull_reject', displayName: 'Pull Reject' });
  const api = adminApi('wrong-key');
  const wrap = deepPullControl({ creatorId: creator.id, adminKey: 'wrong-key', h: fakeH, ...api });
  await until(() => wrap.isConnected === false);
});

test('the public pull route is gone: a visitor cannot start a deep pull', async () => {
  const creator = repo.creators.create({ handle: 'pull_public', displayName: 'Pull Public' });
  const res = await fetch(`${base}/api/creators/${creator.id}/pull`, { method: 'POST' });
  assert.equal(res.status, 404);
  assert.equal(deepsearch.status(creator.id).running, false);
});

test('an admin click starts the pull, shows progress while it runs, ignores a second click, and shows the result', async () => {
  const { deepPullControl } = await load();
  const creator = repo.creators.create({ handle: 'pull_admin', displayName: 'Pull Admin' });
  const api = adminApi('test-key');
  const timers = [];
  const wrap = deepPullControl({ creatorId: creator.id, adminKey: 'test-key', h: fakeH, ...api, every: 20,
    setTimer: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; }, clearTimer: clearInterval });
  try {
    assert.equal(button(wrap).props.class, 'btn');
    await until(() => api.calls.length >= 1); // the initial status read
    await button(wrap).listeners.click();
    assert.ok(api.calls.includes(`POST /creators/${creator.id}/pull`));
    await until(() => deepsearch.status(creator.id).running);
    assert.match(line(wrap).textContent, /1\/3 phases/);
    assert.equal(button(wrap).disabled, true);
    const posts = api.calls.filter((c) => c.startsWith('POST')).length;
    await button(wrap).listeners.click();
    assert.equal(api.calls.filter((c) => c.startsWith('POST')).length, posts, 'a second click sends nothing');
    // the server refuses a second start too
    const again = await api.adminPost(`/creators/${creator.id}/pull`, { force: true });
    assert.equal(again.started, false);
    assert.equal(again.reason, 'already running');
    release();
    await until(() => /^Done:/.test(line(wrap).textContent));
    assert.match(line(wrap).textContent, /results? read/);
    assert.equal(button(wrap).disabled, false);
    assert.ok(api.calls.filter((c) => c.startsWith('GET')).length >= 2, 'progress came from the status endpoint');
  } finally { timers.forEach(clearInterval); if (release) release(); }
});
