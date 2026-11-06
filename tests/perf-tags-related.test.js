'use strict';
/**
 * Tag co-occurrence (tags/related) pins its results: the base set is found from the tag side, and the answer
 * must not change. Covers all-tags and any-tags, unknown tags, and that unpublished / excluded media is left out.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const { db } = repo;

const mk = (i, tags, extra = {}) => repo.media.insert({
  platform: 'reddit', source_id: `tr${i}`, source_key: `tr:${i}:0`, post_key: `tr:${i}`, community: 'tagfixture',
  author: 'tester', title: `Tag fixture ${i}`, media_type: 'image', media_url: `https://i.redd.it/tr${i}.jpg`,
  hash: `trh${i}`, score: 1, posted_at: new Date().toISOString(), ...extra,
}, tags);
const idOf = (i) => db.prepare('SELECT id FROM media WHERE source_key = ?').get(`tr:${i}:0`).id;

mk(1, ['alpha', 'beta', 'gamma']);
mk(2, ['alpha', 'beta']);
mk(3, ['alpha', 'gamma']);
mk(4, ['alpha', 'beta', 'gamma'], {});        // published: counts as a base member
mk(5, ['beta', 'gamma']);
mk(6, ['alpha', 'beta', 'delta'], {});         // will be made excluded below
mk(7, ['alpha', 'beta', 'gamma']);
for (let i = 8; i < 20; i++) mk(i, ['zz']); // filler: dilutes the library totals so real co-occurrence clears the lift cut-off
db.prepare("UPDATE media SET publish_state = 'review' WHERE id = ?").run(idOf(4));
db.prepare("UPDATE media SET scope = 'excluded' WHERE id = ?").run(idOf(6));

const lib = () => ({
  total: db.prepare("SELECT COUNT(*) n FROM media WHERE publish_state = 'published'").get().n,
  tagCount: new Map(db.prepare('SELECT t.name, COUNT(*) n FROM media_tags mt JOIN tags t ON t.id = mt.tag_id GROUP BY t.id').all().map((r) => [r.name, r.n])),
});

describe('tag co-occurrence', () => {
  test('all listed tags: the base set is the published items that carry every tag', () => {
    const out = repo.tagIntel.relatedUncached(['alpha', 'beta'], 12, true, lib());
    // published with alpha+beta: items 1, 2, 7 (4 is in review, 6 is excluded); gamma is on 1 and 7: co-occurrence 2
    const gamma = out.find((r) => r.name === 'gamma');
    assert.ok(gamma, 'gamma co-occurs twice');
    assert.equal(gamma.count, 2);
    assert.equal(out.find((r) => r.name === 'delta'), undefined, 'excluded item contributes nothing');
    assert.ok(!out.some((r) => r.name === 'alpha' || r.name === 'beta'), 'the listed tags are not returned');
  });

  test('an unknown tag in all-mode gives an empty answer', () => {
    assert.deepEqual(repo.tagIntel.relatedUncached(['alpha', 'nosuchtag'], 12, true, lib()), []);
  });

  test('any-mode: the base set is the published items with at least one listed tag', () => {
    const out = repo.tagIntel.relatedUncached(['delta', 'beta'], 12, false, lib());
    // base: items with delta or beta, published, not excluded: 1, 2, 5, 7 (6 excluded, 4 in review)
    const alpha = out.find((r) => r.name === 'alpha');
    assert.ok(alpha, 'alpha co-occurs with beta in the base');
    assert.equal(alpha.count, 3, 'alpha is on items 1, 2 and 7');
  });
});
