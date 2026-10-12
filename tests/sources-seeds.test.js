'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let registry; let femaleCheck;
before(() => { prepareEnv(); registry = require('../src/sources'); ({ femaleCheck } = require('../src/lib/scope')); });

test('every seed targets a registered adapter and a kind it supports; no duplicates', () => {
  const seen = new Set();
  for (const s of registry.SEEDS) {
    const a = registry.get(s.platform);
    assert.ok(a, `unknown platform ${s.platform}`);
    assert.ok(a.kinds.includes(s.kind), `${s.platform} does not support ${s.kind}`);
    assert.ok(String(s.target).trim(), 'empty target');
    const key = `${s.platform}|${s.kind}|${String(s.target).toLowerCase()}`;
    assert.ok(!seen.has(key), `duplicate seed ${key}`);
    seen.add(key);
  }
  assert.ok(registry.SEEDS.length >= 60);
});

test('seeds are male-only: nothing female / feminine / trans-feminine, and untrusted ones read male-focused', () => {
  const { classify } = require('../src/lib/scope');
  for (const s of registry.SEEDS) {
    assert.equal(femaleCheck(s.target).level, null, `female wording in seed ${s.platform}:${s.target}`);
    if (s.trusted === false) assert.equal(classify([s.target], { trusted: false }).scope, 'in', `untrusted seed without a male signal: ${s.platform}:${s.target}`);
  }
});

test('retired seeds are not in the seed list, and the engine switches them off on existing databases', () => {
  const repo = require('../src/db/repo');
  const engine = require('../src/engine/engine');
  for (const r of registry.RETIRED_SEEDS) assert.ok(!registry.SEEDS.some((s) => s.platform === r.platform && s.kind === r.kind && s.target === r.target));
  const old = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'hardbodies', trusted: 1, origin: 'seed', runNow: false }).feed;
  const mine = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'boyswithabs', trusted: 1, origin: 'admin', runNow: false }).feed;
  repo.settings.set('seed_version', '4');
  engine.seedDefaults();
  assert.equal(repo.feeds.get(old.id).enabled, 0, 'retired seed switched off');
  assert.equal(repo.feeds.get(mine.id).enabled, 1, 'an admin-added feed is left alone');
});
