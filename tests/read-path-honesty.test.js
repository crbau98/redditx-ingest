'use strict';
/**
 * Blueprint Phase 5: the admin overview's daily ingest chart reads an index (v34) instead of scanning all media, the
 * maintenance progress counts are cached for 60 s, and the thumbnail progress says what it counts and when it will finish.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
let repo; let schema; let maintenance; let thumbs;
before(() => {
  repo = require('../src/db/repo');
  schema = require('../src/db/schema');
  maintenance = require('../src/engine/maintenance');
  thumbs = require('../src/engine/thumbs');
});

test('v34 is additive DDL only: one CREATE INDEX IF NOT EXISTS, marked ddlOnly', () => {
  const v34 = schema.MIGRATIONS[33];
  assert.equal(v34.name, 'v34');
  assert.equal(v34.ddlOnly, true);
  const src = v34.toString();
  assert.match(src, /CREATE INDEX IF NOT EXISTS ix_media_ingested_plat ON media\(ingested_at, platform\)/);
  assert.doesNotMatch(src, /\b(DROP|DELETE|UPDATE|ALTER|INSERT)\b/i);
  assert.ok(repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_media_ingested_plat'").get());
});

test('the daily ingest chart searches the new index with a full ISO start, never scans media', () => {
  const since = repo._ingestDaily.since(Date.parse('2026-11-11T15:30:00Z'));
  assert.equal(since, '2026-10-28T00:00:00.000Z');
  const plan = repo.db.prepare(`EXPLAIN QUERY PLAN ${repo._ingestDaily.sql}`).all(since).map((r) => r.detail).join(' | ');
  assert.match(plan, /SEARCH media USING (COVERING )?INDEX ix_media_ingested_plat \(ingested_at>\?\)/, plan);
  assert.doesNotMatch(plan, /SCAN media(?! USING)/, plan);
  // and the overview still answers
  assert.ok(Array.isArray(repo.adminOverview().ingestDaily));
});

test('progress counts are cached for 60 s and recomputed after that', () => {
  let now = 1_000_000;
  maintenance._progressCache.clear();
  maintenance._progressCache.setClock(() => now);
  try {
    const insert = (i) => repo.media.insert({ platform: 'reddit', source_id: `pc${i}`, source_key: `reddit:pc${i}:0`, post_key: `reddit:pc${i}`, author: 'pc', media_type: 'image', media_url: `https://i.redd.it/pc${i}.jpg`, hash: `pch${i}` }, []);
    insert(1);
    const first = maintenance.faceSweepProgress().remaining;
    insert(2);
    now += 30_000;
    assert.equal(maintenance.faceSweepProgress().remaining, first, 'within 60 s: the cached count');
    now += maintenance._progressCache.ttlMs;
    assert.equal(maintenance.faceSweepProgress().remaining, first + 1, 'after 60 s: recomputed');
    // a different cursor is a different question, never served from another cursor's answer
    const a = maintenance.hashSweepProgress();
    repo.settings.set('hash_sweep_seq', '999999999');
    assert.equal(maintenance.hashSweepProgress().remaining, 0);
    assert.ok(a.remaining >= 2);
  } finally { maintenance._progressCache.setClock(null); maintenance._progressCache.clear(); repo.settings.set('hash_sweep_seq', '0'); }
});

test('thumbnails: the never-tinted queue and the no-thumbnail count are separate, and the ETA uses the scaled rate', () => {
  thumbs._clearNoThumb();
  let n = 0;
  const insert = (extra) => {
    n++;
    const id = repo.media.insert({ platform: 'reddit', source_id: `th${n}`, source_key: `reddit:th${n}:0`, post_key: `reddit:th${n}`, author: 'th', media_type: 'image', media_url: `https://i.redd.it/th${n}.jpg`, hash: `thh${n}` }, []);
    if (extra) repo.db.prepare('UPDATE media SET tint = ?, thumb_url = ? WHERE id = ?').run(extra.tint, extra.thumb_url, id);
  };
  const base = thumbs.progress({ perMinute: 10 });
  insert(null);                                // never tinted, no thumbnail
  insert({ tint: '', thumb_url: null });       // given up on: tinted, still no thumbnail
  insert({ tint: '#112233', thumb_url: 'https://cdn.example/t.webp' });
  thumbs._clearNoThumb();
  const p = thumbs.progress({ perMinute: 10 });
  assert.equal(p.remaining - base.remaining, 1, 'remaining counts rows never tinted');
  assert.equal(p.noThumbUrl - base.noThumbUrl, 2, 'noThumbUrl counts every published row without a thumbnail');
  // small backlog: calm rate (10 a round, every 75 s = 8/min)
  assert.equal(p.rate.scale, 1);
  assert.equal(p.rate.perRound, 10);
  assert.equal(p.rate.effectivePerMinute, 8);
  assert.equal(p.etaMinutes, Math.ceil(p.remaining / 8));
  assert.equal(thumbs.progress({ perMinute: 0 }).etaMinutes, p.remaining ? null : 0, 'off: no ETA');
});

test('thumbnails: a large backlog uses the 6x scaler (capped at 240 a round) for the ETA', () => {
  // the scaler math, through the public numbers: 100 000 rows waiting at 30/min -> 180 a round -> 144/min
  const scaleFor = (r) => (r > 50000 ? 6 : r > 5000 ? 3 : 1);
  assert.equal(Math.min(Math.round(30 * scaleFor(100000)), 240), 180);
  assert.equal(Math.min(Math.round(60 * scaleFor(100000)), 240), 240, 'never above the ceiling');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'engine', 'thumbs.js'), 'utf8');
  assert.match(src, /const scaleFor = \(remaining\) => \(remaining > 50000 \? 6 : remaining > 5000 \? 3 : 1\)/, 'the progress ETA and the sweep share one scaler');
  assert.match(src, /limit: perRound\(s\.thumbnailsPerMinute, remaining\)/);
});
