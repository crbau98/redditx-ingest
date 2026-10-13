'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');
const { measure, textCheck } = require('../src/lib/physique');

/* ------------------------------------------------------------------ synthetic bodies */
// A 200 x 300 alpha mask with a torso whose half-width at each row is `half(y)`, optional arms hanging beside it, and the
// MoveNet keypoints that go with it (shoulders y=50, hips y=170: torso length 120, shoulder span 80).
function body({ belly = 32, chest = 44, arms = null, w = 200, h = 300, cx = 100, sideways = false, noHips = false } = {}) {
  const mask = new Uint8Array(w * h);
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 255; };
  const half = (y) => (y < 50 ? chest : y > 170 ? belly : chest + ((belly - chest) * (y - 50)) / 120);
  for (let y = 40; y <= 200; y++) for (let x = Math.round(cx - half(y)); x <= Math.round(cx + half(y)); x++) set(x, y);
  const kp = (part, x, y, score = 0.8) => ({ part, position: [x, y], score });
  const span = sideways ? 15 : 40;
  const keypoints = [kp('leftShoulder', cx + span, 50), kp('rightShoulder', cx - span, 50)];
  if (!noHips) keypoints.push(kp('leftHip', cx + 25, 170), kp('rightHip', cx - 25, 170));
  for (const side of arms || []) {
    const s = side === 'left' ? 1 : -1;
    const x0 = Math.round(cx + s * (belly + 1)); // hanging right against the belly: one blob in the silhouette
    for (let y = 50; y <= 190; y++) for (let k = 0; k < 12; k++) set(x0 + s * k, y);
    keypoints.push(kp(`${side}Elbow`, x0 + s * 6, 115, 0.5), kp(`${side}Wrist`, x0 + s * 6, 165, 0.4));
  }
  return [keypoints, mask, w, h];
}

describe('measuring a body (pure geometry)', () => {
  test('a V-shaped torso scores lean, a belly as wide as the shoulders scores heavy', () => {
    const lean = measure(...body({ belly: 30 }));
    assert.equal(lean.decided, true); assert.ok(lean.score <= 10, JSON.stringify(lean));
    const heavy = measure(...body({ belly: 56, chest: 52 }));
    assert.equal(heavy.decided, true); assert.ok(heavy.score >= 80, JSON.stringify(heavy));
    const middle = measure(...body({ belly: 42 }));
    assert.ok(middle.score > lean.score && middle.score < heavy.score, JSON.stringify(middle));
  });
  test('arms hanging against the belly never make a lean body look wide', () => {
    const both = measure(...body({ belly: 30, arms: ['left', 'right'] }));
    assert.ok(!both.decided || both.score <= 10, `both arms down: ${JSON.stringify(both)}`);
    const one = measure(...body({ belly: 30, arms: ['left'] })); // the other arm is up (a mirror selfie)
    assert.equal(one.decided, true); assert.ok(one.score <= 10, `measured from the free side: ${JSON.stringify(one)}`);
  });
  test('no verdict without a frontal torso in view', () => {
    assert.equal(measure(...body({ sideways: true })).decided, false);
    assert.equal(measure(...body({ noHips: true })).decided, false);
    assert.equal(measure([], new Uint8Array(4), 2, 2).decided, false);
    assert.equal(measure(null, null, 0, 0).decided, false);
  });
});

describe('physique words', () => {
  test('chub / gainer / dad-bod vocabulary is heavy, also inside glued handles', () => {
    for (const t of ['Chubby bear next door', 'superchub_sam', 'GainerGuy', 'my dad bod', 'Chub daddy', 'bbm worship', 'fat guy jerking', 'Chubchasers united', 'beer belly rub', 'r/chubbyguys'])
      assert.equal(textCheck(t).heavy, true, t);
  });
  test('"fat" as porn slang for thick, and lean / muscle words, are not', () => {
    for (const t of ['fat cock', 'huge fat dick', 'fat load on abs', 'that fat ass', 'thick muscle jock', 'gym bear', 'muscle bear daddy', 'fit twink', 'athletic swimmer'])
      assert.equal(textCheck(t).heavy, false, t);
  });
});

