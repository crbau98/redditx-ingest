'use strict';
/**
 * A card that is released (its feed was destroyed, or it scrolled far out of range) abandons a picture that is still
 * downloading. components/card.js needs a DOM, so this pins the rule in the source rather than running it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const card = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', 'card.js'), 'utf8');
const releaseCard = card.slice(card.indexOf('export function releaseCard'), card.indexOf('/** One media card.'));

test('releaseCard drops src from a picture that has not finished loading, and only from that', () => {
  assert.match(releaseCard, /const img = media\._img;/);
  assert.match(releaseCard, /if \(img && !media\._loaded && !media\._parked\) img\.removeAttribute\('src'\);/);
});

test('releaseCard still stops previews and observers first', () => {
  assert.match(releaseCard, /stopPreview\(media\);/);
  assert.match(releaseCard, /io\.unobserve\(media\)/);
  assert.match(releaseCard, /reliefIo\.unobserve\(media\)/);
});

test('both places that release cards (feed teardown and the window parking) go through releaseCard', () => {
  const masonry = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'components', 'masonry.js'), 'utf8');
  assert.equal((masonry.match(/releaseCard\(/g) || []).length, 2, 'park() and releaseAll()');
});
