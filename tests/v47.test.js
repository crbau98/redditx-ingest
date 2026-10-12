'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let backup;
const AGE = { cookie: 'prism_age=1' };
const call = async (p, headers = AGE) => { const res = await fetch(`${base}${p}`, { headers }); return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }; };

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });

describe('query performance guards (large library)', () => {
  let creators;
  before(() => {
    const tags = ['muscle', 'gym', 'beach', 'bear', 'twink', 'jock', 'beard', 'swim'];
    creators = Array.from({ length: 40 }, (_, i) => repo.creators.create({ handle: `perf_${i}` }));
    const ins = repo.db.transaction(() => {
      for (let i = 0; i < 6000; i++) {
        const c = creators[i % creators.length];
        repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: `p${i}`, source_key: `reddit:p${i}:0`, post_key: `reddit:p${i}`, title: `post ${tags[i % 8]} ${tags[(i * 3) % 8]}`,
          media_type: i % 3 ? 'image' : 'video', media_url: `https://i.redd.it/p${i}.jpg`, preview_url: `https://i.redd.it/p${i}p.jpg`, hash: `v47p${i}`, score: i % 997, community: `sub${i % 20}`,
          posted_at: new Date(Date.now() - i * 60000).toISOString() }, [tags[i % 8], tags[(i * 3) % 8]]);
      }
    });
    ins();
    for (const c of creators) repo.creators.refreshStats(c.id);
  });
  const timed = (fn) => { const t = Date.now(); const r = fn(); return { r, ms: Date.now() - t }; };
  test('full-text search with a total stays fast (no per-row MATCH)', () => {
    // The FTS join used to drive the COUNT from media and re-run MATCH per row: ~10 s at this size.
    const { r, ms } = timed(() => repo.media.list({ q: 'post muscle', limit: 36 }));
    assert.ok(r.total > 0 && r.items.length > 0);
    assert.ok(ms < 300, `search took ${ms} ms (the per-row MATCH plan takes ~1.4 s here)`);
    const { ms: ms2 } = timed(() => repo.media.list({ q: 'muscle', tag: 'gym', limit: 36 }));
    assert.ok(ms2 < 300, `search + tag took ${ms2} ms`);
  });
  test('listings return the same rows whichever index is used', () => {
    const recent = repo.media.list({ sort: 'recent', limit: 20 }).items.map((m) => m.posted_at);
    assert.deepEqual(recent, [...recent].sort().reverse(), 'newest first');
    const top = repo.media.list({ sort: 'top', limit: 20 }).items.map((m) => m.score);
    assert.deepEqual(top, [...top].sort((a, b) => b - a), 'highest score first');
    const tagged = repo.media.list({ tag: 'muscle', sort: 'recent', limit: 50 }).items;
    assert.ok(tagged.length === 50 && tagged.every((m) => /muscle/.test(m.title)));
    const oldest = repo.media.list({ sort: 'oldest', limit: 5 }).items.map((m) => m.posted_at);
    assert.deepEqual(oldest, [...oldest].sort(), 'oldest first');
  });
  test('totals refresh immediately after new content arrives', () => {
    const before = repo.media.list({ tag: 'swim', limit: 1 }).total;
    repo.media.insert({ creator_id: creators[0].id, platform: 'reddit', source_id: 'fresh', source_key: 'reddit:fresh:0', post_key: 'reddit:fresh', title: 'fresh swim', media_type: 'image', media_url: 'https://i.redd.it/fresh.jpg', hash: 'v47fresh' }, ['swim']);
    assert.equal(repo.media.list({ tag: 'swim', limit: 1 }).total, before + 1);
  });
  test('creator cards never preview off-topic (excluded) posts', () => {
    const c = repo.creators.create({ handle: 'card_scope' });
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: 'cs1', source_key: 'reddit:cs1:0', post_key: 'reddit:cs1', title: 't', media_type: 'image', media_url: 'https://i.redd.it/ok.jpg', preview_url: 'https://i.redd.it/okp.jpg', hash: 'v47cs1', score: 1 }, []);
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: 'cs2', source_key: 'reddit:cs2:0', post_key: 'reddit:cs2', title: 't', media_type: 'image', media_url: 'https://i.redd.it/hidden.jpg', preview_url: 'https://i.redd.it/hiddenp.jpg', hash: 'v47cs2', score: 999, scope: 'excluded' }, []);
    repo.creators.refreshStats(c.id);
    const card = repo.creators.list({ q: 'card_scope', limit: 5 }).items.find((x) => x.id === c.id);
    assert.ok(card);
    assert.ok(!JSON.stringify(card.previews).includes('hidden'), JSON.stringify(card.previews));
  });
  test('related tags, similar creators and autocomplete agree with the data', async () => {
    const sim = repo.creators.similar(creators[0].id);
    assert.ok(sim.length > 0 && !sim.some((x) => x.id === creators[0].id));
    const sug = await call('/api/suggest?q=mus');
    assert.deepEqual(sug.json.tags.map((t) => t.name), ['muscle']);
    assert.equal(sug.json.tags[0].count, 750); // every 8th post
  });
});
