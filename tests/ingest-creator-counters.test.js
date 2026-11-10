'use strict';
/**
 * creators.media_count / video_count / total_score / last_media_at and tags.usage_count must equal what is really in the tables.
 * Every writer in the app keeps them (repo.media.insert/setState/update/block, creators.block/merge, takedowns); the boot-time
 * reconciliation used a second, different formula (total_score over EVERY state, no last_media_at).
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let repo; let engine;
let n = 0;

before(() => {
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
});

function creator(handle) { return repo.creators.create({ handle: handle || `ctr${++n}`, origin: 'admin' }); }
function media(c, { state = 'published', type = 'image', score = 1, postedAt = new Date().toISOString(), tags = [] } = {}) {
  const id = repo.media.insert({
    creator_id: c.id, platform: 'rss', source_id: `s${++n}`, source_key: `rss:c${n}:0`, post_key: `rss:c${n}`, media_type: type,
    media_url: `https://img.example/${n}.${type === 'video' ? 'mp4' : 'jpg'}`, hash: crypto.createHash('md5').update(`c${n}`).digest('hex'),
    score, posted_at: postedAt, publish_state: state,
  }, tags);
  return id;
}

/** Counters stored vs counters recomputed from the media table, for every creator. */
function drift() {
  return repo.db.prepare(`SELECT c.handle, c.media_count AS mc, c.video_count AS vc, c.total_score AS ts, c.last_media_at AS lm,
      (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published') AS rmc,
      (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published' AND m.media_type = 'video') AS rvc,
      (SELECT COALESCE(SUM(score), 0) FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published') AS rts,
      (SELECT MAX(posted_at) FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published') AS rlm
    FROM creators c`).all().filter((r) => r.mc !== r.rmc || r.vc !== r.rvc || r.ts !== r.rts || (r.lm || null) !== (r.rlm || null));
}
function tagDrift() {
  return repo.db.prepare('SELECT t.name, t.usage_count AS u, (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id) AS r FROM tags t').all().filter((r) => r.u !== r.r);
}

test('the counters hold through every writer: insert, state changes, edits, blocks, merges, takedowns', () => {
  const a = creator(); const b = creator(); const c = creator();
  const m1 = media(a, { score: 5, tags: ['alpha', 'beta'] }); const m2 = media(a, { type: 'video', score: 7, tags: ['alpha'] }); const m3 = media(a, { state: 'review', score: 100 });
  media(b, { score: 2 }); media(b, { score: 3, tags: ['beta'] }); media(c, { score: 4 });
  assert.deepEqual(drift(), [], 'after inserts');
  repo.media.setState(m3, 'published'); assert.deepEqual(drift(), [], 'review -> published');
  repo.media.setState(m1, 'hidden', 'junk'); assert.deepEqual(drift(), [], 'published -> hidden');
  repo.media.update(m2, { publish_state: 'review' }); assert.deepEqual(drift(), [], 'update() state');
  repo.media.block(m3, 'test'); assert.deepEqual(drift(), [], 'block()');
  repo.creators.merge(b.id, c.id); assert.deepEqual(drift(), [], 'merge');
  repo.creators.block(b.id, 'test'); assert.deepEqual(drift(), [], 'creators.block');
  const d = creator(); media(d, { score: 9 }); repo.takedowns.add({ kind: 'creator', value: d.handle, reason: 'test' });
  assert.deepEqual(drift(), [], 'takedown');
});

test('tags.usage_count equals its media_tags rows (the v23 triggers), also when media rows are deleted and links re-added', () => {
  const x = creator();
  const m = media(x, { tags: ['gym', 'selfie', 'gym'] });
  assert.deepEqual(tagDrift(), []);
  repo.db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT ?, id FROM tags WHERE name = ?').run(m, 'gym');
  assert.deepEqual(tagDrift(), [], 'a link that already exists is not counted twice');
  repo.db.prepare('DELETE FROM media WHERE id = ?').run(m);
  assert.deepEqual(tagDrift(), [], 'the cascade from a deleted media row decrements');
});

test('a published insert adds that one row, an older post does not rewind the date, and a duplicate adds nothing', () => {
  const x = creator();
  media(x, { score: 4, postedAt: '2026-06-01T00:00:00.000Z' });
  media(x, { type: 'video', score: 6, postedAt: '2026-05-01T00:00:00.000Z' });
  const mid = repo.creators.get(x.id);
  assert.equal(mid.media_count, 2);
  assert.equal(mid.video_count, 1);
  assert.equal(mid.total_score, 10);
  assert.equal(mid.last_media_at, '2026-06-01T00:00:00.000Z', 'an older post stays behind the newer one');
  const hash = crypto.createHash('md5').update('bump-dup').digest('hex');
  const first = repo.media.insert({
    creator_id: x.id, platform: 'rss', source_id: 'bump', source_key: 'rss:bump:0', post_key: 'rss:bump', media_type: 'image',
    media_url: 'https://img.example/bump.jpg', hash, score: 8, posted_at: '2026-07-01T00:00:00.000Z', publish_state: 'published',
  });
  const dup = repo.media.insert({
    creator_id: x.id, platform: 'rss', source_id: 'bump', source_key: 'rss:bump:0', post_key: 'rss:bump', media_type: 'image',
    media_url: 'https://img.example/bump.jpg', hash, score: 80, posted_at: '2026-08-01T00:00:00.000Z', publish_state: 'published',
  });
  assert.ok(first);
  assert.equal(dup, null);
  const row = repo.creators.get(x.id);
  assert.equal(row.media_count, 3);
  assert.equal(row.total_score, 18);
  assert.equal(row.last_media_at, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(drift().filter((r) => r.handle === x.handle), []);
});

test('the boot-time recount uses the same counters: published items only, and last_media_at', async () => {
  const x = creator();
  media(x, { score: 5, postedAt: '2026-01-02T00:00:00.000Z' });
  media(x, { type: 'video', score: 5, postedAt: '2026-03-04T00:00:00.000Z' });
  media(x, { state: 'hidden', score: 1000, postedAt: '2026-09-09T00:00:00.000Z' });
  media(x, { state: 'review', score: 1000, postedAt: '2026-09-09T00:00:00.000Z' });
  repo.db.prepare('UPDATE creators SET media_count = 99, video_count = 99, total_score = 99, last_media_at = NULL WHERE id = ?').run(x.id);
  await engine.backfillCreatorStats(repo.db);
  const row = repo.creators.get(x.id);
  assert.equal(row.media_count, 2); assert.equal(row.video_count, 1);
  assert.equal(row.total_score, 10, 'hidden and in-review items are not in the total');
  assert.equal(row.last_media_at, '2026-03-04T00:00:00.000Z');
  assert.deepEqual(drift(), []);
});

test('the boot-time recount does not mark every creator as just updated', async () => {
  const x = creator();
  repo.db.prepare("UPDATE creators SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(x.id);
  await engine.backfillCreatorStats(repo.db);
  assert.equal(repo.creators.get(x.id).updated_at, '2020-01-01T00:00:00.000Z');
});
