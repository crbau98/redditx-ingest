'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../src/sources/http');
const web = require('../src/sources/web');
const originalHttp = http.forPlatform;
const originalRobots = web.robotsAllows;
const calls = [];
// Each test swaps the answer for one URL prefix; everything else falls through to `defaultAnswer`.
let handler = null;
const defaultAnswer = (url) => `<h1>Test Person</h1><link rel="canonical" href="https://justthegays.tv/performer/test-person-123">${Array.from({length: 30}, (_, i) => `<a href="/video/video-test-${i}">video</a>`).join('')}`;
http.forPlatform = () => ({ text: async (url) => {
  calls.push(url);
  if (handler) {
    const answer = handler(url);
    if (answer) return answer;
  }
  if (url.includes('gayforfans.com/performer/')) throw Object.assign(new Error('not found'), { status: 404 });
  if (url.includes('/performer/')) return defaultAnswer(url);
  return '<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://example.test/stream"}</script>';
} });
web.robotsAllows = async () => true;
const gff = require('../src/sources/gff');
http.forPlatform = originalHttp;
web.robotsAllows = originalRobots;

test.afterEach(() => { handler = null; calls.length = 0; });

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

test('a gayforfans feed reads JustTheGays first and moves there, without touching gayforfans', async () => {
  handler = (url) => {
    if (url.includes('gayforfans.com/performer/')) return Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 }));
    return null;
  };
  const result = await gff.fetch({ target: 'https://gayforfans.com/performer/test-person-123' }, { cursor: {}, limit: 50 });
  assert.equal(result.resolvedTarget, 'https://justthegays.tv/performer/test-person-123');
  assert.equal(result.items.length, 30);
  assert.ok(!calls.some((url) => url.includes('gayforfans.com')), 'gayforfans is not read when JustTheGays has the performer');
});

test('when JustTheGays has nothing under the slug and gayforfans bot-checks, the name search still finds him', async () => {
  handler = (url) => {
    if (url.includes('gayforfans.com/performer/')) return Promise.reject(Object.assign(new Error('Forbidden'), { status: 403 }));
    if (/justthegays\.tv\/performer\/test-person-123/.test(url)) return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
    if (url.includes('/search?q=')) return '<a href="/performer/test-person-x9">#1 Test Person</a>';
    return null;
  };
  const result = await gff.fetch({ target: 'https://gayforfans.com/performer/test-person-123' }, { cursor: {}, limit: 50 });
  // A bot check is usually temporary, so the feed stays on gayforfans and retries it next run.
  assert.equal(result.resolvedTarget, undefined);
  assert.equal(result.items.length, 30);
  assert.ok(result.notes.some((n) => /bot-checking/.test(n)), 'the swap is recorded in the run notes');
});

test('a gayforfans page with no videos moves the feed to the sister page permanently', async () => {
  handler = (url) => {
    if (url.includes('gayforfans.com/performer/')) return '<h1>Test Person</h1><a href="/video/none">nothing</a>';
    return null;
  };
  const result = await gff.fetch({ target: 'https://gayforfans.com/performer/test-person-123' }, { cursor: {}, limit: 50 });
  assert.equal(result.resolvedTarget, 'https://justthegays.tv/performer/test-person-123');
  assert.equal(result.items.length, 30);
});

test('when the slugs differ, the sister directory is searched by name', async () => {
  handler = (url) => {
    if (url.includes('gayforfans.com/performer/')) return '<h1>Test Person</h1><a href="/video/none">nothing</a>';
    // JustTheGays uses a different slug for the same man: the exact-slug page 404s.
    if (/justthegays\.tv\/performer\/adam-gray-1234/i.test(url)) return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
    if (url.includes('/search?q=')) {
      return '<a href="/performer/adam-gray-somuchadam-43">#3 Adam Gray (somuchadam)</a>';
    }
    if (url.includes('/performer/adam-gray-somuchadam-43')) return defaultAnswer(url);
    return null;
  };
  const result = await gff.fetch({ target: 'https://gayforfans.com/performer/adam-gray-1234' }, { cursor: {}, limit: 50 });
  assert.equal(result.resolvedTarget, 'https://justthegays.tv/performer/adam-gray-somuchadam-43');
  assert.equal(result.items.length, 30);
  assert.ok(calls.some((url) => url.includes('justthegays.tv/search?q=adam-gray')));
});

test('a real (non-challenge) error on gayforfans is still thrown', async () => {
  handler = (url) => {
    if (url.includes('gayforfans.com/performer/')) return Promise.reject(Object.assign(new Error('server error'), { status: 500 }));
    if (url.includes('justthegays.tv/performer/')) return Promise.reject(Object.assign(new Error('not found'), { status: 404 }));
    return null;
  };
  await assert.rejects(
    gff.fetch({ target: 'https://gayforfans.com/performer/test-person-123' }, { cursor: {}, limit: 50 }),
    /server error/,
  );
});
