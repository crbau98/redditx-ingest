'use strict';
/**
 * Wave 14: the visual index build after a deploy never holds the loop in one stretch. It loads in time-sized seq windows, computes
 * the mean and the per-row constants in row slices, names every slice for blockwatch, and installs the result in one step.
 * Requests never build it synchronously in production (they answer from tags until it is ready).
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ PRISM_SLOW_BLOCK_MS: '60', PRISM_SLICE_MIN_MS: '1' });
const repo = require('../src/db/repo'); const { db } = repo;
const emb = require('../src/lib/embeddings');
const visual = require('../src/engine/visual');
const ROOT = path.join(__dirname, '..');

const vec = () => { const b = crypto.randomBytes(4 + emb.DIM); b.writeFloatLE(0.01 + Math.random() * 0.02, 0); return b; };
before(() => {
  visual.ensureTable();
  const cs = []; for (let i = 0; i < 30; i++) cs.push(repo.creators.create({ handle: `w14v${i}`, origin: 'admin' }).id);
  const ins = db.prepare('INSERT INTO media_embeddings (media_id, model, vec) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      const id = repo.media.insert({ creator_id: cs[i % 30], platform: 'reddit', source_id: `w14-${i}`, source_key: `reddit:w14-${i}:0`, post_key: `reddit:w14-${i}`, media_type: 'image', media_url: `https://i.redd.it/w14-${i}.jpg`, hash: `w14h${i}`, posted_at: new Date().toISOString() }, []);
      if (i % 3) ins.run(id, emb.MODEL_ID, vec());
    }
  })();
});

const close = (a, b, eps = 1e-3) => a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]) <= eps * Math.max(1, Math.abs(b[i])));

describe('chunked build', () => {
  test('warmIndex gives the same index as the synchronous build: rows, mean and per-row constants', async () => {
    visual._reset();
    const sync = visual._index(); // the inline (test) path: one synchronous build
    const want = { ids: [...sync.ids], mean: Float64Array.from(sync.mean), dm: sync.dm.slice(0, sync.n), nc: sync.nc.slice(0, sync.n), n: sync.n };
    visual._reset();
    const n = await visual.warmIndex();
    const got = visual._index();
    assert.equal(n, want.n);
    assert.deepEqual(got.ids, want.ids);
    assert.ok(close(got.mean, want.mean), 'mean');
    assert.ok(close(got.dm.slice(0, got.n), want.dm) && close(got.nc.slice(0, got.n), want.nc), 'constants');
    assert.equal(got.n <= got.cap && got.cap < want.n * 1.2 + 1024, true, 'preallocated, not doubled');
  });

  test('the loop turns between slices and every slice is named for blockwatch', async () => {
    const bw = require('../src/lib/blockwatch');
    const seen = new Set(); const real = bw.slice;
    bw.slice = (label, fn) => { seen.add(label); return real(label, fn); };
    visual._reset();
    let ticks = 0; const t = setInterval(() => { ticks++; }, 0);
    try { await visual.warmIndex(); } finally { clearInterval(t); bw.slice = real; }
    for (const l of ['visual:load', 'visual:mean', 'visual:centre']) assert.ok(seen.has(l), `${l} recorded`);
    assert.ok(ticks >= 5, `timers ran during the build (${ticks})`);
  });

  test('a due re-mean on the request path is not done synchronously; refreshAsync gives the full-pass result', async () => {
    visual._reset(); await visual.warmIndex();
    const x = visual._index();
    const oldMean = Float64Array.from(x.mean);
    x.meanN = Math.floor(x.n / 2); x.dirty = true; // a re-mean is due
    visual._finish(x, { allowFull: false });
    assert.ok(close(x.mean, oldMean, 0), 'the mean did not change synchronously');
    await visual._refreshAsync(x);
    assert.equal(x.meanN, x.n);
    const full = { ...x, dirty: true, mean: null }; full.dm = null; visual._finish(full);
    assert.ok(close(x.mean, full.mean) && close(x.dm.slice(0, x.n), full.dm.slice(0, x.n)), 'same as the synchronous full pass');
  });
});

describe('production requests never build the index', () => {
  test('similar() answers null (tags stand in) until the boot build is installed, then answers by look', () => {
    const dir = require('fs').mkdtempSync(path.join(os.tmpdir(), 'w14-vis-'));
    const code = `
      const repo=require('./src/db/repo'); const emb=require('./src/lib/embeddings'); const v=require('./src/engine/visual'); const crypto=require('crypto');
      v.ensureTable(); const ins=repo.db.prepare('INSERT INTO media_embeddings (media_id, model, vec) VALUES (?, ?, ?)'); let first=null;
      for(let i=0;i<60;i++){ const id=repo.media.insert({platform:'reddit',source_id:'p'+i,source_key:'reddit:p'+i+':0',post_key:'reddit:p'+i,media_type:'image',media_url:'https://i.redd.it/p'+i+'.jpg',hash:'ph'+i,posted_at:new Date().toISOString()},[]); first=first||id; const b=crypto.randomBytes(4+emb.DIM); b.writeFloatLE(0.02,0); ins.run(id,emb.MODEL_ID,b); }
      const before=v.similar(first,5); const creators=v.similarCreators('x');
      v.warmIndex().then(()=>{ const after=v.similar(first,5); process.stdout.write(JSON.stringify({before, creators, after: Array.isArray(after) ? after.length : after})); process.exit(0); });`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development', DB_PATH: path.join(dir, 't.db'), SCHEDULER_ENABLED: 'false' }, encoding: 'utf8', timeout: 60000 });
    const out = JSON.parse(r.stdout || '{}');
    assert.equal(out.before, null, r.stderr);
    assert.equal(out.creators, null);
    assert.ok(out.after > 0, JSON.stringify(out));
  });
});