/* ------------------------------------------------------------------ policy */
let mock; let imagefilter; let repo; let pipeline; let maintenance; let physique; let feed; let n = 0;
const assets = (f) => path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'assets', f);
const haveModel = fs.existsSync(assets('screenshot-vrm.jpg')) && (() => { try { require.resolve('sharp'); require.resolve('@tensorflow/tfjs-backend-wasm'); return true; } catch { return false; } })();

/** The test avatar with its belly widened (a sine-shaped horizontal stretch around the waist), as JPEG bytes. */
async function widen(file, amount) {
  const sharp = require('sharp');
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width; const out = Buffer.from(data); const cx = 160; const y0 = 195; const y1 = 345;
  for (let y = y0; y < y1; y++) {
    const f = 1 + amount * Math.sin((Math.PI * (y - y0)) / (y1 - y0));
    for (let x = 0; x < W; x++) { const sx = Math.round(cx + (x - cx) / f); for (let c = 0; c < 3; c++) out[(y * W + x) * 3 + c] = sx >= 0 && sx < W ? data[(y * W + sx) * 3 + c] : 0; }
  }
  return sharp(out, { raw: { width: W, height: info.height, channels: 3 } }).jpeg().toBuffer();
}

before(async () => {
  const routes = {};
  if (haveModel) {
    routes['/avatar.jpg'] = () => ({ headers: { 'content-type': 'image/jpeg' }, body: fs.readFileSync(assets('screenshot-vrm.jpg')) });
    const wide = await widen(assets('screenshot-vrm.jpg'), 0.35);
    routes['/avatar-wide.jpg'] = () => ({ headers: { 'content-type': 'image/jpeg' }, body: wide });
  }
  mock = await start(routes);
  prepareEnv();
  imagefilter = require('../src/lib/imagefilter');
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  maintenance = require('../src/engine/maintenance');
  physique = require('../src/engine/physique');
  feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
});
after(async () => { imagefilter._reset(); await imagefilter.shutdown(); await mock.close(); });

const settings = { probeUnknownHosts: false, scopeMode: 'open', imageFilter: true, imageFilterThreshold: 50, physiqueFilter: true, physiqueThreshold: 60, physiqueCreatorShare: 50 };
const item = (o) => ({ sourceId: `b${++n}`, title: 'Gym selfie', author: `guy${n}`, community: 'gaybrosgonewild', mediaType: 'image', trusted: true, mediaUrl: `https://i.redd.it/b${n}.jpg`, ...o });
const male = [{ gender: 'male', score: 0.9, confidence: 0.9 }];
const fake = (scores) => imagefilter._setAnalyzer(async (url, { body }) => {
  const s = scores[url];
  return { status: 'ok', faces: male, ...(body ? { body: s == null ? { decided: false, reason: 'torso not in view' } : { decided: true, score: s } } : {}) };
});

describe('the real pose + silhouette models (on-device, no network)', { skip: !haveModel && 'optional ML dependencies not installed' }, () => {
  test('a slim figure measures lean; the same figure with a widened belly measures clearly heavier', async () => {
    const slim = await imagefilter.analyze(`${mock.url}/avatar.jpg`, { body: true });
    assert.equal(slim.status, 'ok'); assert.equal(slim.body.decided, true, JSON.stringify(slim.body));
    assert.ok(slim.body.score <= 25, `slim: ${JSON.stringify(slim.body)}`);
    const wide = await imagefilter.analyze(`${mock.url}/avatar-wide.jpg`, { body: true });
    assert.equal(wide.body.decided, true, JSON.stringify(wide.body));
    assert.ok(wide.body.score >= slim.body.score + 30, `wide: ${JSON.stringify(wide.body)} vs slim ${JSON.stringify(slim.body)}`);
  });
});

