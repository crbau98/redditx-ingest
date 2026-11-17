'use strict';
/**
 * Wave 13:
 *   1. a video with no still shows its own first frame (grid, Reels, viewer) instead of a blank tile;
 *   2. repair-no-image never sends a video to review (covered in tests/w12-library.test.js);
 *   3. library-health / residue / no-image windows are sized by measured time, so a cold volume cannot make a 1.5 s chunk.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { walkWindows } = require('../src/lib/windowed');

const spin = (ms) => { const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6)); while (process.hrtime.bigint() < end) { /* busy, like a cold read */ } };

describe('3. windows sized by measured time', () => {
  test('a cold volume (0.3 ms a row, production\'s 1,494 ms per 5,000) never makes a chunk much over the target', async () => {
    const stats = {}; let rows = 0;
    await walkWindows({ top: 3000, stats, fn: (a, b) => { rows += b - a; spin((b - a) * 0.3); } });
    assert.equal(rows, 3000, 'every row read once');
    assert.ok(stats.maxChunkMs <= 45, `longest chunk ${stats.maxChunkMs} ms (a fixed 5,000-row window would be 1,500 ms)`);
  });
  test('a warm volume grows to the cap', async () => {
    const stats = {};
    await walkWindows({ top: 200000, stats, fn: () => {} });
    assert.ok(stats.windows <= 220, `${stats.windows} windows`);
  });
  test('a slow patch in the middle shrinks the window at once', async () => {
    const stats = {};
    const cost = (a, b) => { const cold = Math.max(0, Math.min(b, 34000) - Math.max(a, 30000)); return cold * 0.3 + (b - a - cold) * 0.0002; };
    await walkWindows({ top: 60000, stats, fn: (a, b) => spin(cost(a, b)) });
    assert.ok(stats.maxChunkMs <= 340, `longest chunk ${stats.maxChunkMs} ms (bounded by the 1,000-row cap; a 20,000-row window would be 1.2 s)`);
  });
  test('the three passes use it', () => {
    for (const f of ['library-health.js', 'residue-purge.js', 'noimage-repair.js']) assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', f), 'utf8'), /walkWindows\(/, f);
  });
});

describe('1. a video with no still shows its own first frame', () => {
  const JS = path.join(__dirname, '..', 'public', 'js');
  let img;
  before(async () => { img = await import(pathToFileURL(path.join(JS, 'images.js')).href); });
  const proxy = (u) => `/api/proxy?url=${encodeURIComponent(u)}`;

  test('firstFrameSrc: only for a video with no still and a playable file', () => {
    assert.equal(img.firstFrameSrc({ media_type: 'video', media_url: 'https://t.me/x.mp4' }, proxy), `${proxy('https://t.me/x.mp4')}#t=0.1`);
    assert.equal(img.firstFrameSrc({ media_type: 'video', media_url: 'https://t.me/x.mp4', preview_url: 'https://t.me/p.jpg' }, proxy), null, 'has a poster');
    assert.equal(img.firstFrameSrc({ media_type: 'video', media_url: 'https://t.me/x.mp4', thumb_url: '/s/t.webp' }, proxy), null, 'has a thumbnail');
    assert.equal(img.firstFrameSrc({ media_type: 'video', media_url: 'https://x.org/master.m3u8' }, proxy), null, 'HLS needs a player');
    assert.equal(img.firstFrameSrc({ media_type: 'image', media_url: '' }, proxy), null);
    assert.equal(img.firstFrameSrc({ media_type: 'video', media_url: '' }, proxy), null);
  });

  test('the grid card mounts it lazily, hover previews ignore it; Reels and the viewer seek past a black frame', () => {
    const card = fs.readFileSync(path.join(JS, 'components', 'card.js'), 'utf8');
    assert.match(card, /firstFrameSrc\(item, proxied\)/);
    assert.match(card, /h\('video', \{ muted: true, playsinline: true, preload: 'metadata'/, 'the clip loads metadata only');
    assert.match(card, /class: 'card-ff'/, 'the painted frame is a canvas.card-ff (w13-velocity: the video is released once it has drawn)');
    assert.match(card, /new IntersectionObserver\([^\n]*mountFirstFrame/);
    assert.doesNotMatch(card, /getImageData\(|toDataURL\(/, 'no pixel read: a bucket (cross-origin) frame can only be drawn');
    assert.equal((card.match(/querySelector\('video'\)/g) || []).length, 0, 'every hover-preview lookup skips the first-frame video');
    for (const f of [['views', 'reels.js'], ['components', 'lightbox.js']]) assert.match(fs.readFileSync(path.join(JS, ...f), 'utf8'), /firstFrameWhenNoPoster\(v\)/, f.join('/'));
    assert.match(fs.readFileSync(path.join(JS, 'dom.js'), 'utf8'), /export function firstFrameWhenNoPoster\(video\)[\s\S]{0,300}currentTime = 0\.1/);
  });
});
