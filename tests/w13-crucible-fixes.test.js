'use strict';
/**
 * Wave 12 gate fixes: W1 (a RESTART checkpoint must not hold the writer while it waits for a reader), N4 (a failing / lagging checkpoint
 * is visible), T1 (one SQLITE_BUSY must not end a takedown sweep), F1 (follow feed: per-creator index and a bounded read).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key', WAL_CHECKPOINT_MB: '0', WAL_WARN_MB: '1' });
const repo = require('../src/db/repo'); const { db } = repo;
const config = require('../src/config');
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const add = (o = {}) => { n++; return repo.media.insert({ platform: 'reddit', source_id: `w13-${n}`, source_key: `reddit:w13-${n}:0`, post_key: `reddit:w13-${n}`, media_type: 'image', media_url: `https://i.redd.it/w13-${n}.jpg`, hash: `w13h${n}`, title: 'x'.repeat(1500), posted_at: new Date().toISOString(), ...o }, []); };

/** A second connection in another process: holds a read snapshot (`mode: 'read'`) or the write lock (`'write'`) for `ms`. */
function holder(mode, ms) {
  const src = `const D=require('better-sqlite3');const d=new D(${JSON.stringify(config.dbPath)});d.pragma('busy_timeout=2000');
    ${mode === 'read' ? "d.exec('BEGIN'); d.prepare('SELECT COUNT(*) FROM media').get();" : "d.exec('BEGIN IMMEDIATE'); d.prepare(\"INSERT INTO settings (key,value) VALUES ('w13-lock','1') ON CONFLICT(key) DO UPDATE SET value='2'\").run();"}
    process.stdout.write('held\\n'); setTimeout(()=>{ try{d.exec('COMMIT')}catch{} process.exit(0); }, ${ms});`;
  const child = spawn(process.execPath, ['-e', src], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => { child.stdout.once('data', () => resolve({ child, done: new Promise((r) => child.on('exit', r)) })); });
}

describe('W1: RESTART never waits for a reader while holding the writer lock', () => {
  test('a reader holding a snapshot: the RESTART comes back busy at once and main-thread writes are not stalled', async () => {
    const cp = require('../src/engine/checkpoint'); cp._reset();
    db.pragma('wal_autocheckpoint = 0');
    for (let i = 0; i < 100; i++) add();
    const h = await holder('read', 4000);
    for (let i = 0; i < 100; i++) add();                  // the log moves past the reader's snapshot
    const t0 = Date.now();
    const pr = cp.run({ mode: 'RESTART' });
    let worst = 0; let errors = 0;
    while (Date.now() - t0 < 2500) { const t = Date.now(); try { add(); } catch { errors++; } worst = Math.max(worst, Date.now() - t); await sleep(20); }
    const r = await pr;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.busy, `the reader was in the way: busy (${JSON.stringify(r)})`);
    assert.ok(Date.now() - t0 < 2500 + 500 && cp.stats.lastMs < 1500, `the RESTART did not wait for the reader (${cp.stats.lastMs} ms)`);
    assert.equal(errors, 0, 'no write failed with SQLITE_BUSY');
    assert.ok(worst < 500, `no write waited behind it (worst ${worst} ms)`);
    // it is recorded, and the next try is backed off (tick() does not escalate again at once)
    const st = cp.status();
    assert.equal(st.restartBusy, 1); assert.ok(st.lastRestartBusyAt && st.restartRetryAt && Date.parse(st.restartRetryAt) > Date.now() + 30000);
    h.child.kill(); await h.done;
  });
  test('without a reader a RESTART completes and clears the back-off', async () => {
    const cp = require('../src/engine/checkpoint');
    const r = await cp.run({ mode: 'RESTART' });
    assert.equal(r.ok, true); assert.ok(!r.busy, JSON.stringify(r));
    assert.ok(cp.status().lastOkAt);
  });
});

describe('N4: a lagging or failing checkpoint is visible to the patrol', () => {
  test('/api/admin/health carries the WAL size, last success and warnings; the public one carries none of it', async () => {
    const cp = require('../src/engine/checkpoint'); cp._reset();
    for (let i = 0; i < 700; i++) add({ title: 'y'.repeat(3000) }); // a WAL over WAL_WARN_MB (1 MB here), no checkpoint has run
    const server = require('../src/app').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const adm = await (await fetch(`${base}/api/admin/health`, { headers: { 'x-admin-key': 'test-key' } })).json();
      assert.ok(adm.wal && adm.wal.walMb >= 1 && 'lastOkAt' in adm.wal && 'restartBusy' in adm.wal, JSON.stringify(adm.wal));
      assert.ok(adm.warnings.some((w) => /^WAL is \d+ MB/.test(w) && /last successful checkpoint/.test(w)), JSON.stringify(adm.warnings));
      const pub = await (await fetch(`${base}/api/health`)).json();
      assert.ok(!('wal' in pub) && !pub.warnings.some((w) => /WAL/.test(w)));
    } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    await cp.run(); // a successful checkpoint is remembered
    assert.ok(cp.status().lastOkAt);
  });
});

