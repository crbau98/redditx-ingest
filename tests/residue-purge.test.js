'use strict';
/** Phase H: face vectors and alt sources left on already-removed media are cleared through the one purge, in batches. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let db; let server; let base; let engine; let faceMatch;
before(async () => {
  repo = require('../src/db/repo'); db = repo.db; engine = require('../src/engine/engine'); faceMatch = require('../src/lib/face-match');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

let n = 0;
const add = () => { n++; return repo.media.insert({ platform: 'web', source_id: `rp${n}`, source_key: `web:rp${n}:0`, post_key: `web:rp${n}`, author: 'a', media_type: 'image', media_url: `https://example.com/rp${n}.jpg`, hash: `rph${n}` }, []); };
const face = (id) => faceMatch.saveMediaFaces(id, [{ gender: 'male', confidence: 0.9, embedding: [0.1, 0.2] }], { force: true });
const alt = (id) => repo.media.addAltSource(id, { platform: 'x', source_url: `https://x.com/a/status/${id}` });
// a pre-690c331 removal: state flipped, residue left behind
const removeOld = (id) => db.prepare("UPDATE media SET publish_state = 'removed', review_reason = 'takedown' WHERE id = ?").run(id);
const residue = (id) => db.prepare('SELECT (SELECT COUNT(*) FROM media_faces WHERE media_id = ?) + (SELECT COUNT(*) FROM media_alt_sources WHERE media_id = ?) AS n').get(id, id).n;
const post = (path) => fetch(`${base}${path}`, { method: 'POST', headers: { 'x-admin-key': 'test-key' } });

test('dry run counts; a limited pass purges part; the next pass finishes; published rows and states are untouched', async () => {
  const old = [];
  for (let i = 0; i < 5; i++) { const id = add(); if (i % 2) face(id); else alt(id); removeOld(id); old.push(id); }
  const live = add(); face(live); alt(live);                 // published: never touched
  const clean = add(); removeOld(clean);                      // removed, no residue: not counted
  const dry = await (await post('/maintenance/purge-removed-residue?dryRun=1')).json();
  assert.deepEqual({ found: dry.found, purged: dry.purged, remaining: dry.remaining, dryRun: dry.dryRun }, { found: 5, purged: 0, remaining: 5, dryRun: true });
  for (const id of old) assert.ok(residue(id) > 0, 'a dry run deletes nothing');
  const part = await (await post('/maintenance/purge-removed-residue?limit=2')).json();
  assert.equal(part.found, 5); assert.equal(part.purged, 2); assert.equal(part.remaining, 3);
  const rest = await (await post('/maintenance/purge-removed-residue')).json();
  assert.equal(rest.found, 3); assert.equal(rest.purged, 3); assert.equal(rest.remaining, 0);
  for (const id of old) {
    assert.equal(residue(id), 0);
    const row = db.prepare('SELECT publish_state, review_reason FROM media WHERE id = ?').get(id);
    assert.deepEqual(row, { publish_state: 'removed', review_reason: 'takedown' }, 'the row stays, its state and reason unchanged');
  }
  assert.equal(residue(live), 2, 'a published row keeps its face and alt source');
  assert.equal(db.prepare("SELECT publish_state FROM media WHERE id = ?").get(live).publish_state, 'published');
  const again = await (await post('/maintenance/purge-removed-residue')).json();
  assert.deepEqual({ found: again.found, purged: again.purged }, { found: 0, purged: 0 }, 'idempotent');
  const lh = await (await fetch(`${base}/library-health`, { headers: { 'x-admin-key': 'test-key' } })).json();
  assert.equal(lh.removedWithFacesOrAlt, 0, 'library-health agrees');
});

test('small windows and batches find and purge the same set; the action is admin-only', async () => {
  const ids = [];
  for (let i = 0; i < 7; i++) { const id = add(); face(id); alt(id); removeOld(id); ids.push(id); }
  const rp = require('../src/engine/residue-purge');
  assert.equal((await rp.findResidue({ window: 2 })).length, 7);
  const r = await rp.purgeResidue({ window: 2, batch: 3 });
  assert.equal(r.purged, 7); assert.equal(r.batches, 3);
  for (const id of ids) assert.equal(residue(id), 0);
  assert.equal((await fetch(`${base}/maintenance/purge-removed-residue`, { method: 'POST' })).status, 401);
});
