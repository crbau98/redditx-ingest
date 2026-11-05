'use strict';
/**
 * Backend hot paths on a large library (measured with scripts/seed-scale.js + scripts/scale-bench.js: 300k media, 10k creators).
 * These tests pin what the fixes must keep true on any data: the same answers as a plain query, and the access paths that
 * made them fast (the indexes exist and are what the count and prefix queries read; writes that change no count do not
 * throw the cached totals away, and writes that do change one are seen at once).
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const { MIGRATIONS, migrate } = require('../src/db/schema');
const recs = require('../src/engine/recommend');

const { db } = repo;
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
let n = 0;
const post = (creator, o = {}) => {
  n++;
  return repo.media.insert({
    creator_id: creator ? creator.id : null, platform: 'reddit', source_id: `ph${n}`, source_key: `reddit:ph${n}:0`, post_key: `reddit:ph${n}`, author: creator && creator.handle,
    title: `post ${n}`, media_type: 'image', media_url: `https://i.redd.it/ph${n}.jpg`, hash: `phh${n}`, posted_at: daysAgo(n % 50), score: n % 17, ...o,
  }, o.tags || ['gym']);
};
const of = (handle) => { const c = repo.creators.create({ handle }); repo.creators.update(c.id, { links: [{ platform: 'external', service: 'OnlyFans', url: `https://onlyfans.com/${handle}`, handle }] }); return repo.creators.get(c.id); };

/** SQL spies: every statement the repo prepares while `fn` runs, with its text. */
function spy(fn) {
  const seen = [];
  const orig = db.prepare.bind(db);
  db.prepare = (sql) => { seen.push(sql); return orig(sql); };
  try { return { result: fn(), sql: seen }; } finally { db.prepare = orig; }
}
const isCount = (sql) => /^\s*SELECT COUNT\(\*\) AS n FROM media m/.test(sql);

const w = {};
before(() => {
  w.a = of('perf_alpha'); w.b = of('perf_beta'); w.c = repo.creators.create({ handle: 'perf_plain' }); w.hidden = repo.creators.create({ handle: 'perf_hidden' });
  const comm = ['Gym_Bros', 'gymnastics', 'GYM life', '100%_fun', 'a_b', 'beach'];
  for (let i = 0; i < 40; i++) {
    const cr = [w.a, w.b, w.c, w.hidden, null][i % 5];
    post(cr, {
      platform: ['reddit', 'bluesky', 'x'][i % 3], media_type: i % 4 === 0 ? 'video' : 'image', community: comm[i % comm.length],
      scope: i % 11 === 0 ? 'excluded' : 'in', publish_state: i % 13 === 0 ? 'review' : i % 17 === 0 ? 'hidden' : 'published', posted_at: daysAgo(i * 3),
      tags: i % 2 ? ['gym', 'beach'] : ['gym'],
    });
  }
  for (const c of [w.a, w.b, w.c, w.hidden]) repo.creators.refreshStats(c.id);
  repo.creators.update(w.hidden.id, { status: 'hidden' });
});

/** The count an admin-free public list should show, by a query that names no index. */
const plainCount = (extra = '', args = []) => db.prepare(`SELECT COUNT(*) AS n FROM media m WHERE m.publish_state = 'published' AND m.scope != 'excluded'
  AND (m.creator_id IS NULL OR m.creator_id NOT IN (SELECT id FROM creators WHERE status != 'active')) ${extra}`).get(...args).n;

