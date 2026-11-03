'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-overhaul-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, "prism-test.db");
process.env.ADMIN_KEY = 'test-admin-key-overhaul';
process.env.PRISM_TEST_NO_DISCOVERY = '1';

const ROOT = path.resolve(__dirname, '..');
const repo = require('../src/db/repo');
const settingsStore = require('../src/settings');
const faceMatch = require('../src/lib/face-match');
const imagefilter = require('../src/lib/imagefilter');
const imagematch = require('../src/engine/imagematch');
const brave = require('../src/lib/brave');
const web = require('../src/sources/web');

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Phase 1: UI audit & subtraction guards', () => {
  test('primary NAV has 5 core destinations: Home, Explore, Reels, Creators, Saved', () => {
    const mainJs = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
    const m = mainJs.match(/const NAV = \[([\s\S]*?)\];/);
    assert.ok(m, 'NAV array defined');
    const keys = [...m[1].matchAll(/\['(\w+)'/g)].map((x) => x[1]);
    assert.deepEqual(keys, ['home', 'explore', 'reels', 'creators', 'saved']);
  });

  test('decorative WebGL shader, 3D orbit, and pointer card tilt are off by default behind prefs.ambientFx', () => {
    const storeJs = fs.readFileSync(path.join(ROOT, 'public/js/store.js'), 'utf8');
    assert.match(storeJs, /get ambientFx\(\)\s*\{\s*return read\('prism\.ambientFx',\s*false\);/);
    const homeJs = fs.readFileSync(path.join(ROOT, 'public/js/views/home.js'), 'utf8');
    assert.ok(!/^import .*prism-bg\.js/m.test(homeJs), 'home.js does not eagerly import prism-bg.js');
    assert.ok(!/^import .*orbit\.js/m.test(homeJs), 'home.js does not eagerly import orbit.js');
    assert.match(homeJs, /prefs\.ambientFx/);
    const fxJs = fs.readFileSync(path.join(ROOT, 'public/js/components/fx.js'), 'utf8');
    assert.match(fxJs, /prefs\.ambientFx/);
  });

  test('Creators view consolidates inline web lookup and Following filter and removes 3D galaxy header promo', () => {
    const creatorsJs = fs.readFileSync(path.join(ROOT, 'public/js/views/creators.js'), 'utf8');
    assert.ok(!creatorsJs.includes('Explore as a 3D galaxy'), '3D galaxy promo removed from Creators subtitle');
    assert.ok(creatorsJs.includes('runInlineLookup'), 'inline web lookup wired into Creators');
    assert.ok(creatorsJs.includes('followingChip'), 'Following filter chip wired into Creators');
  });
});

