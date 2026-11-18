'use strict';
/** Banner/icon preview heal: clears profile chrome used as post stills and resets thumbs for re-queue. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let heal; let creator; let feed;
before(() => {
  prepareEnv();
  repo = require('../src/db/repo');
  heal = require('../src/engine/banner-heal');
  creator = repo.creators.create({ handle: 'bannerhealguy', origin: 'admin' });
  feed = repo.feeds.upsert({ platform: 'coomer', kind: 'user', target: 'onlyfans/bannerhealguy', trusted: 1, origin: 'admin', creatorId: creator.id }).feed;
});

const add = (id, { preview, thumb = null, type = 'video' } = {}) => {
  repo.db.prepare(`INSERT INTO media (id, feed_id, creator_id, platform, media_type, media_url, preview_url, thumbnail_url, thumb_url, publish_state, source_key, hash, ingested_at)
    VALUES (?, ?, ?, 'coomer', ?, ?, ?, ?, ?, 'published', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(
    id, feed.id, creator.id, type, `https://coomer.st/data/${id}.mp4`, preview, preview, thumb, `coomer:test:${id}`, `h-${id}`,
  );
};

test('dry run counts banner previews; apply clears them and resets tint/thumb', async () => {
  add('bh1', { preview: 'https://img.coomer.st/banners/onlyfans/bannerhealguy', thumb: 'https://media.prism.invalid/th/bh/bh1.webp' });
  add('bh2', { preview: 'https://img.coomer.st/thumbnail/data/aa/bb/real.jpg', thumb: 'https://media.prism.invalid/th/bh/bh2.webp' });
  add('bh3', { preview: 'https://img.coomer.st/icons/onlyfans/bannerhealguy' });

  const dry = await heal.heal({ dryRun: true, creatorId: creator.id });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.found >= 2);
  assert.equal(repo.db.prepare('SELECT preview_url FROM media WHERE id = ?').get('bh1').preview_url.includes('/banners/'), true);

  const applied = await heal.heal({ dryRun: false, creatorId: creator.id });
  assert.equal(applied.dryRun, false);
  assert.ok(applied.cleared >= 2);
  const a = repo.db.prepare('SELECT preview_url, thumbnail_url, thumb_url, tint FROM media WHERE id = ?').get('bh1');
  assert.equal(a.preview_url, null);
  assert.equal(a.thumbnail_url, null);
  assert.equal(a.thumb_url, null);
  assert.equal(a.tint, null);
  const kept = repo.db.prepare('SELECT preview_url, thumb_url FROM media WHERE id = ?').get('bh2');
  assert.match(kept.preview_url, /thumbnail\/data/);
  assert.equal(kept.thumb_url, 'https://media.prism.invalid/th/bh/bh2.webp', 'real preview rows are left alone');
});
