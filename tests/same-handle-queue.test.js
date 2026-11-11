'use strict';
/**
 * Blueprint Phase 6: creators that share a handle are listed for the admin (never merged on their own). Merge is the
 * existing route and keeps the row with more posts; "different people" is a rejected identity link, so the pair stays gone.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let identity; let server; let base; let engine;
before(async () => {
  repo = require('../src/db/repo');
  identity = require('../src/engine/identity');
  engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

const H = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const call = async (method, path, body, headers = H) => {
  const res = await fetch(`${base}/api/admin${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const mk = (handle, name, media) => {
  const c = repo.creators.create({ handle, displayName: name });
  repo.db.prepare('UPDATE creators SET media_count = ? WHERE id = ?').run(media, c.id);
  return repo.creators.get(c.id);
};
const groupOf = (h) => identity.sameHandleGroups().groups.find((g) => g.handle === h);

test('groups creators by handle, case-insensitively, and only where more than one shares it', () => {
  const a = mk('JockFit', 'Jock A', 3);
  const b = mk('jockfit', 'Jock B', 40);
  mk('loner_handle', 'Alone', 5);
  repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'jockfit', creatorId: b.id, runNow: false });
  const g = groupOf('jockfit');
  assert.ok(g);
  assert.deepEqual(g.creators.map((c) => c.id), [b.id, a.id], 'most posts first');
  assert.deepEqual(g.creators[0].platforms, ['x']);
  assert.equal(g.pairs.length, 1);
  assert.equal(g.pairs[0].keepId, b.id, 'the merge keeps the row with more posts');
  assert.equal(g.pairs[0].goneId, a.id);
  assert.equal(groupOf('loner_handle'), undefined);
});

test('a same-handle pair is never allowed to auto-merge, even with strong evidence and a shared name', () => {
  const a = mk('twinman', 'Twin', 2); const b = mk('TwinMan', 'Twin', 9);
  identity.addAlias(a.id, 'twinman', { source: 'account' }); identity.addAlias(b.id, 'twinman', { source: 'account' });
  const r = identity.noteLink(a.id, b.id, { type: 'same-onlyfans', detail: 'twin' }, { autoMerge: false });
  assert.ok(r.strength >= identity.AUTO_STRENGTH);
  const p = groupOf('twinman').pairs[0];
  assert.equal(p.linked, true);
  assert.equal(p.autoMergeAllowed, false);
  assert.ok(repo.creators.get(a.id) && repo.creators.get(b.id), 'listing merges nothing');
});

test('"different people" records the decision and the pair no longer appears', async () => {
  const a = mk('samename', 'One', 1); const b = mk('SameName', 'Two', 2);
  assert.ok(groupOf('samename'));
  const r = await call('POST', '/creators/same-handle/dismiss', { aId: a.id, bId: b.id });
  assert.equal(r.status, 200);
  assert.equal(groupOf('samename'), undefined);
  const link = repo.db.prepare("SELECT status FROM identity_links WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)").get(a.id, b.id, b.id, a.id);
  assert.equal(link.status, 'rejected');
  assert.equal((await call('POST', '/creators/same-handle/dismiss', { aId: a.id, bId: mk('other_handle', 'X', 0).id })).status, 404, 'only same-handle pairs');
});

test('merging through the existing route with the listed keepId folds the smaller row into the one with more posts', async () => {
  const small = mk('mergeme', 'Small', 4); const big = mk('MergeMe', 'Big', 50);
  const p = groupOf('mergeme').pairs[0];
  const { sameHandleActions } = await import('../public/js/views/admin/logic.js');
  const byId = Object.fromEntries(groupOf('mergeme').creators.map((c) => [c.id, c]));
  const act = sameHandleActions(p, byId);
  assert.equal(act.mergeLabel, 'Merge: keep Big (50 posts), fold in Small (4 posts)');
  assert.deepEqual(act.merge, { path: '/creators/merge', body: { keepId: big.id, mergeId: small.id } });
  const r = await call('POST', act.merge.path, act.merge.body);
  assert.equal(r.status, 200);
  assert.ok(repo.creators.get(big.id), 'the bigger row survives');
  assert.equal(repo.creators.get(small.id), null, 'the smaller row is folded in');
  assert.equal(groupOf('mergeme'), undefined);
});

test('the same-handle routes are admin-only', async () => {
  assert.equal((await call('GET', '/creators/same-handle', null, {})).status, 401);
  assert.equal((await call('POST', '/creators/same-handle/dismiss', { aId: 'a', bId: 'b' }, { 'content-type': 'application/json' })).status, 401);
  const ok = await call('GET', '/creators/same-handle');
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.groups));
});
