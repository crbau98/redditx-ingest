'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../src/sources/http');
const web = require('../src/sources/web');
const originalHttp = http.forPlatform;
const originalRobots = web.robotsAllows;
const calls = [];
http.forPlatform = () => ({ text: async (url) => {
  calls.push(url);
  if (url.includes('gayforfans.com/performer/')) throw Object.assign(new Error('not found'), { status: 404 });
  if (url.includes('/performer/')) return `<h1>Test Person</h1><link rel="canonical" href="https://justthegays.tv/performer/test-person-123">${Array.from({length: 30}, (_, i) => `<a href="/video/video-test-${i}">video</a>`).join('')}`;
  return '<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://example.test/stream"}</script>';
} });
web.robotsAllows = async () => true;
const gff = require('../src/sources/gff');
http.forPlatform = originalHttp;
web.robotsAllows = originalRobots;

test('404 fallback resolves target and first run fetches more than routine cap', async () => {
  const result = await gff.fetch({ target: 'https://gayforfans.com/performer/test-person-123' }, { cursor: {}, limit: 50 });
  assert.equal(result.resolvedTarget, 'https://justthegays.tv/performer/test-person-123');
  assert.equal(result.items.length, 30);
  assert.equal(calls.filter((url) => url.includes('/video/')).length, 30);
});
test('lookup probe remains bounded', async () => {
  const result = await gff.fetch({ target: 'https://justthegays.tv/performer/test-person-123' }, { cursor: {}, limit: 8, probe: true });
  assert.equal(result.items.length, 2);
});
