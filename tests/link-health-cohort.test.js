'use strict';
/**
 * Link health for the rot-host cohort: old reddit items are re-checked at the cohort rate, old items on other
 * hosts are not pulled in, and the existing verdict rules still decide what is hidden.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const health = require('../src/engine/health');
const settings = require('../src/settings');

const db = repo.db;
const OLD = new Date(Date.now() - 60 * 86400000).toISOString(); // well past the 14-day staleness window
let seq = 0;
const item = (host, extra = {}) => {
  seq++;
  return repo.media.insert({
    platform: host.includes('redd') ? 'reddit' : 'coomer', source_id: `hc${seq}`, source_key: `hc:${seq}:0`, post_key: `hc:${seq}`,
    community: 'testsub', author: 'tester', title: `Old ${seq}`, media_type: 'image', media_url: `https://${host}/p${seq}.jpg`,
    hash: `hch${seq}`, score: 1, posted_at: OLD, ...extra,
  }) && db.prepare('SELECT id FROM media WHERE source_key = ?').get(`hc:${seq}:0`).id;
};
const state = (id) => repo.media.get(id).publish_state;
const health_ = (id) => db.prepare('SELECT * FROM media_health WHERE media_id = ?').get(id);
/** A fake probe: every call is recorded, and the verdict comes from the URL's answer table. */
const fakeProbe = (answer = () => ({ ok: false, reason: 'http 404' })) => {
  const calls = [];
  const probe = async (url) => { calls.push(url); return answer(url); };
  return { calls, probe };
};
const gone = { ok: false, reason: 'http 404' };
const forbidden = { ok: false, reason: 'http 403' };
const agoMin = (min) => new Date(Date.now() - min * 60000).toISOString();

before(() => { settings.get(); });

describe('rot-host cohort', () => {
  test('an old reddit item is picked up by the cohort pass; an old coomer item is not part of it', async () => {
    const reddit = item('i.redd.it');
    const coomer = item('coomer.su');
    const { calls, probe } = fakeProbe(() => ({ ok: true }));
    const r = await health.sweep({ probe, cohortLimit: 5 });
    assert.equal(r.cohort, 1, 'the cohort holds only the rot-host item');
    assert.ok(calls[0].includes('i.redd.it'), 'and it is probed first');
    assert.equal(health_(reddit).verdict, 'ok');
    // the general pass may still reach the coomer item at its own rate; it is not part of the cohort
    assert.equal(health_(coomer).verdict, 'ok');
  });

  test('the cohort rate is 80 per sweep; other hosts keep 40', async () => {
    for (let i = 0; i < 100; i++) item('i.redd.it');
    for (let i = 0; i < 60; i++) item('coomer.su');
    assert.equal(settings.get().linkHealthCohortPerSweep, 80);
    assert.equal(settings.get().linkHealthPerSweep, 40);
    const { calls, probe } = fakeProbe(() => ({ ok: true }));
    const r = await health.sweep({ probe });
    const reddit = calls.filter((u) => u.includes('i.redd.it')).length;
    const other = calls.filter((u) => u.includes('coomer.su')).length;
    assert.equal(reddit, 80, 'cohort probes per sweep');
    assert.equal(other, 40, 'general probes per sweep');
    assert.equal(r.cohort, 80);
  });

  test('a recent reddit item stays in the live sweep, not the cohort', async () => {
    const recent = item('i.redd.it', { posted_at: new Date().toISOString() });
    const seqOf = Number(repo.media.get(recent).media_url.match(/\/p(\d+)\.jpg/)[1]);
    const { calls, probe } = fakeProbe(() => ({ ok: true }));
    const r = await health.sweep({ probe, cohortLimit: 500 });
    assert.ok(!calls.slice(0, r.cohort).some((u) => u.endsWith(`/p${seqOf}.jpg`)), 'not in the cohort pass');
    assert.equal(health_(recent).verdict, 'ok', 'still checked by the live sweep');
  });

  test('the host list is a setting, and malformed entries cannot widen the query', () => {
    repo.settings.set('linkHealthRotHosts', 'https://PREVIEW.redd.it/x\n i.redd.it ; ok\' OR 1=1 --');
    assert.deepEqual(health.rotHosts(), ['preview.redd.it', 'i.redd.it']);
    repo.settings.set('linkHealthRotHosts', 'i.redd.it\npreview.redd.it');
  });

  test('a 403 never hides, however often it repeats', async () => {
    const id = item('i.redd.it');
    const { probe } = fakeProbe(() => forbidden);
    await health.sweep({ probe });
    db.prepare('UPDATE media_health SET checked_at = ? WHERE media_id = ?').run(agoMin(120), id);
    await health.sweep({ probe });
    assert.equal(state(id), 'published');
    assert.equal(health_(id).verdict, 'unknown');
  });

  test('one 404 does not hide', async () => {
    const id = item('i.redd.it');
    const { probe } = fakeProbe(() => gone);
    await health.sweep({ probe });
    assert.equal(state(id), 'published');
    assert.equal(health_(id).verdict, 'gone');
    assert.equal(health_(id).gone_streak, 1);
  });

  test('two 404s at least an hour apart hide the item', async () => {
    const id = item('i.redd.it');
    const { probe } = fakeProbe(() => gone);
    await health.sweep({ probe });
    db.prepare('UPDATE media_health SET checked_at = ? WHERE media_id = ?').run(agoMin(61), id);
    await health.sweep({ probe });
    assert.equal(state(id), 'hidden');
    assert.match(repo.media.get(id).review_reason, /Gone at source/);
  });

  test('two 404s less than an hour apart do not hide', async () => {
    const id = item('i.redd.it');
    const { probe } = fakeProbe(() => gone);
    await health.sweep({ probe });
    db.prepare('UPDATE media_health SET checked_at = ? WHERE media_id = ?').run(agoMin(10), id);
    await health.sweep({ probe });
    assert.equal(state(id), 'published');
  });
});
