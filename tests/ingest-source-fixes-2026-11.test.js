'use strict';
// Source fixes from the 2026-11-04 ingestion patrol: bare Bluesky handles, bot-challenge classification.
const test = require('node:test');
const assert = require('node:assert/strict');

test('bluesky: bare handles are qualified with .bsky.social; qualified handles and DIDs pass through', () => {
  const { actorOf } = require('../src/sources/bluesky');
  assert.equal(actorOf('cademaddox'), 'cademaddox.bsky.social');
  assert.equal(actorOf('@cademaddox'), 'cademaddox.bsky.social');
  assert.equal(actorOf('thediegovoxxx.bsky.social'), 'thediegovoxxx.bsky.social');
  assert.equal(actorOf('alice.example.com'), 'alice.example.com');
  assert.equal(actorOf('did:plc:abc123'), 'did:plc:abc123');
});

test('bot-challenge text is recognised as a block page, not feed content', () => {
  const { isChallengeText } = require('../src/sources/util');
  assert.equal(isChallengeText("<title>Making sure you're not a bot!</title>"), true);
  assert.equal(isChallengeText('<html>Just a moment...</html>'), true);
  assert.equal(isChallengeText('{"id":"1","acct":"jack"}'), false);
});
