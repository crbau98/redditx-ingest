'use strict';
/** src/sources/_policy.js: the host policy, loadable as CommonJS like the rest of the codebase. Nothing is denied any more: every public host is an ingest candidate. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/sources/_policy');

test('exposes its functions through require()', () => {
  assert.equal(typeof policy.isDenied, 'function');
  assert.equal(typeof policy.isExtractorAllowed, 'function');
});

test('denies nothing: paid pages, leak mirrors and every other public host are allowed', () => {
  assert.equal(policy.isDenied('onlyfans.com'), false);
  assert.equal(policy.isDenied('fansly.com'), false);
  assert.equal(policy.isDenied('coomer.party'), false);
  assert.equal(policy.isDenied('gayforfans.com'), false);
  assert.equal(policy.isDenied('notonlyfans.com'), false);
  assert.equal(policy.isDenied('onlyfans.com.example.org'), false);
  assert.equal(policy.isDenied(''), false);
  assert.equal(policy.isDenied(undefined), false);
  assert.equal(policy.isExtractorAllowed('example.org'), true);
  assert.equal(policy.isExtractorAllowed('onlyfans.com'), true);
});
