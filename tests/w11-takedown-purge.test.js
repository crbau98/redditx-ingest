'use strict';
/**
 * A takedown removes what identifies the post, not only its hashes (Crucible wave 11, items 6 and 7): the text columns and
 * search index, its tags, our stored copy and the proxy's cached image. The scan streams instead of loading every row.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key', MEDIA_STORE: 'disk' });
let repo; let db; let store; let cache;
before(() => {
  repo = require('../src/db/repo'); db = repo.db;
  store = require('../src/lib/objectstore'); cache = require('../src/lib/media-cache');
});

const wait = () => new Promise((r) => setTimeout(r, 50));

test('takedown by handle clears text, search, tags, stored bytes and cached image; other rows stay', async () => {
  const key = 'tg/999/42.jpg';
  await store.put(key, Buffer.alloc(4096, 7), 'image/jpeg');
  const storeUrl = store.urlFor(key);
  const webUrl = 'https://example.com/zeph-takedown.jpg';
  cache.put(webUrl, Buffer.alloc(4096, 9), 'image/jpeg');
  assert.ok(cache.get(webUrl), 'cached before');

  const gone = repo.media.insert({ platform: 'web', source_id: 'td1', source_key: 'web:td1:0', post_key: 'web:td1', author: 'zephyr_takedown',
    title: 'zephyrine private set title', description: 'zephyrine description words', source_url: 'https://example.com/post/td1',
    community: 'zephyrcommunity', media_type: 'image', media_url: storeUrl, preview_url: webUrl, hash: 'tdh1' }, ['zephyrtag']);
  const kept = repo.media.insert({ platform: 'web', source_id: 'td2', source_key: 'web:td2:0', post_key: 'web:td2', author: 'someone_else',
    title: 'an unrelated title', media_type: 'image', media_url: 'https://example.com/kept.jpg', hash: 'tdh2' }, ['zephyrtag']);
  assert.ok(gone && kept);

  const out = repo.takedowns.add({ kind: 'handle', value: 'zephyr_takedown', reason: 'creator request', actor: 'test' });
  assert.ok(out.purgedMedia >= 1);

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(gone);
  assert.equal(row.publish_state, 'removed');
  for (const col of ['title', 'description', 'author', 'source_url', 'ocr_text', 'community', 'preview_url', 'phash']) assert.equal(row[col], null, `${col} cleared`);
  assert.equal(row.tags_text, '');
  assert.equal(row.media_url, '');
  assert.equal(row.source_key, 'web:td1:0', 'the opaque key stays so the post is not imported again');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media_fts WHERE media_fts MATCH 'zephyrine'").get().n, 0, 'search no longer finds it');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_tags WHERE media_id = ?').get(gone).n, 0);

  await wait();
  assert.equal(await store.has(key), false, 'stored copy deleted');
  assert.equal(cache.get(webUrl), null, 'cached image deleted');

  const k = db.prepare('SELECT publish_state, title FROM media WHERE id = ?').get(kept);
  assert.deepEqual(k, { publish_state: 'published', title: 'an unrelated title' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_tags WHERE media_id = ?').get(kept).n, 1);
});

test('the takedown scan streams rows instead of loading the whole table', () => {
  const src = fs.readFileSync(require.resolve('../src/db/repos/takedowns.js'), 'utf8');
  assert.match(src, /FROM media WHERE publish_state != 'removed'`\)\.iterate\(\)/);
  assert.doesNotMatch(src, /FROM media WHERE publish_state != 'removed'`\)\.all\(\)/);
});
