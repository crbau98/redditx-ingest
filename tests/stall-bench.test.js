'use strict';
/** scripts/stall-bench.js: the stall scenarios must run small, measure honestly, and clean up. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const bench = require('../scripts/stall-bench.js');

describe('stall-bench', () => {
  let repo; let cleanup;

  before(async () => {
    ({ repo, cleanup } = await bench.env(3000));
  });
  after(() => { if (cleanup) cleanup(); });

  test('the bench database exists at the requested size', () => {
    const n = repo.db.prepare('SELECT COUNT(*) AS n FROM media').get().n;
    assert.equal(n, 3000);
  });

  test('control: small writes alone barely block the loop and never fail', async () => {
    const r = await bench.scenario('control', repo, { writeMs: 5, durationMs: 600 });
    assert.equal(r.scenario, 'control');
    assert.ok(r.writes > 20, `expected many writes, got ${r.writes}`);
    assert.equal(r.fails, 0);
    assert.equal(r.firstErr, null);
    assert.ok(r.worstMs < 500, `worst write block ${r.worstMs} ms`);
    assert.ok(r.loop.max < 1000, `loop max ${r.loop.max} ms`);
  });

  test('leanBias: one tick judges the whole chunk, biases the worded rows, and stays fast', async () => {
    const r = await bench.scenario('leanBias', repo);
    assert.equal(r.judged, 3000);
    // two of the three seeded wordings bias; the neutral wording stays NULL
    assert.equal(r.biased, 2000);
    assert.ok(r.wallMs < 1000, `tick wall ${r.wallMs} ms`);
  });

  test('workerHot: the worker rewrites exactly the stale rows and no main write waits on busy', async () => {
    // back to the deploy moment: biases stored, hot stale for every row
    repo.db.exec(`UPDATE media SET lean_bias = CASE WHEN title LIKE '%gym%' OR title LIKE '%shredded%' THEN 1.3 WHEN title LIKE '%bear%' OR title LIKE '%dad bod%' THEN 0.7 ELSE NULL END`);
    repo.db.exec(`UPDATE media SET hot = hot_score(score, likes, views, epoch_ms(posted_at), strftime('%s','now') * 1000) WHERE publish_state = 'published'`);
    const r = await bench.scenario('workerHot', repo);
    assert.ok(r.updated >= 2000 && r.updated <= 2003, `updated ${r.updated}: the biased rows plus, at most, a neutral row drifting past the 2% tolerance while the bench ran`);
    assert.equal(r.fails, 0);
    assert.equal(r.firstErr, null);
    assert.ok(r.worstMs < 2000, `worst main write during refresh ${r.worstMs} ms`);
    const stale = repo.db.prepare(`SELECT COUNT(*) AS n FROM media WHERE publish_state = 'published'
      AND abs(hot - hot_score(score, likes, views, epoch_ms(posted_at), strftime('%s','now') * 1000) * COALESCE(lean_bias, 1.0)) > 0.02 * hot_score(score, likes, views, epoch_ms(posted_at), strftime('%s','now') * 1000) * COALESCE(lean_bias, 1.0)`).get().n;
    assert.ok(stale < 50, `${stale} rows left stale after the refresh`);
  });
});
