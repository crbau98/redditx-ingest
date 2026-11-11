'use strict';
/**
 * Blueprint Phase 8: the discovery ranking is a pure module (no database, no network) that discovery.js re-exports.
 * A source that names creators already followed here ranks and can be followed; a bare catalogue hit never auto-follows.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const score = require('../src/engine/discovery-score');
let discovery; let repo; let settings;
before(() => { discovery = require('../src/engine/discovery'); repo = require('../src/db/repo'); settings = require('../src/settings'); });

test('the scoring module requires nothing: no database, no network, no settings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'discovery-score.js'), 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bimport\b/);
});

test('discovery.js re-exports the same scoring function', () => {
  assert.equal(discovery.scoreOf, score.scoreOf);
});

test('a source naming followed creators outranks a bare catalogue hit', () => {
  const followed = score.scoreOf({ mention: ['creatorA', 'creatorB'] }, 'in');
  const catalogue = score.scoreOf({ directory: ['pornhub-gay'] }, 'in');
  assert.equal(catalogue, 2, 'a catalogue hit carries no weight of its own (only the scope bonus)');
  assert.equal(followed, 8);
  assert.ok(followed > catalogue);
  assert.equal(score.scoreOf({ mention: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, null), 15, 'mentions are capped at five');
  assert.equal(score.scoreOf({ identity: ['x'] }, 'excluded'), -14, 'an excluded scope sinks any signal');
});

test('merging a signal is pure and keeps a confirmed OnlyFans link over a guess', () => {
  const prev = { mention: ['a'] };
  const next = score.mergeSignal(prev, 'mention', 'b', { popularity: 250 });
  assert.deepEqual(prev, { mention: ['a'] }, 'the input is not changed');
  assert.deepEqual(next, { mention: ['a', 'b'], popularity: 250 });
  assert.deepEqual(score.mergeSignal({ onlyfans: ['h'] }, 'ofconfirmed', 'h'), { ofconfirmed: ['h'], ofsrc: 1 });
  assert.equal(score.mergeSignal({ ofconfirmed: ['h'] }, 'onlyfans', 'h'), null);
});

test('promote(): a bare catalogue hit is never followed; one that followed creators mention is', () => {
  const spec = (h) => ({ platform: 'bluesky', kind: 'user', target: `${h}.bsky.social`, label: h, ingestable: true });
  const bio = 'gay muscle jock, 18+ creator, onlyfans';
  const cat = discovery.consider(spec('catalogueonly'), 'directory', 'pornhub-gay', { displayName: 'Catalogue Only', bio });
  assert.ok(cat, 'the catalogue hit is queued');
  const a = repo.creators.create({ handle: 'followed_a', displayName: 'A' });
  const b = repo.creators.create({ handle: 'followed_b', displayName: 'B' });
  const c = repo.creators.create({ handle: 'followed_c', displayName: 'C' });
  let named;
  for (const cr of [a, b, c]) named = discovery.consider(spec('namedbyfollows'), 'mention', cr.id, { displayName: 'Named', bio });
  assert.ok(named.score > cat.score);
  const prev = settings.get();
  settings.update({ discoveryAutoFollowScore: 8, discoveryMaxFollowsPerRun: 10, maxFeeds: 100000 });
  try {
    discovery.promote();
    assert.equal(repo.candidates.find('bluesky', 'user', 'catalogueonly.bsky.social').status, 'pending', 'never auto-followed');
    assert.ok(!repo.feeds.find('bluesky', 'user', 'catalogueonly.bsky.social'));
    assert.equal(repo.candidates.find('bluesky', 'user', 'namedbyfollows.bsky.social').status, 'followed');
    assert.ok(repo.feeds.find('bluesky', 'user', 'namedbyfollows.bsky.social'));
  } finally { settings.update({ discoveryAutoFollowScore: prev.discoveryAutoFollowScore, discoveryMaxFollowsPerRun: prev.discoveryMaxFollowsPerRun, maxFeeds: prev.maxFeeds }); }
});
