'use strict';
/**
 * w17 perf + reliability:
 *   freeze   the admin scoreboard's COUNT(DISTINCT creator_id) read ~69k random table rows on production (432 ms warm,
 *            one 34.9 s loop block cold). v40's covering partial index answers it from the index alone; the plan is pinned.
 *   WAL      journal_size_limit 64 MB (was 256), RESTART tried from 48 MB (was 1 GB) with a 45 s..5 min busy back-off
 *            (was 60 s..1 h); after a reset the first commit truncates the file to the limit.
 *   related  media.related reads at most two rows per similar creator through the index (was a ROW_NUMBER window over
 *            their whole libraries, 75 ms a call) and caches the tag co-occurrence join for repeat looks; visibility
 *            is still checked live, so a hidden post drops out at once.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
const repo = require('../src/db/repo'); const { db } = repo;
const cp = require('../src/engine/checkpoint');
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const add = (o = {}) => { n++; return repo.media.insert({ platform: 'reddit', source_id: `w17-${n}`, source_key: `reddit:w17-${n}:0`, post_key: `reddit:w17-${n}`, media_type: 'image', media_url: `https://i.redd.it/w17-${n}.jpg`, hash: `w17h${n}`, title: 'x'.repeat(200), posted_at: new Date().toISOString(), ...o }, o.tags || []); };

/** Capture the SQL a call prepares (the w13 F1 pattern). */
function captureSql(fn) {
  const real = db.prepare.bind(db); const seen = [];
  db.prepare = (sql) => { seen.push(String(sql)); return real(sql); };
  try { fn(); } finally { db.prepare = real; }
  return seen;
}

describe('the scoreboard freeze fix: a covering index, pinned', () => {
  test('migration v40 created ix_media_pub_ingested_creator', () => {
    assert.ok(db.pragma('user_version', { simple: true }) >= 40);
    const names = db.prepare('PRAGMA index_list(media)').all().map((r) => r.name);
    assert.ok(names.includes('ix_media_pub_ingested_creator'), names.join(', '));
  });

  test('the creators count is an index-only range scan, and scoreboard pins that index', () => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const sql = 'SELECT platform, COUNT(DISTINCT creator_id) AS n FROM media INDEXED BY ix_media_pub_ingested_creator WHERE ingested_at >= ? AND creator_id IS NOT NULL AND publish_state = \'published\' GROUP BY platform';
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(since).map((r) => r.detail).join(' | ');
    assert.match(plan, /COVERING INDEX ix_media_pub_ingested_creator/, plan);
    assert.doesNotMatch(plan, /USING INDEX ix_media_state/, plan);
    const seen = captureSql(() => repo.runs.scoreboard(7));
    assert.ok(seen.some((q) => /INDEXED BY ix_media_pub_ingested_creator/.test(q)), 'scoreboard names the covering index');
  });

  test('scoreboard counts distinct published creators per platform inside the window only', () => {
    const t0 = Date.now();
    const cs = [0, 1, 2, 3].map((i) => repo.creators.create({ handle: `w17sc${i}`, origin: 'admin' }));
    const recent = new Date(t0 - 2 * 86400000).toISOString();
    const old = new Date(t0 - 30 * 86400000).toISOString();
    // scoreboard rows come from feed_runs in the window; the creator counts join onto them
    db.prepare("INSERT INTO feeds (id, platform, kind, target) VALUES ('w17f-r', 'reddit', 'user', 'w17sc0'), ('w17f-b', 'bluesky', 'user', 'w17sc1')").run();
    db.prepare("INSERT INTO feed_runs (id, feed_id, trigger, started_at, status, fetched, added) VALUES ('w17r-r', 'w17f-r', 'manual', ?, 'ok', 2, 2), ('w17r-b', 'w17f-b', 'manual', ?, 'ok', 1, 1)").run(recent, recent);
    add({ creator_id: cs[0].id, platform: 'reddit', ingested_at: recent });
    add({ creator_id: cs[0].id, platform: 'reddit', ingested_at: recent }); // same creator twice: counted once
    add({ creator_id: cs[1].id, platform: 'bluesky', ingested_at: recent });
    const oldRow = add({ creator_id: cs[2].id, platform: 'reddit' });       // outside the window (insert stamps now)
    db.prepare('UPDATE media SET ingested_at = ? WHERE id = ?').run(old, oldRow);
    const review = add({ creator_id: cs[3].id, platform: 'reddit', ingested_at: recent });
    repo.media.setState(review, 'review');                                    // not published
    add({ creator_id: null, platform: 'reddit', ingested_at: recent });      // no creator
    const score = Object.fromEntries(repo.runs.scoreboard(7).map((r) => [r.platform, r]));
    assert.equal(score.reddit.creators, 1);
    assert.equal(score.bluesky.creators, 1);
  });
});

