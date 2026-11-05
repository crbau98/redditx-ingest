'use strict';
// The page-feed allowlist matches whole path segments only: an entry is a segment, or starts one and is followed by - _ or .
// A substring inside someone else's slug must not spend credits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'allow-seg-')), 'test.db');
process.env.SCHEDULER_ENABLED = 'false';

const settings = require('../src/settings');
const realGet = settings.get;
const scrapfly = require('../src/lib/scrapfly');
const withList = (list) => { settings.get = () => ({ ...realGet(), scrapflyAllowlist: list }); };

test('an allowlisted handle matches as a whole segment, or a segment followed by - _ or .', () => {
  withList('thegaygaston');
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://gayforfans.com/performer/thegaygaston' }), true, 'whole segment');
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://gayforfans.com/performer/thegaygaston-vbhwf' }), true, 'segment + dash');
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://example.com/thegaygaston_page' }), true, 'segment + underscore');
  settings.get = realGet;
});

test('a handle that is only a substring of a longer segment does not match', () => {
  withList('twinks');
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://example.com/twinksandpics' }), false, 'substring inside a word');
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://example.com/hottwinks/x' }), false, 'inside another segment');
  settings.get = realGet;
});

test('the host and the query string never match', () => {
  withList('thegaygaston');
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://thegaygaston.example.com/' }), false);
  assert.equal(scrapfly.allowedFor({ kind: 'page', target: 'https://example.com/list?who=thegaygaston' }), false);
  settings.get = realGet;
});
