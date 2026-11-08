'use strict';
/**
 * OCR: the text column, the FTS trigger, the background sweep, and the "do not retry a dead picture"
 * marker. Tesseract itself is replaced, so no binary or network is needed.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let ocr; let engine; let net; let originalFetch;

before(() => {
  prepareEnv({});
  repo = require('../src/db/repo');
  ocr = require('../src/lib/ocr');
  engine = require('../src/engine/ocr');
  net = require('../src/lib/net');
  originalFetch = net.fetchBuffer;
});

after(() => {
  net.fetchBuffer = originalFetch;
  ocr._reset();
});

const insert = (n, over = {}) => repo.media.insert({
  creator_id: null, platform: 'reddit', source_id: `ocr${n}`, source_key: `reddit:ocr${n}:0`, post_key: `reddit:ocr${n}`,
  author: 'ocr_author', title: null, media_type: 'image', media_url: `https://media.example/ocr${n}.jpg`,
  preview_url: `https://media.example/ocr${n}-small.jpg`, hash: `ocrhash${n}`, source_url: `https://example.com/ocr${n}`,
  posted_at: new Date().toISOString(), ...over,
}, []);

test('the migration adds ocr_text/ocr_at and OCR text reaches full-text search', () => {
  const cols = repo.db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  assert.ok(cols.includes('ocr_text') && cols.includes('ocr_at'));
  const id = insert(1);
  repo.db.prepare('UPDATE media SET ocr_text = ? WHERE id = ?').run('sunset beach volleyball', id);
  const hit = repo.db.prepare("SELECT m.id FROM media_fts f JOIN media m ON m.seq = f.rowid WHERE media_fts MATCH 'volleyball'").all();
  assert.ok(hit.some((r) => r.id === id));
});

test('normalize collapses control characters and caps the stored text', () => {
  assert.equal(ocr.normalize('  HELLO\n\n\nworld\t!  '), 'HELLO\nworld !');
  assert.ok(ocr.normalize('x'.repeat(5000)).length <= 1200);
});

test('a sweep reads the picture, stores only the words, and marks the attempt', async () => {
  ocr._setRecognize(async () => 'ONLY THE WORDS');
  net.fetchBuffer = async () => ({ status: 200, contentType: 'image/jpeg', buffer: Buffer.from('fake-image') });
  const id = insert(2);
  const result = await engine.tick({ limit: 5 });
  assert.ok(result.checked >= 1);
  const row = repo.db.prepare('SELECT ocr_text, ocr_at FROM media WHERE id = ?').get(id);
  assert.equal(row.ocr_text, 'ONLY THE WORDS');
  assert.ok(row.ocr_at);
  const again = await engine.tick({ limit: 5 });
  assert.equal(again.checked, 0, 'a read picture is not picked again');
});

test('a failed fetch is marked once and not retried', async () => {
  ocr._setRecognize(async () => 'never called');
  net.fetchBuffer = async () => { throw new Error('origin gone'); };
  const id = insert(3);
  await engine.tick({ limit: 5 });
  const row = repo.db.prepare('SELECT ocr_text, ocr_at FROM media WHERE id = ?').get(id);
  assert.equal(row.ocr_text, null);
  assert.ok(row.ocr_at);
  assert.equal((await engine.tick({ limit: 5 })).checked, 0);
});

test('the OCR switch off makes the sweep a no-op', async () => {
  const settings = require('../src/settings');
  const prev = settings.get().ocr;
  settings.update({ ocr: false });
  try {
    insert(4);
    const result = await engine.tick({ limit: 5 });
    assert.equal(result.off, true);
  } finally { settings.update({ ocr: prev }); }
});