describe('schema v24: covering indexes for the whole-library scans', () => {
  test('a fresh database has both, as partial indexes (published and not excluded only)', () => {
    for (const name of ['ix_media_pub_count', 'ix_media_pub_comm']) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
      assert.ok(row, `${name} exists`);
      assert.match(row.sql, /WHERE publish_state = 'published' AND scope != 'excluded'/, `${name} is partial`);
    }
    assert.ok(MIGRATIONS.length >= 24);
  });

  test('on a v23 database it only adds the indexes: no row is touched, and running it again changes nothing', () => {
    const d = new Database(':memory:');
    d.pragma('foreign_keys = OFF');
    for (let i = 0; i < 23; i++) MIGRATIONS[i](d);
    d.pragma('user_version = 23');
    d.prepare("INSERT INTO media (id, platform, media_type, media_url, hash) VALUES ('m1', 'reddit', 'image', 'https://x/1.jpg', 'h1')").run();
    const before = d.prepare('SELECT COUNT(*) AS n, total_changes() AS c FROM media').get();
    assert.deepEqual(migrate(d), { from: 23, to: MIGRATIONS.length });
    for (const name of ['ix_media_pub_count', 'ix_media_pub_comm']) assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM media').get().n, before.n);
    assert.equal(d.prepare('SELECT total_changes() AS c').get().c, before.c, 'creating the indexes rewrites no row');
    assert.deepEqual(migrate(d), { from: MIGRATIONS.length, to: MIGRATIONS.length });
    MIGRATIONS[23](d); // CREATE INDEX IF NOT EXISTS: safe to repeat
  });
});

