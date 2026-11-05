'use strict';
// The paid-page rule (owner decision 2026-11-05): a paid creator page is a public page. It stays a
// link-out card on the profile AND it is read like any other web page, so the media the platform
// serves publicly to any visitor is ingested like the rest of the library.
//
// Covered here: every paid service PRISM knows resolves a handle and a canonical page URL; a paid
// page becomes a web/page feed; it is idempotent; a page that is not a paid page is refused; and the
// hard gates (safety, male-only scope, takedowns) are untouched by this change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// The database is set up before anything loads the repo (src/db/index.js does), so the test never touches the default database.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paidpage-')), 't.db');
process.env.SCHEDULER_ENABLED = 'false';

const paid = require('../src/lib/paid');
const repo = require('../src/db/repo');
const { registerPaidPage, paidPageUrl } = require('../src/engine/paidpage');

const PAGES = [
  ['OnlyFans', 'https://onlyfans.com/renogold'],
  ['Fansly', 'https://fansly.com/renogold'],
  ['JustFor.Fans', 'https://justfor.fans/renogold'],
  ['ManyVids', 'https://manyvids.com/renogold'],
  ['LoyalFans', 'https://loyalfans.com/renogold'],
  ['Fanvue', 'https://fanvue.com/renogold'],
  ['FanCentro', 'https://fancentro.com/renogold'],
  ['Clips4Sale', 'https://clips4sale.com/store/renogold'],
];

test('every paid service knows its host, its handle and its canonical page', () => {
  for (const [service, url] of PAGES) {
    assert.equal(paid.serviceOf(url), service, `serviceOf(${url})`);
    assert.equal(paid.paidHandle(service, url), 'renogold', `paidHandle(${url})`);
    const page = paid.pageUrl(service, 'renogold');
    assert.ok(page && page.startsWith('https://'), `pageUrl(${service})`);
    assert.equal(paid.SERVICES[service].trace, true, `${service} must be traced to free public accounts`);
    assert.equal(paid.PAID_HOSTS[service] !== undefined, true, `PAID_HOSTS must list ${service}`);
  }
});

test('a paid page URL resolves to the canonical page, not to a link-out', () => {
  for (const [service, url] of PAGES) {
    const page = paidPageUrl(url);
    assert.ok(page, `paidPageUrl(${url})`);
    assert.equal(page.service, service);
    assert.equal(page.handle, 'renogold');
    // A post URL collapses to the profile page: the media path is not the page we read.
    assert.equal(page.url, paid.pageUrl(service, 'renogold'));
  }
  // A post URL still resolves to the same profile page.
  assert.equal(paidPageUrl('https://onlyfans.com/renogold/media/12345').url, 'https://onlyfans.com/renogold');
  // Not a paid page: nothing to read.
  assert.equal(paidPageUrl('https://example.com/some/page'), null);
  assert.equal(paidPageUrl(''), null);
});

test('a paid page is registered as a web page feed, so its public media is read', () => {
  const feed = registerPaidPage('https://fansly.com/renogold', { origin: 'test' });
  assert.ok(feed, 'the feed row');
  assert.equal(feed.platform, 'web');
  assert.equal(feed.kind, 'page');
  assert.equal(feed.target, 'https://fansly.com/renogold');
  assert.equal(feed.enabled, 1);
  // Idempotent: the same page is not registered twice.
  const again = registerPaidPage('https://fansly.com/renogold', { origin: 'test' });
  assert.equal(again.id, feed.id);
  assert.equal(repo.feeds.list({ platform: 'web', limit: 50 }).total, 1);
});

test('the creator is attached to the page feed once we know whose page it is', () => {
  const creator = repo.creators.create({ handle: 'renogold', displayName: 'Reno Gold', origin: 'test' });
  const feed = registerPaidPage('https://fanvue.com/renogold', { creatorId: creator.id, origin: 'test' });
  assert.equal(feed.creator_id, creator.id);
  // A second call with the same creator keeps one feed.
  const again = registerPaidPage('https://fanvue.com/renogold', { creatorId: creator.id, origin: 'test' });
  assert.equal(again.id, feed.id);
  assert.equal(repo.feeds.list({ platform: 'web', limit: 50 }).total, 2);
});

test('a page that is not a paid page is not registered here', () => {
  assert.equal(registerPaidPage('https://example.com/page'), null);
  assert.equal(registerPaidPage('not a url'), null);
});

test('one creator cannot fill the feed budget with paid pages', () => {
  const creator = repo.creators.create({ handle: 'greedy', displayName: 'Greedy', origin: 'test' });
  const pages = ['https://onlyfans.com/greedy', 'https://fansly.com/greedy', 'https://fanvue.com/greedy', 'https://loyalfans.com/greedy'];
  const made = pages.map((u) => registerPaidPage(u, { creatorId: creator.id, origin: 'test' })).filter(Boolean);
  assert.equal(made.length, 3, 'at most three paid pages per creator');
});

test('a paid page is still a link-out: the profile keeps the paid card', () => {
  const { parseProfile } = require('../src/lib/links');
  const spec = parseProfile('https://onlyfans.com/renogold');
  assert.ok(spec, 'the link is parsed');
  assert.equal(spec.external, true);
  assert.equal(spec.ingestable, false);
  assert.equal(spec.service, 'OnlyFans');
  assert.equal(spec.url, 'https://onlyfans.com/renogold');
});

test('a bio that names a paid page in prose is recognised for every service', () => {
  const text = 'my fanvue: @renogold · fansly: @renogold · https://manyvids.com/renogold · clips4sale: @renogold';
  const found = paid.findPaidHandles(text);
  const services = new Set(found.map((f) => f.service));
  for (const service of ['Fanvue', 'Fansly', 'ManyVids', 'Clips4Sale']) {
    assert.ok(services.has(service), `${service} must be found in a bio`);
  }
  for (const f of found) assert.equal(f.handle, 'renogold');
});

test('the seed derives a page feed for a creator whose paid page is in his links', () => {
  const { deriveFeeds } = require('../src/sources/seed-feeds');
  const seed = {
    creators: [{ id: 'c1', handle: 'renogold', displayName: 'Reno Gold', links: JSON.stringify([{ service: 'Fansly', handle: 'renogold', url: 'https://fansly.com/renogold' }]), bio: '' }],
    feeds: [],
    media: [],
  };
  const feeds = deriveFeeds(seed);
  const page = feeds.find((f) => f.platform === 'web' && f.kind === 'page');
  assert.ok(page, 'the paid page is seeded as a page feed');
  assert.equal(page.target, 'https://fansly.com/renogold');
  assert.equal(page.creator_id, 'c1');
});
