'use strict';
/** Wave 11 (Halyard): duplicate-only backoff, slower dry backfill, and feed-target validation. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let engine; let targets;
before(() => { repo = require('../src/db/repo'); engine = require('../src/engine/engine'); targets = require('../src/services/targets'); });
after(() => { engine.shutdown(); });

const DAY = 86400000;
let n = 0;
function seed(feedId, list) { // [{ daysAgo, fetched, added }]
  const ins = repo.db.prepare('INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of list) { n++; const at = new Date(Date.now() - r.daysAgo * DAY).toISOString(); ins.run(`w11${n}`, feedId, at, at, r.fetched ? 'ok' : 'empty', r.fetched, r.added || 0); }
}
const feed = (target) => repo.feeds.upsert({ platform: 'web', kind: 'page', target, runNow: false }).feed;

test('a feed that fetches items but adds none for 7 days (5+ runs) backs off 2 days', () => {
  const f = feed('https://dupes.example/a');
  seed(f.id, [1, 2, 3, 4, 5, 6].map((d) => ({ daysAgo: d, fetched: 12, added: 0 })));
  const next = Date.parse(engine.idleNextRun(f, 12, Date.now(), 0));
  assert.ok(next - Date.now() > 1.7 * DAY && next - Date.now() < 2.3 * DAY);
});

test('duplicate backoff is not applied when this run added, any run added, too few runs, or the caller omits the added count', () => {
  const f = feed('https://dupes.example/b');
  seed(f.id, [1, 2, 3, 4, 5].map((d) => ({ daysAgo: d, fetched: 8, added: 0 })));
  assert.equal(engine.idleNextRun(f, 8, Date.now(), 2), null, 'this run added items');
  assert.equal(engine.idleNextRun(f, 8), null, 'added count unknown: old behaviour');
  const woke = feed('https://dupes.example/c');
  seed(woke.id, [{ daysAgo: 1, fetched: 8, added: 0 }, { daysAgo: 2, fetched: 8, added: 1 }, { daysAgo: 3, fetched: 8, added: 0 }, { daysAgo: 4, fetched: 8, added: 0 }, { daysAgo: 5, fetched: 8, added: 0 }]);
  assert.equal(engine.idleNextRun(woke, 8, Date.now(), 0), null, 'one add in 7 days keeps the pace');
  const young = feed('https://dupes.example/d');
  seed(young.id, [{ daysAgo: 1, fetched: 8, added: 0 }, { daysAgo: 2, fetched: 8, added: 0 }]);
  assert.equal(engine.idleNextRun(young, 8, Date.now(), 0), null, 'too few runs');
});

test('the yield scoreboard reports added items', () => {
  const f = feed('https://dupes.example/e');
  seed(f.id, [{ daysAgo: 1, fetched: 5, added: 2 }, { daysAgo: 2, fetched: 5, added: 1 }]);
  assert.deepEqual(repo.runs.yieldSince(f.id, new Date(Date.now() - 7 * DAY).toISOString()), { runs: 2, fetched: 10, added: 3 });
});

test('feed creation refuses empty and invalid handles and PeerTube targets', () => {
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: '.bsky.social' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: '  ' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: 'not valid_name' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'user', target: 'flixcdn' }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'user', target: `${'n2jlodrlmmvkmtgxzgvmztmwyzbhzdcxytg1mdvlnmu'}@ic-nss.flix` }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'channel', target: 'onlyfans@@bad' }).status, 'invalid');
});

test('valid Bluesky and PeerTube targets are still created', () => {
  assert.equal(targets.addSpec({ platform: 'bluesky', kind: 'user', target: 'validperson.bsky.social' }, { origin: 'admin' }).status, 'created');
  assert.equal(targets.addSpec({ platform: 'peertube', kind: 'user', target: 'someone@tube.example.org' }, { origin: 'admin' }).status, 'created');
});

test('an empty backfill slice keeps the normal gap (only fetched-but-stored slices wait 4x, BACKFILL_DRY_GAP_FACTOR)', async () => {
  const registry = require('../src/sources'); const settingsStore = require('../src/settings');
  const real = registry.get;
  let added = false;
  const stub = { platform: 'w11bf', kinds: ['user'], isConfigured: () => ({ ok: true }), fetch: async () => ({ items: [{ id: 'w11-' + Math.random(), mediaType: 'image', mediaUrl: 'https://x.invalid/a.jpg' }].slice(0, added ? 1 : 0), via: 't', cursor: { pos: 1 }, backfillPending: true }) };
  registry.get = (p) => (p === 'w11bf' ? stub : real(p));
  try {
    const f = repo.feeds.upsert({ platform: 'w11bf', kind: 'user', target: 'bfuser', runNow: false }).feed;
    // fetched > 0 but nothing added: the engine counts stored items as dupes
    const gap = settingsStore.get().backfillGapMin * 60000;
    repo.db.prepare("INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES ('w11-x', ?, datetime('now','-1 day'), datetime('now','-1 day'), 'ok', 3, 0)").run(f.id);
    await engine.runFeed(f.id, 'schedule');
    const wait = new Date(repo.feeds.get(f.id).next_run_at).getTime() - Date.now();
    assert.ok(wait > 0 && wait <= gap + 1000, 'an empty slice keeps the normal gap');
  } finally { registry.get = real; }
});
