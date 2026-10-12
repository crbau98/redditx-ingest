'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let imagefilter; let repo; let pipeline; let maintenance; let feed; let n = 0;
const assets = (f) => path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'assets', f);
const haveModel = fs.existsSync(assets('screenshot-facedetect.jpg')) && (() => { try { require.resolve('sharp'); require.resolve('@tensorflow/tfjs-backend-wasm'); return true; } catch { return false; } })();

before(async () => {
  const routes = {};
  if (haveModel) for (const f of ['screenshot-facedetect.jpg', 'screenshot-faceid.jpg']) routes[`/${f}`] = () => ({ headers: { 'content-type': 'image/jpeg' }, body: fs.readFileSync(assets(f)) });
  routes['/notimage'] = () => ({ headers: { 'content-type': 'text/html' }, body: '<html>nope</html>' });
  mock = await start(routes);
  prepareEnv();
  imagefilter = require('../src/lib/imagefilter');
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  maintenance = require('../src/engine/maintenance');
  feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
});
after(async () => { imagefilter._reset(); await imagefilter.shutdown(); await mock.close(); });

const settings = { probeUnknownHosts: false, scopeMode: 'open', imageFilter: true, imageFilterThreshold: 50 };
const item = (o) => ({ sourceId: `p${++n}`, title: 'Gym selfie', author: `bro${n}`, community: 'gaybrosgonewild', mediaType: 'image', trusted: true, mediaUrl: `https://i.redd.it/img${n}.jpg`, ...o });

describe('the real face + gender model (on-device, no network)', { skip: !haveModel && 'optional ML dependencies not installed' }, () => {
  test('a photo with several women is female-containing; a lone man is not', async () => {
    const women = imagefilter.judge(await imagefilter.analyze(`${mock.url}/screenshot-facedetect.jpg`), 0.5);
    assert.equal(women.decided, true); assert.ok(women.females >= 3, JSON.stringify(women)); assert.equal(women.female, true);
    const man = imagefilter.judge(await imagefilter.analyze(`${mock.url}/screenshot-faceid.jpg`), 0.5);
    assert.equal(man.decided, true); assert.equal(man.female, false, JSON.stringify(man)); assert.ok(man.males >= 1);
  });
  test('results are cached per URL and the model reports itself ready', async () => {
    const again = await imagefilter.analyze(`${mock.url}/screenshot-faceid.jpg`);
    assert.equal(again.cached, true);
    assert.equal(imagefilter.status().ready, true);
  });
  test('non-images and unreachable URLs are "error", never a verdict', async () => {
    assert.equal(imagefilter.judge(await imagefilter.analyze(`${mock.url}/notimage`)).decided, false);
    assert.equal(imagefilter.judge(await imagefilter.analyze(`${mock.url}/missing.jpg`)).decided, false);
  });
});

