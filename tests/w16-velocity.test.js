'use strict';
/**
 * Wave 16 Velocity: creator-grid still fallbacks.
 *  - Profile banners/icons are not stills (coordinate with Forge's images.js matcher).
 *  - A banner-derived store thumb is skipped so firstFrameSrc runs with no proxy 404.
 *  - Card source: a video whose every still dies falls through to firstFrame; dead URLs are remembered.
 *  - Viewer/Reels start from fallbackStills (not raw thumb/preview fields).
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'public', 'js');
const esm = (file) => import(pathToFileURL(path.join(JS, file)).href);

describe('w16 creator-grid still fallbacks', () => {
  let img;
  before(async () => { img = await esm('images.js'); });
  const proxy = (u) => `/p?${u}`;
  const banner = 'https://img.coomer.st/banners/onlyfans/bigggwild';
  const store = 'https://media.prism.invalid/th/banner-derived.webp';
  const video = { media_type: 'video', media_url: 'https://cdn.example.test/v.mp4', preview_url: banner, thumbnail_url: banner, thumb_url: store };

  test('isProfileChromeUrl matches coomer/kemono banners and icons only', () => {
    assert.equal(img.isProfileChromeUrl(banner), true);
    assert.equal(img.isProfileChromeUrl('https://img.kemono.su/icons/onlyfans/x'), true);
    assert.equal(img.isProfileChromeUrl('https://img.coomer.st/thumbnail/data/ab/cd/x.jpg'), false);
    assert.equal(img.isProfileChromeUrl('https://i.redd.it/a.jpg'), false);
  });

  test('a video with only a banner + store thumb has an empty stillChain and a firstFrameSrc', () => {
    assert.deepEqual(img.stillChain(video), []);
    assert.equal(img.cardImage(video, { proxy, isVideo: true }).src, null);
    assert.equal(img.firstFrameSrc(video, proxy), '/p?https://cdn.example.test/v.mp4#t=0.1');
  });

  test('a lone store thumb with no platform still is kept (real thumbs.js poster)', () => {
    const it = { media_type: 'video', media_url: 'https://cdn.example.test/v.mp4', thumb_url: '/s/t.webp' };
    assert.deepEqual(img.stillChain(it), ['/s/t.webp']);
    assert.equal(img.firstFrameSrc(it, proxy), null);
  });

  test('a real platform still is kept even when a store thumb exists', () => {
    const real = 'https://img.coomer.st/thumbnail/data/ab/cd/x.jpg';
    const it = { ...video, preview_url: real, thumbnail_url: real };
    assert.deepEqual(img.stillChain(it), [store, real]);
    assert.ok(img.cardImage(it, { proxy, width: 175, dpr: 2, isVideo: true }).src);
  });

  test('fallbackStills drops banners so the viewer never opens on profile chrome', () => {
    assert.deepEqual(img.fallbackStills({ media_type: 'image', media_url: 'https://cdn/m.jpg', preview_url: banner, thumb_url: store }), [store, 'https://cdn/m.jpg']);
  });

  test('card.js remembers dead stills and falls through to firstFrame for videos', () => {
    const card = fs.readFileSync(path.join(JS, 'components', 'card.js'), 'utf8');
    assert.match(card, /const deadStills = new Set\(\)/);
    assert.match(card, /deadStills\.add\(media\._src\)/);
    assert.match(card, /!deadStills\.has\(u\)/);
    assert.match(card, /img\.classList\.add\('loading'\)/);
    assert.match(card, /if \(isVideo\) \{ armFirstFrame\(media, item, ph\); return; \}/);
    assert.match(card, /function armFirstFrame\(media, item, ph\)/);
  });

  test('lightbox and reels pick the first candidate from fallbackStills', () => {
    const lb = fs.readFileSync(path.join(JS, 'components', 'lightbox.js'), 'utf8');
    const reels = fs.readFileSync(path.join(JS, 'views', 'reels.js'), 'utf8');
    assert.match(lb, /const order = fallbackStills\(it\)/);
    assert.match(lb, /const first = ready \? it\.media_url : \(order\[0\] \|\| it\.media_url\)/);
    assert.doesNotMatch(lb, /it\.thumb_url && it\.thumb_url !== sharp/);
    assert.match(reels, /const order = fallbackStills\(s\.it\)/);
    assert.match(reels, /const first = order\[0\] \|\| s\.it\.media_url/);
    assert.doesNotMatch(reels, /s\.it\.thumb_url && s\.it\.thumb_url !== sharp/);
  });
});
