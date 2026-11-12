'use strict';
/**
 * The ten-minute hot refresh must not hold SQLite's write lock while it scores rows.
 * The worker reads drifted rows, writes them in short batches, and will not start a second worker.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const { recomputeHot } = require('../src/engine/backup-worker');
const backup = require('../src/engine/backup');

let n = 0;
function add(extra = {}) {
  n += 1;
  const id = repo.media.insert({
    platform: 'web', source_id: `hw${n}`, source_key: `web:hw${n}:0`, post_key: `web:hw${n}`, author: 'a',
    media_type: 'image', media_url: `https://example.com/hw${n}.jpg`, hash: `hwh${n}`,
    score: extra.score == null ? 12 : extra.score,
    posted_at: extra.posted_at || '2026-11-01T00:00:00.000Z',
    publish_state: extra.publish_state || 'published',
  });
  repo.db.prepare('UPDATE media SET likes = ?, views = ?, lean_bias = ?, hot = ? WHERE id = ?').run(
    extra.likes || 0, extra.views || 0, extra.lean_bias == null ? null : extra.lean_bias, extra.hot == null ? 0 : extra.hot, id,
  );
  return repo.db.prepare('SELECT seq, id, hot FROM media WHERE id = ?').get(id);
}

function settle(now) {
  repo.db.prepare(`UPDATE media SET hot = hot_score(score, likes, views, epoch_ms(posted_at), ?) * COALESCE(lean_bias, 1.0)
    WHERE publish_state = 'published'`).run(now);
}

function watchTransactions() {
  let calls = 0;
  const orig = repo.db.transaction.bind(repo.db);
  repo.db.transaction = (fn) => {
    const wrapped = orig(fn);
    return (...args) => { calls += 1; return wrapped(...args); };
  };
  return { count: () => calls, restore: () => { repo.db.transaction = orig; } };
}

const scoreOf = (seq, now) => repo.db.prepare(
  'SELECT hot_score(score, likes, views, epoch_ms(posted_at), ?) * COALESCE(lean_bias, 1.0) AS h FROM media WHERE seq = ?',
).get(now, seq).h;

describe('hot worker lock', { concurrency: 1 }, () => {
  test('recomputeHot stores the score function result and batches the writes', async () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const a = add({ score: 40, likes: 8, views: 100, lean_bias: 1.25, hot: 0 });
    const b = add({ score: 5, likes: 1, views: 2, lean_bias: null, hot: 0 });
    const c = add({ score: 9, likes: 0, views: 50, hot: 0 });
    const held = add({ score: 80, likes: 10, views: 10, hot: 0, publish_state: 'review' });
    settle(now);
    for (const row of [a, b, c]) repo.db.prepare('UPDATE media SET hot = 0 WHERE seq = ?').run(row.seq);
    const watch = watchTransactions();
    try {
      const updated = await recomputeHot(repo.db, { now, writeBatch: 2 });
      assert.equal(updated, 3, 'three drifted published rows');
      assert.equal(watch.count(), 2, 'two writes of at most 2 rows, not one lock across the scan');
      assert.equal(repo.db.prepare('SELECT hot FROM media WHERE seq = ?').get(a.seq).hot, scoreOf(a.seq, now));
      assert.equal(repo.db.prepare('SELECT hot FROM media WHERE seq = ?').get(b.seq).hot, scoreOf(b.seq, now));
      assert.equal(repo.db.prepare('SELECT hot FROM media WHERE seq = ?').get(c.seq).hot, scoreOf(c.seq, now));
      assert.equal(repo.db.prepare('SELECT hot FROM media WHERE seq = ?').get(held.seq).hot, 0, 'a review row is not scored');
    } finally { watch.restore(); }
  });

  test('a chunk that has not drifted opens no write transaction', async () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    add({ score: 15, likes: 3, views: 30, lean_bias: 0.8, hot: 0 });
    settle(now);
    const before = repo.db.prepare("SELECT seq, hot FROM media WHERE publish_state = 'published' ORDER BY seq").all();
    const watch = watchTransactions();
    try {
      const updated = await recomputeHot(repo.db, { now });
      assert.equal(updated, 0);
      assert.equal(watch.count(), 0);
      const after = repo.db.prepare("SELECT seq, hot FROM media WHERE publish_state = 'published' ORDER BY seq").all();
      assert.deepEqual(after, before);
    } finally { watch.restore(); }
  });

  test('hotScore skips while any database worker is already running', async () => {
    backup._setActiveWorkers(1);
    try {
      assert.deepEqual(await backup.hotScore(), { updated: 0, skipped: true });
    } finally { backup._setActiveWorkers(0); }
    const idle = await backup.hotScore();
    assert.equal(idle.updated, 0);
    assert.equal(idle.skipped, undefined);
  });
});
