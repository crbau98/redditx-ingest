'use strict';
/**
 * ownedByFeed: accounts/mirrors still own; aggregator/search pages never; editorial pages need per-item proof.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const pipeline = require('../src/engine/pipeline');
const aggregators = require('../src/lib/aggregators');
const identity = require('../src/engine/identity');

let creator;
before(() => {
  creator = repo.creators.create({ handle: 'bigggwild', displayName: 'Bigggwild', origin: 'admin' });
  identity.addAlias(creator.id, 'bigggwild', { kind: 'handle', platform: 'coomer', source: 'admin' });
});

const item = (o = {}) => ({
  author: null, mediaUrl: 'https://cdn.example/a.jpg', previewUrl: null, permalink: null, repostOf: null, ...o,
});

describe('isSearchPage / discovery-only pages', () => {
  test('aggregator hosts and search URLs are discovery-only', () => {
    assert.equal(aggregators.isAggregator('https://fapello.com/bigggwild/'), true);
    assert.equal(aggregators.isSearchPage('https://www.eporner.com/search/bigggwild/'), true);
    assert.equal(aggregators.isSearchPage('https://editorial.example/search?q=bigggwild'), true);
    assert.equal(aggregators.isSearchPage('https://editorial.example/bigggwild/interview'), false);
  });
});

describe('ownedByFeed', () => {
  test('coomer/reddit-style account feeds still own', () => {
    const feed = { creator_id: creator.id, kind: 'user', platform: 'coomer', target: 'onlyfans/bigggwild' };
    assert.equal(pipeline.ownedByFeed(item(), feed), true);
    assert.equal(pipeline.ownedByFeed(item(), { creator_id: creator.id, kind: 'user', platform: 'reddit', target: 'bigggwild' }), true);
    assert.equal(pipeline.ownedByFeed(item(), { creator_id: creator.id, kind: 'feed', platform: 'rss', target: 'https://example.com/bigggwild.xml' }), true);
  });

  test('aggregator and search page feeds never own, even when attached', () => {
    const agg = { creator_id: creator.id, kind: 'page', platform: 'web', target: 'https://fapello.com/bigggwild/' };
    const search = { creator_id: creator.id, kind: 'page', platform: 'web', target: 'https://www.eporner.com/search/bigggwild/' };
    assert.equal(pipeline.pageIsDiscoveryOnly(agg), true);
    assert.equal(pipeline.ownedByFeed(item({ author: 'bigggwild' }), agg), false);
    assert.equal(pipeline.ownedByFeed(item({ author: 'bigggwild' }), search), false);
  });

  test('editorial page owns only with author/path proof', () => {
    const feed = { creator_id: creator.id, kind: 'page', platform: 'web', target: 'https://mag.example/features/summer' };
    assert.equal(pipeline.ownedByFeed(item(), feed), false, 'no proof');
    assert.equal(pipeline.ownedByFeed(item({ author: 'bigggwild' }), feed), true, 'author handle');
    assert.equal(pipeline.ownedByFeed(item({ permalink: 'https://mag.example/features/bigggwild-cover' }), feed), true, 'path names him');
  });

  test('editorial page owns with same phash as an already-owned item', () => {
    const feed = { creator_id: creator.id, kind: 'page', platform: 'web', target: 'https://mag.example/gallery/1' };
    const phash = 'a'.repeat(16);
    const id = crypto.randomUUID();
    repo.db.prepare(`INSERT INTO media (id, creator_id, platform, source_key, post_key, media_type, media_url, hash, phash, publish_state)
      VALUES (?, ?, 'coomer', ?, ?, 'image', 'https://cdn.example/owned.jpg', ?, ?, 'published')`)
      .run(id, creator.id, `sk-${id}`, `pk-${id}`, crypto.randomUUID().replace(/-/g, ''), phash);
    assert.equal(pipeline.ownedByFeed(item(), feed, { phash }), true);
    assert.equal(pipeline.ownedByFeed(item(), feed, { phash: 'b'.repeat(16) }), false);
  });
});

describe('resolveCreator', () => {
  test('aggregator page attached to a creator leaves the item unassigned', () => {
    const feed = repo.feeds.upsert({
      platform: 'web', kind: 'page', target: 'https://gaysdream.com/top-50', creatorId: creator.id, origin: 'admin', runNow: false,
    }).feed;
    const got = pipeline.resolveCreator(item({ sourceId: 'x1', mediaType: 'image' }), feed, null);
    assert.equal(got, null);
    assert.equal(feed.creator_id, creator.id, 'feed stays attached; media does not inherit');
  });

  test('editorial page without proof leaves unassigned; with author proof assigns', () => {
    const feed = repo.feeds.upsert({
      platform: 'web', kind: 'page', target: 'https://editorial.example.com/spread-2026', creatorId: creator.id, origin: 'admin', runNow: false,
    }).feed;
    assert.equal(pipeline.resolveCreator(item({ sourceId: 'e1', mediaType: 'image' }), feed, null), null);
    const proved = pipeline.resolveCreator(item({ sourceId: 'e2', mediaType: 'image', author: 'bigggwild' }), feed, null);
    assert.equal(proved && proved.id, creator.id);
  });

  test('coomer user feed still resolves to the attached creator', () => {
    const feed = repo.feeds.upsert({
      platform: 'coomer', kind: 'user', target: 'onlyfans/bigggwild', creatorId: creator.id, origin: 'admin', runNow: false,
    }).feed;
    const got = pipeline.resolveCreator(item({ sourceId: 'c1', mediaType: 'video', author: 'someoneelse' }), feed, null);
    assert.equal(got && got.id, creator.id);
  });
});

describe('processItem review reasons', () => {
  const settings = { probeUnknownHosts: false, hostReachability: false, scopeMode: 'open', dedupe: false, imageFilter: false };

  test('aggregator page ingest goes to review without creator_id', async () => {
    const feed = repo.feeds.upsert({
      platform: 'web', kind: 'page', target: `https://fapello.com/bigggwild/shot-${Date.now()}`, creatorId: creator.id, origin: 'admin', runNow: false,
    }).feed;
    const out = await pipeline.processItem({
      sourceId: `agg-${Date.now()}`, mediaType: 'image', mediaUrl: 'https://i.imgur.com/zzzzzzz.jpg',
      title: 'gallery shot', author: null, trusted: true,
    }, feed, null, settings);
    assert.equal(out.outcome, 'review');
    assert.equal(out.reason, 'attribution:aggregator');
    assert.equal(out.creatorId, null);
    const row = repo.media.get(out.mediaId);
    assert.equal(row.creator_id, null);
    assert.equal(row.review_reason, 'attribution:aggregator');
  });

  test('editorial page without proof goes to review unproven', async () => {
    const feed = repo.feeds.upsert({
      platform: 'web', kind: 'page', target: `https://mag.example/issue-${Date.now()}`, creatorId: creator.id, origin: 'admin', runNow: false,
    }).feed;
    const out = await pipeline.processItem({
      sourceId: `ed-${Date.now()}`, mediaType: 'image', mediaUrl: 'https://i.imgur.com/yyyyyyy.jpg',
      title: 'spread', author: null, trusted: true,
    }, feed, null, settings);
    assert.equal(out.outcome, 'review');
    assert.equal(out.reason, 'attribution:unproven');
    assert.equal(out.creatorId, null);
  });
});
