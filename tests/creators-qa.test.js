'use strict';
/**
 * Creators QA (Crucible, 2026-11-11): handle and display name stored swapped ("@Dante Colle"), Find showing "@@handle"
 * and "@https://…", and gammacdn movie previews through /api/proxy.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, prepareEnv, JPEG } = require('./helpers/mock');

let upstream; let server; let base; let repo; let pipeline; let engine; let db; let schema;
before(async () => {
  upstream = await start({
    '/movies/70378/70378_01/previews/5/83/top_1_1366x768/70378_01_01.jpg': () => ({ headers: { 'content-type': 'image/webp' }, body: JPEG }),
    '/movies/broken/preview.jpg': () => ({ status: 500, headers: { 'content-type': 'text/html' }, body: 'error' }),
  });
  prepareEnv({});
  repo = require('../src/db/repo');
  db = require('../src/db').db;
  schema = require('../src/db/schema');
  pipeline = require('../src/engine/pipeline');
  engine = require('../src/engine/engine');
  repo.hosts.add(`${upstream.url}/`);
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); await upstream.close(); });

test('a swapped handle / display name pair is put right; anything less clear is left alone', () => {
  const { orderNames } = require('../src/lib/creator-names');
  assert.deepEqual(orderNames('Dante Colle', 'dantecolle.bsky.social'), { handle: 'dantecolle.bsky.social', displayName: 'Dante Colle', swapped: true });
  assert.equal(orderNames('Dante Colle', '@dante_colle').handle, 'dante_colle');
  assert.equal(orderNames('dantecolle', 'Dante Colle').swapped, false, 'already right');
  assert.equal(orderNames('Dante Colle', 'Dante').swapped, false, 'a one-word name is not a handle');
  assert.equal(orderNames('Dante Colle', 'Dante Colle').swapped, false);
  assert.equal(orderNames('Dante Colle', null).swapped, false);
});

test('a site feed named after a person does not store his name as the handle', () => {
  const feed = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://example.com/dante-colle', label: 'Dante Colle', runNow: false }).feed;
  const c = pipeline.resolveCreator({ author: 'dantecolle.bsky.social', title: 'x' }, feed, null);
  assert.equal(c.handle, 'dantecolle.bsky.social');
  assert.equal(c.display_name, 'Dante Colle');
  const direct = repo.creators.create({ handle: 'Other Person', displayName: 'otherperson.bsky.social' });
  assert.equal(direct.handle, 'otherperson.bsky.social');
});

test('migration v35 repairs rows already stored swapped, and only those', () => {
  const ins = db.prepare("INSERT INTO creators (id, handle, display_name) VALUES (?, ?, ?)");
  ins.run('swapped-1', 'Jake Rich', 'jakeandrich1');
  ins.run('fine-1', 'jakipz', 'Jake Ipz');
  ins.run('unclear-1', 'Big Bear', 'Bear');
  schema.MIGRATIONS[34](db);
  const get = (id) => db.prepare('SELECT handle, display_name FROM creators WHERE id = ?').get(id);
  assert.deepEqual(get('swapped-1'), { handle: 'jakeandrich1', display_name: 'Jake Rich' });
  assert.deepEqual(get('fine-1'), { handle: 'jakipz', display_name: 'Jake Ipz' });
  assert.deepEqual(get('unclear-1'), { handle: 'Big Bear', display_name: 'Bear' }, 'not a clear swap: untouched');
});

test('Find names a handle with one @ and a page by host and path', async () => {
  const { targetLabel } = await import('../public/js/handle-label.js');
  assert.equal(targetLabel('jakipz'), '@jakipz');
  assert.equal(targetLabel('@jakipz'), '@jakipz');
  assert.equal(targetLabel('@@jakeandrich1'), '@jakeandrich1');
  assert.equal(targetLabel('https://xhamster.com/gay/creators/jakipz'), 'xhamster.com/gay/creators/jakipz');
  assert.equal(targetLabel('https://www.example.com/a/'), 'example.com/a');
  const find = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'find.js'), 'utf8');
  assert.doesNotMatch(find, /`@\$\{c\.target\}`/);
  assert.equal((find.match(/targetLabel\(c\.target\)/g) || []).length, 2);
});

test('a movie preview with a query string streams through the proxy; a broken upstream answers a clear error at once', async () => {
  const px = (u) => fetch(`${base}/api/proxy?url=${encodeURIComponent(u)}`, { headers: { cookie: 'prism_age=1' } });
  const ok = await px(`${upstream.url}/movies/70378/70378_01/previews/5/83/top_1_1366x768/70378_01_01.jpg?width=500&height=281&format=webp`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/webp');
  const t = Date.now();
  const bad = await px(`${upstream.url}/movies/broken/preview.jpg?width=500`);
  assert.equal(bad.status, 502);
  assert.deepEqual(await bad.json(), { error: 'Upstream error' });
  assert.ok(Date.now() - t < 3000, 'no hang');
});
