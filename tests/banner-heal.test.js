'use strict';
/** Banner/icon preview heal: clears profile chrome used as post stills, resets thumbs, and drops missing store thumbs. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

const dir = prepareEnv({ MEDIA_STORE: 'disk' });
let repo; let heal; let store; let creator; let feed;
before(() => {
  repo = require('../src/db/repo');
  heal = require('../src/engine/banner-heal');
  store = require('../src/lib/objectstore');
  creator = repo.creators.create({ handle: 'bannerhealguy', origin: 'admin' });
  feed = repo.feeds.upsert({ platform: 'coomer', kind: 'user', target: 'onlyfans/bannerhealguy', trusted: 1, origin: 'admin', creatorId: creator.id }).feed;
});
after(() => { try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

const add = (id, { preview, thumb = null, type = 'video', creatorId = null } = {}) => {
  repo.db.prepare(`INSERT INTO media (id, feed_id, creator_id, platform, media_type, media_url, preview_url, thumbnail_url, thumb_url, tint, publish_state, source_key, hash, ingested_at)
    VALUES (?, ?, ?, 'coomer', ?, ?, ?, ?, ?, '#112233', 'published', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(
    id, feed.id, creatorId || creator.id, type, `https://coomer.st/data/${id}.mp4`, preview, preview, thumb, `coomer:test:${id}`, `h-${id}`,
  );
};
const row = (id) => repo.db.prepare('SELECT preview_url, thumbnail_url, thumb_url, tint FROM media WHERE id = ?').get(id);

test('dry run counts banner previews; apply clears them and resets tint/thumb', async () => {
  add('bh1', { preview: 'https://img.coomer.st/banners/onlyfans/bannerhealguy', thumb: 'https://media.prism.invalid/th/bh/bh1.webp' });
  add('bh2', { preview: 'https://img.coomer.st/thumbnail/data/aa/bb/real.jpg', thumb: 'https://media.prism.invalid/th/bh/bh2.webp' });
  add('bh3', { preview: 'https://img.coomer.st/icons/onlyfans/bannerhealguy' });

  // bh2's store object exists → not a banner and not missing
  await store.put('th/bh/bh2.webp', Buffer.from('ok'), 'image/webp');

  const dry = await heal.heal({ dryRun: true, creatorId: creator.id });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.found >= 2);
  assert.ok(dry.bannerPreviews >= 2);
  assert.equal(row('bh1').preview_url.includes('/banners/'), true);

  const applied = await heal.heal({ dryRun: false, creatorId: creator.id });
  assert.equal(applied.dryRun, false);
  assert.ok(applied.cleared >= 2);
  const a = row('bh1');
  assert.equal(a.preview_url, null);
  assert.equal(a.thumbnail_url, null);
  assert.equal(a.thumb_url, null);
  assert.equal(a.tint, null);
  const kept = row('bh2');
  assert.match(kept.preview_url, /thumbnail\/data/);
  assert.equal(kept.thumb_url, 'https://media.prism.invalid/th/bh/bh2.webp', 'real preview + present store thumb left alone');
});

test('missing media.prism.invalid/th/... thumb is cleared even when preview is real', async () => {
  const id = `miss-${crypto.randomUUID().slice(0, 8)}`;
  const key = `th/zz/${id}.webp`;
  add(id, { preview: 'https://img.coomer.st/thumbnail/data/aa/bb/real.jpg', thumb: store.urlFor(key) });
  const dry = await heal.heal({ dryRun: true, creatorId: creator.id });
  assert.ok(dry.missingThumbs >= 1, JSON.stringify(dry));
  assert.ok(dry.sample.some((s) => s.id === id && s.action === 'clear-missing-thumb'));
  assert.equal(row(id).thumb_url, store.urlFor(key), 'dry writes nothing');

  const applied = await heal.heal({ dryRun: false, creatorId: creator.id, limit: 50 });
  assert.equal(row(id).thumb_url, null);
  assert.equal(row(id).tint, null);
  assert.match(row(id).preview_url, /thumbnail\/data/, 'real preview kept');
  assert.ok(applied.missingThumbs >= 1);
});

test('admin endpoint is dry unless ?apply=1', async () => {
  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin/maintenance/heal-banner-previews`;
  const id = `ep-${crypto.randomUUID().slice(0, 8)}`;
  add(id, { preview: 'https://img.coomer.st/banners/onlyfans/bannerhealguy' });
  const dry = await (await fetch(base, { method: 'POST', headers: { 'x-admin-key': 'test-key' } })).json();
  assert.equal(dry.dryRun, true);
  assert.equal(row(id).preview_url.includes('/banners/'), true);
  const wet = await (await fetch(`${base}?apply=1&creatorId=${creator.id}&limit=20`, { method: 'POST', headers: { 'x-admin-key': 'test-key' } })).json();
  assert.equal(wet.dryRun, false);
  assert.equal(row(id).preview_url, null);
  await new Promise((r) => server.close(r));
});

test('direct heal({limit:0}) means no cap (not a one-row walk)', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = `lim0-${i}-${crypto.randomUUID().slice(0, 6)}`;
    ids.push(id);
    add(id, { preview: `https://img.coomer.st/banners/onlyfans/lim0${i}` });
  }
  const dry = await heal.heal({ dryRun: true, creatorId: creator.id, limit: 0, afterSeq: 0 });
  assert.ok(dry.wouldClear >= 3, `limit 0 must not stop after one row: ${dry.wouldClear}`);
  assert.equal(dry.done, true);
});

test('chunked heal: afterSeq+limit resumes; second chunk finishes', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = `chunk-${i}-${crypto.randomUUID().slice(0, 6)}`;
    ids.push(id);
    add(id, { preview: `https://img.coomer.st/banners/onlyfans/chunk${i}` });
  }
  const a = await heal.heal({ dryRun: true, creatorId: creator.id, limit: 2, afterSeq: 0 });
  assert.equal(a.wouldClear, 2);
  assert.equal(a.done, false);
  assert.ok(a.nextAfter > a.afterSeq, `cursor advances: ${a.afterSeq} → ${a.nextAfter}`);

  const b = await heal.heal({ dryRun: true, creatorId: creator.id, limit: 2, afterSeq: a.nextAfter });
  assert.ok(b.wouldClear >= 1);
  assert.ok(b.afterSeq === a.nextAfter);

  // Drain the rest
  let cursor = b.nextAfter;
  let guard = 0;
  let last;
  while (guard++ < 20) {
    last = await heal.heal({ dryRun: true, creatorId: creator.id, limit: 10, afterSeq: cursor });
    cursor = last.nextAfter;
    if (last.done) break;
  }
  assert.equal(last.done, true);
  // Apply one chunk for real
  const wet = await heal.heal({ dryRun: false, creatorId: creator.id, limit: 2, afterSeq: 0 });
  assert.equal(wet.cleared, 2);
  assert.equal(wet.done, false);
});

