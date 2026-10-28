'use strict';
/** src/sources/_policy.js: the registrable-suffix host policy, loadable as CommonJS like the rest of the codebase. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/sources/_policy');

test('exposes its functions through require()', () => {
  for (const k of ['isDenied', 'isPaywall', 'isLeakAggregator', 'isExtractorAllowed']) assert.equal(typeof policy[k], 'function', k);
});

test('matches the registrable suffix, so subdomains and case do not slip through', () => {
  assert.equal(policy.isPaywall('onlyfans.com'), true);
  assert.equal(policy.isPaywall('cdn.OnlyFans.com.'), true);
  assert.equal(policy.isLeakAggregator('www.coomer.su'), true);
  assert.equal(policy.isDenied('fansly.com'), true);
  assert.equal(policy.isDenied('coomer.party'), true);
});

test('does not match look-alikes or unrelated hosts', () => {
  assert.equal(policy.isDenied('notonlyfans.com'), false);
  assert.equal(policy.isDenied('onlyfans.com.example.org'), false);
  assert.equal(policy.isExtractorAllowed('example.org'), true);
  assert.equal(policy.isExtractorAllowed('onlyfans.com'), false);
  assert.equal(policy.isDenied(''), false);
  assert.equal(policy.isDenied(undefined), false);
});
