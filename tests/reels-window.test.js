'use strict';
/**
 * Reels buffer window. Only the playing slide holds a decoder; the next one pre-buffers; the one
 * before keeps a small buffer; the two beyond the neighbours keep just a poster. This keeps an endless
 * swipe session at a fixed number of live video streams, so memory does not grow with the feed.
 * The policy is a pure module (exercised directly); the wiring is guarded by reading the shipped source.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const pub = path.join(__dirname, '..', 'public', 'js');
const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');

async function loadWindow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-window-'));
  const file = path.join(dir, 'reel-window.mjs');
  fs.copyFileSync(path.join(pub, 'components', 'reel-window.js'), file);
  return import(pathToFileURL(file).href);
}

test('the first slide warms only the next one and has no slide before it', async () => {
  const { planWindow } = await loadWindow();
  assert.deepEqual(planWindow(0, 5), { active: 0, warm: [1], near: [2] });
});

test('a middle slide warms both neighbours and keeps posters two away', async () => {
  const { planWindow } = await loadWindow();
  assert.deepEqual(planWindow(2, 5), { active: 2, warm: [3, 1], near: [4, 0] });
});

test('the last slide warms only the one before it', async () => {
  const { planWindow } = await loadWindow();
  assert.deepEqual(planWindow(4, 5), { active: 4, warm: [3], near: [2] });
});

test('an empty feed plans nothing', async () => {
  const { planWindow } = await loadWindow();
  assert.deepEqual(planWindow(0, 0), { active: 0, warm: [], near: [] });
});

test('for every position the window is bounded and its groups do not overlap', async () => {
  const { planWindow } = await loadWindow();
  for (let n = 1; n <= 40; n++) {
    for (let i = 0; i < n; i++) {
      const p = planWindow(i, n);
      assert.ok(p.warm.length <= 2, `at most two warmed slides (i=${i}, n=${n})`);
      assert.ok(!p.warm.includes(i), 'the active slide is not listed as warm');
      const all = [p.active, ...p.warm, ...p.near];
      assert.equal(new Set(all).size, all.length, `no index in two groups (i=${i}, n=${n})`);
      for (const k of all) assert.ok(k >= 0 && k < n, `index ${k} is inside the feed (n=${n})`);
      // live video streams: the active slide plus its warmed neighbours
      assert.ok(1 + p.warm.length <= 3, 'at most three live streams at once');
    }
  }
});

test('the reels view drives its buffer from planWindow, and neighbours shrink their buffer', () => {
  const reels = read('views', 'reels.js');
  assert.match(reels, /import \{ planWindow \} from '\.\.\/components\/reel-window\.js'/);
  assert.match(reels, /const plan = planWindow\(i, slides\.length\)/);
  assert.match(reels, /plan\.warm\.includes\(k\)/);
  assert.match(reels, /s\.handle\.demote\(\)/, 'a slide that stops being active gives back its large buffer');

  const video = read('components', 'video.js');
  assert.match(video, /demote\(\) \{[^}]*maxBufferLength = 6/, 'demote() restores the small buffer target');
});

test('the reels view has the keyboard moves a reader expects: horizontal arrows and Home/End', () => {
  const reels = read('views', 'reels.js');
  assert.match(reels, /case 'ArrowRight'/);
  assert.match(reels, /case 'ArrowLeft'/);
  assert.match(reels, /case 'Home'/);
  assert.match(reels, /case 'End'/);
});

test('reel scrolling honours reduced motion', () => {
  const reels = read('views', 'reels.js');
  assert.match(reels, /prefers-reduced-motion: reduce/);
});
