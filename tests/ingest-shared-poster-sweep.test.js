'use strict';
/**
 * The background hash sweep must not undo the shared-poster rule: a video whose poster is borrowed (a creator banner, or the picture
 * of the post it belongs to) gets no perceptual hash from that poster, so the sweep may not hash it and collapse a creator's videos
 * into one. Videos that the sweep already collapsed that way are restored once.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let repo; let maintenance; let imagefilter; let dedupe;
const settings = { dedupe: true, dedupeDistance: 6, imageFilter: false };
let n = 0;
const BANNER = 'https://img.coomer.st/banners/onlyfans/zedfit';

before(() => {
  prepareEnv();
  repo = require('../src/db/repo');
  maintenance = require('../src/engine/maintenance');
  imagefilter = require('../src/lib/imagefilter');
  dedupe = require('../src/services/dedupe');
  imagefilter._setAnalyzer(async (url) => ({ status: 'ok', faces: [], phash: crypto.createHash('md5').update(url).digest('hex') }));
});
after(() => { imagefilter._reset(); });

function row({ type = 'video', preview, post = `coomer:p${++n}`, state = 'published', reason = null, phash = null, platform = 'coomer' }) {
  const id = crypto.randomUUID();
  repo.db.prepare(`INSERT INTO media (id, platform, source_key, post_key, media_type, media_url, preview_url, hash, publish_state, review_reason, phash, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, platform, `${post}:0:${id}`, post, type, `https://coomer.st/data/${id}.${type === 'video' ? 'mp4' : 'jpg'}`, preview, crypto.randomUUID().replace(/-/g, ''), state, reason, phash, `https://coomer.st/onlyfans/user/zedfit/${id}`);
  return id;
}
const get = (id) => repo.db.prepare('SELECT publish_state, review_reason, phash FROM media WHERE id = ?').get(id);
const reset = () => { repo.db.prepare('DELETE FROM media').run(); repo.settings.set('hash_sweep_seq', '0'); dedupe._reset(); };

test('videos that borrow the creator banner as poster are not hashed, so they are not collapsed', async () => {
  reset();
  const ids = [row({ preview: BANNER }), row({ preview: BANNER }), row({ preview: BANNER })];
  await maintenance.hashSweep({ limit: 100, settings });
  for (const id of ids) { assert.equal(get(id).publish_state, 'published'); assert.equal(get(id).phash, null); }
});

test('videos of one post that share its picture as poster are not collapsed either', async () => {
  reset();
  const poster = 'https://img.coomer.st/thumbnail/data/ab/cd/post.jpg';
  const ids = [row({ post: 'coomer:one', preview: poster }), row({ post: 'coomer:one', preview: poster })];
  await maintenance.hashSweep({ limit: 100, settings });
  for (const id of ids) assert.equal(get(id).publish_state, 'published');
});

test('a video with a poster of its own is still hashed, and a real duplicate still collapses', async () => {
  reset();
  const a = row({ platform: 'reddit', preview: 'https://thumbs.example/same.jpg' }); const b = row({ platform: 'reddit', preview: 'https://thumbs.example/same.jpg' }); // different posts, same picture
  await maintenance.hashSweep({ limit: 100, settings });
  assert.ok(get(a).phash, 'hashed');
  assert.equal(get(a).publish_state, 'published');
  assert.equal(get(b).publish_state, 'hidden'); assert.match(get(b).review_reason, /^duplicate of /);
});

test('repair: coomer videos the sweep collapsed on a shared poster come back, with their stale hash cleared', () => {
  reset();
  const orig = row({ preview: BANNER, phash: 'a'.repeat(32) });
  const gone1 = row({ preview: BANNER, state: 'hidden', reason: `duplicate of ${orig}`, phash: 'a'.repeat(32) });
  repo.media.addAltSource(orig, { platform: 'coomer', source_url: `https://coomer.st/onlyfans/user/zedfit/${gone1}` });
  // a genuine duplicate (its own, different poster than the original) and a non-coomer one stay hidden
  const realOrig = row({ preview: 'https://thumbs.example/x.jpg', phash: 'b'.repeat(32) });
  const real = row({ preview: 'https://thumbs.example/y.jpg', state: 'hidden', reason: `duplicate of ${realOrig}`, phash: 'b'.repeat(32) });
  const other = row({ platform: 'reddit', preview: BANNER, state: 'hidden', reason: `duplicate of ${orig}` });
  const out = maintenance.repairSharedPosterCollapse();
  assert.equal(out.restored, 1);
  assert.equal(get(gone1).publish_state, 'published'); assert.equal(get(gone1).phash, null); assert.equal(get(gone1).review_reason, null);
  assert.equal(get(orig).phash, null, 'the original no longer carries the banner hash');
  assert.equal(repo.media.altSources(orig).length, 0, 'and no longer says "also posted on" a video that is a different one');
  assert.equal(get(real).publish_state, 'hidden'); assert.equal(get(other).publish_state, 'hidden');
  assert.equal(maintenance.repairSharedPosterCollapse().restored, 0, 'idempotent');
});

test('a hash the old sweep took from a borrowed poster is cleared (database and dedupe index), by the sweep and by the one-off', async () => {
  reset();
  const H = 'c'.repeat(32);
  const swept = row({ preview: BANNER, phash: H });                 // the sweep reaches this one
  const passed = row({ preview: BANNER, phash: H });                // a cursor that is already past it: only the one-off can reach it
  const own = row({ platform: 'reddit', preview: 'https://thumbs.example/own.jpg', phash: 'd'.repeat(32) }); // a poster of its own keeps its hash
  dedupe.load(); dedupe.remember(swept, H, { mediaType: 'video' }); dedupe.remember(passed, H, { mediaType: 'video' });
  assert.ok(dedupe.check({ phash: H, mediaType: 'video' }).dup, 'the stale hash is findable before');
  repo.settings.set('hash_sweep_seq', String(repo.db.prepare('SELECT seq FROM media WHERE id = ?').get(passed).seq));
  const out = await maintenance.clearBorrowedPosterHashes();
  assert.equal(out.cleared, 2); assert.equal(get(passed).phash, null); assert.equal(get(own).phash, 'd'.repeat(32));
  assert.equal(dedupe.check({ phash: H, mediaType: 'video' }).dup, null, 'and gone from the dedupe index');
  assert.equal((await maintenance.clearBorrowedPosterHashes()).cleared, 0, 'idempotent');
  repo.settings.set('hash_sweep_seq', '0');
  const again = row({ preview: BANNER, phash: H }); dedupe.remember(again, H, { mediaType: 'video' });
  await maintenance.hashSweep({ limit: 100, settings });
  assert.equal(get(again).phash, null, 'the sweep clears one it reaches');
  assert.equal(dedupe.check({ phash: H, mediaType: 'video' }).dup, null);
});

test('an RSS video (even a video-only entry, with no sibling row) is never hashed by the sweep: its poster is channel artwork', async () => {
  reset();
  const art = 'https://v.example/art.jpg';
  const a = row({ platform: 'rss', post: 'rss:ep1', preview: art }); const b = row({ platform: 'rss', post: 'rss:ep2', preview: art });
  await maintenance.hashSweep({ limit: 100, settings });
  for (const id of [a, b]) { assert.equal(get(id).publish_state, 'published', 'no second episode is hidden as a duplicate'); assert.equal(get(id).phash, null); }
  const own = row({ platform: 'reddit', post: 'reddit:x', preview: 'https://thumbs.example/own2.jpg' });
  await maintenance.hashSweep({ limit: 100, settings });
  assert.ok(get(own).phash, 'other platforms\' videos with a poster of their own are still hashed');
});

test('repair also drops the repaired ORIGINAL from an already-loaded dedupe index', () => {
  reset();
  const H = 'e'.repeat(32);
  const orig = row({ preview: BANNER, phash: H }); const gone = row({ preview: BANNER, state: 'hidden', reason: `duplicate of ${orig}`, phash: H });
  dedupe.load(); dedupe.remember(orig, H, { mediaType: 'video' });          // the index loaded before the repair
  assert.ok(dedupe.check({ phash: H, mediaType: 'video' }).dup, 'the stale original is findable before');
  maintenance.repairSharedPosterCollapse();
  assert.equal(get(gone).publish_state, 'published');
  assert.equal(dedupe.check({ phash: H, mediaType: 'video' }).dup, null, 'and not after: it cannot collapse later videos until a restart');
});

test('a Coomer post with a picture and several videos: the sibling rows have DIFFERENT post_keys, yet their shared picture is not hashed', async () => {
  reset();
  const poster = 'https://img.coomer.st/thumbnail/data/ab/cd/pic.jpg'; // the post's first picture, borrowed by every video of it
  // real keys: coomer-<service>-<post>-<index> per attachment, so no two siblings share a post_key
  const v1 = row({ post: 'coomer:coomer-onlyfans-777-1', preview: poster }); const v2 = row({ post: 'coomer:coomer-onlyfans-777-2', preview: poster });
  await maintenance.hashSweep({ limit: 100, settings });
  for (const id of [v1, v2]) { assert.equal(get(id).publish_state, 'published', 'the second video is not hidden as a duplicate of the first'); assert.equal(get(id).phash, null); }
});
