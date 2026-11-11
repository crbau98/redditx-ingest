'use strict';
/** Phase C: GET /api/admin/library-health counts four kinds of library damage, read-only. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let server; let base; let engine; let db;
before(async () => {
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); db = repo.db;
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

let n = 0;
const add = (row) => { n++; return repo.media.insert({ platform: 'web', source_id: `lh${n}`, source_key: `web:lh${n}:0`, post_key: `web:lh${n}`, author: 'a', media_type: 'image', media_url: `https://example.com/lh${n}.jpg`, hash: `lhh${n}`, ...row }, []); };
const set = (id, sql, ...a) => db.prepare(`UPDATE media SET ${sql} WHERE id = ?`).run(...a, id);

test('each count finds exactly the seeded damage, and the report changes nothing', async () => {
  const c = repo.creators.create({ handle: 'lh_creator', displayName: 'LH' });
  // healthy rows (not counted)
  add({ creator_id: c.id, platform: 'reddit', phash: 'aaaaaaaaaaaaaaaa' });
  add({ creator_id: c.id, preview_url: 'https://example.com/p.jpg', media_type: 'video', media_url: 'https://example.com/v.mp4' });
  // 1) published, no picture at all: an image with an empty media_url, and a video with no preview / thumbnail
  const noImg = add({ creator_id: c.id }); set(noImg, "media_url = ''");
  add({ creator_id: c.id, media_type: 'video', media_url: 'https://example.com/v2.mp4' });
  // 2) reddit images without a phash: one published, one in review; a removed one and a video are not counted
  add({ platform: 'reddit' }); add({ platform: 'reddit', publish_state: 'review' });
  const gone = add({ platform: 'reddit' }); set(gone, "publish_state = 'removed'");
  add({ platform: 'reddit', media_type: 'video', preview_url: 'https://example.com/rp.jpg' });
  // 3) removed rows with residue: one with a face row, one with an alt source; a clean removed row is not counted
  const withFace = add({}); set(withFace, "publish_state = 'removed'");
  require('../src/lib/face-match').saveMediaFaces(withFace, [{ gender: 'male', confidence: 0.9, embedding: [0.1, 0.2] }], { force: true });
  const withAlt = add({}); repo.media.addAltSource(withAlt, { platform: 'x', source_url: 'https://x.com/a/status/1' }); set(withAlt, "publish_state = 'removed'");
  // 4) a creator whose stored count is wrong
  repo.creators.refreshStats(c.id);
  const drifted = repo.creators.create({ handle: 'lh_drift', displayName: 'Drift' });
  add({ creator_id: drifted.id }); add({ creator_id: drifted.id });
  db.prepare('UPDATE creators SET media_count = 7 WHERE id = ?').run(drifted.id);
  const snapshot = JSON.stringify(db.prepare('SELECT * FROM media ORDER BY seq').all());

  const res = await fetch(`${base}/library-health`, { headers: { 'x-admin-key': 'test-key' } });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.publishedNoImage, 2);
  assert.equal(r.redditPhashNull, 2);
  assert.equal(r.removedWithFacesOrAlt, 2);
  assert.ok(r.creatorCountDrift.creators >= 1);
  const d = r.creatorCountDrift.top.find((x) => x.id === drifted.id);
  assert.deepEqual({ stored: d.stored, actual: d.actual, diff: d.diff }, { stored: 7, actual: 2, diff: -5 });
  assert.ok(!r.creatorCountDrift.top.some((x) => x.id === c.id), 'a correct count is not drift');
  assert.ok(r.definitions && r.definitions.publishedNoImage);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM media ORDER BY seq').all()), snapshot, 'read-only');
  assert.equal(db.prepare('SELECT media_count FROM creators WHERE id = ?').get(drifted.id).media_count, 7, 'no repair');
});

test('small windows give the same totals (the pass is windowed) and the route is admin-only', async () => {
  const lh = require('../src/engine/library-health');
  const a = await lh.report(); const b = await lh.report({ window: 3 });
  for (const k of ['publishedNoImage', 'redditPhashNull', 'removedWithFacesOrAlt']) assert.equal(b[k], a[k], k);
  assert.equal(b.creatorCountDrift.creators, a.creatorCountDrift.creators);
  assert.equal((await fetch(`${base}/library-health`)).status, 401);
});
