'use strict';
/** The trending refresh is one statement (db/functions.js), used by repo.media.recomputeHot* and engine/backup-worker.js. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const fns = require('../src/db/functions');

test('repo.media.recomputeHot and recomputeHotChunked prepare exactly the exported statements', async () => {
  const seen = [];
  const real = repo.db.prepare.bind(repo.db);
  repo.db.prepare = (sql) => { if (/^UPDATE media SET hot/.test(sql)) seen.push(sql); return real(sql); };
  try {
    repo.media.recomputeHot();
    await repo.media.recomputeHotChunked();
  } finally { repo.db.prepare = real; }
  assert.ok(seen.includes(fns.HOT_UPDATE_SQL), 'recomputeHot uses HOT_UPDATE_SQL');
  assert.ok(seen.every((s) => s === fns.HOT_UPDATE_SQL || s === fns.HOT_UPDATE_RANGE_SQL), 'no other hot UPDATE text is built');
});

test('the backup worker builds the same range statement, with no copy of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'backup-worker.js'), 'utf8');
  assert.match(src, /db\.prepare\(require\('\.\.\/db\/functions'\)\.HOT_UPDATE_RANGE_SQL\)/);
  assert.doesNotMatch(src, /UPDATE media SET hot/);
  assert.match(src, /require\('\.\.\/db\/functions'\)\.hotScore\(db\)/, 'and still registers hot_score on its own connection');
  const media = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'repos', 'media.js'), 'utf8');
  assert.doesNotMatch(media, /UPDATE media SET hot/);
});

test('the range statement is the full statement plus the rowid range', () => {
  assert.equal(fns.HOT_UPDATE_RANGE_SQL.replace('seq > @from AND seq <= @to AND ', ''), fns.HOT_UPDATE_SQL);
});