describe('Phase 2: Expanded public web reach & video keyframes', () => {
  test('deriveVideoPosterUrl extracts keyframes/posters for RedGIFs, YouTube, and Bluesky videos', () => {
    assert.equal(
      imagefilter.deriveVideoPosterUrl('https://thumbs4.redgifs.com/FitMaleAthlete-mobile.mp4'),
      'https://thumbs4.redgifs.com/FitMaleAthlete-poster.jpg'
    );
    assert.equal(
      imagefilter.deriveVideoPosterUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
    );
    assert.equal(
      imagefilter.deriveVideoPosterUrl('https://video.bsky.app/watch/did%3Aplc%3A123/cid456/playlist.m3u8'),
      'https://video.bsky.app/watch/did%3Aplc%3A123/cid456/thumbnail.jpg'
    );
    // imageUrlOf uses deriveVideoPosterUrl when previewUrl/thumbnailUrl are absent
    assert.equal(
      imagefilter.imageUrlOf({ mediaType: 'video', mediaUrl: 'https://thumbs4.redgifs.com/ClipOne.mp4' }),
      'https://thumbs4.redgifs.com/ClipOne-poster.jpg'
    );
  });

  test('buildQueries combines name, handle, paid slug, and top creator style tags', () => {
    const c = repo.creators.create({ handle: 'alex_fit99', displayName: 'Alex Rivera', origin: 'admin' });
    const mid = repo.media.insert({
      creator_id: c.id, platform: 'bluesky', source_id: 'b1', source_key: 'bluesky:b1:0', post_key: 'bluesky:b1',
      media_type: 'image', media_url: 'https://i.example.test/b1.jpg', hash: 'h_b1', phash: 'ffffffffffffffffffffffffffffffff',
    }, ['muscle', 'swimmer']);
    assert.ok(mid);
    const qs = imagematch.buildQueries(repo.creators.get(c.id), { service: 'fansly', paidHandle: 'alexvip' });
    assert.ok(qs.includes('"Alex Rivera" onlyfans'));
    assert.ok(qs.includes('"alexvip" fansly'));
    assert.ok(qs.includes('"alex_fit99" onlyfans'));
    assert.ok(qs.includes('"Alex Rivera" "alex_fit99"'));
    assert.ok(qs.some((q) => q.includes('muscle') || q.includes('swimmer')), 'includes style tag query');
  });

  test('seedCrawlCreator discovers ingestable public accounts from creator links and records seed_crawl evidence', async () => {
    const c = repo.creators.create({ handle: 'seed_guy', displayName: 'Seed Guy', origin: 'admin' });
    repo.creators.update(c.id, { links: [{ url: 'https://bsky.app/profile/seedguy.bsky.social', label: 'Bluesky' }] });
    const updated = repo.creators.get(c.id);
    const res = await imagematch.seedCrawlCreator(updated, { maxPages: 2 });
    assert.equal(res.discovered, 1);
    const matches = faceMatch.listWebMatches({ creatorId: c.id, status: 'confirmed' });
    assert.ok(matches.some((m) => m.match_kind === 'seed_crawl' && m.page_url.includes('seedguy.bsky.social')));
  });
});

