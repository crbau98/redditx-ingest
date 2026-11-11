'use strict';
/**
 * The loop watchdog (lib/blockwatch.js): a stall is recorded against the job that was running,
 * which is what makes a multi-second pause in /api/health actionable instead of a bare number.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let blockwatch;

before(() => {
  prepareEnv({ PRISM_SLOW_BLOCK_MS: '60', ADMIN_KEY: 'test-key' }); // a 60 ms threshold keeps the test quick
  blockwatch = require('../src/lib/blockwatch');
});
after(() => { blockwatch.stop(); blockwatch.reset(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (ms) => { const end = Date.now(); while (Date.now() - end < ms) { /* busy: this is the stall */ } };

describe('loop watchdog', () => {
  test('a stall is recorded against the job that was running', async () => {
    blockwatch.start();
    blockwatch.reset();
    blockwatch.work('testJob');
    await wait(120); // one full sample window, clean
    block(250);      // the stall
    await wait(400); // let the sampler notice it
    const b = blockwatch.lastBlock();
    assert.ok(b, 'a block was recorded');
    assert.ok(b.ms >= 60, `expected at least the threshold, got ${b.ms}`);
    assert.equal(b.job, 'testJob', 'attributed to the active job');
    assert.ok(b.at, 'and stamped');
    assert.ok(blockwatch.blocks().length >= 1, 'the recent list keeps it too');
    blockwatch.stop();
    blockwatch.work('idle');
    blockwatch.reset();
  });

  test('around() restores the previous label even when the job throws', async () => {
    blockwatch.work('outer');
    await assert.rejects(() => blockwatch.around('inner', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(blockwatch.current(), 'outer', 'the outer label is back after around()');
    blockwatch.work('idle');
    blockwatch.reset();
  });

  test('clean runs record nothing', async () => {
    blockwatch.start();
    blockwatch.reset();
    blockwatch.work('idle');
    await wait(200);
    assert.equal(blockwatch.lastBlock(), null, 'no stall, no warning');
    blockwatch.stop();
    blockwatch.reset();
  });

  test('a 1.5 s synchronous block under two concurrent labels reports both', async () => {
    blockwatch.start();
    blockwatch.reset();
    blockwatch.work('idle');
    const leaveA = blockwatch.enter('feed web:aaa');
    const leaveB = blockwatch.enter('feed redgifs:bbb');
    await wait(120);
    block(1500);
    await wait(400);
    const b = blockwatch.lastBlock();
    assert.ok(b && b.ms >= 1400, `a long block was recorded (${b && b.ms})`);
    assert.deepEqual(b.jobs, ['feed web:aaa', 'feed redgifs:bbb'], 'both overlapping jobs are named, not only the last to start');
    assert.equal(b.job, 'feed web:aaa, feed redgifs:bbb');
    assert.equal(typeof b.gcMs, 'number', 'and how much of it was garbage collection');
    leaveA(); leaveB();
    blockwatch._noteBlock(0); // the window ends
    assert.deepEqual(blockwatch.labels(), [], 'a finished job leaves no label behind');
    blockwatch.stop();
    blockwatch.reset();
  });

  test('a block inside a timer callback that also ends its job is caught, measured and labelled', async () => {
    // The histogram alone missed this: both timers are overdue after the stall and the sampler can read the
    // histogram before the delay lands in it. The tick's own lateness catches it; the late reading is folded in.
    blockwatch.start();
    blockwatch.reset();
    const leave = blockwatch.enter('feed web:timer');
    await new Promise((r) => setTimeout(() => { block(1200); leave(); r(); }, 300));
    await wait(700);
    const all = blockwatch.blocks().filter((b) => b.ms >= 1000);
    assert.equal(all.length, 1, 'one block, not a duplicate from the late histogram reading');
    assert.ok(all[0].ms >= 1150 && all[0].ms <= 1500, `measured ${all[0].ms}`);
    assert.deepEqual(all[0].jobs, ['feed web:timer']);
    blockwatch.stop();
    blockwatch.reset();
  });

  test('around() and a shared work() label are both reported', () => {
    blockwatch.reset();
    const leave = blockwatch.enter('feed coomer:ccc');
    blockwatch.work('imageSweep');
    const rec = blockwatch._noteBlock(900);
    assert.deepEqual(rec.jobs, ['feed coomer:ccc', 'imageSweep']);
    leave(); blockwatch.work('idle'); blockwatch.reset();
  });

  test('a job whose last synchronous stretch is the block still owns that block', () => {
    blockwatch.reset();
    const leave = blockwatch.enter('feed web:ending');
    leave(); // finished in the same tick as the block
    const rec = blockwatch._noteBlock(3200);
    assert.deepEqual(rec.jobs, ['feed web:ending']);
    assert.equal(blockwatch._noteBlock(3200).job, 'idle', 'the next window no longer carries it');
    blockwatch.reset();
  });

  test('GC pauses over 200 ms are recorded with their kind and counted into the next block', () => {
    blockwatch.reset();
    assert.equal(blockwatch._noteGc(50, 1), null, 'a short pause is only counted');
    const rec = blockwatch._noteGc(450, 2);
    assert.equal(rec.ms, 450); assert.equal(rec.kind, 'major');
    assert.deepEqual({ ms: blockwatch.lastGc().ms, kind: blockwatch.lastGc().kind }, { ms: 450, kind: 'major' });
    const b = blockwatch._noteBlock(1200);
    assert.equal(b.gcMs, 500, 'the block says 500 ms of it was GC');
    blockwatch.reset();
  });

  test('profiles are written only on request and capped at two files', async () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-prof-'));
    try {
      for (let i = 0; i < 4; i++) {
        await blockwatch._writeProfile(dir, { nodes: [], samples: [], i }, { ms: 3000 + i, job: 'feed web:x', at: new Date(Date.UTC(2026, 10, 11, 0, 0, i)).toISOString() });
      }
      const files = fs.readdirSync(dir).sort();
      assert.equal(files.length, blockwatch.PROFILE_KEEP);
      assert.match(files[1], /3003ms\.cpuprofile$/, 'the newest stay');
      assert.deepEqual(blockwatch.profiles(), files);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a feed run labels itself by platform and feed id, and leaves the label when it finishes', () => {
    const fs = require('fs'); const path = require('path');
    const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'engine.js'), 'utf8');
    assert.match(engine, /const leaveWatch = blockwatch\.enter\(`feed \$\{feed\.platform\}:\$\{feed\.id\}`\)/);
    assert.match(engine, /const finish = \(status, extra = \{\}\) => \{\n    leaveWatch\(\);/);
  });

  test('the link-health sweep and the deep-pull rotation carry their own labels', () => {
    const fs = require('fs');
    const path = require('path');
    const health = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'health.js'), 'utf8');
    assert.match(health, /around\('linkHealth'/, 'the 10-minute sweep must not wear whoever ran before it');
    const ds = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'deepsearch.js'), 'utf8');
    assert.match(ds, /work\('deepPull'\)/, 'the rotation kick is tagged while it fans out');
  });
});
test('saved profiles can be listed and downloaded by an admin only, by exact file name', async () => {
  const fs = require('fs'); const path = require('path');
  const bw = require('../src/lib/blockwatch');
  const dir = path.join(require('../src/config').dataDir, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const name = 'block-2026-11-11T18-29-56-067Z-100461ms.cpuprofile';
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ nodes: [], samples: [] }));
  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    assert.equal((await fetch(`${base}/profiles`)).status, 401);
    const list = await (await fetch(`${base}/profiles`, { headers: { 'x-admin-key': 'test-key' } })).json();
    assert.ok(list.files.includes(name));
    const got = await fetch(`${base}/profiles/${name}`, { headers: { 'x-admin-key': 'test-key' } });
    assert.equal(got.status, 200);
    assert.deepEqual(await got.json(), { nodes: [], samples: [] });
    assert.equal((await fetch(`${base}/profiles/${encodeURIComponent('../test.db')}`, { headers: { 'x-admin-key': 'test-key' } })).status, 404);
    assert.equal(bw.profilePath('../../etc/passwd'), null);
  } finally {
    require('../src/engine/engine').shutdown();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a synchronous block inside a boot warm-up step is reported against warm:<step>', async () => {
  const bw = require('../src/lib/blockwatch');
  const { _warmStep } = require('../src/routes/public');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const block = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* the stall */ } };
  bw.start(); bw.reset(); bw.work('idle');
  await wait(120);
  _warmStep('visualIndex', () => block(400));
  await wait(400);
  const b = bw.lastBlock();
  assert.ok(b && b.ms >= 300, `recorded (${b && b.ms})`);
  assert.ok(b.jobs.includes('warm:visualIndex'), JSON.stringify(b.jobs));
  // an async step keeps its label until it settles, then leaves none behind
  let done; const p = new Promise((r) => { done = r; });
  _warmStep('dedupe', () => p);
  assert.ok(bw.labels().includes('warm:dedupe'));
  done(); await p; await wait(0);
  bw._noteBlock(0);
  assert.ok(!bw.labels().includes('warm:dedupe'));
  bw.stop(); bw.reset();
});

