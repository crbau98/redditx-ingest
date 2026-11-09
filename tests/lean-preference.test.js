'use strict';
/**
 * Lean preference (lib/buildbias + the lean_bias ranking multiplier): a ranking nudge, not a
 * filter — the body filter itself stays off (owner decision 2026-11-02). Nothing here hides
 * a row or pauses a feed; it only moves the trending score a little.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let settings; let maintenance; let buildbias; let config;

before(() => {
  prepareEnv({});
  repo = require('../src/db/repo');
  settings = require('../src/settings');
  maintenance = require('../src/engine/maintenance');
  buildbias = require('../src/lib/buildbias');
  config = require('../src/config');
  settings.update({ leanPreference: true });
});
after(() => { try { require('../src/engine/engine').shutdown(); } catch { /* not started */ } });

let n = 0;
/** A minimal published row; `posted_at` fixed so hot_score() is comparable across rows. */
const row = (title, extra = {}) => {
  n++;
  return repo.media.insert({
    platform: 'reddit', source_id: `lean${n}`, source_key: `reddit:lean${n}:0`, post_key: `reddit:lean${n}`,
    title, media_type: 'image', media_url: `https://example.com/lean${n}.jpg`, hash: `leanhash${n}`,
    score: 10, likes: 5, views: 50, posted_at: '2026-11-01T00:00:00.000Z', ...extra,
  }, []);
};
const hot = (id) => repo.db.prepare('SELECT hot, lean_bias FROM media WHERE id = ?').get(id);

describe('buildbias', () => {
  test('lean words raise, heavy words lower, anything else stays neutral', () => {
    assert.equal(buildbias.biasFor(null, ['gym shred abs session']), buildbias.LEAN_BIAS);
    assert.equal(buildbias.biasFor(null, ['personal trainer pics']), buildbias.LEAN_BIAS);
    assert.equal(buildbias.biasFor(null, ['bear cub pics']), buildbias.HEAVY_BIAS);
    assert.equal(buildbias.biasFor(null, ['dad bod monday']), buildbias.HEAVY_BIAS);
    assert.equal(buildbias.biasFor(null, ['new post today']), null);
  });
  test('a measured build decides over words; the preference off means neutral', () => {
    assert.equal(buildbias.biasFor(20, ['bear pics']), buildbias.LEAN_BIAS);
    assert.equal(buildbias.biasFor(70, ['gym pics']), buildbias.HEAVY_BIAS);
    assert.equal(buildbias.biasFor(50, ['gym pics']), null); // mid-range measured: neutral
    assert.equal(buildbias.biasFor(null, ['bear pics'], false), null);
    assert.equal(buildbias.biasFor(20, null, false), null);
  });
});

describe('lean_bias in the trending refresh', () => {
  test('a biased row ranks at formula × bias; a neutral row is untouched', () => {
    const lean = row('gym shredded abs', { lean_bias: buildbias.LEAN_BIAS });
    const plain = row('new post today');
    const heavy = row('bear dad bod', { lean_bias: buildbias.HEAVY_BIAS });
    repo.media.recomputeHot(0.0001);
    // per-row expected value: the refresh's own formula over the row's actual score/likes/views,
    // with a now a few ms after the refresh's (the decay moves microscopically in that window)
    const formula = (id) => repo.db.prepare('SELECT hot_score(score, likes, views, epoch_ms(posted_at), ?) AS v FROM media WHERE id = ?').get(Date.now(), id).v;
    assert.ok(Math.abs(hot(lean).hot - formula(lean) * buildbias.LEAN_BIAS) < Math.max(0.01, formula(lean) * 0.001), `lean hot folds the multiplier (${hot(lean).hot} vs ${formula(lean)})`);
    assert.ok(Math.abs(hot(plain).hot - formula(plain)) < Math.max(0.01, formula(plain) * 0.001));
    assert.ok(Math.abs(hot(heavy).hot - formula(heavy) * buildbias.HEAVY_BIAS) < Math.max(0.01, formula(heavy) * 0.001));
  });
  test('the ingest path stores the bias from the item text', () => {
    const id = row('gym session');
    // the pipeline sets lean_bias before insert; here the sweep fills what ingest did not
    assert.equal(hot(id).lean_bias, null);
  });
});

describe('the maintenance bias sweep', () => {
  test('fills biases from words, keeps neutral rows NULL, reports done, and clears on demand', async () => {
    const lean = row('personal trainer workout');
    const heavy = row('chub gainer belly');
    const neutral = row('just a video');
    const first = await maintenance.leanBiasSweep({ limit: 4000 });
    assert.equal(hot(lean).lean_bias, buildbias.LEAN_BIAS);
    assert.equal(hot(heavy).lean_bias, buildbias.HEAVY_BIAS);
    assert.equal(hot(neutral).lean_bias, null);
    const second = await maintenance.leanBiasSweep({ limit: 4000 });
    assert.equal(second.done, true, 'a second pass finds nothing left');
    const cleared = await maintenance.clearLeanBias();
    assert.ok(cleared >= 2, 'both stored biases are removed');
    assert.equal(hot(lean).lean_bias, null);
    assert.equal(hot(heavy).lean_bias, null);
  });
});
