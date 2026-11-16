'use strict';
/**
 * Wave 12: library data quality.
 *   1. The hash sweep's misses are remembered (v38) and retried by a paced pass that tries every picture URL; a gone picture,
 *      or one that failed 5 times, is given up with a reason; a 429 pauses the passes and is not counted against the row.
 *   2. Published rows with no picture get a verified video poster or go to review ('no-image'); a dry run reports first.
 *   3. library-health and the residue purge report the longest synchronous chunk; library-health splits the unhashed count.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const settings = require('../src/settings');
const imagefilter = require('../src/lib/imagefilter');
const maintenance = require('../src/engine/maintenance');
const { MIGRATIONS } = require('../src/db/schema');

const { db } = repo;
let n = 0;
const HEX = (i) => (`${i.toString(16)}`.padStart(2, '0')).repeat(16);
const item = (o = {}) => {
  n++;
  return repo.media.insert({
    platform: 'reddit', source_id: `w12${n}`, source_key: `reddit:w12${n}:0`, post_key: `reddit:w12${n}`, author: 'someone', title: `w12 ${n}`,
    media_type: 'image', media_url: `https://i.redd.it/w12-${n}.jpg`, preview_url: `https://preview.redd.it/w12-${n}.jpg?s=x`, hash: `w12h${n}`, ...o,
  }, []);
};
const row = (id) => db.prepare('SELECT seq, phash, phash_tries, phash_at, phash_error, publish_state, review_reason, preview_url FROM media WHERE id = ?').get(id);
let answer = () => ({ status: 'ok', phash: null });
const asked = [];
before(() => {
  settings.update({ dedupe: true, imageSweep: true });
  imagefilter._setAnalyzer(async (url, o) => { asked.push(url); return answer(url, o); });
});
after(() => { imagefilter._reset(); });
const sweepAll = async () => { await maintenance.hashSweep({ limit: 1000 }); };

describe('1. hash misses are remembered, retried, and given up with a reason', () => {
  test('v38 adds the tracking columns and the retry index', () => {
    assert.ok(MIGRATIONS.length >= 38);
    const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
    for (const c of ['phash_tries', 'phash_at', 'phash_error']) assert.ok(cols.includes(c), c);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ix_media_phash_todo'").get().sql, /phash IS NULL AND phash_error IS NULL/);
  });

  test('a gone picture (404 on every URL) is given up at once; a transient failure is counted and left for the retry', async () => {
    repo.settings.set('hash_sweep_seq', String(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM media').get().m));
    const gone = item(); const flaky = item();
    answer = (url) => (url.includes(`w12-${n - 1}`) ? { status: 'error', reason: 'http 404' } : { status: 'error', reason: 'timeout' });
    await sweepAll();
    assert.match(row(gone).phash_error, /^gone: http 404/);
    assert.equal(row(gone).phash_tries, 1);
    const f = row(flaky);
    assert.equal(f.phash_error, null, 'not given up');
    assert.equal(f.phash_tries, 1);
    assert.ok(f.phash_at);
    assert.equal(Number(repo.settings.get('hash_sweep_seq')), f.seq, 'the main pass moved on past both');
  });

  test('the retry pass waits 6 h, then tries every URL: an expired preview no longer hides the original', async () => {
    const flakyId = db.prepare("SELECT id FROM media WHERE phash IS NULL AND phash_error IS NULL AND phash_tries = 1 ORDER BY seq DESC LIMIT 1").get().id;
    repo.settings.set('hash_retry_seq', '0');
    answer = (url) => (url.includes('preview.redd.it') ? { status: 'error', reason: 'http 403' } : { status: 'ok', phash: HEX(7) });
    asked.length = 0;
    const early = await maintenance.hashRetrySweep({ limit: 50 });
    assert.equal(early.checked, 0, 'tried an instant ago: not yet');
    const later = await maintenance.hashRetrySweep({ limit: 50, now: Date.now() + maintenance._hash.RETRY_AFTER_MS + 1000 });
    assert.ok(later.hashed >= 1);
    assert.equal(row(flakyId).phash, HEX(7));
    assert.ok(asked.some((u) => u.includes('preview.redd.it')) && asked.some((u) => u.includes('i.redd.it')), 'preview first, then the original');
  });

  test('after 5 failed tries a row is given up with the count and the reason', async () => {
    const id = item();
    repo.settings.set('hash_sweep_seq', String(row(id).seq));
    answer = () => ({ status: 'error', reason: 'http 500' });
    for (let i = 0; i < 5; i++) {
      repo.settings.set('hash_retry_seq', '0');
      await maintenance.hashRetrySweep({ limit: 50, now: Date.now() + (i + 1) * (maintenance._hash.RETRY_AFTER_MS + 1000) });
      db.prepare('UPDATE media SET phash_at = NULL WHERE id = ?').run(id); // time travel for the next round
    }
    assert.equal(row(id).phash_tries, 5);
    assert.match(row(id).phash_error, /^gave up after 5 tries: http 500/);
    const again = await maintenance.hashRetrySweep({ limit: 50, now: Date.now() + 99 * maintenance._hash.RETRY_AFTER_MS });
    assert.equal(again.checked, 0, 'a given-up row is not tried again');
  });

  test('a 429 pauses both passes, is not counted, and the main cursor stays before the row it hit', async () => {
    const before = Number(repo.settings.get('hash_sweep_seq'));
    const id = item();
    answer = () => ({ status: 'error', reason: 'http 429' });
    const r = await maintenance.hashSweep({ limit: 50 });
    assert.equal(r.limited, true);
    assert.equal(row(id).phash_tries, 0, 'not the picture\'s fault');
    assert.equal(row(id).phash_error, null);
    assert.equal(Number(repo.settings.get('hash_sweep_seq')), before, 'read again next time');
    assert.equal((await maintenance.hashSweep({ limit: 50 })).paused, true);
    assert.equal((await maintenance.hashRetrySweep({ limit: 50 })).paused, true);
    maintenance._hash.unpause();
    answer = () => ({ status: 'ok', phash: HEX(9) });
    await maintenance.hashSweep({ limit: 50 });
    assert.equal(row(id).phash, HEX(9));
  });

  test('the retry pass reads its partial index, with no temp B-tree', () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT seq FROM media INDEXED BY ix_media_phash_todo
      WHERE phash IS NULL AND phash_error IS NULL AND publish_state IN ('published','review') AND seq > 0 AND seq <= 10 AND (phash_at IS NULL OR phash_at < 'x') ORDER BY seq LIMIT 5`).all().map((r) => r.detail).join(' | ');
    assert.match(plan, /ix_media_phash_todo/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  });
});

describe('3. library-health tells pending from unhashable, and reports its longest chunk', () => {
  test('the split adds up and maxChunkMs is reported', async () => {
    const hidden = item(); repo.media.setState(hidden, 'hidden', 'test', { deferStats: true });
    const r = await require('../src/engine/library-health').report();
    const { pending, unhashable, hidden: h } = r.redditPhash;
    assert.ok(unhashable >= 2, 'the gone one and the given-up one');
    assert.ok(h >= 1);
    assert.equal(pending + unhashable + h, r.redditPhashNull);
    assert.equal(typeof r.maxChunkMs, 'number');
    assert.equal(r.window, 5000);
  });
  test('the residue purge reports its longest chunk too', async () => {
    const r = await require('../src/engine/residue-purge').purgeResidue({ dryRun: true });
    assert.equal(typeof r.maxChunkMs, 'number');
  });
});

describe('2. published rows with no picture', () => {
  const repair = require('../src/engine/noimage-repair');
  let gif; let unknown; let pic;
  before(() => {
    gif = item({ platform: 'redgifs', media_type: 'video', media_url: 'https://media.redgifs.com/QuietBlank.mp4', preview_url: null });
    unknown = item({ platform: 'x', media_type: 'video', media_url: 'https://video.twimg.com/blank.mp4', preview_url: null });
    pic = item({ media_url: '', preview_url: null });
  });

  test('a dry run reports the plan and changes nothing', async () => {
    asked.length = 0;
    const r = await repair.repair({ dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(r.found >= 3);
    assert.ok(r.posterCandidates >= 1 && r.wouldReview >= 2);
    assert.equal(asked.length, 0, 'no network');
    assert.equal(row(gif).publish_state, 'published');
    assert.equal(row(unknown).publish_state, 'published');
    assert.equal(typeof r.maxChunkMs, 'number');
  });

  test('the run restores a poster that reads, and sends the rest to review as no-image; the grid has no blanks left', async () => {
    answer = (url) => (url.endsWith('-poster.jpg') ? { status: 'ok', phash: HEX(11) } : { status: 'error', reason: 'http 404' });
    const r = await repair.repair({ dryRun: false });
    assert.ok(r.postered >= 1 && r.reviewed >= 2);
    assert.equal(row(gif).preview_url, 'https://media.redgifs.com/QuietBlank-poster.jpg');
    assert.equal(row(gif).publish_state, 'published');
    for (const id of [unknown, pic]) { assert.equal(row(id).publish_state, 'review'); assert.equal(row(id).review_reason, 'no-image'); }
    assert.equal((await require('../src/engine/library-health').report()).publishedNoImage, 0);
    assert.equal((await repair.repair({ dryRun: true })).found, 0, 'running it again finds nothing');
  });

  test('a poster that does not read sends the video to review instead', async () => {
    const v = item({ platform: 'redgifs', media_type: 'video', media_url: 'https://media.redgifs.com/DeadPoster.mp4', preview_url: null });
    answer = () => ({ status: 'error', reason: 'http 404' });
    const r = await repair.repair({});
    assert.equal(r.posterFailed, 1);
    assert.equal(row(v).publish_state, 'review');
  });

  test('admin endpoint: POST /api/admin/maintenance/repair-no-image?dryRun=1', async () => {
    item({ platform: 'x', media_type: 'video', media_url: 'https://video.twimg.com/blank2.mp4', preview_url: null });
    const { createApp } = require('../src/app');
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const body = await new Promise((ok, fail) => {
        const req = http.request(`http://127.0.0.1:${server.address().port}/api/admin/maintenance/repair-no-image?dryRun=1&limit=10`, { method: 'POST', headers: { 'x-admin-key': 'test-key' } }, (res) => {
          let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => ok({ status: res.statusCode, json: JSON.parse(d) }));
        });
        req.on('error', fail); req.end();
      });
      assert.equal(body.status, 200);
      assert.equal(body.json.dryRun, true);
      assert.equal(body.json.found, 1);
      assert.equal(body.json.wouldReview, 1);
    } finally { server.close(); }
  });
});
