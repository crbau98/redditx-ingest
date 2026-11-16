'use strict';
/** Wave 12 follow-on: the stalls v4.21.0's blame labels named in production. */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
let n = 0;
const add = (o = {}) => { n++; return repo.media.insert({ platform: 'reddit', source_id: `w12s${n}`, source_key: `reddit:w12s${n}:0`, post_key: `reddit:w12s${n}`, media_type: 'image', media_url: `https://i.redd.it/w12s${n}.jpg`, hash: `w12sh${n}`, posted_at: new Date().toISOString(), ...o }, []); };

describe('dedupe boot build: a slice is a range of the table, never "the next N matches"', () => {
  test('a long stretch of rows without a hash is crossed in bounded windows, and every hashed row is still loaded', async () => {
    const dedupe = require('../src/services/dedupe');
    const ids = [];
    for (let i = 0; i < 300; i++) ids.push(add({ phash: crypto.randomBytes(16).toString('hex') }));
    for (let i = 0; i < 2500; i++) add({ phash: null });           // the unhashed stretch (Reddit rows before their hash sweep)
    for (let i = 0; i < 300; i++) ids.push(add({ phash: crypto.randomBytes(16).toString('hex') }));
    dedupe._reset();
    const real = repo.media.hashedWindow; const spans = [];
    repo.media.hashedWindow = (after, to) => { spans.push(to - after); return real(after, to); };
    try {
      const r = await dedupe.loadChunked({ chunk: 400, targetMs: 5 });
      assert.equal(r.rows, 600);
      assert.equal(dedupe.stats().indexed, 600);
      assert.ok(Math.max(...spans) <= 400, `no window wider than the cap (${Math.max(...spans)})`);
      assert.ok(spans.length >= 7, `the 2,500-row gap took several windows (${spans.length})`);
    } finally { repo.media.hashedWindow = real; dedupe._reset(); }
  });
});

describe('WAL checkpoints leave the serving thread', () => {
  test('the serving connection does not checkpoint inline when it runs as production (autocheckpoint 0); tests keep the default', () => {
    const code = "const c=require('./src/config');const {db}=require('./src/db');process.stdout.write(String(db.pragma('wal_autocheckpoint',{simple:true})));";
    const run = (env) => spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env, DB_PATH: path.join(require('os').tmpdir(), `w12-wal-${process.pid}-${Math.random().toString(36).slice(2)}.db`), SCHEDULER_ENABLED: 'false' }, encoding: 'utf8' });
    const prod = run({ NODE_ENV: 'development' });
    assert.equal(prod.stdout.trim(), '0', prod.stderr);
    assert.equal(run({ NODE_ENV: 'test' }).stdout.trim(), '4000');
    assert.equal(run({ NODE_ENV: 'development', PRISM_AUTOCHECKPOINT: '1' }).stdout.trim(), '4000', 'the escape hatch');
  });
  test('the worker task checkpoints a growing WAL without anyone waiting on it', async () => {
    const fs = require('fs'); const config = require('../src/config');
    repo.db.pragma('wal_autocheckpoint = 0'); // as in production
    for (let i = 0; i < 400; i++) add({ title: 'x'.repeat(2000) });
    const walBefore = fs.statSync(`${config.dbPath}-wal`).size;
    assert.ok(walBefore > 500000, `the WAL grew (${walBefore})`);
    const cp = require('../src/engine/checkpoint');
    const r = await cp.run();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.checkpointed > 0 && r.checkpointed >= r.log - 1, JSON.stringify(r));
    assert.equal(cp.stats.failures, 0);
    repo.db.pragma('wal_autocheckpoint = 4000');
  });
  test('a second request while one runs shares it', async () => {
    const cp = require('../src/engine/checkpoint');
    const a = cp.run(); const b = cp.run();
    assert.equal(a, b);
    await a;
  });
});