describe('T1: a takedown sweep survives a locked database', () => {
  test('SQLITE_BUSY is retried with back-off; the job finishes; nothing is left in `running`', async () => {
    for (let i = 0; i < 60; i++) add({ author: 'w13-victim' });
    const job = repo.takedowns.begin({ kind: 'handle', value: 'w13-victim', reason: 'asked' }); // phase 1 done, the sweep not started
    db.pragma('busy_timeout = 50');
    const h = await holder('write', 1800);        // another connection now holds the write lock
    try {
      repo.takedowns.resume();                    // the background runner starts and finds the database locked
      await sleep(900);
      const mid = repo.takedowns.job(job.id);
      assert.equal(mid.done, false, 'still waiting for the lock, not failed');
      assert.notEqual(mid.state, 'failed');
      assert.ok(repo.takedowns._running.has(job.id), 'the runner is alive');
      await h.done;
      for (let i = 0; i < 400 && !repo.takedowns.job(job.id).done; i++) await sleep(25);
      const end = repo.takedowns.job(job.id);
      assert.equal(end.done, true, JSON.stringify(end)); assert.equal(end.purged, 60);
      await sleep(30);
      assert.equal(repo.takedowns._running.has(job.id), false, 'cleaned up');
    } finally { db.pragma('busy_timeout = 5000'); h.child.kill(); }
  });
  test('resume() takes over a runner entry that went stale', async () => {
    for (let i = 0; i < 20; i++) add({ author: 'w13-stale' });
    const job = repo.takedowns.begin({ kind: 'handle', value: 'w13-stale', reason: 'asked' });
    repo.takedowns._running.set(job.id, { at: Date.now() - 10 * 60 * 1000 }); // a chain that died without cleaning up
    repo.takedowns.resume();
    for (let i = 0; i < 300 && !repo.takedowns.job(job.id).done; i++) await sleep(20);
    assert.equal(repo.takedowns.job(job.id).done, true);
  });
  test('a live runner is not duplicated by resume()', async () => {
    for (let i = 0; i < 5; i++) add({ author: 'w13-live' });
    const job = repo.takedowns.begin({ kind: 'handle', value: 'w13-live', reason: 'asked' });
    const mine = { at: Date.now() }; repo.takedowns._running.set(job.id, mine);
    repo.takedowns.resume();
    assert.equal(repo.takedowns._running.get(job.id), mine, 'the fresh entry stays');
    repo.takedowns._running.delete(job.id); repo.takedowns.finishNow(job.id);
  });
});

describe('F1: follow feed uses the per-creator index and reads a bounded number of rows', () => {
  let server; let base;
  before(async () => { server = require('../src/app').createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
  after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const post = async (body) => (await fetch(`${base}/api/follow/feed`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'prism_age=1' }, body: JSON.stringify(body) })).json();

  test("with gathered statistics the 'new' and 'earlier' queries still name ix_media_creator_pub and give the same rows", async () => {
    const cs = [0, 1, 2].map((i) => repo.creators.create({ handle: `w13f${i}`, origin: 'admin' }));
    const t0 = Date.now(); const rows = [];
    for (let i = 0; i < 60; i++) rows.push(add({ creator_id: cs[i % 3].id, title: 't', posted_at: new Date(t0 - i * 60000).toISOString(), ingested_at: new Date(t0 - (i % 9) * 86400000).toISOString() }));
    for (const c of cs) repo.creators.refreshStats(c.id);
    db.exec('ANALYZE');
    const since = new Date(t0 - 4 * 86400000).toISOString();
    const real = db.prepare.bind(db); const seen = [];
    db.prepare = (sql) => { if (/ix_media_creator_pub|FROM media m/.test(sql)) seen.push(sql); return real(sql); };
    try {
      for (const part of ['new', 'earlier']) {
        const r = await post({ follows: cs.map((c) => ({ id: c.id, since })), part, page: 0, limit: 100 });
        const want = real(`SELECT id FROM media WHERE creator_id IN (${cs.map(() => '?').join(',')}) AND publish_state='published' AND ingested_at ${part === 'new' ? '>' : '<='} ? ORDER BY posted_at DESC, seq DESC`).all(...cs.map((c) => c.id), since).map((x) => x.id);
        assert.deepEqual(r.items.map((m) => m.id), want, part);
      }
    } finally { db.prepare = real; }
    assert.ok(seen.some((q) => /INDEXED BY ix_media_creator_pub/.test(q)), 'the per-creator index is named');
    void rows;
  });

  test('the rows one request may read are budgeted: a page too deep for the creators it names answers empty; a far-future since reads a bounded window', async () => {
    const follow = require('../src/routes/follow');
    const cs = [0, 1, 2].map((i) => repo.creators.create({ handle: `w13b${i}`, origin: 'admin' }));
    for (let i = 0; i < 90; i++) add({ creator_id: cs[i % 3].id, title: 't', posted_at: new Date(Date.now() - i * 60000).toISOString() });
    for (const c of cs) repo.creators.refreshStats(c.id);
    const saved = { ...follow._budget };
    follow._budget.rows = 60; // 3 creators -> 20 rows each
    try {
      const f = cs.map((c) => ({ id: c.id }));
      assert.equal((await post({ follows: f, part: 'all', page: 0, limit: 13 })).items.length, 13);
      assert.equal((await post({ follows: f, part: 'all', page: 1, limit: 13 })).items.length, 13);
      const deep = await post({ follows: f, part: 'all', page: 2, limit: 13 });
      assert.deepEqual([deep.items.length, deep.total], [0, null], 'past the per-creator budget: empty');
    } finally { Object.assign(follow._budget, saved); }
    follow._budget.scan = 6; // 3 creators -> a window of max(need, 2)
    try {
      const far = new Date(Date.now() + 365 * 86400000).toISOString();
      const r = await post({ follows: cs.map((c) => ({ id: c.id, since: far })), part: 'earlier', page: 0, limit: 5 });
      assert.equal(r.items.length, 5); assert.equal(r.totalCapped, true, 'a window smaller than the creators\' libraries says so');
    } finally { Object.assign(follow._budget, saved); }
  });
});
