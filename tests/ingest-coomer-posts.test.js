'use strict';
/**
 * Coomer posts -> items.
 *  1. A post's attachments are not all pictures or videos (archives, voice messages, documents): only real media becomes an item.
 *  2. A video has no poster of its own on Coomer, so it borrows the post's first picture when there is one. It must NOT use the
 *     creator's banner (that made every video-only card identical). Borrowed picture posters are SHARED, and the duplicate
 *     detector used to collapse those videos; items mark posterShared and the pipeline does not hash a borrowed poster.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let coomer; let repo; let pipeline; let imagefilter; let dedupe; let feed;
const settings = { probeUnknownHosts: false, hostReachability: false, scopeMode: 'open', dedupe: true, imageFilter: false, dedupeDistance: 6 };

before(() => {
  prepareEnv();
  coomer = require('../src/sources/coomer');
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  imagefilter = require('../src/lib/imagefilter');
  dedupe = require('../src/services/dedupe');
  feed = repo.feeds.upsert({ platform: 'coomer', kind: 'user', target: 'onlyfans/zedfit', trusted: 1, origin: 'admin' }).feed;
  // the picture model replaced by one that hashes the URL it is asked about: the same poster URL gives the same hash
  imagefilter._setAnalyzer(async (url) => ({ status: 'ok', faces: [], phash: crypto.createHash('md5').update(url).digest('hex') }));
});
after(() => { imagefilter._reset(); });

const post = (o) => ({ id: '100', user: 'zedfit', service: 'onlyfans', title: 'Gym day', published: '2026-10-01T10:00:00', ...o });
const file = (name) => ({ name, path: `/ab/cd/${name}` });

test('only pictures and videos become items; archives, audio and documents do not', () => {
  const items = coomer.itemsFromPost(post({ file: file('a.jpg'), attachments: [file('b.mp4'), file('pack.zip'), file('voice.m4a'), file('notes.pdf'), file('c.mkv'), file('d.PNG'), file('e.gif'), file('noext')] }), feed);
  const got = items.map((i) => `${i.mediaType}:${i.mediaUrl.split('/').pop()}`);
  assert.deepEqual(got, ['image:a.jpg', 'video:b.mp4', 'video:c.mkv', 'image:d.PNG', 'image:e.gif']);
});

test('a video borrows a sibling picture poster and says so; video-only posts get no banner poster', () => {
  const withImage = coomer.itemsFromPost(post({ file: file('a.jpg'), attachments: [file('b.mp4')] }), feed);
  const videoOnly = coomer.itemsFromPost(post({ file: file('b.mp4') }), feed);
  assert.equal(withImage.find((i) => i.mediaType === 'image').posterShared, undefined);
  assert.equal(withImage.find((i) => i.mediaType === 'video').posterShared, true);
  assert.match(withImage.find((i) => i.mediaType === 'video').previewUrl, /thumbnail\/data\/ab\/cd\/a\.jpg/);
  assert.equal(videoOnly[0].posterShared, undefined);
  assert.equal(videoOnly[0].previewUrl, null, 'no banner fallback');
  assert.equal(videoOnly[0].thumbnailUrl, null);
});

let n = 0;
const run = (it) => pipeline.processItem({ ...it, sourceId: `${it.sourceId}-${++n}` }, feed, null, settings);

test('two video-only posts with no poster are both kept (they used to share a banner and still must not collapse)', async () => {
  dedupe._reset();
  const a = coomer.itemsFromPost(post({ id: '201', file: file('v1.mp4') }), feed)[0];
  const b = coomer.itemsFromPost(post({ id: '202', file: file('v2.mp4') }), feed)[0];
  assert.equal(a.previewUrl, null);
  assert.equal(b.previewUrl, null);
  assert.equal((await run(a)).outcome, 'added');
  const second = await run(b);
  assert.equal(second.outcome, 'added', JSON.stringify(second));
});

test('two videos of one post that share its picture as poster are both kept', async () => {
  dedupe._reset();
  const items = coomer.itemsFromPost(post({ id: '301', file: file('p.jpg'), attachments: [file('x1.mp4'), file('x2.mp4')] }), feed);
  const outcomes = [];
  for (const it of items) outcomes.push((await run(it)).outcome);
  assert.deepEqual(outcomes, ['added', 'added', 'added']);
});

test('the same picture posted twice under different file names still collapses (perceptual duplicates work as before)', async () => {
  dedupe._reset();
  const mk = (id, name) => ({ sourceId: `pic${id}`, title: 'Gym day', author: 'zedfit', service: 'onlyfans', mediaType: 'image', trusted: true,
    mediaUrl: `https://coomer.st/data/ab/cd/${name}`, previewUrl: 'https://img.coomer.st/thumbnail/data/ab/cd/same.jpg' });
  assert.equal((await run(mk(1, 'first.jpg'))).outcome, 'added');
  const again = await run(mk(2, 'second.jpg'));
  assert.equal(again.outcome, 'dupe');
});