test('every boot warm-up step runs under a named label', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'public.js'), 'utf8');
  for (const name of ['prep:recent', 'prep:trending', 'prep:foryou', 'prep:reddit', 'prep:tag-gay', 'prep:creators']) assert.ok(src.includes(`['${name}', `), name);
  assert.match(src, /warmStep\('dedupe', /); assert.match(src, /warmStep\('visualIndex', buildVisual\)/);
  assert.match(src, /warmStep\('snapshots', primeSnapshots\)/);
  assert.match(src, /try \{ if \(g\[0\]\) warmStep\(g\[0\], g\[1\]\); else g\[1\]\(\); \}/, 'warm() runs named steps through warmStep (the index pair labels itself)');
  assert.match(src, /try \{ warmStep\(g\[0\], g\[1\]\); \}/, 'warmPrep() runs every step through warmStep');
});

test('the visual index build starts only after the dedupe load has settled, never alongside it', async () => {
  const bw = require('../src/lib/blockwatch');
  const { _warmIndexes } = require('../src/routes/public');
  let finishDedupe; const dedupe = new Promise((r) => { finishDedupe = r; });
  let visualStarted = 0;
  const all = _warmIndexes(() => dedupe, () => { visualStarted++; return Promise.resolve(); });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(visualStarted, 0, 'not started while dedupe is pending');
  assert.ok(bw.labels().includes('warm:dedupe'));
  assert.ok(!bw.labels().includes('warm:visualIndex'), 'its label is not there either');
  finishDedupe();
  await all;
  assert.equal(visualStarted, 1);
  // a failing dedupe load still lets the visual build run
  let ran = 0;
  await _warmIndexes(() => Promise.reject(new Error('boom')), () => { ran++; });
  assert.equal(ran, 1);
  bw._noteBlock(0);
  assert.ok(!bw.labels().some((l) => l.startsWith('warm:')), 'no warm label left behind');
});
