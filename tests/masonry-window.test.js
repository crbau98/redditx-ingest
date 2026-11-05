'use strict';
/**
 * The masonry swaps far-away cards for height-only shells and back (components/masonry.js). Measuring a card
 * (offsetHeight) right after replacing its neighbour forces a layout, once per card in a fast fling; the observer
 * callback therefore reads every height first and replaces afterwards. It needs a DOM, so the rule is pinned in the source.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', 'masonry.js'), 'utf8');
const callback = src.slice(src.indexOf('const windowIo ='), src.indexOf('function watch(node)'));

test('the window observer measures every card that is leaving in one pass, then parks them', () => {
  const measure = callback.indexOf('leaving.map(');
  const replace = callback.indexOf('leaving.forEach(');
  assert.ok(measure > 0 && replace > measure, 'heights are read before any card is replaced');
  assert.match(callback, /if \(e\.isIntersecting\) restore\(e\.target\);\s*else leaving\.push\(e\.target\);/);
  assert.doesNotMatch(callback, /park\(e\.target\)/, 'no per-entry park(): that interleaves a read and a write for every card');
});

test('park() takes the measured height and only measures itself when called alone', () => {
  assert.match(src, /function park\(card, measured\)/);
  assert.match(src, /const px = measured \|\| parkHeight\(card\);/);
  assert.match(src, /const parkHeight = \(card\) => Math\.round\(card\.offsetHeight \|\| card\._est \|\| 240\);/);
});
