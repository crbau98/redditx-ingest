'use strict';
/**
 * Face enrolment hole (Blueprint Phase 3): a row that entered as review was stamped face_at with no vectors saved, so the
 * face sweep (face_at IS NULL, published only) never enrolled it once it was published. Now: review rows stay unstamped,
 * any move to published with no vectors clears a stale stamp (schema v33), and a one-pass backfill hands old rows back.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, prepareEnv, JPEG } = require('./helpers/mock');

let mock; let repo; let pipeline; let maintenance; let imagefilter; let settings; let engine;
const FACE = [{ gender: 'male', confidence: 0.9, embedding: [0.1, 0.2, 0.3, 0.4] }];
let faces = FACE;

before(async () => {
  mock = await start({ '/p.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }) });
  prepareEnv({});
  repo = require('../src/db/repo');
  settings = require('../src/settings');
  imagefilter = require('../src/lib/imagefilter');
  pipeline = require('../src/engine/pipeline');
  maintenance = require('../src/engine/maintenance');
  engine = require('../src/engine/engine');
  settings.update({ imageFilter: true, faceMatch: true });
  imagefilter.available = async () => true;
  imagefilter.checkItem = async () => ({ status: 'ok', decided: true, female: false, faceList: faces, phash: null });
  repo.hosts.add(`${mock.url}/`);
});
after(async () => { engine.shutdown(); await mock.close(); });

const faceRows = (id) => repo.db.prepare('SELECT COUNT(*) AS n FROM media_faces WHERE media_id = ?').get(id).n;
const faceAt = (id) => repo.db.prepare('SELECT face_at FROM media WHERE id = ?').get(id).face_at;
let n = 0;
const item = (extra = {}) => { n++; return { sourceId: `fe${n}`, position: 0, title: 'sunset at the beach', author: `fe_author${n}`, community: 'pics', mediaType: 'image', mediaUrl: `${mock.url}/p.jpg?n=${n}`, permalink: `https://example.com/fe${n}`, trusted: false, ...extra }; };
const feed = () => repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'facehole', trusted: 0, runNow: false }).feed;

test('a review insert leaves face_at NULL and writes no face rows', async () => {
  const r = await pipeline.processItem(item(), feed(), null, { probeUnknownHosts: false, scopeMode: 'strict', imageFilter: true, faceMatch: true });
  assert.equal(r.outcome, 'review', JSON.stringify(r));
  assert.equal(faceAt(r.mediaId), null);
  assert.equal(faceRows(r.mediaId), 0);
});

test('publishing a review row (repo path) leaves it eligible for the face sweep, even with a stale stamp', async () => {
  const r = await pipeline.processItem(item(), feed(), null, { probeUnknownHosts: false, scopeMode: 'strict', imageFilter: true, faceMatch: true });
  // a stamp from before this fix (or from another sweep) with no vectors
  repo.db.prepare('UPDATE media SET face_at = ? WHERE id = ?').run('2026-11-01T00:00:00.000Z', r.mediaId);
  repo.media.setState(r.mediaId, 'published', null, { exact: true });
  assert.equal(faceAt(r.mediaId), null, 'v33 cleared the stale stamp on publish');
  const sweep = await maintenance.faceSweep({ limit: 120 });
  assert.ok(sweep.checked >= 1);
  assert.ok(faceRows(r.mediaId) >= 1, 'the sweep enrolled it');
  assert.ok(faceAt(r.mediaId));
  // a row that HAS vectors keeps its stamp through hide + restore
  repo.media.setState(r.mediaId, 'hidden', 'test', { exact: true });
  const stamp = faceAt(r.mediaId);
  repo.media.setState(r.mediaId, 'published', null, { exact: true });
  assert.equal(faceAt(r.mediaId), stamp);
});

test('a published insert with a face writes the face row and face_at', async () => {
  const r = await pipeline.processItem(item({ title: 'gay muscle jock', trusted: true }), feed(), null, { probeUnknownHosts: false, scopeMode: 'open', imageFilter: true, faceMatch: true });
  assert.equal(r.outcome, 'added', JSON.stringify(r));
  assert.ok(faceRows(r.mediaId) >= 1);
  assert.ok(faceAt(r.mediaId));
});

test('the backfill hands back a published row stamped without vectors exactly once', async () => {
  repo.settings.set('face_backfill_seq', '0');
  const id = repo.media.insert({ creator_id: null, platform: 'reddit', source_id: 'bf1', source_key: 'reddit:bf1:0', post_key: 'reddit:bf1', author: 'bf', media_type: 'image', media_url: `${mock.url}/p.jpg?bf=1`, hash: 'bfhash1', source_url: 'https://example.com/bf1' }, []);
  const withFace = repo.media.insert({ creator_id: null, platform: 'reddit', source_id: 'bf2', source_key: 'reddit:bf2:0', post_key: 'reddit:bf2', author: 'bf', media_type: 'image', media_url: `${mock.url}/p.jpg?bf=2`, hash: 'bfhash2', source_url: 'https://example.com/bf2' }, []);
  repo.db.prepare('UPDATE media SET face_at = ? WHERE id IN (?, ?)').run('2026-11-01T00:00:00.000Z', id, withFace);
  require('../src/lib/face-match').saveMediaFaces(withFace, FACE);
  const first = maintenance.faceBackfill({ limit: 200 });
  assert.ok(first.cleared >= 1);
  assert.equal(faceAt(id), null, 'stamped without vectors: handed back');
  assert.ok(faceAt(withFace), 'a row with vectors is left alone');
  // the sweep looks at it, finds no face this time, and stamps it: the backfill never clears it again
  faces = [];
  await maintenance.faceSweep({ limit: 120 });
  faces = FACE;
  assert.ok(faceAt(id));
  const again = maintenance.faceBackfill({ limit: 200 });
  assert.equal(again.cleared, 0);
  assert.ok(faceAt(id));
  assert.equal(repo.settings.get('face_backfill_seq'), 'done');
});

test('the body filter stays words and build only: physique modules never load face matching or identity', () => {
  for (const f of ['src/engine/physique.js', 'src/lib/physique.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(reqs.length, `${f} was read`);
    for (const r of reqs) assert.doesNotMatch(r, /face|identity/i, `${f} requires ${r}`);
  }
});
