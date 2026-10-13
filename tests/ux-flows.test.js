'use strict';
/**
 * Interaction & flow guards (phone menu, viewer dock, feed restore). These read the shipped
 * files directly (no browser), like v413.test.js; the behaviour itself was checked in Chromium.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { staticGraph } = require('../src/lib/assets');

const pub = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');

test('the flow stylesheet is linked and part of the offline shell', () => {
  assert.match(read('index.html'), /href="\/css\/ux\.css"/);
  assert.match(read('sw.js'), /'\/css\/ux\.css'/);
});

test('every page the footer links to is reachable from the phone menu (the footer sits under an endless feed)', () => {
  const menu = read('js', 'components', 'menu.js');
  for (const route of ['/browse', '/galaxy', '/admin']) assert.ok(menu.includes(`'${route}'`), `phone menu links ${route}`);
  for (const fn of ['openDisplaySettings', 'openTakedownForm']) assert.ok(menu.includes(fn), `phone menu offers ${fn}`);
  const graph = staticGraph(path.join(pub, 'js'), 'main.js').map((f) => path.basename(f));
  assert.ok(graph.includes('menu.js'), 'menu is preloaded with the shell');
});

test('feeds stash what they loaded and rebuild it synchronously, and Explore no longer opts out of scroll restore', () => {
  const feed = read('js', 'components', 'feed.js');
  assert.match(feed, /export function dropFeedStash/);
  assert.match(feed, /stash\.set\(stashKey/);
  // per-visit randomness must not stop a feed from matching its own stash
  assert.match(feed, /seed: _s, exclude: _e/);
  assert.doesNotMatch(read('js', 'main.js'), /p\.path !== '\/explore' \? y : 0/);
});

test('viewer: actions live in one container (top bar on desktop, thumb dock on phones) and touch drags follow the finger', () => {
  const lb = read('js', 'components', 'lightbox.js');
  assert.match(lb, /class: 'lb-actions'/);
  assert.match(lb, /addEventListener\('pointermove'/);
  const css = read('css', 'ux.css');
  assert.match(css, /\.lb-actions \{ display: contents; \}/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.lb-stage \{ touch-action: none; \} \}/);
});
