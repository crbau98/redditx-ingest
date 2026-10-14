'use strict';
/**
 * v5 "More like this" by look: compact visual vectors (lib/embeddings), a background backfill and an in-memory index
 * (engine/visual), and GET /api/media/:id/similar with a tag-based fallback.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let visual; let imagefilter; let emb;
const AGE = { cookie: 'prism_age=1' };
const pub = async (p) => { const res = await fetch(`${base}${p}`, { headers: AGE }); return { status: res.status, json: await res.json() }; };
const assets = (f) => path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'assets', f);
const haveModel = fs.existsSync(assets('screenshot-faceid.jpg')) && (() => { try { require.resolve('sharp'); require.resolve('@tensorflow/tfjs-backend-wasm'); return true; } catch { return false; } })();

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  visual = require('../src/engine/visual');
  imagefilter = require('../src/lib/imagefilter');
  emb = require('../src/lib/embeddings');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { imagefilter._reset(); engine.shutdown(); await imagefilter.shutdown(); await new Promise((r) => server.close(r)); });

const cos = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
const unit = (v) => { const n = Math.hypot(...v) || 1; return Float32Array.from(v, (x) => x / n); };
const asFloat = (buf) => { const u = emb.unpack(buf); return Float32Array.from(u.q, (x) => x * u.scale); };

describe('vectors', () => {
  test('pack / unpack keep the direction; malformed blobs are refused', () => {
    const v = unit(Array.from({ length: emb.DIM }, (_, i) => Math.sin(i * 1.7)));
    const back = asFloat(emb.pack(v));
    assert.ok(cos(v, unit(back)) > 0.999);
    assert.equal(emb.pack(v).length, emb.DIM + 4);
    assert.equal(emb.unpack(Buffer.alloc(10)), null);
  });
  test('the projection is fixed, so every process agrees', () => {
    const f = Float32Array.from({ length: 1280 }, (_, i) => (i % 7) / 7);
    const a = emb.project(f); const b = emb.project(f);
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.ok(Math.abs(cos(a, a) - 1) < 1e-5, 'unit length');
  });
});

describe('the real model (on-device, no network)', { skip: !haveModel && 'optional ML dependencies not installed' }, () => {
  test('an edited copy of a photo is closer than an unrelated picture', async () => {
    const sharp = require('sharp');
    const { createModel } = require('../src/lib/imagefilter-core');
    const model = await createModel();
    const photo = fs.readFileSync(assets('screenshot-faceid.jpg'));
    const meta = await sharp(photo).metadata();
    const edited = await sharp(photo).flop().extract({ left: 8, top: 8, width: meta.width - 24, height: meta.height - 24 }).modulate({ brightness: 1.1 }).jpeg().toBuffer();
    const other = fs.readFileSync(assets('screenshot-typedoc.png'));
    const [a, b, c] = [await model.embed(photo), await model.embed(edited), await model.embed(other)].map(asFloat).map(unit);
    assert.ok(cos(a, b) > cos(a, c) + 0.1, `edited ${cos(a, b).toFixed(3)} vs unrelated ${cos(a, c).toFixed(3)}`);
  });
});

describe('similar posts by look', () => {
  let n = 0;
  const post = (creator, tags, extra = {}) => {
    n++;
    const id = repo.media.insert({ creator_id: creator.id, platform: 'x', source_id: `vis${n}`, source_key: `x:vis${n}:0`, post_key: `x:vis${n}`, author: creator.handle,
      title: `post ${n}`, media_type: 'image', media_url: `https://pbs.twimg.com/vis${n}.jpg`, hash: `vish${n}`, ...extra }, tags);
    repo.creators.refreshStats(creator.id);
    return id;
  };
  // Three looks ("gym", "beach", "mirror"), each a direction plus a little per-picture noise.
  const look = (k, seed) => unit(Array.from({ length: emb.DIM }, (_, i) => (i % 3 === k ? 1 : 0) + 0.15 * Math.sin(seed * 13.1 + i * 0.7)));
  const w = { byUrl: new Map() };

  before(async () => {
    const cs = ['vis_a', 'vis_b', 'vis_c', 'vis_d'].map((h) => repo.creators.create({ handle: h }));
    w.cs = cs;
    w.gym = []; w.beach = []; w.mirror = [];
    let seed = 0;
    for (const c of cs) {
      for (let i = 0; i < 3; i++) { const id = post(c, ['gym']); w.gym.push(id); w.byUrl.set(`https://pbs.twimg.com/vis${n}.jpg`, look(0, ++seed)); }
      for (let i = 0; i < 3; i++) { const id = post(c, ['beach']); w.beach.push(id); w.byUrl.set(`https://pbs.twimg.com/vis${n}.jpg`, look(1, ++seed)); }
      for (let i = 0; i < 2; i++) { const id = post(c, ['mirror']); w.mirror.push(id); w.byUrl.set(`https://pbs.twimg.com/vis${n}.jpg`, look(2, ++seed)); }
    }
    // a carousel sibling of the first gym post, and one picture that cannot be fetched
    w.sibling = post(cs[0], ['gym'], { post_key: repo.media.get(w.gym[0]).post_key, position: 1, source_key: 'x:sib:1' });
    w.byUrl.set(`https://pbs.twimg.com/vis${n}.jpg`, look(0, 999));
    w.broken = post(cs[1], ['gym']);
    w.noVector = w.broken;
    imagefilter._setEmbedder(async (url) => (w.byUrl.has(url) ? { status: 'ok', vec: emb.pack(w.byUrl.get(url)) } : { status: 'error', reason: 'http 404' }));
    visual._reset();
    const r = await visual.backfill(100);
    assert.equal(r.failed, 1); assert.equal(r.embedded, w.byUrl.size);
    assert.deepEqual(await visual.backfill(100), { embedded: 0, failed: 0 }, 'nothing is embedded twice and failures are not retried at once');
  });

  test('nearest posts share the look, across creators, at most two per creator, never the same post', async () => {
    const r = await pub(`/api/media/${w.gym[0]}/similar?limit=6`);
    assert.equal(r.status, 200);
    assert.equal(r.json.basis, 'look');
    const ids = r.json.items.map((x) => x.id);
    assert.equal(ids.length, 6);
    assert.ok(ids.every((id) => w.gym.includes(id)), 'all gym-look posts');
    assert.ok(!ids.includes(w.gym[0]) && !ids.includes(w.sibling), 'not itself or its carousel sibling');
    const per = {};
    for (const it of r.json.items) per[it.creator_id] = (per[it.creator_id] || 0) + 1;
    assert.ok(Object.values(per).every((k) => k <= 2), JSON.stringify(per));
    assert.ok(r.json.items.every((x) => x.similarity > 0 && x.similarity <= 1));
    assert.ok(r.json.items[0].similarity >= r.json.items[5].similarity);
  });

  test('hidden posts and creators drop out', async () => {
    const victim = w.beach[1];
    repo.media.setState(victim, 'hidden', 'physique:test');
    repo.creators.update(w.cs[3].id, { status: 'hidden' });
    visual._reset();
    const r = await pub(`/api/media/${w.beach[0]}/similar?limit=5`); // 5 beach posts remain visible within the per-creator cap
    const ids = r.json.items.map((x) => x.id);
    assert.ok(!ids.includes(victim));
    assert.ok(!r.json.items.some((x) => x.creator_id === w.cs[3].id));
    assert.ok(ids.length === 5 && ids.every((id) => w.beach.includes(id)), JSON.stringify(ids));
  });

  test('an item without a vector falls back to tags; new posts join the index as they are embedded', async () => {
    const r = await pub(`/api/media/${w.noVector}/similar`);
    assert.equal(r.json.basis, 'tags');
    const fresh = post(w.cs[0], ['mirror']);
    w.byUrl.set(`https://pbs.twimg.com/vis${n}.jpg`, look(2, 4242));
    await visual._index();
    assert.deepEqual(await visual.backfill(10), { embedded: 1, failed: 0 });
    const m = await pub(`/api/media/${w.mirror[0]}/similar?limit=12`);
    assert.ok(m.json.items.some((x) => x.id === fresh), 'found without rebuilding the index');
    assert.equal((await pub('/api/media/00000000-0000-0000-0000-000000000000/similar')).status, 404);
  });
});

describe('creators with a similar look', () => {
  test('a creator whose pictures look like his ranks first; without a profile it falls back to tags', async () => {
    const mk = (h) => repo.creators.create({ handle: h });
    const [p, q, r] = [mk('look_p'), mk('look_q'), mk('look_r')];
    const vec = (k, s) => { const v = Array.from({ length: emb.DIM }, (_, i) => (i % 5 === k ? 1 : 0) + 0.1 * Math.sin(s * 3.3 + i)); const n = Math.hypot(...v); return v.map((x) => x / n); };
    const urls = new Map();
    let s = 0;
    for (const [c, k] of [[p, 3], [q, 3], [r, 4]]) {
      for (let i = 0; i < 4; i++) {
        const id = repo.media.insert({ creator_id: c.id, platform: 'x', source_id: `lk${++s}`, source_key: `x:lk${s}:0`, post_key: `x:lk${s}`, author: c.handle, title: 't', media_type: 'image', media_url: `https://pbs.twimg.com/lk${s}.jpg`, hash: `lkh${s}` }, ['gym']);
        repo.creators.refreshStats(c.id);
        urls.set(`https://pbs.twimg.com/lk${s}.jpg`, vec(k, s));
        void id;
      }
    }
    imagefilter._setEmbedder(async (url) => (urls.has(url) ? { status: 'ok', vec: emb.pack(Float32Array.from(urls.get(url))) } : { status: 'error' }));
    visual._reset();
    await visual.backfill(200);
    const res = await pub(`/api/creators/${p.id}/similar?by=look&limit=5`);
    assert.equal(res.status, 200);
    assert.equal(res.json[0].id, q.id, JSON.stringify(res.json.map((c) => c.handle)));
    assert.ok(res.json[0].similarity > (res.json.find((c) => c.id === r.id) || { similarity: -1 }).similarity);
    const fresh = mk('look_new');
    const fb = await pub(`/api/creators/${fresh.id}/similar?by=look`);
    assert.equal(fb.status, 200); assert.ok(Array.isArray(fb.json));
  });
});
