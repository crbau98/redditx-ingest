'use strict';
/**
 * POST /api/admin/feeds accepts `creatorId`: an editorial page or own-site hub can be
 * registered already tied to a followed creator (Halyard's editorial-gap wiring), instead
 * of landing unattributed and hoping lookup connects it later.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let settings;
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const AGE = { cookie: 'prism_age=1' };
const call = async (p, { method = 'GET', headers = AGE, body } = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { ...headers, ...(body ? ADMIN : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};

before(async () => {
  prepareEnv({});
  repo = require('../src/db/repo');
  settings = require('../src/settings');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

describe('admin feed creation with creatorId', () => {
  test('a web page feed lands on the named creator', async () => {
    settings.update({ physiqueFilter: false }); // keep the body words out of this test's way
    const c = repo.creators.create({ handle: 'hogue-test', displayName: 'Christian Hogue Test', origin: 'test' });
    const r = await call('/api/admin/feeds', { method: 'POST', body: { platform: 'web', kind: 'page', target: 'https://editorial.example.com/hogue-spread', creatorId: c.id } });
    assert.equal(r.status, 201);
    assert.equal(r.json.feed.creator_id, c.id, 'the feed is tied to the creator');
    const again = await call('/api/admin/feeds', { method: 'POST', body: { platform: 'web', kind: 'page', target: 'https://editorial.example.com/hogue-spread', creatorId: c.id } });
    assert.ok([200, 409].includes(again.status), 'a re-add is idempotent-ish');
  });
  test('an unknown creatorId is refused, not silently unlinked', async () => {
    const r = await call('/api/admin/feeds', { method: 'POST', body: { platform: 'web', kind: 'page', target: 'https://editorial.example.com/nope', creatorId: 'no-such-id' } });
    assert.equal(r.status, 404);
  });
});
