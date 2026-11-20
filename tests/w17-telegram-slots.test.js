'use strict';
/**
 * Telegram slot share: three concurrent telegram feeds (was one) so ~559 feeds at ~193 s/run
 * finish a cycle in ~10 h instead of ~30 h, without touching platformDailyMb (5 GB/day guard).
 */
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let engine; let repo; let budget; let settingsStore;
before(() => {
  prepareEnv({ SCHEDULER_ENABLED: 'true' });
  repo = require('../src/db/repo');
  budget = require('../src/services/budget');
  settingsStore = require('../src/settings');
  engine = require('../src/engine/engine');
});
beforeEach(() => {
  repo.db.prepare('DELETE FROM feeds').run();
  budget._reset();
  engine._state.queue.length = 0;
  engine._state.running.clear();
  engine._state.paused = false;
});

const mk = (platform, target) => repo.feeds.upsert({
  platform, kind: platform === 'telegram' ? 'channel' : 'user', target, origin: 'admin', trusted: 1, runNow: true,
}).feed;

test('default telegram slots are 3 (was 1)', () => {
  assert.equal(engine.slotsFor('telegram', settingsStore.get()), 3);
});

test('telegram runs up to 3 at once; a fourth waits', () => {
  const cfg = settingsStore.get();
  for (let i = 0; i < 6; i++) mk('telegram', `ch${i}`);
  mk('bluesky', 'other');
  const take = () => {
    const w = engine._nextWork(cfg);
    if (w) engine._state.running.set(w.feed.id, { platform: w.feed.platform });
    return w;
  };
  const got = [take(), take(), take(), take()].filter(Boolean).map((w) => w.feed.platform);
  assert.equal(got.filter((p) => p === 'telegram').length, 3, 'three telegram slots filled');
  assert.ok(got.includes('bluesky'), 'other platforms still get a turn once telegram is full');
});

test('cycle math: 559 feeds × 193s / 3 slots fits under a day', () => {
  const feeds = 559;
  const secPerRun = 193;
  const slots = engine.slotsFor('telegram', settingsStore.get());
  const cycleHours = (feeds * secPerRun) / slots / 3600;
  assert.ok(cycleHours < 24, `expected <24h, got ${cycleHours.toFixed(1)}h`);
  assert.ok(cycleHours > 8 && cycleHours < 12, `~10h expected, got ${cycleHours.toFixed(1)}h`);
});
