'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ptrCode = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', 'pull-to-refresh.js'), 'utf8');

describe('pull to refresh mobile gesture', () => {
  test('pull-to-refresh file exports initPullToRefresh and conforms to token conventions', () => {
    assert.match(ptrCode, /export function initPullToRefresh/);
    assert.match(ptrCode, /ptr-indicator/);
    assert.match(ptrCode, /ptr-loading/);
    // Uses CSS variable tokens for smooth springs and durations
    assert.match(ptrCode, /var\(--dur-/);
    assert.match(ptrCode, /var\(--spring-/);
  });

  test('home, explore and following wire pull-to-refresh and cleanly tear it down', () => {
    const home = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'home.js'), 'utf8');
    const explore = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'explore.js'), 'utf8');
    const following = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'following.js'), 'utf8');

    for (const [name, code] of [['home', home], ['explore', explore], ['following', following]]) {
      assert.match(code, /initPullToRefresh/, `${name} imports initPullToRefresh`);
      assert.match(code, /stopPtr\(\)/, `${name} calls cleanup on teardown`);
    }
  });

  test('aurora.css has styles for ptr-indicator, spin animation and touch momentum on rails', () => {
    const aurora = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(aurora, /\.ptr-indicator/);
    assert.match(aurora, /@keyframes ptr-spin/);
    assert.match(aurora, /-webkit-overflow-scrolling:\s*touch/);
  });
});
