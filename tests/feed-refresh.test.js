'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const feedSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', 'feed.js'), 'utf8');
const refreshBody = feedSrc.slice(feedSrc.indexOf('async function refresh()'));

describe('feed refresh', () => {
  test('refresh waits for an in-flight page before clearing the grid', () => {
    // loadPage() bails out while `loading` is true; without the await, a pull during a page load
    // would empty the grid and then append the old page under a reset counter.
    assert.match(refreshBody, /if \(inflight\) \{[^}]*await inflight/);
    assert.match(refreshBody, /if \(destroyed\) return;/);
  });

  test('refresh resets the paging state and drops the route stash', () => {
    assert.match(refreshBody, /page = 0/);
    assert.match(refreshBody, /masonry\.clear\(\)/);
    assert.match(refreshBody, /dropFeedStash\(routeKey\(\)\)/);
    assert.match(refreshBody, /return loadPage\(\)/);
  });
});