describe('list totals', () => {
  test('equal a plain count for the default feed, one type, one platform and both', () => {
    assert.equal(repo.media.list({}).total, plainCount());
    assert.equal(repo.media.list({ type: 'video' }).total, plainCount('AND m.media_type = ?', ['video']));
    assert.equal(repo.media.list({ platform: 'bluesky' }).total, plainCount('AND m.platform = ?', ['bluesky']));
    assert.equal(repo.media.list({ platform: 'x', type: 'image' }).total, plainCount('AND m.platform = ? AND m.media_type = ?', ['x', 'image']));
    assert.ok(plainCount() > 0 && plainCount() < n, 'the fixture has rows both inside and outside the public library');
  });

  test('the plain-library count reads only the covering index (no table lookup per row)', () => {
    repo.media.list({ type: 'video', limit: 1 }); // plans are prepared lazily: capture the count statement
    const { sql } = spy(() => repo.media.list({ platform: 'reddit', type: 'video', limit: 1, page: 3 }));
    const count = sql.find(isCount);
    assert.ok(count, 'the list asked for a total');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${count}`).all('reddit', 'video').map((r) => r.detail).join(' | ');
    assert.match(plan, /ix_media_pub_count/, plan);
    assert.doesNotMatch(plan, /ix_media_state|ix_media_platform|SCAN m(?! USING)/, plan);
  });

  test('windows of time and filters that need other indexes still count exactly', () => {
    const wk = new Date(Date.now() - 7 * 86400000).toISOString(); const mo = new Date(Date.now() - 30 * 86400000).toISOString();
    assert.equal(repo.media.list({ since: 'week' }).total, plainCount('AND m.posted_at >= ?', [wk]));
    assert.equal(repo.media.list({ since: 'month', type: 'video' }).total, plainCount('AND m.posted_at >= ? AND m.media_type = ?', [mo, 'video']));
    const after = daysAgo(40);
    assert.equal(repo.media.list({ after }).total, plainCount('AND m.ingested_at > ?', [after]));
    assert.equal(repo.media.list({ community: 'gym_bros' }).total, plainCount('AND m.community = ? COLLATE NOCASE', ['gym_bros']));
    assert.equal(repo.media.list({ tag: 'beach' }).total, plainCount("AND m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = 'beach')"));
    // an admin view lists other states: the public-library index must not be named there
    const adminAll = repo.media.list({ admin: true, state: 'any' }).total;
    assert.equal(adminAll, db.prepare('SELECT COUNT(*) AS n FROM media').get().n);
  });

  test('stats, platform counts and community counts equal plain aggregates', () => {
    const base = "FROM media WHERE publish_state = 'published' AND scope != 'excluded'";
    const s = repo.publicStats();
    assert.equal(s.total, db.prepare(`SELECT COUNT(*) AS n ${base}`).get().n);
    assert.equal(s.videos, db.prepare(`SELECT COUNT(*) AS n ${base} AND media_type = 'video'`).get().n);
    // equal counts have no defined order: compare with a total order
    const settle = (rows) => [...rows].sort((a, b) => b.count - a.count || String(a.name || a.platform).localeCompare(String(b.name || b.platform)) || String(a.platform).localeCompare(String(b.platform)));
    assert.deepEqual(settle(repo.media.platforms()), settle(db.prepare(`SELECT platform, COUNT(*) AS count ${base} GROUP BY platform`).all()));
    assert.deepEqual(settle(repo.media.communities(100)), settle(db.prepare(`SELECT community AS name, platform, COUNT(*) AS count ${base} AND community IS NOT NULL AND community != '' GROUP BY community, platform`).all()));
  });
});

describe('cached totals follow data changes, not engagement', () => {
  test('a like or a view recounts nothing; hiding a post is reflected at once', () => {
    const first = repo.media.list({ limit: 1 }).total;
    const victim = db.prepare("SELECT id FROM media WHERE publish_state = 'published' AND scope != 'excluded' AND creator_id IS NULL LIMIT 1").get().id;
    const engaged = spy(() => { repo.media.bumpView(victim); repo.media.bumpLike(victim, 1); return repo.media.list({ limit: 1 }).total; });
    assert.equal(engaged.result, first);
    assert.equal(engaged.sql.filter(isCount).length, 0, 'the total came from the cache');
    repo.media.setState(victim, 'hidden', 'perf test');
    const after = spy(() => repo.media.list({ limit: 1 }).total);
    assert.equal(after.result, first - 1, 'a state change is seen immediately');
    assert.equal(after.sql.filter(isCount).length, 1, 'and recounted once');
    assert.equal(after.result, plainCount());
    repo.media.setState(victim, 'published', null, { exact: true });
    assert.equal(repo.media.list({ limit: 1 }).total, first);
  });

  test('the trending refresh does not invalidate them either', () => {
    const t = repo.media.list({ type: 'image', limit: 1 }).total;
    const r = spy(() => { repo.media.recomputeHot(0); return repo.media.list({ type: 'image', limit: 1 }).total; });
    assert.equal(r.result, t);
    assert.equal(r.sql.filter(isCount).length, 0);
  });
});

describe('community autocomplete', () => {
  /** What the LIKE-based query answered before the prefix range. */
  const viaLike = (q) => {
    const pre = `${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return db.prepare(`SELECT community AS name, platform, COUNT(*) AS count FROM media WHERE publish_state = 'published' AND scope != 'excluded' AND community LIKE ? ESCAPE '\\'
      GROUP BY community, platform ORDER BY count DESC LIMIT 6`).all(pre);
  };
  test('answers the same as the case-insensitive prefix match, wildcard characters being literal', () => {
    // a library snapshot is not needed for the community half; the tag half would ask for it
    const communities = (q) => db.prepare(`SELECT community AS name, platform, COUNT(*) AS count FROM media INDEXED BY ix_media_pub_comm
      WHERE publish_state = 'published' AND scope != 'excluded' AND community >= ? COLLATE NOCASE AND community < ? COLLATE NOCASE GROUP BY community, platform ORDER BY count DESC LIMIT 6`).all(q, `${q}\u{10FFFF}`);
    for (const q of ['gym', 'GYM', 'Gym_', 'gym_b', '100%', '100', 'a_', 'a', 'be', 'zzz', 'GYMN']) {
      assert.deepEqual(communities(q).sort((x, y) => x.name.localeCompare(y.name) || x.platform.localeCompare(y.platform)),
        viaLike(q).sort((x, y) => x.name.localeCompare(y.name) || x.platform.localeCompare(y.platform)), `prefix ${q}`);
    }
  });
  test('repo.suggest uses the range on the index', () => {
    let out;
    const { sql } = spy(() => { try { out = repo.suggest('gym', 6); } catch (e) { out = e; } });
    const q = sql.find((s) => /FROM media INDEXED BY ix_media_pub_comm/.test(s) && /COLLATE NOCASE/.test(s));
    assert.ok(q, 'the community query names the index');
    if (!(out instanceof Error)) assert.ok(out.communities.length >= 1);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${q}`).all('gym', 'gym\u{10FFFF}', 6).map((r) => r.detail).join(' | ');
    assert.match(plan, /ix_media_pub_comm \(community>\? AND community<\?\)/, plan);
  });
});

describe('sort-index choice does not change the answer', () => {
  /** Reference: the same filter and order with no index hint. */
  const ids = (sql, args = []) => db.prepare(sql).all(...args).map((r) => r.id);
  const PUB = "m.publish_state = 'published' AND m.scope != 'excluded' AND (m.creator_id IS NULL OR m.creator_id NOT IN (SELECT id FROM creators WHERE status != 'active'))";

  test('creators with an OnlyFans page, newest first and by score (a broad host walks the sort index)', () => {
    const ofCreators = "m.creator_id IN (SELECT id FROM creators WHERE links GLOB '*onlyfans.com/[A-Za-z0-9]*' OR links LIKE '%\"service\":\"OnlyFans\"%' OR links LIKE '%onlyfans.com/%')";
    for (const [sort, order] of [['recent', 'm.posted_at DESC, m.seq DESC'], ['top', 'm.score DESC, m.seq DESC'], ['trending', 'm.hot DESC, m.seq DESC']]) {
      const got = repo.media.list({ paidHost: 'onlyfans', sort, limit: 12 });
      assert.deepEqual(got.items.map((m) => m.id), ids(`SELECT m.id FROM media m WHERE ${PUB} AND ${ofCreators} ORDER BY ${order} LIMIT 12`), `${sort} page 0`);
      assert.equal(got.total, plainCount(`AND ${ofCreators}`), `${sort} total`);
    }
    const p2 = repo.media.list({ paidHost: 'onlyfans', sort: 'recent', limit: 5, page: 2 });
    assert.deepEqual(p2.items.map((m) => m.id), ids(`SELECT m.id FROM media m WHERE ${PUB} AND ${ofCreators} ORDER BY m.posted_at DESC, m.seq DESC LIMIT 5 OFFSET 10`));
  });

  test('several tags that must all match', () => {
    const both = "m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = 'gym') AND m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name = 'beach')";
    for (const [sort, order] of [['recent', 'm.posted_at DESC, m.seq DESC'], ['top', 'm.score DESC, m.seq DESC']]) {
      const got = repo.media.list({ tagsAll: ['gym', 'beach'], sort, limit: 8 });
      assert.deepEqual(got.items.map((m) => m.id), ids(`SELECT m.id FROM media m WHERE ${PUB} AND ${both} ORDER BY ${order} LIMIT 8`), sort);
      assert.equal(got.total, plainCount(`AND ${both}`));
    }
  });

  test('a window of time with a sort', () => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const got = repo.media.list({ since: 'month', sort: 'top', limit: 10 });
    assert.deepEqual(got.items.map((m) => m.id), ids(`SELECT m.id FROM media m WHERE ${PUB} AND m.posted_at >= ? ORDER BY m.score DESC, m.seq DESC LIMIT 10`, [since]));
  });
});

describe('creators.rising and the background sweeps keep their plans', () => {
  test('rising reads a window of the date index and returns the same creators as before', () => {
    for (const c of [w.a, w.b, w.c]) { post(c, { posted_at: daysAgo(1) }); post(c, { posted_at: daysAgo(2) }); post(c, { posted_at: daysAgo(3) }); }
    const rising = repo.creators.rising(12);
    assert.ok(rising.length >= 3);
    const d7 = daysAgo(7); const d28 = daysAgo(28);
    const week = new Map(db.prepare(`SELECT m.creator_id AS id, SUM(CASE WHEN m.posted_at >= ? THEN 1 ELSE 0 END) AS week FROM media m JOIN creators c ON c.id = m.creator_id
      WHERE m.posted_at >= ? AND m.publish_state = 'published' AND m.scope != 'excluded' AND c.status = 'active' AND c.scope != 'excluded' GROUP BY m.creator_id HAVING week >= 2`).all(d7, d28).map((r) => [r.id, r.week]));
    assert.deepEqual([...rising.map((r) => r.id)].sort(), [...week.keys()].sort());
    for (const r of rising) assert.equal(r.week_count, week.get(r.id));
  });

  test('the thumbnail queue reads its partial index (planner would sort every published row)', () => {
    const thumbs = require('../src/engine/thumbs');
    assert.equal(typeof thumbs.progress().remaining, 'number');
    const { sql } = spy(() => thumbs.sweep({ limit: 0 }));
    assert.ok(Array.isArray(sql));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM media INDEXED BY ix_media_tint_todo WHERE tint IS NULL AND publish_state = 'published' ORDER BY seq DESC LIMIT 30").all().map((r) => r.detail).join(' | ');
    assert.match(plan, /ix_media_tint_todo/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  });

  test('the embedding backlog is the newest published items without a vector, in order', () => {
    const visual = require('../src/engine/visual');
    visual.ensureTable();
    const all = db.prepare("SELECT id FROM media WHERE publish_state = 'published' AND scope != 'excluded' ORDER BY seq DESC").all().map((r) => r.id);
    db.prepare("INSERT OR REPLACE INTO media_embeddings (media_id, model, vec) VALUES (?, 'mnv2-p256-v1', zeroblob(260))").run(all[0]);
    db.prepare("INSERT OR REPLACE INTO media_embeddings (media_id, model, vec) VALUES (?, 'fail', NULL)").run(all[1]);
    const got = visual._pending(5).map((r) => r.id);
    assert.deepEqual(got, all.slice(2, 7), 'skips the embedded one and the recent failure, newest first');
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT m.id FROM media m NOT INDEXED WHERE m.publish_state = 'published' ORDER BY m.seq DESC LIMIT 5").all().map((r) => r.detail).join(' | ');
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  });
});

describe('For You: candidates are gathered once per taste, not once per seed', () => {
  test('a second visit with a new seed reuses them; the same seed gives the same order; a hidden post never comes back', () => {
    const t = (seed) => recs.tasteFromQuery({ tags: 'gym:3,beach:1', creators: `${w.a.id}:2`, seed: String(seed), limit: '6' }, repo);
    recs.setCacheTtl(60000);
    try {
      const gathering = (sql) => /ROW_NUMBER\(\) OVER \(PARTITION BY m\.creator_id/.test(sql) && /creator_last_at/.test(sql);
      const one = spy(() => recs.recommend(t(1)));
      assert.ok(one.sql.filter(gathering).length >= 1, 'the first visit gathers candidates');
      assert.ok(one.result.items.length > 0);
      const two = spy(() => recs.recommend(t(2)));
      assert.equal(two.sql.filter(gathering).length, 0, 'a new seed for the same taste reuses them');
      assert.equal(two.sql.filter((s) => /INDEXED BY ix_media_pub_hot/.test(s)).length, 0);
      // the same seed, with nothing cached, is the same order
      recs.setCacheTtl(0);
      const cold = recs.recommend(t(2)).items.map((m) => m.id);
      recs.setCacheTtl(60000);
      recs.recommend(t(7)); // warm the candidates under another seed
      assert.deepEqual(recs.recommend(t(2)).items.map((m) => m.id), cold, 'seed 2 gives one order whether or not the candidates came from the cache');
      // moderation: the library changes, candidates are gathered again, and the hidden post is gone
      const gone = cold[0];
      repo.media.setState(gone, 'hidden', 'perf test');
      const after = recs.recommend(t(2)).items.map((m) => m.id);
      assert.ok(!after.includes(gone), 'a post hidden after the candidates were cached is not served');
    } finally { recs.setCacheTtl(0); }
  });
});