describe('policy (model replaced by a fake)', () => {
  const faces = (...g) => ({ status: 'ok', faces: g.map(([gender, score]) => ({ gender, score, confidence: 0.9 })) });
  const fake = (map) => imagefilter._setAnalyzer(async (url) => map[url] || { status: 'ok', faces: [] });

  test('judge: threshold, low-confidence boxes and unknown results', () => {
    assert.equal(imagefilter.judge(faces(['female', 0.9])).female, true);
    assert.equal(imagefilter.judge(faces(['female', 0.3])).female, false, 'below the threshold');
    assert.equal(imagefilter.judge(faces(['female', 0.3]), 0.25).female, true, 'threshold is configurable');
    assert.equal(imagefilter.judge(faces(['male', 0.9], ['female', 0.8])).female, true, 'one woman anywhere is enough');
    assert.equal(imagefilter.judge({ status: 'ok', faces: [{ gender: 'female', score: 0.99, confidence: 0.2 }] }).decided, false, 'a weak face box is ignored');
    assert.equal(imagefilter.judge({ status: 'error' }).female, false);
  });

  test('imageUrlOf: photos use their preview, videos their poster, HLS-only items have none', () => {
    assert.equal(imagefilter.imageUrlOf({ mediaType: 'image', previewUrl: 'https://a/p.jpg', mediaUrl: 'https://a/m.jpg' }), 'https://a/p.jpg');
    assert.equal(imagefilter.imageUrlOf({ mediaType: 'video', previewUrl: 'https://a/poster.jpg', mediaUrl: 'https://a/v.mp4' }), 'https://a/poster.jpg');
    assert.equal(imagefilter.imageUrlOf({ mediaType: 'video', mediaUrl: 'https://a/v.m3u8' }), null);
    assert.equal(imagefilter.imageUrlOf({ mediaType: 'video', previewUrl: 'https://a/v.mp4', mediaUrl: 'https://a/v.m3u8' }), null);
  });

  test('pipeline: a neutral-titled photo with a woman in it is excluded and its hash remembered; men and faceless shots pass', async () => {
    fake({ 'https://i.redd.it/woman.jpg': faces(['female', 0.95]), 'https://i.redd.it/man.jpg': faces(['male', 0.9]) });
    const w = await pipeline.processItem(item({ title: 'sunset', mediaUrl: 'https://i.redd.it/woman.jpg' }), feed, null, settings);
    assert.equal(w.outcome, 'excluded'); assert.equal(w.reason, 'image:female-face');
    assert.equal((await pipeline.processItem(item({ title: 'sunset', mediaUrl: 'https://i.redd.it/woman.jpg' }), feed, null, settings)).outcome, 'blocked', 'remembered by hash');
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/man.jpg' }), feed, null, settings)).outcome, 'added');
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/torso.jpg' }), feed, null, settings)).outcome, 'added', 'no face: the text gates decide');
  });

  test('pipeline: the filter can be switched off, and an analyzer error never blocks ingestion', async () => {
    fake({ 'https://i.redd.it/woman2.jpg': faces(['female', 0.95]) });
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/woman2.jpg' }), feed, null, { ...settings, imageFilter: false })).outcome, 'added');
    imagefilter._setAnalyzer(async () => ({ status: 'error', reason: 'http 403' }));
    assert.equal((await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/err.jpg' }), feed, null, settings)).outcome, 'added');
  });

  test('pipeline: videos are judged by their poster frame', async () => {
    fake({ 'https://media.redgifs.com/poster1.jpg': faces(['female', 0.9]) });
    const r = await pipeline.processItem(item({ mediaType: 'video', mediaUrl: 'https://media.redgifs.com/v1.mp4', previewUrl: 'https://media.redgifs.com/poster1.jpg' }), feed, null, settings);
    assert.equal(r.outcome, 'excluded');
  });

  test('three image strikes block the account for good', async () => {
    fake({ 'https://i.redd.it/s1.jpg': faces(['female', 0.9]), 'https://i.redd.it/s2.jpg': faces(['female', 0.9]), 'https://i.redd.it/s3.jpg': faces(['female', 0.9]) });
    for (const u of ['s1', 's2', 's3']) await pipeline.processItem(item({ author: 'strikeguy', mediaUrl: `https://i.redd.it/${u}.jpg` }), feed, null, settings);
    assert.ok(repo.blocklist.has('creator', 'reddit:strikeguy'));
    assert.equal((await pipeline.processItem(item({ author: 'strikeguy', title: 'fine pic' }), feed, null, settings)).outcome, 'blocked');
  });

  test('retroactive image sweep removes stored items whose picture shows a woman, and resumes where it stopped', async () => {
    const ins = (u) => repo.media.insert({
      creator_id: null, feed_id: feed.id, platform: 'reddit', source_id: `sw${++n}`, source_key: `reddit:sw${n}:0`, post_key: `reddit:sw${n}`, position: 0, source_url: 'https://reddit.com/x',
      community: 'gaybrosgonewild', author: 'swuser', title: 'old post', media_type: 'image', media_url: u, preview_url: u, hash: `swhash${n}`, nsfw_level: 'explicit', scope: 'in',
      publish_state: 'published', posted_at: new Date().toISOString(),
    }, ['gay']);
    const bad = ins('https://i.redd.it/oldwoman.jpg'); const ok = ins('https://i.redd.it/oldman.jpg');
    fake({ 'https://i.redd.it/oldwoman.jpg': faces(['female', 0.9]), 'https://i.redd.it/oldman.jpg': faces(['male', 0.9]) });
    const r = await maintenance.imageSweep({ limit: 100, settings });
    assert.ok(r.checked >= 2 && r.removed >= 1, JSON.stringify(r));
    assert.equal(repo.media.get(bad).publish_state, 'removed');
    assert.equal(repo.media.get(ok).publish_state, 'published');
    assert.ok(repo.blocklist.has('hash', repo.db.prepare('SELECT hash FROM media WHERE id = ?').get(bad).hash));
    const again = await maintenance.imageSweep({ limit: 100, settings });
    assert.equal(again.checked, 0, 'the cursor moved past everything already checked');
  });
});
