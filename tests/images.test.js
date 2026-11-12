'use strict';
/**
 * Which picture a grid card downloads: the 360px thumbnail, or the platform preview only where the thumbnail would be
 * stretched (public/js/images.js).
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const JS = path.join(__dirname, '..', 'public', 'js');
const esm = (file) => import(pathToFileURL(path.join(JS, file)).href);

describe('thumbnail or preview for a grid card (images.js)', () => {
  let img;
  before(async () => { img = await esm('images.js'); });
  const proxy = (u) => `/p?${u}`;
  const item = { thumb_url: 'https://cdn/t.webp', preview_url: 'https://cdn/p.jpg', thumbnail_url: null, media_url: 'https://cdn/m.jpg', media_type: 'image' };
  const THUMB = '/p?https://cdn/t.webp';
  const PREVIEW = '/p?https://cdn/p.jpg';
  const src = (opts, it = item) => img.cardImage(it, { proxy, ...opts }).src;
  const full = (opts, it = item) => img.cardImage(it, { proxy, ...opts });

  test('the thumbnail covers a 2-column phone grid and a phone rail, on 2x and 3x screens alike', () => {
    assert.equal(src({ width: 175, dpr: 2 }), THUMB, '2-column grid at 2x: 350 device px');
    assert.equal(src({ width: 175, dpr: 3 }), THUMB, 'density is capped at 2x: a 3x phone shows a 2x grid picture');
    assert.equal(src({ width: 112, dpr: 3 }), THUMB, '3-column dense grid');
    assert.equal(src({ viewport: 390, dpr: 2 }), THUMB, 'rail card: 168px wide on a 390px phone');
    assert.equal(src({ viewport: 390, dpr: 3 }), THUMB);
    assert.equal(src({ width: 230, dpr: 1 }), THUMB, 'desktop at 1x');
    assert.equal(src({ viewport: 1280, dpr: 1 }), THUMB, 'desktop rail card (240px) at 1x');
  });

  test('the preview is used where the thumbnail would be stretched', () => {
    assert.equal(src({ width: 330, dpr: 2 }), PREVIEW, 'one-column phone layout');
    assert.equal(src({ viewport: 1280, dpr: 2 }), PREVIEW, 'desktop rail card (240px) on a 2x screen');
    assert.equal(src({ width: 480, dpr: 1 }), PREVIEW, 'a wide desktop column');
    // the boundary: 360px thumb stretched by at most 15%
    assert.equal(src({ width: 207, dpr: 2 }), THUMB);
    assert.equal(src({ width: 208, dpr: 2 }), PREVIEW);
  });

  test('rail cards follow the CSS clamp(168px, 22vw, 240px)', () => {
    assert.equal(img.railWidth(390), 168);
    assert.equal(img.railWidth(800), 176);
    assert.equal(img.railWidth(1280), 240);
    const css = fs.readFileSync(path.join(JS, '..', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.rail \.card \{ width: clamp\(168px, 22vw, 240px\); \}/, 'update railWidth() when this rule changes');
  });

  test('without a thumbnail the platform preview, thumbnail or the image itself is the picture', () => {
    const noThumb = { ...item, thumb_url: null };
    assert.equal(src({ width: 175, dpr: 2 }, noThumb), PREVIEW);
    assert.equal(src({ width: 175, dpr: 2 }, { ...noThumb, preview_url: null, thumbnail_url: 'https://cdn/tn.jpg' }), '/p?https://cdn/tn.jpg');
    assert.equal(src({ width: 175, dpr: 2 }, { ...noThumb, preview_url: null }), '/p?https://cdn/m.jpg');
    assert.equal(src({ width: 175, dpr: 2, isVideo: true }, { ...noThumb, preview_url: null, media_type: 'video', media_url: 'https://cdn/v.mp4' }), null, 'a video file is not a still');
  });

  test('a thumbnail with nothing larger to offer is used at any size', () => {
    const only = { thumb_url: 'https://cdn/t.webp', media_type: 'video' };
    assert.equal(src({ width: 600, dpr: 2, isVideo: true }, only), THUMB);
    assert.equal(src({ width: 600, dpr: 2 }, { ...item, preview_url: null, thumbnail_url: null, media_url: null }), THUMB);
  });

  test('a dead thumbnail falls back to the preview instead of a blank tile', () => {
    assert.equal(full({ width: 175, dpr: 2 }).fallback, PREVIEW, 'small slot: the thumbnail is first, the preview is the retry');
    assert.equal(full({ width: 330, dpr: 2 }).fallback, null, 'large slot: the preview is already first, no retry needed');
    assert.equal(full({ width: 175, dpr: 2 }, { ...item, preview_url: null, thumbnail_url: null, media_url: null }).fallback, null, 'nothing larger exists: no retry');
    const card = fs.readFileSync(path.join(JS, 'components', 'card.js'), 'utf8');
    assert.match(card, /cardImage\(item/, 'the card picks a size-aware first still');
    assert.match(card, /stillChain\(item\)/, 'then walks every remaining still when that URL dies');
    assert.match(card, /retries\.shift\(\)/, 'each error takes the next still; the last failure leaves the placeholder + report');
  });
  test('every grid card is built through it, with the layout width passed down from the masonry', () => {
    const card = fs.readFileSync(path.join(JS, 'components', 'card.js'), 'utf8');
    const masonry = fs.readFileSync(path.join(JS, 'components', 'masonry.js'), 'utf8');
    const feed = fs.readFileSync(path.join(JS, 'components', 'feed.js'), 'utf8');
    assert.match(card, /cardImage\(item, \{ proxy: proxied, width, viewport: window\.innerWidth, dpr: window\.devicePixelRatio/);
    assert.equal((masonry.match(/width: colWidth/g) || []).length, 2, 'both the first render and the restore of a parked card');
    assert.match(feed, /width: \(opts && opts\.width\) \|\| 0/);
  });

  test('viewer tiles (filmstrip, dock, related, backdrop) use the thumbnail, so a post that came from a grid costs no new request', () => {
    assert.equal(img.tileImage(item), 'https://cdn/t.webp');
    assert.equal(img.tileImage({ ...item, thumb_url: null }), 'https://cdn/p.jpg');
    assert.equal(img.tileImage({ ...item, thumb_url: null, preview_url: null, thumbnail_url: 'https://cdn/tn.jpg' }), 'https://cdn/tn.jpg');
    assert.equal(img.tileImage({ media_type: 'image', media_url: 'https://cdn/m.jpg' }), 'https://cdn/m.jpg');
    assert.equal(img.tileImage({ media_type: 'video', media_url: 'https://cdn/v.mp4' }), null);
    assert.deepEqual(img.stillChain(item), ['https://cdn/t.webp', 'https://cdn/p.jpg', 'https://cdn/m.jpg']);
    assert.deepEqual(img.stillChain({ thumb_url: 'https://cdn/t.webp', preview_url: 'https://cdn/t.webp', media_type: 'image', media_url: 'https://cdn/m.jpg' }), ['https://cdn/t.webp', 'https://cdn/m.jpg']);
    assert.deepEqual(img.stillChain({ media_type: 'video', thumb_url: 'https://cdn/t.webp', media_url: 'https://cdn/v.mp4' }), ['https://cdn/t.webp']);
    const lb = fs.readFileSync(path.join(JS, 'components', 'lightbox.js'), 'utf8');
    assert.equal((lb.match(/tileImage\(/g) || []).length, 2, 'blurred backdrop and video poster stay on the single small still');
    assert.equal((lb.match(/paintCover\([^)]*stillChain\(/g) || []).length, 4, 'dock, filmstrip, related, more-from-creator');
    assert.match(lb, /const poster = tileImage\(it\)/);
    assert.match(lb, /armPoster\(v, stillChain\(it\)\)/);
    assert.doesNotMatch(lb, /backgroundImage[^\n]*preview_url/, 'no tile asks for the full preview');
    const reels = fs.readFileSync(path.join(JS, 'views', 'reels.js'), 'utf8');
    assert.match(reels, /const poster = tileImage\(it\)/);
    assert.match(reels, /armPoster\(v, stillChain\(s\.it\)\)/);
    assert.match(reels, /const first = s\.it\.thumb_url && s\.it\.thumb_url !== sharp \? s\.it\.thumb_url : sharp/);
    assert.match(reels, /mid\.onerror = startFull/);
    assert.match(reels, /current !== proxied\(sharp\)/);
    const suggest = fs.readFileSync(path.join(JS, 'components', 'suggest.js'), 'utf8');
    assert.match(suggest, /const chain = stillChain\(it\)/);
    assert.match(suggest, /items\.slice\(0, 6\)/);
    assert.match(suggest, /dataset\.step/);
    assert.doesNotMatch(suggest, /tileImage\(/);
    const saved = fs.readFileSync(path.join(JS, 'views', 'saved.js'), 'utf8');
    assert.match(saved, /paintCover\(x\.cover\.children\[i\], chain\)/);
    const adminUi = fs.readFileSync(path.join(JS, 'views', 'admin', 'ui.js'), 'utf8');
    assert.match(adminUi, /stillChain\(m\)\[0\]/);
    assert.match(adminUi, /paintCover\(el, stillChain\(m\)\)/);
    const moderation = fs.readFileSync(path.join(JS, 'views', 'admin', 'moderation.js'), 'utf8');
    assert.equal((moderation.match(/paintCover\(img, stillChain\(m\)\)/g) || []).length, 2);
    const dom = fs.readFileSync(path.join(JS, 'dom.js'), 'utf8');
    assert.match(dom, /probe\.onerror = \(\) => paint\(i \+ 1\)/);
    assert.match(dom, /video\.poster = proxied\(chain\[i \+ 1\]\)/);
    const reports = fs.readFileSync(path.join(JS, 'views', 'admin', 'reports.js'), 'utf8');
    assert.match(reports, /paintCover\(cover, stillChain\(x\)/);
    const repo = fs.readFileSync(path.join(JS, '..', '..', 'src', 'db', 'repos', 'reports.js'), 'utf8');
    assert.match(repo, /m\.thumb_url, m\.preview_url, m\.thumbnail_url, m\.media_url, m\.media_type/);
  });

  test('the viewer stage shows the cached thumbnail first, then the preview, then the full file', () => {
    const lb = fs.readFileSync(path.join(JS, 'components', 'lightbox.js'), 'utf8');
    assert.match(lb, /const first = ready \? it\.media_url : it\.thumb_url && it\.thumb_url !== sharp \? it\.thumb_url : sharp;/);
    assert.match(lb, /const ready = warmed\.has\(it\.media_url\);/, 'a full file already loaded (the preloaded next item, the one just left) is shown at once');
    assert.match(lb, /pre\.onload = \(\) => warmed\.add\(n\.media_url\);/);
    assert.match(lb, /mid\.onload = \(\) => \{ if \(img\.isConnected\) img\.src = mid\.src; startFull\(\); \};/, 'the full file starts after the preview, not beside it');
    assert.match(lb, /mid\.onerror = startFull;/, 'a failed preview still gets the full file');
  });
});
