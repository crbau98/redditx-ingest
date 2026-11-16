'use strict';
/**
 * Crucible F2: the Following "Earlier" tab answered an empty page once the scan budget was used up by each creator's NEWER rows.
 * The index walk now seeks to posted_at <= since, so the budget only covers rows that can qualify.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key', AGE_GATE_ENFORCE: 'false' });
let repo; let server; let base; let follow; let engine;
before(async () => {
  repo = require('../src/db/repo'); follow = require('../src/routes/follow'); engine = require('../src/engine/engine');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

test('earlier still answers when every creator has more newer rows than its share of the scan budget', async () => {
  const since = '2026-06-01T00:00:00.000Z';
  const ids = []; let n = 0;
  for (let c = 0; c < 4; c++) {
    const cr = repo.creators.create({ handle: `w12early${c}`, displayName: `E${c}`, scope: 'in' }); const id = cr.id || cr; ids.push(id);
    const row = (when) => { n++; repo.media.insert({ platform: 'web', source_id: `fe${n}`, source_key: `web:fe${n}:0`, post_key: `web:fe${n}`, author: 'a', creator_id: id, media_type: 'image', media_url: `https://cdn.example/fe${n}.jpg`, hash: `feh${n}`, posted_at: when }, []); return n; };
    for (let i = 0; i < 30; i++) { const k = row(`2026-0${7 + (i % 3)}-1${i % 10}T00:00:00.000Z`); repo.db.prepare("UPDATE media SET ingested_at = posted_at WHERE source_id = ?").run(`fe${k}`); } // newer than since
    for (let i = 0; i < 5; i++) { const k = row(`2026-0${1 + i}-05T00:00:00.000Z`); repo.db.prepare("UPDATE media SET ingested_at = posted_at WHERE source_id = ?").run(`fe${k}`); } // before since
  }
  repo.db.prepare('UPDATE creators SET media_count = 35 WHERE id IN (?, ?, ?, ?)').run(...ids);
  const saved = follow._budget.scan;
  follow._budget.scan = 40; // 10 rows per creator: all of them newer rows before the fix
  try {
    const r = await (await fetch(`${base}/api/follow/feed`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'prism_age=1' },
      body: JSON.stringify({ part: 'earlier', limit: 12, follows: ids.map((id) => ({ id, since })) }) })).json();
    assert.equal(r.items.length, 12, JSON.stringify(r).slice(0, 300));
    assert.equal(r.total, 20);
    for (const it of r.items) assert.ok(it.posted_at <= since);
  } finally { follow._budget.scan = saved; }
});
