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
    assert.equal(lean.decided, true); assert.ok(lean.score <= 25, JSON.stringify(lean)); // well under the default line (45)
    const heavy = measure(...body({ belly: 56, chest: 52 }));
    assert.equal(heavy.decided, true); assert.ok(heavy.score >= 80, JSON.stringify(heavy));
    const middle = measure(...body({ belly: 36 }));
    assert.ok(middle.score > lean.score && middle.score < heavy.score, JSON.stringify(middle));
  });
  test('arms hanging against the belly never make a lean body look wide', () => {
    const both = measure(...body({ belly: 30, arms: ['left', 'right'] }));
    assert.ok(!both.decided || both.score <= 25, `both arms down: ${JSON.stringify(both)}`);
    const one = measure(...body({ belly: 30, arms: ['left'] })); // the other arm is up (a mirror selfie)
    assert.equal(one.decided, true); assert.ok(one.score <= 25, `measured from the free side: ${JSON.stringify(one)}`);
  });
  // Regression (fix/physique-scoring): sampled Coomer / Bluesky thumbnails scored 100 with belly widths of 1.5-2.4 shoulder spans.
  // The torso crop's border was counted as the body's edge, and silhouettes merged with a partner / bed were read as one belly.
  test('a silhouette that runs off the torso crop has no edge there: no verdict, not a crop-wide "belly" scored 100', () => {
    const [kp, mask, w, h] = body({ belly: 120, chest: 120 }); // wider than the 200 px mask: every row is "person" to both borders
    const r = measure(kp, mask, w, h);
    assert.equal(r.decided, false, JSON.stringify(r));
    // one side runs off the crop, the other is a real edge: that side is measured and mirrored, as for a hidden arm
    const [kp2, mask2, w2, h2] = body({ belly: 30, chest: 40, cx: 40 });
    const r2 = measure(kp2, mask2, w2, h2);
    assert.ok(!r2.decided || r2.score <= 25, JSON.stringify(r2));
  });
  test('a silhouette far wider than one torso (a partner, a bed) is not a very large body: no verdict', () => {
    const wide = measure(...body({ belly: 150, chest: 150, w: 600, cx: 300 })); // ~3.7 shoulder spans, fully inside the mask
    assert.equal(wide.decided, false, JSON.stringify(wide));
    // ... while a genuinely very large build (belly 1.4 shoulder spans) is still measured and scores 100
    const big = measure(...body({ belly: 56, chest: 52 }));
    assert.equal(big.decided, true, JSON.stringify(big)); assert.equal(big.score, 100);
  });
  test('keypoints that do not describe one upright torso give no verdict', () => {
    const [kp, mask, w, h] = body({ belly: 56, chest: 52 });
    const twisted = kp.map((k) => (k.part === 'leftHip' ? { ...k, position: [k.position[0] - 40, k.position[1] - 80] } : k)); // hips twisted far from the shoulder line
    assert.equal(measure(twisted, mask, w, h).decided, false);
    const stretched = kp.map((k) => (k.part === 'leftShoulder' ? { ...k, position: [k.position[0] + 140, k.position[1]] } : k)); // shoulder span 2x the torso length
    assert.equal(measure(stretched, mask, w, h).decided, false);
  });
  test('a short (foreshortened) torso with shoulders wider than the belly is not read as heavy', () => {
    // belly 36 / chest 44 / hips 25: ws 0.9 but the torso keypoints are squeezed together (a seated or high-angle shot): wl is far over its line
    const [kp, mask, w, h] = body({ belly: 28, chest: 44 });
    const squeezed = kp.map((k) => (/Hip$/.test(k.part) ? { ...k, position: [k.position[0], 50 + (k.position[1] - 50) * 0.55] } : k)); // torso length 120 -> 66, shoulders unchanged
    const r = measure(squeezed, mask, w, h);
    assert.equal(r.decided, false, JSON.stringify(r));
    // a long torso with a belly as wide as the shoulders (ws heavy, wl not) is still heavy
    const long = measure(...body({ belly: 44, chest: 44 }));
    assert.equal(long.decided, true, JSON.stringify(long)); assert.ok(long.score >= 45, JSON.stringify(long));
  });
  test('a person facing away (left shoulder and hip on the image\'s left) is not measured: the belly is not in view', () => {
    const [kp, mask, w, h] = body({ belly: 56, chest: 52 }); // the wide silhouette that scores 100 from the front
    assert.equal(measure(kp, mask, w, h).score, 100);
    const flip = { leftShoulder: 'rightShoulder', rightShoulder: 'leftShoulder', leftHip: 'rightHip', rightHip: 'leftHip' };
    const fromBehind = kp.map((k) => (flip[k.part] ? { ...k, part: flip[k.part] } : k));
    const r = measure(fromBehind, mask, w, h);
    assert.equal(r.decided, false, JSON.stringify(r)); assert.equal(r.reason, 'facing away');
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
  test('bears, cubs and stocky builds are not the fit / athletic look either', () => {
    for (const t of ['gym bear', 'muscle bear daddy', 'r/bearsgonewild', 'GayBearSam', 'cute cub', 'stocky guy', 'burly trucker', 'big guys only', 'ガチムチ', '#gaybear', 'polarbear_dad'])
      assert.equal(textCheck(t).heavy, true, t);
  });
  test('beards, otters and muscle words are fine', () => {
    for (const t of ['bearded jock', 'Beard and abs', 'gaybeard', 'otter swimmer', 'thick muscle jock', 'big cock', 'big dick energy', 'huge fat dick'])
      assert.equal(textCheck(t).heavy, false, t);
  });
  test('"fat" as porn slang for thick, and lean / muscle words, are not', () => {
    for (const t of ['fat cock', 'huge fat dick', 'fat load on abs', 'that fat ass', 'thick muscle jock', 'fit twink', 'athletic swimmer'])
      assert.equal(textCheck(t).heavy, false, t);
  });
});