describe('Phase 3 & 4: Opt-in local face matching, safety gates, review queue & takedown purge', () => {
  const makeVec = (seed, dim = 128) => {
    const arr = new Float32Array(dim);
    for (let i = 0; i < dim; i++) arr[i] = Math.sin(seed * (i + 1) * 0.37);
    return faceMatch.normalizeVec(arr);
  };

  beforeEach(() => {
    settingsStore.update({ faceMatch: false, faceMatchThreshold: 78 });
  });

  test('packFaceVec and unpackFaceVec preserve cosine similarity accurately', () => {
    const v1 = makeVec(1);
    const v2 = makeVec(2);
    const packed1 = faceMatch.packFaceVec(v1);
    const unpacked1 = faceMatch.unpackFaceVec(packed1);
    assert.ok(faceMatch.cosine(v1, unpacked1) > 0.998, 'quantized self-similarity > 0.998');
    assert.ok(faceMatch.cosine(v1, v2) < 0.35, 'distinct vectors have low similarity');
  });

  test('opt-in gating: saveMediaFaces is a no-op when faceMatch is false, and stores male faces when true', () => {
    const c = repo.creators.create({ handle: 'face_optin', displayName: 'Face Optin', origin: 'admin' });
    const mid = repo.media.insert({
      creator_id: c.id, platform: 'bluesky', source_id: 'f1', source_key: 'bluesky:f1:0', post_key: 'bluesky:f1',
      media_type: 'image', media_url: 'https://i.example.test/f1.jpg', hash: 'h_f1',
    });
    const v = Array.from(makeVec(10));
    assert.equal(faceMatch.saveMediaFaces(mid, [{ gender: 'male', score: 0.95, confidence: 0.9, embedding: v }]), 0, 'off by default');

    settingsStore.update({ faceMatch: true });
    // Female face is never stored even when faceMatch is enabled
    assert.equal(faceMatch.saveMediaFaces(mid, [{ gender: 'female', score: 0.92, confidence: 0.9, embedding: v }]), 0, 'female faces excluded');
    // Male face is stored
    assert.equal(faceMatch.saveMediaFaces(mid, [{ gender: 'male', score: 0.95, confidence: 0.9, box: [10, 20, 100, 100], embedding: v }]), 1);
    const refs = faceMatch.creatorReferenceFaces(c.id);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].mediaId, mid);
  });

  test('matchCreator with faceMatch enabled: confirms when face + name match, queues for review when face matches without name, and rejects different faces', async () => {
    settingsStore.update({ faceMatch: true, faceMatchThreshold: 78 });
    const c = repo.creators.create({ handle: 'marco_fit', displayName: 'Marco Fit', origin: 'admin' });
    const refVec = Array.from(makeVec(42));
    const strangerVec = Array.from(makeVec(99));

    for (let i = 0; i < 2; i++) {
      const mid = repo.media.insert({
        creator_id: c.id, platform: 'bluesky', source_id: `mf-${i}`, source_key: `bluesky:mf-${i}:0`, post_key: `bluesky:mf-${i}`,
        media_type: 'image', media_url: `https://i.example.test/mf-${i}.jpg`, hash: `h_mf_${i}`, phash: 'ffffffffffffffffffffffffffffffff',
      });
      faceMatch.saveMediaFaces(mid, [{ gender: 'male', score: 0.95, confidence: 0.92, embedding: refVec }]);
    }

    const origImages = brave.images;
    const origAnalyze = imagefilter.analyze;
    const origRobots = web.robotsAllows;
    web.robotsAllows = async () => true;

    try {
      brave.images = async () => [
        { pageUrl: 'https://gallery.example.test/marco-fit-shoot', imageUrl: 'https://gallery.example.test/1.jpg', title: 'Marco Fit new shoot', description: '' },
        { pageUrl: 'https://anon.example.test/mystery-post', imageUrl: 'https://anon.example.test/2.jpg', title: 'Summer pool day', description: '' },
        { pageUrl: 'https://other.example.test/marco-fit-unrelated', imageUrl: 'https://other.example.test/3.jpg', title: 'Marco Fit tag', description: '' },
      ];
      imagefilter.analyze = async (imgUrl) => {
        if (imgUrl.endsWith('/1.jpg')) return { status: 'ok', phash: '00000000000000000000000000000000', faces: [{ gender: 'male', score: 0.95, confidence: 0.9, embedding: refVec }] };
        if (imgUrl.endsWith('/2.jpg')) return { status: 'ok', phash: '00000000000000000000000000000000', faces: [{ gender: 'male', score: 0.95, confidence: 0.9, embedding: refVec }] };
        return { status: 'ok', phash: '00000000000000000000000000000000', faces: [{ gender: 'male', score: 0.95, confidence: 0.9, embedding: strangerVec }] };
      };

      const out = await imagematch.matchCreator(repo.creators.get(c.id), { budget: 40 });
      assert.equal(out.pages, 1, 'only the page with BOTH high face similarity AND name evidence is registered');
      assert.ok(repo.feeds.find('web', 'page', 'https://gallery.example.test/marco-fit-shoot'), 'confirmed page feed created');
      assert.ok(!repo.feeds.find('web', 'page', 'https://anon.example.test/mystery-post'), 'uncorroborated face match is NOT auto-followed');

      const confirmed = faceMatch.listWebMatches({ creatorId: c.id, status: 'confirmed' });
      const reviews = faceMatch.listWebMatches({ creatorId: c.id, status: 'review' });
      assert.equal(confirmed.length, 1);
      assert.equal(confirmed[0].match_kind, 'face+text');
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].match_kind, 'face_review');

      // Admin can triage the review item
      const decided = faceMatch.decideWebMatch(reviews[0].id, 'reject', 'admin');
      assert.equal(decided.status, 'rejected');

      // Takedown purges all face embeddings and web matches for the creator
      repo.takedowns.add({ kind: 'creator', value: c.id, reason: 'owner request' });
      assert.equal(faceMatch.creatorReferenceFaces(c.id).length, 0, 'all face vectors purged on takedown');
      assert.equal(faceMatch.listWebMatches({ creatorId: c.id, status: 'all' }).length, 0, 'all web matches purged on takedown');
    } finally {
      brave.images = origImages;
      imagefilter.analyze = origAnalyze;
      web.robotsAllows = origRobots;
      settingsStore.update({ faceMatch: false });
    }
  });
});
