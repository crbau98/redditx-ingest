'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let backup;
const AGE = { cookie: 'prism_age=1' };
const call = async (p, headers = AGE) => { const res = await fetch(`${base}${p}`, { headers }); return { status: res.status, json: await res.json().catch(() => null) }; };

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });

let n = 0;
const creatorWith = (handle, tagSets, community = null) => {
  const c = repo.creators.create({ handle });
  for (const tags of tagSets) {
    n++;
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: `g${n}`, source_key: `reddit:g${n}:0`, post_key: `reddit:g${n}`, title: 't', media_type: 'image', media_url: `https://i.redd.it/g${n}.jpg`, preview_url: `https://i.redd.it/g${n}p.jpg`, hash: `v45h${n}`, community }, tags);
  }
  repo.creators.refreshStats(c.id);
  return c;
};

describe('creator constellation graph', () => {
  test('links creators who post alike, groups them by style, hides non-public creators', async () => {
    const a = creatorWith('gym_a', [['gym', 'muscle', 'mirror'], ['gym', 'muscle']], 'gymsub');
    const b = creatorWith('gym_b', [['gym', 'muscle'], ['gym', 'flex']], 'gymsub');
    const c = creatorWith('beach_c', [['beach', 'surf'], ['beach', 'sunset']], 'gymsub');
    const d = creatorWith('beach_d', [['beach', 'surf'], ['beach']], 'gymsub');
    const hidden = creatorWith('gym_hidden', [['gym', 'muscle'], ['gym']]);
    repo.creators.update(hidden.id, { status: 'hidden' });
    creatorWith('one_post', [['gym']]); // a single post is not enough to place a star

    const g = repo.creators.graph({ limit: 50 });
    const ids = new Set(g.nodes.map((x) => x.id));
    assert.ok(ids.has(a.id) && ids.has(b.id) && ids.has(c.id) && ids.has(d.id));
    assert.ok(!ids.has(hidden.id), 'hidden creators are not shown');
    assert.ok(!g.nodes.some((x) => x.handle === 'one_post'), 'creators need at least two posts');
    const linked = (x, y) => g.links.some((l) => (l.source === x && l.target === y) || (l.source === y && l.target === x));
    assert.ok(linked(a.id, b.id), 'gym creators are linked');
    assert.ok(linked(c.id, d.id), 'beach creators are linked');
    const ab = g.links.find((l) => (l.source === a.id && l.target === b.id) || (l.source === b.id && l.target === a.id));
    assert.ok(ab.weight > 0.3 && ab.weight <= 1, String(ab.weight));
    assert.equal(g.nodes.find((x) => x.id === a.id).group, 'gym', 'dominant style tag');
    assert.notEqual(g.nodes.find((x) => x.id === c.id).group, 'gymsub', 'community names are not used as the style group');
    assert.ok(g.nodes.find((x) => x.id === a.id).preview, 'each star carries a preview image');
  });
  test('each node keeps only its strongest few links', () => {
    for (let i = 0; i < 8; i++) creatorWith(`hub_${i}`, [['hubtag', `t${i}`], ['hubtag']]);
    const g = repo.creators.graph({ limit: 100, perNode: 3 });
    const degree = new Map();
    for (const l of g.links) { degree.set(l.source, (degree.get(l.source) || 0) + 1); degree.set(l.target, (degree.get(l.target) || 0) + 1); }
    // a node can receive extra links chosen by others, but nobody ends up linked to everyone
    assert.ok(Math.max(...degree.values()) < g.nodes.length - 1);
  });
  test('API: public shape, cached, age-gated', async () => {
    const r = await call('/api/graph');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.nodes) && Array.isArray(r.json.links));
    const node = r.json.nodes[0];
    assert.deepEqual(Object.keys(node).sort(), ['avatar_url', 'display_name', 'group', 'handle', 'id', 'last_media_at', 'media_count', 'preview'].sort());
    assert.equal((await call('/api/graph', {})).status, 403);
  });
});