describe('big communities and creators walk the sort index instead of sorting their rows', () => {
  test('past the broad-size threshold the list names the sort index; below it the planner is left alone; same answer either way', () => {
    const tag = `w12big${Date.now()}`;
    for (let i = 0; i < 40; i++) add({ community: tag, score: i, hot: 40 - i, posted_at: new Date(Date.now() - i * 60000).toISOString() });
    for (let i = 0; i < 40; i++) add({ community: 'w12-other', score: 100 + i });
    const real = repo.db.prepare.bind(repo.db); const seen = [];
    repo.db.prepare = (sql) => { if (/FROM media m/.test(sql) && /ORDER BY/.test(sql) && !/COUNT/.test(sql)) seen.push(sql); return real(sql); };
    const run = (sort) => repo.media.list({ community: tag, sort, limit: 10, noCount: true }).items.map((m) => m.id);
    try {
      const narrow = {}; for (const s of ['top', 'trending', 'recent']) narrow[s] = run(s);
      assert.ok(!seen.some((q) => /INDEXED BY ix_media_pub_(score|hot|posted)/.test(q)), 'a small community is left to the planner');
      seen.length = 0;
      repo.media._broad.community = 5; // "big" for this test
      try {
        for (const s of ['top', 'trending', 'recent']) assert.deepEqual(run(s), narrow[s], `${s}: the same ten rows in the same order`);
        assert.ok(seen.some((q) => /INDEXED BY ix_media_pub_score/.test(q)) && seen.some((q) => /INDEXED BY ix_media_pub_hot/.test(q)) && seen.some((q) => /INDEXED BY ix_media_pub_posted/.test(q)), 'a big community walks the sort index');
      } finally { repo.media._broad.community = 3000; }
    } finally { repo.db.prepare = real; }
  });
});

describe('POST /api/follow/feed reads each creator\'s newest rows, not all of them', () => {
  test('same items, order and totals as the all-rows query; deep pages answer empty', async () => {
    const http = require('http');
    const cs = [0, 1, 2].map((i) => repo.creators.create({ handle: `w12follow${i}`, origin: 'admin' }));
    const t0 = Date.now();
    const rows = [];
    for (let i = 0; i < 90; i++) { const c = cs[i % 3]; rows.push(add({ creator_id: c.id, media_type: i % 4 === 0 ? 'video' : 'image', posted_at: new Date(t0 - i * 1000 * 60).toISOString(), ingested_at: new Date(t0 - (i % 7) * 86400000).toISOString() })); }
    for (const c of cs) repo.creators.refreshStats(c.id);
    const server = require('../src/app').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const post = async (body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/follow/feed`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'prism_age=1' }, body: JSON.stringify(body) })).json();
    try {
      const since = new Date(t0 - 3 * 86400000).toISOString();
      const follows = cs.map((c) => ({ id: c.id, since }));
      const brute = (part, type) => repo.db.prepare(`SELECT m.id FROM media m WHERE m.creator_id IN (${cs.map(() => '?').join(',')}) AND m.publish_state = 'published' AND m.scope != 'excluded'${type ? ' AND m.media_type = ?' : ''}${part === 'new' ? ' AND m.ingested_at > ?' : part === 'earlier' ? ' AND m.ingested_at <= ?' : ''} ORDER BY m.posted_at DESC, m.seq DESC`).all(...cs.map((c) => c.id), ...(type ? [type] : []), ...(part === 'all' ? [] : [since])).map((r) => r.id);
      for (const [part, type] of [['all', undefined], ['all', 'video'], ['all', 'image'], ['new', undefined], ['earlier', 'image']]) {
        const want = brute(part, type);
        const got = [];
        for (let page = 0; page < 8; page++) { const r = await post({ follows, part, type, page, limit: 13 }); got.push(...r.items.map((m) => m.id)); if (page === 0) assert.equal(r.total, want.length, `${part}/${type}: total`); if (r.items.length < 13) break; }
        assert.deepEqual(got, want, `${part}/${type}: same ids in the same order`);
      }
      const deep = await post({ follows, part: 'all', page: 9000, limit: 120 });
      assert.deepEqual([deep.items.length, deep.total], [0, null]);
    } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    void http;
  });
});
