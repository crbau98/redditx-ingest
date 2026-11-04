'use strict';
/**
 * Library data integrity: a removed item keeps no content identifiers (embeddings, hashes, URLs), the
 * audit trail and blocklists stay, published rows are never touched, and counters are right on write.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const { db } = require('../src/db');
const repo = require('../src/db/repo');
const visual = require('../src/engine/visual');
const { MIGRATIONS } = require('../src/db/schema');

const PHASH = 'ff00ff00ff00ff00';
const mk = (i, extra = {}) => ({
  platform: 'reddit', source_id: `q${i}`, source_key: `reddit:q${i}:0`, post_key: `reddit:q${i}`, community: 'testsub',
  author: 'tester', title: `Item ${i} gym`, media_type: 'image', media_url: `https://i.redd.it/q${i}.jpg`,
  preview_url: `https://i.redd.it/q${i}-p.jpg`, thumbnail_url: `https://i.redd.it/q${i}-t.jpg`, hash: `qh${i}`,
  score: i * 10, posted_at: new Date(Date.now() - i * 3600000).toISOString(), ...extra,
});
const hasEmbedding = (id) => !!db.prepare('SELECT 1 FROM media_embeddings WHERE media_id = ?').get(id);
const identifiers = (id) => db.prepare('SELECT phash, hash, media_url, preview_url, thumbnail_url, thumb_url, hls_url, tint FROM media WHERE id = ?').get(id);
const addEmbedding = (id) => { visual.ensureTable(); db.prepare("INSERT OR REPLACE INTO media_embeddings (media_id, model, vec) VALUES (?, 'test', x'00')").run(id); };
const ids = (list) => list.items.map((m) => m.id);
const idOf = (sourceKey) => db.prepare('SELECT id FROM media WHERE source_key = ?').get(sourceKey).id;

describe('removing content purges its identifiers', () => {
  let creator; let innocent; let victim; let sibling; let keep;
  before(() => {
    creator = repo.creators.create({ handle: 'takedown_target', display_name: 'Takedown Target' });
    innocent = repo.creators.create({ handle: 'innocent_bro', display_name: 'Innocent' });
    repo.media.insert(mk(1, { creator_id: creator.id, phash: PHASH }), ['gym']);
    repo.media.insert(mk(2, { creator_id: creator.id, phash: 'aa11aa11aa11aa11' }), ['gym']);
    repo.media.insert(mk(3, { creator_id: innocent.id, phash: 'bb22bb22bb22bb22' }), ['gym']);
    victim = idOf('reddit:q1:0'); sibling = idOf('reddit:q2:0'); keep = idOf('reddit:q3:0');
    for (const id of [victim, sibling, keep]) addEmbedding(id);
  });

  test('a takedown removes the item and leaves no embedding, phash, hash or URL behind', () => {
    const before = identifiers(victim);
    assert.ok(before.phash && before.media_url && hasEmbedding(victim));
    const td = repo.takedowns.add({ kind: 'url', value: 'https://i.redd.it/q1.jpg', reason: 'opt-out' });
    assert.ok(td.purged >= 1, 'takedown reports the purge');
    const row = repo.media.get(victim);
    assert.equal(row.publish_state, 'removed');
    assert.equal(row.review_reason, 'takedown', 'audit trail: the reason stays');
    assert.equal(hasEmbedding(victim), false, 'no embedding');
    const after = identifiers(victim);
    assert.equal(after.phash, null, 'no phash');
    assert.match(after.hash, /^purged:/, 'no real hash');
    assert.notEqual(after.hash, before.hash);
    for (const col of ['media_url', 'preview_url', 'thumbnail_url', 'thumb_url', 'hls_url', 'tint']) {
      assert.ok(!after[col], `${col} cleared`);
    }
    assert.ok(repo.blocklist.has('hash', before.hash), 'the blocklist still holds the hash');
    assert.equal(repo.media.phashBlocked().includes(PHASH), true, 'the phash blocklist still holds the phash');
  });

  test('the purged item is still excluded from every public read', () => {
    assert.ok(!ids(repo.media.list({ limit: 200 })).includes(victim));
    assert.ok(!ids(repo.media.list({ q: 'gym', limit: 200 })).includes(victim));
    assert.equal(repo.media.get(victim).publish_state, 'removed');
  });

  test('published rows are not changed by a takedown', () => {
    const row = identifiers(keep);
    assert.equal(repo.media.get(keep).publish_state, 'published');
    assert.equal(row.phash, 'bb22bb22bb22bb22');
    assert.ok(row.media_url && row.hash === `qh3`);
    assert.equal(hasEmbedding(keep), true);
  });

  test('blocking a creator purges every item of that creator, including ones removed earlier', () => {
    repo.creators.block(creator.id, 'creator opt-out', 'admin');
    const s = identifiers(sibling);
    assert.equal(repo.media.get(sibling).publish_state, 'removed');
    assert.equal(hasEmbedding(sibling), false);
    assert.equal(s.phash, null);
    assert.match(s.hash, /^purged:/);
    assert.equal(repo.media.phashBlocked().includes('aa11aa11aa11aa11'), true, 'the creator block still blocks the picture');
    assert.ok(!ids(repo.media.list({ limit: 200 })).includes(sibling));
  });

  test('blocking one item removes its identifiers and keeps its state', () => {
    repo.media.insert(mk(4, { creator_id: innocent.id, phash: 'cc33cc33cc33cc33' }), ['gym']);
    const fresh = idOf('reddit:q4:0');
    addEmbedding(fresh);
    repo.media.block(fresh, 'bad image', 'admin');
    assert.equal(repo.media.get(fresh).publish_state, 'removed');
    assert.equal(hasEmbedding(fresh), false);
    assert.equal(identifiers(fresh).phash, null);
    assert.equal(repo.media.phashBlocked().includes('cc33cc33cc33cc33'), true);
  });

  test('the v22 migration clears identifiers already on removed rows and keeps the published ones', () => {
    repo.media.insert(mk(5, { creator_id: innocent.id, phash: 'dd44dd44dd44dd44', hash: 'legacyhash5' }), ['gym']);
    const old = idOf('reddit:q5:0');
    db.prepare("UPDATE media SET publish_state = 'removed', review_reason = 'legacy' WHERE id = ?").run(old);
    addEmbedding(old);
    MIGRATIONS[21](db);
    assert.equal(hasEmbedding(old), false);
    assert.equal(identifiers(old).phash, null);
    assert.equal(identifiers(old).media_url, '');
    assert.equal(repo.blocklist.has('hash', 'legacyhash5'), true);
    assert.equal(repo.media.phashBlocked().includes('dd44dd44dd44dd44'), true);
    assert.equal(repo.media.get(keep).publish_state, 'published');
    assert.equal(hasEmbedding(keep), true);
  });
});

describe('counters are right on write and repaired once', () => {
  const tagUsage = (name) => db.prepare('SELECT usage_count FROM tags WHERE name = ?').get(name)?.usage_count;
  const tagRows = (name) => db.prepare('SELECT COUNT(*) AS n FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = ?').get(name).n;
  const counts = (cid) => db.prepare('SELECT media_count, video_count, total_score FROM creators WHERE id = ?').get(cid);

  test('a new item counts toward its creator at once, and state changes move the count', () => {
    const c = repo.creators.create({ handle: 'counter_bro', display_name: 'Counter' });
    repo.media.insert(mk(20, { creator_id: c.id, source_key: 'reddit:c20:0', score: 7 }), ['gym']);
    repo.media.insert(mk(21, { creator_id: c.id, source_key: 'reddit:c21:0', score: 5, media_type: 'video', media_url: 'https://v.redd.it/x.mp4' }), ['gym']);
    assert.deepEqual(counts(c.id), { media_count: 2, video_count: 1, total_score: 12 });
    repo.media.setState(idOf('reddit:c20:0'), 'hidden', 'test');
    assert.deepEqual(counts(c.id), { media_count: 1, video_count: 1, total_score: 5 });
  });

  test('tags.usage_count follows the media_tags rows, including deletes', () => {
    repo.media.insert(mk(22, { source_key: 'reddit:c22:0' }), ['youtubetest']);
    repo.media.insert(mk(23, { source_key: 'reddit:c23:0' }), ['youtubetest']);
    assert.equal(tagUsage('youtubetest'), 2);
    assert.equal(tagUsage('youtubetest'), tagRows('youtubetest'));
    db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(idOf('reddit:c22:0'));
    assert.equal(tagUsage('youtubetest'), 1);
  });

  test('the v23 migration repairs counters that were already wrong, and leaves correct ones alone', () => {
    const c = repo.creators.create({ handle: 'drifted_bro', display_name: 'Drifted' });
    repo.media.insert(mk(24, { creator_id: c.id, source_key: 'reddit:c24:0', score: 3 }), ['gym']);
    db.prepare('UPDATE creators SET media_count = 0, video_count = 9, total_score = 1 WHERE id = ?').run(c.id);
    db.prepare("UPDATE tags SET usage_count = 500 WHERE name = 'youtubetest'").run();
    MIGRATIONS[22](db);
    assert.deepEqual(counts(c.id), { media_count: 1, video_count: 0, total_score: 3 });
    assert.equal(tagUsage('youtubetest'), 1);
    assert.equal(tagUsage('youtubetest'), tagRows('youtubetest'));
  });
});