describe('body filter policy (model replaced by a fake)', () => {
  test('heavy pictures are kept but hidden with their score; lean and unmeasurable ones publish', async () => {
    fake({ 'https://i.redd.it/heavy.jpg': 85, 'https://i.redd.it/lean.jpg': 10 });
    const h = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/heavy.jpg' }), feed, null, settings);
    assert.equal(h.outcome, 'hidden');
    const m = repo.media.get(h.mediaId);
    assert.equal(m.publish_state, 'hidden'); assert.equal(m.physique, 85); assert.equal(m.review_reason, 'physique:85');
    const l = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/lean.jpg' }), feed, null, settings);
    assert.equal(l.outcome, 'added'); assert.equal(repo.media.get(l.mediaId).physique, 10);
    const u = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/closeup.jpg' }), feed, null, settings);
    assert.equal(u.outcome, 'added', 'no torso in view: no verdict'); assert.equal(repo.media.get(u.mediaId).physique, null);
  });

  test('switched off, nothing is measured or hidden', async () => {
    fake({ 'https://i.redd.it/heavy-off.jpg': 95 });
    const r = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/heavy-off.jpg' }), feed, null, { ...settings, physiqueFilter: false });
    assert.equal(r.outcome, 'added'); assert.equal(repo.media.get(r.mediaId).physique, null);
  });

  test('chub vocabulary in the post excludes it before any download', async () => {
    let looked = 0;
    imagefilter._setAnalyzer(async () => { looked++; return { status: 'ok', faces: male, body: { decided: true, score: 0 } }; });
    const r = await pipeline.processItem(item({ title: 'Chubby bear showing off' }), feed, null, settings);
    assert.equal(r.outcome, 'excluded'); assert.match(r.reason, /^physique:chubby/);
    assert.equal(looked, 0, 'the picture was never fetched');
    assert.equal((await pipeline.processItem(item({ title: 'fat cock friday' }), feed, null, settings)).outcome, 'added', '"fat cock" is not about the body');
  });

  test('moving the threshold re-applies to the stored library in both directions; switching off shows everything again', async () => {
    fake({ 'https://i.redd.it/t70.jpg': 70 });
    const id = (await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/t70.jpg' }), feed, null, settings)).mediaId;
    assert.equal(repo.media.get(id).publish_state, 'hidden');
    physique.reapply({ ...settings, physiqueThreshold: 80 });
    assert.equal(repo.media.get(id).publish_state, 'published'); assert.equal(repo.media.get(id).review_reason, null);
    physique.reapply({ ...settings, physiqueThreshold: 65 });
    assert.equal(repo.media.get(id).publish_state, 'hidden');
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.media.get(id).publish_state, 'published');
    physique.reapply(settings);
    assert.equal(repo.media.get(id).publish_state, 'hidden');
  });

  test('items an admin hid for another reason are never shown again by the body filter', () => {
    fake({});
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'adm1', source_key: 'reddit:adm1:0', post_key: 'reddit:adm1', source_url: 'https://reddit.com/a', media_type: 'image', media_url: 'https://i.redd.it/adm1.jpg', hash: 'admhash1', physique: 10, publish_state: 'hidden', review_reason: 'reported:spam' });
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.media.get(id).publish_state, 'hidden');
  });

  test('a creator whose measured pictures are mostly heavy is hidden with their feed paused; reversible', async () => {
    const c = repo.creators.create({ handle: 'bigdan', origin: 'admin' });
    const own = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'bigdan', creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin' }).feed;
    const scores = {}; ['d1', 'd2', 'd3', 'd4'].forEach((k, i) => { scores[`https://i.redd.it/${k}.jpg`] = i === 0 ? 20 : 80; });
    fake(scores);
    for (const k of ['d1', 'd2', 'd3', 'd4']) await pipeline.processItem(item({ author: 'bigdan', mediaUrl: `https://i.redd.it/${k}.jpg` }), own, null, settings);
    assert.equal(repo.creators.get(c.id).status, 'hidden', '3 of 4 heavy');
    assert.equal(repo.feeds.get(own.id).enabled, 0);
    assert.equal((await pipeline.processItem(item({ author: 'bigdan', mediaUrl: 'https://i.redd.it/d5.jpg' }), own, null, settings)).outcome, 'blocked', 'refused before any download');
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.creators.get(c.id).status, 'active');
    assert.equal(repo.feeds.get(own.id).enabled, 1);
    physique.reapply({ ...settings, physiqueCreatorShare: 0 });
    assert.equal(repo.creators.get(c.id).status, 'active', 'share 0 = creators are never hidden');
  });

  test('an item an admin approves is never re-hidden by the body filter', async () => {
    fake({ 'https://i.redd.it/appr.jpg': 90 });
    const id = (await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/appr.jpg' }), feed, null, settings)).mediaId;
    require('../src/services/targets').moderate(id, 'approve', 'looks fit to me');
    assert.equal(repo.media.get(id).publish_state, 'published'); assert.equal(repo.media.get(id).physique, null);
    physique.reapply({ ...settings, physiqueThreshold: 20 });
    assert.equal(repo.media.get(id).publish_state, 'published');
  });

  test('a creator with an open safety report stays hidden when the body filter lets go', async () => {
    const c = repo.creators.create({ handle: 'reportedbig', origin: 'admin' });
    const own = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'reportedbig', creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin' }).feed;
    const scores = {}; ['r1', 'r2', 'r3', 'r4'].forEach((k) => { scores[`https://i.redd.it/${k}.jpg`] = 85; });
    fake(scores);
    for (const k of ['r1', 'r2', 'r3', 'r4']) await pipeline.processItem(item({ author: 'reportedbig', mediaUrl: `https://i.redd.it/${k}.jpg` }), own, null, settings);
    assert.equal(repo.creators.get(c.id).status, 'hidden');
    repo.reports.create({ creatorId: c.id, kind: 'underage', reason: 'test', reporterHash: 'x' });
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.creators.get(c.id).status, 'hidden');
  });

  test('feeds named in chub wording cannot be added while the filter is on', () => {
    const targets = require('../src/services/targets');
    const r = targets.addSpec({ platform: 'reddit', kind: 'community', target: 'chubbyguys2', label: 'r/chubbyguys2' });
    assert.equal(r.status, 'invalid'); assert.match(r.reason, /Body filter/);
  });

  test('approving an item from the safety review queue still applies its body verdict', () => {
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'aq1', source_key: 'reddit:aq1:0', post_key: 'reddit:aq1', source_url: 'https://reddit.com/x', media_type: 'image', media_url: 'https://i.redd.it/aq1.jpg', hash: 'h-aq1', physique: 90, publish_state: 'review', review_reason: 'safety:teen' });
    require('../src/services/targets').moderate(id, 'approve', 'adult, fine');
    assert.equal(repo.media.get(id).publish_state, 'hidden'); assert.equal(repo.media.get(id).physique, 90);
  });

  test('the word sweep stops when the filter is switched off mid-way', async () => {
    const store = require('../src/settings');
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'off1', source_key: 'reddit:off1:0', post_key: 'reddit:off1', source_url: 'https://reddit.com/x', title: 'gainer pics', media_type: 'image', media_url: 'https://i.redd.it/off1.jpg', hash: 'h-off1', publish_state: 'published' });
    store.update({ physiqueFilter: false });
    try { await physique.textSweep(settings, { force: true }); } finally { store.update({ physiqueFilter: true }); }
    assert.equal(repo.media.get(id).publish_state, 'published');
  });

  test('an admin can still add a chub-named feed explicitly (discovery Follow click)', () => {
    const r = require('../src/services/targets').addSpec({ platform: 'reddit', kind: 'community', target: 'chubbyguys3' }, { bodyOverride: true });
    assert.equal(r.status, 'created');
  });

  test('posts hidden for their words never count as measured pictures for the creator ratio', async () => {
    const c = repo.creators.create({ handle: 'wordyguy', origin: 'admin' });
    const ids = ['w1', 'w2', 'w3', 'w4'].map((k) => repo.media.insert({ creator_id: c.id, feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: 'https://reddit.com/x', title: 'chubby day', media_type: 'image', media_url: `https://i.redd.it/${k}.jpg`, hash: `h-${k}`, publish_state: 'published' }));
    await physique.textSweep(settings, { force: true });
    for (const id of ids) assert.equal(repo.media.get(id).publish_state, 'hidden');
    physique.reapply(settings);
    assert.equal(repo.creators.get(c.id).status, 'active');
  });

  test('a refreshed profile that now reads chub hides the creator', () => {
    const c = repo.creators.create({ handle: 'renamedguy', origin: 'admin' });
    const f = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'renamedguy', creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin' }).feed;
    const r = require('../src/engine/creators').applyProfile(repo.feeds.get(f.id), { displayName: 'Renamed', bio: 'proud superchub' }, settings);
    assert.equal(r.hidden, true); assert.equal(repo.creators.get(c.id).status, 'hidden');
  });

  test('a feed the admin switched off again stays off when the body filter is switched off', async () => {
    const f = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gainerhub', enabled: 1, trusted: 1, origin: 'admin' }).feed;
    await physique.textSweep(settings, { force: true });
    assert.equal(repo.feeds.get(f.id).enabled, 0);
    repo.logAction('feed', f.id, 'enable', 'admin', 'admin'); repo.feeds.update(f.id, { enabled: true });
    repo.logAction('feed', f.id, 'disable', 'admin', 'admin'); repo.feeds.update(f.id, { enabled: false });
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.feeds.get(f.id).enabled, 0);
  });

  test('a creator an admin hid stays hidden whatever the body filter says', () => {
    const c = repo.creators.create({ handle: 'adminhid', origin: 'admin' });
    repo.creators.update(c.id, { status: 'hidden' });
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.creators.get(c.id).status, 'hidden');
  });

  test('the body sweep measures stored pictures once, hides the heavy ones and moves on', async () => {
    const ins = (u, k) => repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: 'https://reddit.com/x', media_type: 'image', media_url: u, preview_url: u, hash: `h-${k}`, publish_state: 'published' });
    const heavy = ins('https://i.redd.it/oldheavy.jpg', 'ps1'); const lean = ins('https://i.redd.it/oldlean.jpg', 'ps2');
    fake({ 'https://i.redd.it/oldheavy.jpg': 90, 'https://i.redd.it/oldlean.jpg': 5 });
    const r = await maintenance.physiqueSweep({ limit: 500, settings });
    assert.ok(r.hidden >= 1, JSON.stringify(r));
    assert.equal(repo.media.get(heavy).publish_state, 'hidden'); assert.equal(repo.media.get(heavy).physique, 90);
    assert.equal(repo.media.get(lean).publish_state, 'published'); assert.equal(repo.media.get(lean).physique, 5);
    assert.equal((await maintenance.physiqueSweep({ limit: 500, settings })).checked, 0, 'cursor moved past everything');
  });

  test('the word sweep leaves items in the review queue alone, so switching off never publishes them', async () => {
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'rv1', source_key: 'reddit:rv1:0', post_key: 'reddit:rv1', source_url: 'https://reddit.com/x', title: 'chubby and borderline', media_type: 'image', media_url: 'https://i.redd.it/rv1.jpg', hash: 'h-rv1', publish_state: 'review', review_reason: 'safety:teen' });
    await physique.textSweep(settings, { force: true });
    assert.equal(repo.media.get(id).publish_state, 'review'); assert.equal(repo.media.get(id).review_reason, 'safety:teen');
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.media.get(id).publish_state, 'review');
  });

  test('the word sweep hides stored chub posts and pauses chub feeds; stats report it', async () => {
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'ws1', source_key: 'reddit:ws1:0', post_key: 'reddit:ws1', source_url: 'https://reddit.com/x', title: 'superchub belly', media_type: 'image', media_url: 'https://i.redd.it/ws1.jpg', hash: 'h-ws1', publish_state: 'published' });
    const chubFeed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'chubbyguys', enabled: 1, trusted: 1, origin: 'admin' }).feed;
    const r = await physique.textSweep(settings, { force: true });
    assert.ok(r.items >= 1 && r.feeds >= 1, JSON.stringify(r));
    assert.equal(repo.media.get(id).publish_state, 'hidden');
    assert.equal(repo.feeds.get(chubFeed.id).enabled, 0);
    const st = physique.stats(settings);
    assert.ok(st.measured > 0 && st.hidden > 0 && st.histogram.length > 0, JSON.stringify(st));
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.media.get(id).publish_state, 'published');
    assert.equal(repo.feeds.get(chubFeed.id).enabled, 1);
  });
});