describe('older men: words and stated ages only', () => {
  test('a man who calls himself older, or states an age of 45 or more, is matched', () => {
    for (const t of ['silver fox', '#silverdaddy', 'GreyDaddy', 'Grandpa', 'Grandpa fucks twink', 'your new grandad', '#oldman', '#maturemen', '52yo', '52 y/o', '52 y o', '52 years old', '52-year-old', 'Age: 55', 'aged 58', "I'm 58", "I'm 58, gym rat", "I'm 52 and lifting", 'I am 61 years old', 'in my 50s', 'in my early 50s', 'late 40s', 'mid-60s', 'Looking good at 61 yrs old']) {
      const r = textCheck(t);
      assert.equal(r.heavy, true, t); assert.equal(r.kind, 'older', t); assert.match(r.rule, /^physique:older:/, t);
    }
  });
  test('look-alikes, younger stated ages and plain "daddy" are not matched', () => {
    for (const t of ['Goldman', 'Holderman', 'age 24', "I'm 24", '24yo', '31 y/o', '44 years of age', 'turning 25', 'age 18', '19yo', 'in my 20s', '18+ only', 'mature content',
      '50 years of experience', "I'm 60 kg", "I'm 50% done", 'over 50 videos', 'sugar daddy', 'gym daddy', 'daddy', 'old school gym', 'Old Spice', 'Class of 2010', 'gay muscle jock'])
      assert.equal(textCheck(t).heavy, false, t);
  });
  test('regressions from an independent review: comp-prep and fitness lines, other people, and attraction are not an older man', () => {
    for (const t of [
      // "I'm NN" followed by something other than an age
      "I'm 48 hours into fasting", 'I am 60 days out from my first show', "I'm 60 days into my cut", 'Im 46 days into keto', "I'm 45 days sober", "I'm 50 weeks out",
      "I'm 50 sets", "I'm 50 pounds down", "I'm 50/50", "I'm 70 percent there", 'Age: 45 days to go', 'turning 50 pages', 'im 50 Meter Becken', '27 | natural | I am 60 days out from my first show',
      "I'm 50,000 followers strong", "I'm 45.5 kg down", 'Age: 45.5 days into prep', "I'm 60.5 kg",
      // somebody else, or a thing, not himself
      'my old man taught me to lift', 'Raised by my grandpa', 'My grandfather got me into lifting', 'Grandfather clock', 'gramps hoodie giveaway', 'Elderly care worker, 29',
      'Old Man Strength lifts', 'OldManStrength', 'Gray Fox Gaming', 'Grey fox sneakers', 'pensioner discount',
      // liking older men is not being one, and 44 to 46 is under the line
      'Seeking older men', 'I love older men (19yo twink)', 'Into mature men', "Mature men's skincare brand", 'mid 40s'])
      assert.equal(textCheck(t).heavy, false, t);
  });
  test('the rule is words only: it never reads a picture, and the age line is a constant', () => {
    assert.equal(require('../src/lib/physique').OLDER_MIN_AGE, 45);
    assert.equal(textCheck('silver fox').kind, 'older'); assert.equal(textCheck('chubby').kind, 'heavy');
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
    const midBody = await widen(assets('screenshot-vrm.jpg'), 0.2);
    routes['/avatar-mid.jpg'] = () => ({ headers: { 'content-type': 'image/jpeg' }, body: midBody });
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
  test('a belly only ~20% wider than the slim figure is already over the default line (v4.14 let it through at 50)', async () => {
    const mid = await imagefilter.analyze(`${mock.url}/avatar-mid.jpg`, { body: true });
    assert.equal(mid.body.decided, true, JSON.stringify(mid.body));
    assert.ok(mid.body.score >= physique.DEFAULT_THRESHOLD, JSON.stringify(mid.body));
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
    assert.equal(repo.media.get(id).publish_state, 'published'); assert.equal(repo.media.get(id).physique, physique.APPROVED);
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

  test('the sweep SHOWS AGAIN what an earlier, broader list hid (after the body sweep measures it), keeps what still matches, and never undoes a person', async () => {
    const base = (k, extra) => repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: `https://reddit.com/${k}`,
      media_type: 'image', media_url: `https://i.redd.it/${k}.jpg`, preview_url: `https://i.redd.it/${k}.jpg`, hash: `h-${k}`, publish_state: 'hidden', ...extra });
    // hidden by the old rule for "I am 60 days out": the current rules do not match it, so it is shown again
    const stale = base('stale1', { title: 'I am 60 days out from my first show', physique: 101, review_reason: "physique:text:older:i am 60" });
    const staleHeavy = base('stale2', { title: 'I am 60 days out from my first show', physique: 101, review_reason: "physique:text:older:i am 60" });
    // still matches: stays hidden
    const still = base('still1', { title: 'silver fox at the gym', physique: 101, review_reason: 'physique:text:older:silver fox' });
    // hidden by a person for another reason: never touched, even though its words are harmless
    const person = base('person1', { title: 'I am 60 days out from my first show', physique: null, review_reason: 'reported:spam' });
    fake({ 'https://i.redd.it/stale1.jpg': 10, 'https://i.redd.it/stale2.jpg': 88, 'https://i.redd.it/still1.jpg': 10, 'https://i.redd.it/person1.jpg': 10 });
    await physique.textSweep(settings, { force: true });
    assert.equal(repo.media.get(stale).publish_state, 'hidden', 'not shown on the strength of words alone: it has no measured picture yet');
    const r = await maintenance.physiqueSweep({ limit: 500, settings });  // the text sweep rewound it to these rows
    assert.ok(r.restored >= 2, JSON.stringify(r));
    assert.equal(repo.media.get(stale).publish_state, 'published'); assert.equal(repo.media.get(stale).physique, 10);
    assert.equal(repo.media.get(staleHeavy).publish_state, 'hidden', 'a heavy picture stays hidden, now for the body reason');
    assert.equal(repo.media.get(staleHeavy).physique, 88); assert.equal(repo.media.get(staleHeavy).review_reason, 'physique:88');
    physique.reapply(settings);
    assert.equal(repo.media.get(stale).publish_state, 'published', 'and it stays shown after the next boot');
    assert.equal(repo.media.get(still).publish_state, 'hidden');
    assert.equal(repo.media.get(person).publish_state, 'hidden'); assert.equal(repo.media.get(person).review_reason, 'reported:spam');
  });

  test('restoring a word-hidden item never throws away a MEASURED score: heavy stays hidden (with the body reason), light is shown', async () => {
    fake({});
    const base = (k, extra) => repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: `https://reddit.com/${k}`,
      media_type: 'image', media_url: `https://i.redd.it/${k}.jpg`, hash: `h-${k}`, publish_state: 'hidden', title: 'I am 60 days out from my first show', ...extra });
    // the body sweep replaced the word marker (101) with a measured score but left the old text reason on the row
    const heavy = base('meas-heavy', { physique: 88, review_reason: 'physique:text:older:i am 60' });
    const light = base('meas-light', { physique: 20, review_reason: 'physique:text:older:i am 60' });
    const r = await physique.textSweep(settings, { force: true });
    assert.equal(repo.media.get(heavy).publish_state, 'hidden', 'a measured heavy picture must not be published');
    assert.equal(repo.media.get(heavy).physique, 88, 'and its measured score is kept');
    assert.equal(repo.media.get(heavy).review_reason, 'physique:88', 'now hidden for the right reason');
    assert.equal(repo.media.get(light).publish_state, 'published'); assert.equal(repo.media.get(light).physique, 20);
    assert.ok(r.restored >= 1);
    physique.reapply(settings);
    assert.equal(repo.media.get(heavy).publish_state, 'hidden'); assert.equal(repo.media.get(light).publish_state, 'published');
  });

  test('the restore decision uses the threshold as it is NOW, not the sweep\'s starting snapshot', async () => {
    fake({});
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'snap1', source_key: 'reddit:snap1:0', post_key: 'reddit:snap1', source_url: 'https://reddit.com/snap1',
      media_type: 'image', media_url: 'https://i.redd.it/snap1.jpg', hash: 'h-snap1', publish_state: 'hidden', title: 'I am 60 days out from my first show', physique: 50, review_reason: 'physique:text:older:i am 60' });
    const store = require('../src/settings');
    const before = store.get().physiqueThreshold;
    store.update({ physiqueFilter: true, physiqueThreshold: 40 });  // an admin lowered it; the sweep still holds `settings` (threshold 60)
    try {
      await physique.textSweep({ ...settings, physiqueThreshold: 60 }, { force: true });
      assert.equal(repo.media.get(id).publish_state, 'hidden', 'measured 50 is over the current threshold 40, so it stays hidden');
    } finally { store.update({ physiqueThreshold: before }); }
  });

  test('an item the filter\'s off/on path left as "physique:101" (word marker, body reason) is re-read too; a person\'s hide is not', async () => {
    const base = (k, extra) => repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: `https://reddit.com/${k}`,
      media_type: 'image', media_url: `https://i.redd.it/${k}.jpg`, preview_url: `https://i.redd.it/${k}.jpg`, hash: `h-${k}`, publish_state: 'hidden', title: 'I am 60 days out from my first show', ...extra });
    const legacy = base('legacy101', { physique: 101, review_reason: 'physique:101' });
    const person = base('person101', { physique: 101, review_reason: 'reported:spam' });
    fake({ 'https://i.redd.it/legacy101.jpg': 12, 'https://i.redd.it/person101.jpg': 12 });
    await physique.textSweep(settings, { force: true });
    await maintenance.physiqueSweep({ limit: 500, settings });
    assert.equal(repo.media.get(legacy).publish_state, 'published'); assert.equal(repo.media.get(legacy).physique, 12);
    physique.reapply(settings);
    assert.equal(repo.media.get(legacy).publish_state, 'published', 'and it stays shown');
    assert.equal(repo.media.get(person).publish_state, 'hidden', 'a person\'s decision stands');
  });

  test('a word-marker row is measured again: the body sweep cursor moves back to it, and never forward', async () => {
    fake({});
    const base = (k, extra) => repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: `https://reddit.com/${k}`,
      media_type: 'image', media_url: `https://i.redd.it/${k}.jpg`, hash: `h-${k}`, publish_state: 'hidden', title: 'I am 60 days out from my first show', ...extra });
    const id = base('rewind1', { physique: 101, review_reason: 'physique:text:older:i am 60' });
    const seqOf = (i) => repo.db.prepare('SELECT seq FROM media WHERE id = ?').get(i).seq;
    const seq = seqOf(id);
    repo.settings.set('physique_sweep_seq', String(seq + 5000));            // the body sweep is already far past this row
    const r = await physique.textSweep(settings, { force: true });
    assert.equal(repo.media.get(id).publish_state, 'hidden', 'still hidden until it is measured');
    assert.equal(repo.settings.get('physique_sweep_seq'), String(seq - 1), 'the cursor is just before the row');
    assert.equal(r.rewound, seq - 1);
    repo.settings.set('physique_sweep_seq', '0');                           // a cursor that has not reached it yet stays where it is
    const id2 = base('rewind2', { physique: 101, review_reason: 'physique:text:older:i am 60' });
    await physique.textSweep(settings, { force: true });
    assert.equal(repo.settings.get('physique_sweep_seq'), '0');
    assert.ok(seqOf(id2) > 0);
  });

  test('a marker row stays hidden whenever no measurement happens (sweep off, no model, a failed analysis) and no torso in view shows it as unmeasured', async () => {
    const store = require('../src/settings');
    const base = (k) => repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: `https://reddit.com/${k}`,
      media_type: 'image', media_url: `https://i.redd.it/${k}.jpg`, preview_url: `https://i.redd.it/${k}.jpg`, hash: `h-${k}`, publish_state: 'hidden', title: 'I am 60 days out from my first show', physique: 101, review_reason: 'physique:text:older:i am 60' });
    const id = base('nomodel1');
    await physique.textSweep(settings, { force: true });
    // the model is missing or fails: the analysis returns an error / unavailable, so nothing is measured and nothing is shown
    for (const status of ['unavailable', 'error']) {
      imagefilter._setAnalyzer(async () => ({ status }));
      await physique.textSweep(settings, { force: true });
      await maintenance.physiqueSweep({ limit: 500, settings });
      assert.equal(repo.media.get(id).publish_state, 'hidden', status); assert.equal(repo.media.get(id).physique, 101);
    }
    // the image sweep is switched off: the body sweep is never run by the timer, and the text sweep alone shows nothing
    const was = store.get().imageSweep; store.update({ imageSweep: false });
    try { await physique.textSweep(settings, { force: true }); } finally { store.update({ imageSweep: was }); }
    assert.equal(repo.media.get(id).publish_state, 'hidden');
    // a picture with no torso in view is a real analysis: it is shown, unmeasured, like any other such picture
    fake({});
    await physique.textSweep(settings, { force: true });
    await maintenance.physiqueSweep({ limit: 500, settings });
    assert.equal(repo.media.get(id).publish_state, 'published'); assert.equal(repo.media.get(id).physique, null);
  });

  test('the cursor rewind is kept when the filter is switched off between restore batches', async () => {
    fake({});
    const store = require('../src/settings');
    const ids = [];
    for (let i = 0; i < 501; i++) ids.push(repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: `bt${i}`, source_key: `reddit:bt${i}:0`, post_key: `reddit:bt${i}`, source_url: `https://reddit.com/bt${i}`,
      media_type: 'image', media_url: `https://i.redd.it/bt${i}.jpg`, hash: `h-bt${i}`, publish_state: 'hidden', title: 'I am 60 days out from my first show', physique: 101, review_reason: 'physique:text:older:i am 60' }));
    const lowest = repo.db.prepare('SELECT MIN(seq) AS s FROM media WHERE id IN (' + ids.map(() => '?').join(',') + ')').get(...ids).s;
    const far = String(lowest + 100000);
    repo.settings.set('physique_sweep_seq', far); repo.settings.set('physique_text_sweep_version', '');
    const realSI = global.setImmediate;
    // off right after the first restore batch (once the cursor has moved), i.e. between two batches
    global.setImmediate = (fn, ...a) => { if (repo.settings.get('physique_sweep_seq') !== far && store.get().physiqueFilter) store.update({ physiqueFilter: false }); return realSI(fn, ...a); };
    try { await physique.textSweep(settings, { force: true }); } finally { global.setImmediate = realSI; store.update({ physiqueFilter: true }); }
    assert.equal(repo.settings.get('physique_sweep_seq'), String(lowest - 1), 'the first batch\'s rewind was applied before the abort');
    assert.notEqual(repo.settings.get('physique_text_sweep_version'), '4', 'and the pass really was cut short (not marked done)');
    repo.db.prepare('DELETE FROM media WHERE id IN (' + ids.map(() => '?').join(',') + ')').run(...ids); // leave the shared library as it was
  });

  test('the body sweep keeps a cursor that was moved BACK while its batch awaited the model', async () => {
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'race1', source_key: 'reddit:race1:0', post_key: 'reddit:race1', source_url: 'https://reddit.com/race1',
      media_type: 'image', media_url: 'https://i.redd.it/race1.jpg', preview_url: 'https://i.redd.it/race1.jpg', hash: 'h-race1', publish_state: 'published' });
    const seq = repo.db.prepare('SELECT seq FROM media WHERE id = ?').get(id).seq;
    repo.settings.set('physique_sweep_seq', String(seq - 1));
    imagefilter._setAnalyzer(async () => { repo.settings.set('physique_sweep_seq', '3'); return { status: 'ok', faces: male, body: { decided: true, score: 5 } }; }); // a text sweep rewinds meanwhile
    await maintenance.physiqueSweep({ limit: 1, settings });
    assert.equal(repo.settings.get('physique_sweep_seq'), '3', 'the rewind was not overwritten by this batch\'s own position');
    repo.settings.set('physique_sweep_seq', String(seq));
  });

  test('a row an admin changed while the model was working is not restored or overwritten from the stale snapshot', async () => {
    const base = (k) => repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: k, source_key: `reddit:${k}:0`, post_key: `reddit:${k}`, source_url: `https://reddit.com/${k}`,
      media_type: 'image', media_url: `https://i.redd.it/${k}.jpg`, preview_url: `https://i.redd.it/${k}.jpg`, hash: `h-${k}`, publish_state: 'hidden', title: 'I am 60 days out from my first show', physique: 101, review_reason: 'physique:text:older:i am 60' });
    const approved = base('mid-approve'); const reported = base('mid-report'); const retitled = base('mid-title');
    const first = repo.db.prepare('SELECT MIN(seq) AS s FROM media WHERE id IN (?, ?, ?)').get(approved, reported, retitled).s;
    repo.settings.set('physique_sweep_seq', String(first - 1));
    imagefilter._setAnalyzer(async (url) => {
      if (url.includes('mid-approve')) { repo.media.setPhysique(approved, physique.APPROVED); repo.media.setState(approved, 'published', null, { exact: true }); }   // approved meanwhile
      if (url.includes('mid-report')) repo.media.setState(reported, 'hidden', 'reported:spam', { exact: true });                                                 // taken down for another reason meanwhile
      if (url.includes('mid-title')) repo.db.prepare('UPDATE media SET title = ? WHERE id = ?').run('chubby gainer progress', retitled);                  // its words changed to something the policy really matches
      return { status: 'ok', faces: male, body: { decided: true, score: 5 } };
    });
    await maintenance.physiqueSweep({ limit: 500, settings });
    assert.equal(repo.media.get(retitled).publish_state, 'hidden', 'the text is re-read after the model call, so changed words are judged');
    assert.equal(repo.media.get(approved).physique, physique.APPROVED, 'an approval is not overwritten'); assert.equal(repo.media.get(approved).publish_state, 'published');
    assert.equal(repo.media.get(reported).publish_state, 'hidden'); assert.equal(repo.media.get(reported).review_reason, 'reported:spam', 'and a hide for another reason is not republished');
  });

  test('a stated age is still read when other fields follow it: "I\'m 58" then an author name', () => {
    for (const args of [["I'm 58", '', '', '', 'someauthor'], ["I'm 58", 'bio text', ['tag1', 'tag2'], 'community', 'author'], ['Age 52', null, null, 'r/fitness', 'x']]) {
      const r = physique.textCheck(...args);
      assert.equal(r.heavy, true, JSON.stringify(args)); assert.equal(r.kind, 'older');
    }
    for (const args of [["I'm 60 days out", 'prep', '', '', 'author'], ["I'm 50,000 followers strong", 'x', '', '', 'author']]) assert.equal(physique.textCheck(...args).heavy, false, JSON.stringify(args));
  });

  test('a stated age on its own LINE inside one field is read ("I\'m 58\\nfitness creator"), and a line that continues the number is not', () => {
    for (const bio of ["I'm 58\nfitness creator", "fitness creator\nAge: 58\nDM for collabs", "I'm 58\r\nlifting", "I'm 58\u2028coach"]) {
      assert.equal(physique.textCheck('title', bio).heavy, true, JSON.stringify(bio));
    }
    for (const bio of ["I'm 60 days out\nfitness creator", "I'm 58 kg\nfitness creator"]) assert.equal(physique.textCheck('title', bio).heavy, false, JSON.stringify(bio));
  });

  test('a feed this policy paused whose name no longer matches runs again, unless a person acted on it', async () => {
    const ok = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'plainlifters', enabled: 0, trusted: 1, origin: 'admin' }).feed;
    repo.logAction('feed', ok.id, 'physique-feed-off', 'body filter: "older:i am 60"', 'system');
    const matches = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gainerhub2', enabled: 0, trusted: 1, origin: 'admin' }).feed;
    repo.logAction('feed', matches.id, 'physique-feed-off', 'body filter: "gainer"', 'system');
    const touched = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'plainlifters2', enabled: 0, trusted: 1, origin: 'admin' }).feed;
    repo.logAction('feed', touched.id, 'physique-feed-off', 'body filter: "older:i am 60"', 'system');
    repo.logAction('feed', touched.id, 'disable', 'I turned it off', 'admin');
    await physique.textSweep(settings, { force: true });
    assert.equal(repo.feeds.get(ok.id).enabled, 1, 'no longer matches: runs again');
    assert.equal(repo.feeds.get(matches.id).enabled, 0, 'still matches: stays paused');
    assert.equal(repo.feeds.get(touched.id).enabled, 0, 'a person acted last: left alone');
  });

  test('a post that calls its man older is excluded before any download, and a "daddy" post is not', async () => {
    let looked = 0;
    imagefilter._setAnalyzer(async () => { looked++; return { status: 'ok', faces: male, body: { decided: true, score: 0 } }; });
    const r = await pipeline.processItem(item({ title: 'Silver fox at the gym' }), feed, null, settings);
    assert.equal(r.outcome, 'excluded'); assert.match(r.reason, /^physique:older:silver fox/);
    assert.equal(looked, 0, 'the picture was never fetched');
    assert.equal((await pipeline.processItem(item({ title: 'gym daddy leg day' }), feed, null, settings)).outcome, 'added', '"daddy" alone is not about age');
  });

  test('a creator whose profile says he is older is hidden, and shown again when the filter is switched off', () => {
    const c = repo.creators.create({ handle: 'foxsam', origin: 'admin' });
    const f = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'foxsam', creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin' }).feed;
    const r = require('../src/engine/creators').applyProfile(repo.feeds.get(f.id), { displayName: 'Sam', bio: '54yo, lifting since 90s' }, settings);
    assert.equal(r.hidden, true); assert.equal(repo.creators.get(c.id).status, 'hidden');
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.creators.get(c.id).status, 'active', 'reversible: it only undoes its own decision');
    assert.equal(repo.feeds.get(f.id).enabled, 1);
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

  test('the body sweep also measures hidden pictures (without showing them), so one restored later has a score', async () => {
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'hid1', source_key: 'reddit:hid1:0', post_key: 'reddit:hid1', source_url: 'https://reddit.com/x', media_type: 'image', media_url: 'https://i.redd.it/hid1.jpg', preview_url: 'https://i.redd.it/hid1.jpg', hash: 'h-hid1', publish_state: 'hidden', review_reason: 'reported:spam' });
    fake({ 'https://i.redd.it/hid1.jpg': 88 });
    await maintenance.physiqueSweep({ limit: 500, settings });
    assert.equal(repo.media.get(id).physique, 88);
    assert.equal(repo.media.get(id).publish_state, 'hidden'); assert.equal(repo.media.get(id).review_reason, 'reported:spam');
  });

  test('the body sweep judges each picture with the settings current when its measurement returns', async () => {
    const store = require('../src/settings');
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'thr1', source_key: 'reddit:thr1:0', post_key: 'reddit:thr1', source_url: 'https://reddit.com/x', media_type: 'image', media_url: 'https://i.redd.it/thr1.jpg', preview_url: 'https://i.redd.it/thr1.jpg', hash: 'h-thr1', publish_state: 'published' });
    const was = store.get().physiqueThreshold;
    imagefilter._setAnalyzer(async () => { store.update({ physiqueThreshold: 90 }); return { status: 'ok', faces: male, body: { decided: true, score: 80 } }; });
    try { await maintenance.physiqueSweep({ limit: 500, settings }); } finally { store.update({ physiqueThreshold: was }); }
    assert.equal(repo.media.get(id).physique, 80);
    assert.equal(repo.media.get(id).publish_state, 'published', 'threshold raised to 90 while measuring');
  });

  test('pictures the body filter hid stay in the duplicate index, so a threshold change never shows two copies', async () => {
    fake({ 'https://i.redd.it/dupheavy.jpg': 90 });
    const r = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/dupheavy.jpg' }), feed, null, settings);
    assert.equal(r.outcome, 'hidden');
    repo.db.prepare('UPDATE media SET phash = ? WHERE id = ?').run('ffff0000ffff0000', r.mediaId);
    assert.ok(repo.media.hashedRows().some((x) => x.id === r.mediaId));
  });

  test('a creator feed the admin changed after the body filter paused it keeps the admin decision', async () => {
    const c = repo.creators.create({ handle: 'bigtom', origin: 'admin' });
    const own = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'bigtom', creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin' }).feed;
    const scores = {}; ['t1', 't2', 't3', 't4'].forEach((k) => { scores[`https://i.redd.it/${k}.jpg`] = 85; });
    fake(scores);
    for (const k of ['t1', 't2', 't3', 't4']) await pipeline.processItem(item({ author: 'bigtom', mediaUrl: `https://i.redd.it/${k}.jpg` }), own, null, settings);
    assert.equal(repo.creators.get(c.id).status, 'hidden'); assert.equal(repo.feeds.get(own.id).enabled, 0);
    repo.logAction('feed', own.id, 'enable', 'admin', 'admin'); repo.feeds.update(own.id, { enabled: true });
    repo.logAction('feed', own.id, 'disable', 'admin', 'admin'); repo.feeds.update(own.id, { enabled: false });
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.creators.get(c.id).status, 'active');
    assert.equal(repo.feeds.get(own.id).enabled, 0, 'the admin switched it off');
  });

  test('an approved word hit is not hidden again when the filter is switched off and on', async () => {
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'apw1', source_key: 'reddit:apw1:0', post_key: 'reddit:apw1', source_url: 'https://reddit.com/x', title: 'dad bod gym progress', media_type: 'image', media_url: 'https://i.redd.it/apw1.jpg', hash: 'h-apw1', publish_state: 'published' });
    await physique.textSweep(settings, { force: true });
    assert.equal(repo.media.get(id).publish_state, 'hidden');
    require('../src/services/targets').moderate(id, 'approve', 'he is fit');
    physique.reapply({ ...settings, physiqueFilter: false });
    await physique.textSweep(settings, { force: true });
    assert.equal(repo.media.get(id).publish_state, 'published');
  });

  test('a feed run applies a body filter switched off mid-run to the next item and to a slow model pass', async () => {
    const store = require('../src/settings');
    imagefilter._setAnalyzer(async () => { store.update({ physiqueFilter: false }); return { status: 'ok', faces: male, body: { decided: true, score: 95 } }; });
    try {
      const r = await pipeline.processItem(item({ mediaUrl: 'https://i.redd.it/live1.jpg' }), feed, null, { ...settings, liveBody: true });
      assert.equal(r.outcome, 'added', 'switched off while the model ran');
      const t = await pipeline.processItem(item({ title: 'chubby bear', mediaUrl: 'https://i.redd.it/live2.jpg' }), feed, null, { ...settings, liveBody: true });
      assert.notEqual(t.outcome, 'excluded', JSON.stringify(t));
    } finally { store.update({ physiqueFilter: true }); }
  });

  test('a picture the body sweep hides stays findable as a duplicate while the index is loaded', () => {
    const dedupe = require('../src/services/dedupe');
    dedupe.check({ phash: '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', mediaType: 'image' }); // loads the index
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'dx1', source_key: 'reddit:dx1:0', post_key: 'reddit:dx1', source_url: 'https://reddit.com/x', media_type: 'image', media_url: 'https://i.redd.it/dx1.jpg', hash: 'h-dx1', phash: 'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5', publish_state: 'published' });
    dedupe.remember(id, 'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5', { mediaType: 'image' });
    repo.media.setState(id, 'hidden', 'physique:90', { exact: true });
    assert.equal(dedupe.check({ phash: 'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5', mediaType: 'image' }).dup?.id, id);
    repo.media.setState(id, 'hidden', 'reported:spam', { exact: true });
    assert.equal(dedupe.check({ phash: 'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5', mediaType: 'image' }).dup, null);
  });

  test('a profile refresh that hides a creator keeps the new bio, so switching off and on hides them again', () => {
    const c = repo.creators.create({ handle: 'biochange', origin: 'admin' });
    const f = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'biochange', creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin' }).feed;
    const r = require('../src/engine/creators').applyProfile(repo.feeds.get(f.id), { displayName: 'Bio Change', bio: 'proud gainer' }, settings);
    assert.equal(r.hidden, true); assert.equal(repo.creators.get(c.id).bio, 'proud gainer');
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.creators.get(c.id).status, 'active');
    physique.reapply(settings);
    assert.equal(repo.creators.get(c.id).status, 'hidden');
  });

  test('a linked or imported feed named in chub wording starts paused, reversibly', () => {
    const r = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'superchubs_united', enabled: 1, trusted: 1, origin: 'import' });
    assert.equal(physique.screenFeed(r), true);
    assert.equal(repo.feeds.get(r.feed.id).enabled, 0);
    physique.reapply({ ...settings, physiqueFilter: false });
    assert.equal(repo.feeds.get(r.feed.id).enabled, 1);
    assert.equal(physique.screenFeed(repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybros_fit', enabled: 1, trusted: 1, origin: 'import' })), false);
  });

  test('restoring a reported item still applies its body score', () => {
    const id = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'rep1', source_key: 'reddit:rep1:0', post_key: 'reddit:rep1', source_url: 'https://reddit.com/x', media_type: 'image', media_url: 'https://i.redd.it/rep1.jpg', hash: 'h-rep1', physique: 85, publish_state: 'hidden', review_reason: 'reported:spam' });
    assert.equal(physique.publish(id, settings), 'hidden'); assert.equal(repo.media.get(id).review_reason, 'physique:85');
    const ok = repo.media.insert({ feed_id: feed.id, platform: 'reddit', source_id: 'rep2', source_key: 'reddit:rep2:0', post_key: 'reddit:rep2', source_url: 'https://reddit.com/x', media_type: 'image', media_url: 'https://i.redd.it/rep2.jpg', hash: 'h-rep2', physique: 15, publish_state: 'hidden', review_reason: 'reported:spam' });
    assert.equal(physique.publish(ok, settings), 'published');
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

describe('stricter v5 defaults', () => {
  test('an install still on the old defaults moves to the new ones once; a value an admin chose is kept', () => {
    repo.settings.set('physique_defaults_version', '');
    repo.settings.set('physiqueThreshold', '60'); repo.settings.set('physiqueCreatorShare', '70');
    assert.equal(physique.migrateDefaults(), true);
    assert.equal(repo.settings.get('physiqueThreshold'), String(physique.DEFAULT_THRESHOLD));
    assert.equal(repo.settings.get('physiqueCreatorShare'), '70', 'chosen by an admin');
    repo.settings.set('physiqueThreshold', '60');
    assert.equal(physique.migrateDefaults(), false, 'only once');
    assert.equal(repo.settings.get('physiqueThreshold'), '60');
  });
});
