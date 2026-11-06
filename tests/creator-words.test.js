'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// public/js is an ES module tree; the helper has no imports, so it loads with a dynamic import.
const load = () => import('../public/js/components/creator-words.js');
const DAY = 86400000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();

test('no post, or a bad date, gives no freshness line', async () => {
  const { postedWords } = await load();
  assert.equal(postedWords(null, NOW), null);
  assert.equal(postedWords('not a date', NOW), null);
});

test('reads in words, never a raw date or an abbreviation', async () => {
  const { postedWords } = await load();
  assert.equal(postedWords(ago(0.2), NOW).text, 'Posted today');
  assert.equal(postedWords(ago(1.5), NOW).text, 'Posted yesterday');
  assert.equal(postedWords(ago(2), NOW).text, 'Posted 2 days ago');
  assert.equal(postedWords(ago(13), NOW).text, 'Posted 13 days ago');
  assert.equal(postedWords(ago(14), NOW).text, 'Posted 2 weeks ago');
  assert.equal(postedWords(ago(45), NOW).text, 'Posted 6 weeks ago');
  assert.equal(postedWords(ago(70), NOW).text, 'Posted 2 months ago');
  assert.equal(postedWords(ago(200), NOW).text, 'Posted 6 months ago');
  assert.equal(postedWords(ago(400), NOW).text, 'Posted 1 year ago');
});

test('live under a week, quiet past 90 days, and quiet is never hidden', async () => {
  const { postedWords } = await load();
  assert.equal(postedWords(ago(6), NOW).live, true);
  assert.equal(postedWords(ago(7), NOW).live, false);
  assert.equal(postedWords(ago(90), NOW).quiet, false);
  const old = postedWords(ago(120), NOW);
  assert.equal(old.quiet, true);
  assert.ok(old.text.length > 0);
});
