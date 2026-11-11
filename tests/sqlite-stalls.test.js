'use strict';
/**
 * Main-thread SQLite stalls (production CPU profiles, 2026-11-11): one synchronous statement that sorts a whole table
 * cannot be broken up by yields around it. warmIndex and faceBackfill now walk media by rowid in fixed windows (no
 * TEMP B-TREE), and abandonRunning uses a partial index (v36) instead of scanning the run history.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
let repo; let db; let visual; let maintenance; let emb;
before(() => {
  repo = require('../src/db/repo'); db = repo.db;
  visual = require('../src/engine/visual'); maintenance = require('../src/engine/maintenance'); emb = require('../src/lib/embeddings');
  visual.ensureTable();
});

const plan = (sql, args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');
/** Run fn and return every SQL text it prepared that matches `re`. */
function captured(re, fn) {
  const seen = []; const real = db.prepare.bind(db);
  db.prepare = (sql) => { if (re.test(sql)) seen.push(sql); return real(sql); };
  return Promise.resolve().then(fn).finally(() => { db.prepare = real; }).then(() => seen);
}
let n = 0;
const add = (extra = {}) => { n++; return repo.media.insert({ platform: 'web', source_id: `st${n}`, source_key: `web:st${n}:0`, post_key: `web:st${n}`, author: 'a', media_type: 'image', media_url: `https://example.com/st${n}.jpg`, hash: `sth${n}`, ...extra }, []); };

test('v36 adds the partial index and abandonRunning searches it instead of scanning feed_runs', () => {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_runs_running'").get());
  const p = plan("UPDATE feed_runs SET status = 'error', error = 'interrupted by restart', finished_at = ? WHERE status = 'running'", ['x']);
  assert.match(p, /SEARCH feed_runs USING INDEX ix_runs_running/, p);
  const v36 = require('../src/db/schema').MIGRATIONS[35];
  assert.equal(v36.name, 'v36'); assert.equal(v36.ddlOnly, true);
});

test('warmIndex walks media by rowid in windows: no temporary sort, and every published vector is indexed', async () => {
  const vec = emb.pack ? emb.pack(new Float32Array(emb.DIM).fill(0.01)) : Buffer.alloc(emb.DIM + 4);
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(add({ publish_state: i === 5 ? 'review' : 'published' }));
  for (const id of ids) db.prepare('INSERT OR REPLACE INTO media_embeddings (media_id, model, vec) VALUES (?, ?, ?)').run(id, emb.MODEL_ID, vec);
  visual._reset();
  const sqls = await captured(/media_embeddings e/, () => visual.warmIndex());
  assert.equal(sqls.length, 1);
  const p = plan(sqls[0], [0, 20000, emb.MODEL_ID]);
  assert.match(p, /SEARCH m USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/, p);
  assert.doesNotMatch(p, /TEMP B-TREE/, p);
  assert.equal(visual._index().n, 5, 'the five published vectors, not the one in review');
});

test('faceBackfill reads one rowid window per call, without a temporary sort, and still finishes', async () => {
  repo.settings.set('face_backfill_seq', '0');
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(add());
  db.prepare(`UPDATE media SET face_at = '2026-11-01T00:00:00.000Z' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  const top = db.prepare('SELECT MAX(seq) AS m FROM media').get().m;
  let sqls = []; let calls = 0; let cleared = 0; let r;
  do {
    sqls = await captured(/FROM media NOT INDEXED/, () => { r = maintenance.faceBackfill({ limit: 200, window: 5 }); });
    cleared += r.cleared; calls++;
  } while (!r.done && calls < 1000);
  assert.ok(r.done);
  assert.ok(calls >= Math.ceil(top / 5) - 1, `walked in windows (${calls} calls)`);
  assert.ok(cleared >= 12, 'every stamped row without vectors was handed back');
  for (const id of ids) assert.equal(db.prepare('SELECT face_at FROM media WHERE id = ?').get(id).face_at, null);
  const p = plan("SELECT seq, id FROM media NOT INDEXED WHERE seq > ? AND seq <= ? AND publish_state = 'published' AND face_at IS NOT NULL AND scope != 'excluded' AND NOT EXISTS (SELECT 1 FROM media_faces f WHERE f.media_id = media.id) ORDER BY seq LIMIT ?", [0, 5, 200]);
  assert.match(p, /SEARCH media USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/, p);
  assert.doesNotMatch(p, /TEMP B-TREE/, p);
  assert.equal(repo.settings.get('face_backfill_seq'), 'done');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'engine', 'maintenance.js'), 'utf8');
  assert.match(src, /FROM media NOT INDEXED\n\s+WHERE seq > \? AND seq <= \? AND publish_state = 'published'/, 'the statement tested is the one the code runs');
});

test('a full batch inside a window resumes after its last row, not at the window end', () => {
  repo.settings.set('face_backfill_seq', '0');
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(add());
  db.prepare(`UPDATE media SET face_at = '2026-11-01T00:00:00.000Z' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  const start = db.prepare('SELECT MIN(seq) AS s FROM media WHERE id IN (' + ids.map(() => '?').join(',') + ')').get(...ids).s;
  repo.settings.set('face_backfill_seq', String(start - 1));
  const r = maintenance.faceBackfill({ limit: 2, window: 1000 });
  assert.equal(r.cleared, 2); assert.equal(r.done, false);
  assert.equal(repo.settings.get('face_backfill_seq'), String(start + 1));
});
