'use strict';
/**
 * Newest-first face enrolment: one pass stores male descriptors and marks the picture done; a second
 * pass skips it. The model call is mocked so no image or TensorFlow runtime is needed.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let maintenance; let imagefilter;

before(() => {
  prepareEnv({});
  repo = require('../src/db/repo');
  maintenance = require('../src/engine/maintenance');
  imagefilter = require('../src/lib/imagefilter');
});

after(() => { /* monkeypatches die with the process */ });

const insert = (n) => repo.media.insert({
  creator_id: null, platform: 'reddit', source_id: `fs${n}`, source_key: `reddit:fs${n}:0`, post_key: `reddit:fs${n}`,
  author: 'face_author', title: null, media_type: 'image', media_url: `https://media.example/fs${n}.jpg`,
  preview_url: `https://media.example/fs${n}-small.jpg`, hash: `fshash${n}`, source_url: `https://example.com/fs${n}`,
  posted_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
}, []);

test('the migration adds face_at', () => {
  const cols = repo.db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  assert.ok(cols.includes('face_at'));
});

test('a face sweep enrols a male descriptor, marks the picture, and does not repeat it', async () => {
  const id = insert(1);
  let calls = 0;
  imagefilter.checkItem = async () => {
    calls++;
    return { status: 'ok', female: false, faceList: [{ gender: 'male', confidence: 0.9, embedding: [0.1, 0.2, 0.3, 0.4] }], phash: null };
  };
  const first = await maintenance.faceSweep({ limit: 5 });
  assert.ok(first.checked >= 1);
  assert.ok(first.enrolled >= 1);
  const row = repo.db.prepare('SELECT face_at FROM media WHERE id = ?').get(id);
  assert.ok(row.face_at);
  assert.ok(repo.db.prepare('SELECT COUNT(*) AS n FROM media_faces WHERE media_id = ?').get(id).n >= 1);
  const before = calls;
  const second = await maintenance.faceSweep({ limit: 5 });
  assert.equal(calls, before, 'a marked picture is not analysed again');
  assert.equal(second.checked, 0);
});

test('the sweep is off when face matching is off', async () => {
  const settings = require('../src/settings');
  const prev = settings.get().faceMatch;
  settings.update({ faceMatch: false });
  try {
    const r = await maintenance.faceSweep({ limit: 5 });
    assert.equal(r.off, true);
  } finally { settings.update({ faceMatch: prev }); }
});
