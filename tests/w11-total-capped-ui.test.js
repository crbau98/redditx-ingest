'use strict';
/** A capped total (server counted to its cap, `totalCapped`) is shown as a lower bound, "10,000+", everywhere a list total is shown. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public/js', f), 'utf8');

test('feed passes the capped flag to onTotal, and every total label adds "+" for it', () => {
  assert.match(read('components/feed.js'), /totalCapped = !!res\.totalCapped/);
  assert.match(read('components/feed.js'), /onTotal\(total, !ids && totalCapped\)/);
  const explore = read('views/explore.js');
  assert.equal((explore.match(/onTotal: \(t, capped\)/g) || []).length, 2);
  assert.match(explore, /r\.capped \? '\+' : ''/);
  assert.match(read('views/following.js'), /onTotal: \(t, capped\)/);
  assert.match(read('components/suggest.js'), /res\.totalCapped \? '\+' : ''/);
  assert.match(read('smart.js'), /capped: !!r\.totalCapped/);
});
