'use strict';
/**
 * Wave 1: the background sweeps that stalled the production event loop for 23-118 s.
 *
 *   faceSweep    sorted every un-enrolled published row by posted_at into a temp B-tree, every minute
 *   ocr.pick     the same, by ingested_at, with no partial index at all
 *   db/index.js  a main-thread PRAGMA optimize every 6 h (the nightly backup worker already runs it off-thread)
 *   visual       the embedding backlog re-walked every already-embedded row from the top, every minute
 *   PhashIndex   re-parsed a stored hash's hex on every remove()
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const settings = require('../src/settings');
const { MIGRATIONS } = require('../src/db/schema');

const { db } = repo;
let n = 0;
const item = (o = {}) => {
  n++;
  return repo.media.insert({
    platform: 'reddit', source_id: `w1${n}`, source_key: `reddit:w1${n}:0`, post_key: `reddit:w1${n}`, author: 'someone',
    title: `w1 ${n}`, media_type: 'image', media_url: `https://i.redd.it/w1${n}.jpg`, hash: `w1h${n}`, posted_at: new Date(Date.now() - n * 60000).toISOString(), ...o,
  }, []);
};
const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');

/** Every statement prepared while `fn` (sync or async) runs. */
async function spy(fn) {
  const seen = [];
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => { seen.push(sql); return orig(sql); };
  try { await fn(); } finally { db.prepare = orig; }
  return seen;
}

before(() => { for (let i = 0; i < 12; i++) item(); });

describe('Task 1.1: faceSweep picks from its partial index, newest ingested first', () => {
  test('the candidate query reads ix_media_face_todo and builds no temp B-tree', async () => {
    const imagefilter = require('../src/lib/imagefilter');
    const maintenance = require('../src/engine/maintenance');
    const prev = settings.get().faceMatch;
    const avail = imagefilter.available; const check = imagefilter.checkItem;
    settings.update({ faceMatch: true });
    imagefilter.available = async () => true;
    imagefilter.checkItem = async () => ({ status: 'ok', faceList: [] });
    let sql;
    try { sql = (await spy(() => maintenance.faceSweep({ limit: 1 }))).find((s) => /face_at IS NULL/.test(s) && /LIMIT \?/.test(s) && /SELECT id, media_type/.test(s)); }
    finally { imagefilter.available = avail; imagefilter.checkItem = check; settings.update({ faceMatch: prev }); }
    assert.ok(sql, 'faceSweep ran its candidate query');
    const p = plan(sql, 5);
    assert.match(p, /ix_media_face_todo/, p);
    assert.doesNotMatch(p, /TEMP B-TREE/, p);
  });
});

describe('Task 1.2: OCR has its own partial index; no main-thread PRAGMA optimize', () => {
  test('v37 creates ix_media_ocr_todo as a partial index', () => {
    assert.ok(MIGRATIONS.length >= 37);
    const ix = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ix_media_ocr_todo'").get();
    assert.ok(ix, 'the index exists on a fresh database');
    assert.match(ix.sql, /WHERE ocr_at IS NULL AND publish_state = 'published'/);
  });

  test('ocr.pick reads ix_media_ocr_todo, builds no temp B-tree, and returns newest first', async () => {
    const ocr = require('../src/engine/ocr');
    let rows;
    const sql = (await spy(() => { rows = ocr.pick(3); })).find((s) => /ocr_at IS NULL/.test(s));
    const p = plan(sql, 3);
    assert.match(p, /ix_media_ocr_todo/, p);
    assert.doesNotMatch(p, /TEMP B-TREE/, p);
    const want = db.prepare("SELECT id FROM media WHERE ocr_at IS NULL AND publish_state = 'published' AND COALESCE(scope, 'creator') != 'excluded' ORDER BY seq DESC LIMIT 3").all().map((r) => r.id);
    assert.deepEqual(rows.map((r) => r.id), want);
  });

  test('an excluded item is not read for OCR', () => {
    const ocr = require('../src/engine/ocr');
    const out = item({ scope: 'excluded' });
    assert.ok(!ocr.pick(50).some((r) => r.id === out));
  });

  test('src/db/index.js no longer runs PRAGMA optimize on a main-thread timer', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
    assert.doesNotMatch(src, /setInterval\([^\n]*PRAGMA optimize/);
  });
});

describe('Task 1.3: the embedding backlog resumes where it stopped instead of re-walking embedded rows', () => {
  const visual = require('../src/engine/visual');
  const embed = (id) => db.prepare("INSERT OR REPLACE INTO media_embeddings (media_id, model, vec) VALUES (?, ?, zeroblob(260))").run(id, visual._MODEL_ID);

  test('each call reads at most its window budget, finds the old backlog over a few calls, and new rows at once', () => {
    visual.ensureTable();
    const ids = []; for (let i = 0; i < 40; i++) ids.push(item());
    // everything embedded except the 3 oldest of this batch and everything inserted before it
    const all = db.prepare("SELECT id FROM media WHERE publish_state = 'published' AND scope != 'excluded' ORDER BY seq DESC").all().map((r) => r.id);
    const todo = ids.slice(0, 3); // the oldest of the batch (lowest seq)
    for (const id of all) if (!todo.includes(id)) embed(id);
    visual._resetScan({ window: 5, windows: 2 });

    const found = []; let calls = 0;
    while (found.length < 3 && calls < 20) {
      const before = visual._scanStats().windows;
      found.push(...visual._pending(2).map((r) => r.id));
      assert.ok(visual._scanStats().windows - before <= 2, 'never more than the window budget per call');
      for (const id of found) embed(id);
      calls++;
    }
    assert.deepEqual(found, [todo[2], todo[1], todo[0]], 'the backlog is found, newest first');
    assert.ok(calls > 1 && calls < 20, `took ${calls} calls`);

    const fresh = item();
    assert.deepEqual(visual._pending(5).map((r) => r.id), [fresh], 'a new row is picked on the next call');
    embed(fresh);

    // a row below the scanned range that needs work again waits for the next full pass, not every minute
    db.prepare('DELETE FROM media_embeddings WHERE media_id = ?').run(ids[20]);
    assert.deepEqual(visual._pending(5), [], 'resting after a full pass: no re-walk');
    visual._resetScan({ window: 5, windows: 100 });
    assert.deepEqual(visual._pending(5).map((r) => r.id), [ids[20]], 'the next full pass finds it');
    visual._resetScan();
  });

  test('a window query seeks by rowid: no table scan, no temp B-tree', () => {
    const p = plan(visual._WINDOW_SQL, visual._MODEL_ID, new Date().toISOString(), 0, 100, 5);
    assert.match(p, /INTEGER PRIMARY KEY/, p);
    assert.doesNotMatch(p, /TEMP B-TREE/, p);
  });
});

describe('Task 1.3: PhashIndex keeps the parsed chunks on the entry', () => {
  const { PhashIndex } = require('../src/lib/phash-index');
  test('add() stores the 8 chunk bytes; remove() and find() still work', () => {
    const ix = new PhashIndex();
    const a = '0123456789abcdef0123456789abcdef';
    ix.add('a', a);
    const e = ix.entries.get('a');
    assert.ok(e.c instanceof Uint8Array && e.c.length === 8);
    assert.deepEqual([...e.c], PhashIndex.chunks(a));
    assert.deepEqual(ix.find(a).map((m) => m.id), ['a']);
    ix.remove('a');
    assert.equal(ix.size, 0);
    assert.equal(ix.buckets.size, 0, 'every bucket entry is removed');
  });
});
