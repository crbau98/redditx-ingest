'use strict';
/** GFF: a failed video page read is retried next run, and a video with no performer name never mints a creator. */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const http = require('../src/sources/http');
const web = require('../src/sources/web');
const originalHttp = http.forPlatform;
const originalRobots = web.robotsAllows;
let videoAnswer = null;
let performerH1 = 'Test Person';
const ld = (o) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', contentUrl: 'https://example.test/stream', ...o })}</script>`;
http.forPlatform = () => ({ text: async (url) => {
  if (url.includes('/performer/')) return `<h1>${performerH1}</h1><link rel="canonical" href="https://justthegays.tv/performer/test-person-123"><a href="/video/video-alpha">a</a>`;
  return videoAnswer(url);
} });
web.robotsAllows = async () => true;
const gff = require('../src/sources/gff');
http.forPlatform = originalHttp;
web.robotsAllows = originalRobots;

let repo; let pipeline;
before(() => { repo = require('../src/db/repo'); pipeline = require('../src/engine/pipeline'); });

const feed = { platform: 'gff', kind: 'user', target: 'https://justthegays.tv/performer/test-person-123' };
const run = (cursor) => gff.fetch(feed, { cursor, limit: 50, aborted: () => false });

test('a 500 on a video page leaves the slug out of cursor.seen and the next run retries it', async () => {
  performerH1 = 'Test Person';
  videoAnswer = () => Promise.reject(Object.assign(new Error('HTTP 500'), { status: 500 }));
  const first = await run({});
  assert.equal(first.items.length, 0);
  assert.ok(!first.cursor.seen.includes('video-alpha'));
  videoAnswer = () => ld({ actor: { name: 'Test Person' } });
  const second = await run(first.cursor);
  assert.deepEqual(second.items.map((it) => it.sourceId), ['gff-video-alpha']);
  assert.ok(second.cursor.seen.includes('video-alpha'));
});

test('a video page with no actor and only the site name on the page does not create a creator', async () => {
  performerH1 = 'JustTheGays.com | Just The Gays';
  videoAnswer = () => ld({});
  const real = repo.creators.create;
  let created = 0;
  repo.creators.create = (...a) => { created++; return real.apply(repo.creators, a); };
  try {
    const r = await run({});
    assert.equal(r.items.length, 0, 'the item is skipped, not authored by its slug');
    assert.ok(r.notes.some((n) => /no performer name/.test(n)));
    assert.ok(!r.cursor.seen.includes('video-alpha'));
    for (const it of r.items) pipeline.resolveCreator(it, feed);
    assert.equal(created, 0);
  } finally { repo.creators.create = real; }
});

test('a video page with no actor still uses a real performer page name', async () => {
  performerH1 = 'Test Person';
  videoAnswer = () => ld({});
  const r = await run({});
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].author, 'Test Person');
});
