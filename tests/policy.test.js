'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/sources/_policy');

test('policy is loadable as CommonJS and denies paywall and leak domains', () => {
  assert.equal(policy.isPaywall('creator.onlyfans.com'), true);
  assert.equal(policy.isLeakAggregator('cdn.coomer.su'), true);
  assert.equal(policy.isDenied('example.com'), false);
  assert.equal(policy.isExtractorAllowed('example.com'), true);
});
