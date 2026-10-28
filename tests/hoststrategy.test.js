'use strict';
/** engine/hoststrategy.js: what PRISM learns about which hosts need a browser, and when to leave one alone. */
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const hs = require('../src/engine/hoststrategy');

const H = 'gallery.example';
const hoursFromNow = (iso) => (Date.parse(iso) - Date.now()) / 3600_000;
const age = (days) => repo.db.prepare('UPDATE host_strategy SET last_render_at = ? WHERE host = ?').run(new Date(Date.now() - days * 86400_000).toISOString(), H);
beforeEach(() => hs._reset());

describe('fallback mode', () => {
  test('renders only when the plain download showed nothing', () => {
    assert.equal(hs.decide(H, { mode: 'fallback', found: 0 }).render, true);
    assert.equal(hs.decide(H, { mode: 'fallback', found: 7 }).render, false);
  });
  test('a host that renders to nothing is rested with growing back-off: 6 h, 12 h, 24 h, 48 h, then 72 h at most', () => {
    const waits = [];
    for (let i = 0; i < 6; i++) { hs.record(H, { found: 0, rendered: 0 }); waits.push(Math.round(hoursFromNow(hs.get(H).render_after))); }
    assert.deepEqual(waits, [6, 12, 24, 48, 72, 72]);
    const d = hs.decide(H, { mode: 'fallback', found: 0 });
    assert.equal(d.render, false);
    assert.match(d.why, /found nothing 6x in a row/);
  });
  test('the first render that finds something ends the rest', () => {
    for (let i = 0; i < 3; i++) hs.record(H, { found: 0, rendered: 0 });
    assert.equal(hs.decide(H, { mode: 'fallback', found: 0 }).render, false);
    repo.db.prepare("UPDATE host_strategy SET render_after = ? WHERE host = ?").run(new Date(Date.now() - 1000).toISOString(), H); // the rest is over
    hs.record(H, { found: 0, rendered: 12 });
    const row = hs.get(H);
    assert.equal(row.empty_streak, 0); assert.equal(row.render_after, null); assert.equal(row.render_wins, 1);
    assert.equal(hs.decide(H, { mode: 'fallback', found: 0 }).render, true);
  });
});

describe('always mode is adaptive', () => {
  test('explores a new host, then keeps rendering only while rendering beats the plain read', () => {
    for (let i = 0; i < hs.EXPLORE; i++) {
      assert.equal(hs.decide(H, { mode: 'always', found: 5 }).render, true, `exploring render ${i + 1}`);
      hs.record(H, { found: 5, rendered: 5 }); // renders find the same as the plain read: no win
    }
    const d = hs.decide(H, { mode: 'always', found: 5 });
    assert.equal(d.render, false);
    assert.match(d.why, /only 0\/3 runs/);
  });
  test('a host where rendering often finds more keeps being rendered', () => {
    for (let i = 0; i < 3; i++) hs.record(H, { found: 5, rendered: i === 0 ? 20 : 5 }); // 1 win in 3
    const d = hs.decide(H, { mode: 'always', found: 5 });
    assert.equal(d.render, true);
    assert.match(d.why, /beaten the plain read in 1\/3/);
  });
  test('a written-off host is looked at again after two weeks', () => {
    for (let i = 0; i < 3; i++) hs.record(H, { found: 5, rendered: 5 });
    assert.equal(hs.decide(H, { mode: 'always', found: 5 }).render, false);
    age(15);
    const d = hs.decide(H, { mode: 'always', found: 5 });
    assert.equal(d.render, true); assert.match(d.why, /again/);
  });
  test('an empty plain read always gets a render (unless the host is resting)', () => {
    for (let i = 0; i < 3; i++) hs.record(H, { found: 5, rendered: 5 });
    assert.equal(hs.decide(H, { mode: 'always', found: 0 }).render, true);
  });
});

describe('bot-challenges', () => {
  test('rest the host for 1 day, doubling to at most 7; nothing is solved or retried', () => {
    const days = [];
    for (let i = 0; i < 5; i++) { hs.record(H, { found: 0, challenge: true }); days.push(Math.round(hoursFromNow(hs.get(H).challenged_until) / 24)); }
    assert.deepEqual(days, [1, 2, 4, 7, 7]);
    const d = hs.decide(H, { mode: 'always', found: 0 });
    assert.equal(d.render, false); assert.match(d.why, /bot-challenge/);
  });
  test('a host that is not resting is not affected by another host\'s history', () => {
    hs.record(H, { found: 0, challenge: true });
    assert.equal(hs.decide('other.example', { mode: 'fallback', found: 0 }).render, true);
  });
});

describe('unlock back-off (paid requests)', () => {
  test('the first unlock is allowed; empty answers back off 12 h, 24 h, 48 h, 72 h at most', () => {
    assert.equal(hs.decideUnlock(H).unlock, true);
    const waits = [];
    for (let i = 0; i < 5; i++) { hs.recordUnlock(H, { found: 0 }); waits.push(Math.round(hoursFromNow(hs.get(H).unlock_after))); }
    assert.deepEqual(waits, [12, 24, 48, 72, 72]);
    assert.equal(hs.decideUnlock(H).unlock, false);
  });
  test('an unlock that finds something clears the back-off', () => {
    hs.recordUnlock(H, { found: 0 });
    hs.recordUnlock(H, { found: 9 });
    const row = hs.get(H);
    assert.equal(row.unlock_after, null); assert.equal(row.unlock_empty_streak, 0); assert.equal(row.unlock_wins, 1); assert.equal(row.unlock_runs, 2);
    assert.equal(hs.decideUnlock(H).unlock, true);
  });
  test('unlock history and render history do not disturb each other', () => {
    hs.record(H, { found: 0, rendered: 8 });
    hs.recordUnlock(H, { found: 0 });
    const row = hs.get(H);
    assert.equal(row.render_wins, 1); assert.equal(row.unlock_runs, 1);
    assert.equal(hs.decide(H, { mode: 'fallback', found: 0 }).render, true, 'resting from unlocks does not stop renders');
  });
});

test('summary counts what the admin console shows', () => {
  hs.record('a.example', { found: 0, rendered: 4 });
  hs.record('b.example', { found: 0, rendered: 0 });
  hs.record('c.example', { found: 0, challenge: true });
  const s = hs.summary();
  assert.equal(s.hosts, 3); assert.equal(s.renderHelps, 1); assert.equal(s.resting, 2);
  assert.equal(s.top[0].host, 'a.example');
});