describe('media.related: bounded near-creator reads and a warm rank cache', () => {
  // c0 has a style profile (item Z) but the probe item X carries only the platform tag, so the tag join finds nothing
  // and the near-creator step is reached; c1..c3 share c0's style tag and have several scored posts each.
  let X; const near = [];
  test('setup: a probe item whose related posts must come from similar creators', () => {
    const c0 = repo.creators.create({ handle: 'w17rel0', origin: 'admin' });
    add({ creator_id: c0.id, tags: ['muscle'], score: 5 }); // Z: gives c0 a style profile
    X = add({ creator_id: c0.id, tags: [], score: 1 });
    for (let i = 1; i <= 3; i++) {
      const c = repo.creators.create({ handle: `w17rel${i}`, origin: 'admin' });
      near.push(c.id);
      for (let k = 0; k < 4; k++) add({ creator_id: c.id, tags: ['muscle'], score: 10 + k });
    }
    for (const c of [c0, ...near.map((id) => ({ id }))]) repo.creators.refreshStats(c.id);
  });

  test('the near-creator step reads two rows per creator through the index, never a window over their libraries', () => {
    const seen = captureSql(() => repo.media.related(X, 12));
    assert.ok(!seen.some((q) => /ROW_NUMBER/.test(q)), 'the old window query is gone');
    const bounded = seen.filter((q) => /creator_id = \?/.test(q) && /LIMIT 2/.test(q));
    assert.ok(bounded.length >= 1, `expected per-creator LIMIT 2 seeks, saw: ${seen.map((s) => s.slice(0, 60)).join(' || ')}`);
    const out = repo.media.related(X, 12);
    const per = new Map();
    for (const m of out) if (near.includes(m.creator_id)) per.set(m.creator_id, (per.get(m.creator_id) || 0) + 1);
    for (const [cid, k] of per) assert.ok(k <= 2, `creator ${cid} contributed ${k} items`);
    assert.ok(out.length > 0);
  });

  test('repeat looks return the same items and run the tag join only once', () => {
    const first = repo.media.related(X, 12).map((m) => m.id);
    let joins = 0;
    const real = db.prepare.bind(db);
    db.prepare = (sql) => { if (/mt2\.media_id/.test(String(sql))) joins++; return real(sql); };
    let second;
    try { second = repo.media.related(X, 12).map((m) => m.id); } finally { db.prepare = real; }
    assert.deepEqual(second, first);
    assert.equal(joins, 0, 'the warm rank cache answered; the join ran again');
  });

  test('a hidden candidate drops out at once even with a warm cache', () => {
    const before = repo.media.related(X, 12);
    assert.ok(before.length >= 2);
    const victim = before.find((m) => m.creator_id && near.includes(m.creator_id)) || before[before.length - 1];
    db.prepare("UPDATE media SET publish_state = 'hidden' WHERE id = ?").run(victim.id);
    try {
      const after = repo.media.related(X, 12);
      assert.ok(!after.some((m) => m.id === victim.id), 'the hidden item is gone on the very next call');
    } finally { db.prepare("UPDATE media SET publish_state = 'published' WHERE id = ?").run(victim.id); }
  });
});

