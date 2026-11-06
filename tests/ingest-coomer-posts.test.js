'use strict';
/**
 * Coomer posts -> items.
 *  1. A post's attachments are not all pictures or videos (archives, voice messages, documents): only real media becomes an item.
 *  2. A video has no poster of its own on Coomer, so it borrows the post's first picture or the creator's banner. Those posters are
 *     SHARED, and the duplicate detector (perceptual hash of the poster) took the second video of a post, or of a creator, for a
 *     copy of the first and collapsed it into "also posted on". Items now say their poster is borrowed, and the pipeline does not
 *     hash a borrowed poster.
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

test('a video borrows its poster, and says so; a picture is its own preview', () => {
  const withImage = coomer.itemsFromPost(post({ file: file('a.jpg'), attachments: [file('b.mp4')] }), feed);
  const videoOnly = coomer.itemsFromPost(post({ file: file('b.mp4') }), feed);
  assert.equal(withImage.find((i) => i.mediaType === 'image').posterShared, undefined);
  assert.equal(withImage.find((i) => i.mediaType === 'video').posterShared, true);
  assert.equal(videoOnly[0].posterShared, true);
  assert.match(videoOnly[0].previewUrl, /banners\/onlyfans\/zedfit/, 'the banner is still the card picture');
});

let n = 0;
const run = (it) => pipeline.processItem({ ...it, sourceId: `${it.sourceId}-${++n}` }, feed, null, settings);

test('two videos of a creator that share the banner as poster are both kept (they used to collapse into one)', async () => {
  dedupe._reset();
  const a = coomer.itemsFromPost(post({ id: '201', file: file('v1.mp4') }), feed)[0];
  const b = coomer.itemsFromPost(post({ id: '202', file: file('v2.mp4') }), feed)[0];
  assert.equal(a.previewUrl, b.previewUrl, 'same borrowed poster');
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
