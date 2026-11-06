'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let backup;
const AGE = { cookie: 'prism_age=1' };
const call = async (p, headers = AGE) => { const res = await fetch(`${base}${p}`, { headers }); return { status: res.status, json: await res.json().catch(() => null) }; };
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });

/** A creator with a media count and a last-post date (days ago). */
function seed(handle, { media, lastDays }) {
  const c = repo.creators.create({ handle });
  repo.db.prepare('UPDATE creators SET media_count = ?, last_media_at = ?, status = ? WHERE id = ?')
    .run(media, lastDays === null ? null : daysAgo(lastDays), 'active', c.id);
  return c;
}

describe('popular creators', () => {
  let stale; let recent; let big;
  before(() => {
    // Old but huge: the most posts, last posted 200 days ago. It must not lead "Popular".
    stale = seed('pop_stale_big', { media: 500, lastDays: 200 });
    recent = seed('pop_recent_small', { media: 6, lastDays: 1 });
    big = seed('pop_active_big', { media: 40, lastDays: 3 });
  });

  test('Popular leaves out creators who have not posted in 90 days', () => {
    const ids = repo.creators.list({ sort: 'popular', limit: 100 }).items.map((c) => c.id);
    assert.ok(!ids.includes(stale.id), 'a 200-day-old page must not appear in Popular');
    assert.ok(ids.includes(recent.id) && ids.includes(big.id));
  });

  test('without a popularity column, Popular keeps the existing media order', () => {
    const popular = repo.creators.list({ sort: 'popular', limit: 100 }).items.map((c) => c.id);
    const media = repo.creators.list({ sort: 'media', limit: 100 }).items.map((c) => c.id).filter((id) => popular.includes(id));
    assert.deepEqual(popular, media);
  });

  test('with creators.popularity, Popular ranks by popularity first', () => {
    repo.db.prepare('ALTER TABLE creators ADD COLUMN popularity INTEGER NOT NULL DEFAULT 0').run();
    repo.db.prepare('UPDATE creators SET popularity = 10 WHERE id = ?').run(recent.id);
    repo.db.prepare('UPDATE creators SET popularity = 90 WHERE id = ?').run(big.id);
    const ids = repo.creators.list({ sort: 'popular', limit: 100 }).items.map((c) => c.id);
    assert.ok(ids.indexOf(big.id) < ids.indexOf(recent.id), 'higher popularity first');
  });

  test('"Hot this week" (Popular with a 7-day window) leaves out older posters', () => {
    const ids = repo.creators.list({ sort: 'popular', freshDays: 7, limit: 100 }).items.map((c) => c.id);
    assert.ok(ids.includes(recent.id) && ids.includes(big.id));
    assert.ok(!ids.includes(stale.id));
  });

  test('/api/creators accepts sort=popular and the 90-day floor applies over HTTP', async () => {
    const r = await call('/api/creators?sort=popular&limit=100');
    assert.equal(r.status, 200);
    const handles = r.json.items.map((c) => c.handle);
    assert.ok(!handles.includes('pop_stale_big'));
    assert.ok(handles.includes('pop_active_big'));
  });

  test('an unknown sort falls back to media order (no error)', async () => {
    const r = await call('/api/creators?sort=bogus&limit=5');
    assert.equal(r.status, 200);
  });
});