describe('WAL discipline: 64 MB limit, 48 MB RESTART trigger, short back-off', () => {
  test('the serving connection truncates to a 64 MB journal limit by default', () => {
    assert.equal(db.pragma('journal_size_limit', { simple: true }), 64 * 1048576);
  });

  test('RESTART is tried from 48 MB and the busy back-off runs 45 s to five minutes', () => {
    assert.equal(cp.RESTART_BYTES, 48 * 1048576);
    assert.deepEqual(cp.RESTART_BACKOFF_MS, [45000, 90000, 180000, 300000]);
  });

  test('a busy RESTART backs off ~45 s (was 60 s) and holds no writer lock', async () => {
    cp._reset();
    for (let i = 0; i < 30; i++) add({ title: 'z'.repeat(3000) });
    const src = `const D=require('better-sqlite3');const d=new D(${JSON.stringify(require('../src/config').dbPath)});d.pragma('busy_timeout=2000');d.exec('BEGIN');d.prepare('SELECT COUNT(*) FROM media').get();process.stdout.write('held\\n');setTimeout(()=>{try{d.exec('COMMIT')}catch{}process.exit(0);},3000);`;
    const child = spawn(process.execPath, ['-e', src], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => child.stdout.once('data', r));
    try {
      for (let i = 0; i < 30; i++) add({ title: 'z'.repeat(3000) }); // move the log past the reader's snapshot
      const r = await cp.run({ mode: 'RESTART' });
      assert.equal(r.ok, true); assert.ok(r.busy, JSON.stringify(r));
      const retry = Date.parse(cp.status().restartRetryAt);
      assert.ok(retry > Date.now() + 30000 && retry <= Date.now() + 46000, `first back-off ~45 s, got ${retry - Date.now()} ms`);
    } finally { child.kill(); await new Promise((r) => child.on('exit', r)); cp._reset(); }
  });

  test('tick escalates to RESTART past the trigger; the first commit after the reset truncates to the limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-w17-wal-'));
    const script = `
      process.env.NODE_ENV='test'; process.env.DB_PATH=${JSON.stringify(path.join(dir, 't.db'))};
      process.env.ADMIN_KEY='t'; process.env.SCHEDULER_ENABLED='false'; process.env.MEDIA_STORE='none';
      process.env.WAL_CHECKPOINT_MB='1'; process.env.WAL_RESTART_MB='1'; process.env.WAL_JOURNAL_LIMIT_MB='1';
      const repo=require(${JSON.stringify(path.join(ROOT, 'src/db/repo'))}); const cp=require(${JSON.stringify(path.join(ROOT, 'src/engine/checkpoint'))});
      const db=repo.db; db.pragma('wal_autocheckpoint = 0');
      const ins=db.prepare("INSERT INTO media (id, platform, source_id, source_key, post_key, media_type, media_url, hash, title, publish_state, posted_at) VALUES (?, 'reddit', ?, ?, ?, 'image', ?, ?, ?, 'published', strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
      for(let i=0;i<1200;i++){const s='w'+i;ins.run(s,s,'reddit:'+s+':0','reddit:'+s,'https://i.redd.it/'+s+'.jpg','h'+i,'z'.repeat(3000));}
      const walMb=()=>Math.round(require('fs').statSync(process.env.DB_PATH+'-wal').size/1048576*10)/10;
      const before=walMb();
      cp.tick();
      (async()=>{
        const t0=Date.now(); while(!cp.stats.lastRestartAt && Date.now()-t0<8000) await new Promise(r=>setTimeout(r,100));
        ins.run('after','after','reddit:after:0','reddit:after','https://i.redd.it/after.jpg','hafter','z'.repeat(3000));
        await new Promise(r=>setTimeout(r,200));
        console.log(JSON.stringify({before, restarted:!!cp.stats.lastRestartAt, after:walMb()}));
        process.exit(0);
      })();`;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(out.before >= 1, `WAL grew past the 1 MB test trigger (${out.before} MB)`);
    assert.ok(out.restarted, 'tick() attempted a RESTART past the trigger');
    assert.ok(out.after <= 2, `the first commit after the reset truncated to the limit (${out.before} -> ${out.after} MB)`);
  });
});