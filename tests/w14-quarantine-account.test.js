'use strict';
/**
 * Crucible v4.23 re-gate: female evidence on an automatically attached feed quarantines the ACCOUNT (every automatic feed on it and
 * everything she posted on that platform), never the creator; and any origin a person did not choose counts as automatic.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let pipeline; let db; let origins;
before(() => { repo = require('../src/db/repo'); db = repo.db; pipeline = require('../src/engine/pipeline'); origins = require('../src/lib/feed-origins'); });

let n = 0;
const mkFeed = (creatorId, o) => { n++; const id = `qa-feed-${n}`; db.prepare("INSERT INTO feeds (id, platform, kind, target, label, enabled, trusted, origin, creator_id, interval_min) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, 60)").run(id, o.platform || 'bluesky', o.kind || 'user', o.target, o.target, o.origin, creatorId); return repo.feeds.get(id); };
const mkItem = (creatorId, feedId, author, platform = 'bluesky') => { n++; return repo.media.insert({ platform, source_id: `qa${n}`, source_key: `${platform}:qa${n}:0`, post_key: `${platform}:qa${n}`, author, creator_id: creatorId, feed_id: feedId, media_type: 'image', media_url: `https://cdn.example/qa${n}.jpg`, hash: `qah${n}` }, []); };

test('every unlisted or automatic origin is automatic; a person-chosen origin is not', () => {
  for (const o of ['coverage', 'discovered', 'cbir', 'paid-page', 'face-match-confirm', 'search-paid', 'paid-mirror', 'some-future-origin']) assert.equal(origins.isAutomaticOrigin(o), true, o);
  for (const o of ['admin', 'seed', 'ingest', 'import', 'telegram-sync', null, undefined, '']) assert.equal(origins.isAutomaticOrigin(o), false, String(o));
});

test("her account's second automatic feed and her posts under another feed are held; the man and his own feed are untouched", () => {
  const man = repo.creators.create({ handle: 'qaman', displayName: 'QA Man', scope: 'in' }); const mid = man.id || man;
  const own = mkFeed(mid, { target: 'qaman', origin: 'admin' });
  for (let i = 0; i < 3; i++) mkItem(mid, own.id, 'qaman');
  const a = mkFeed(mid, { target: 'her_handle', origin: 'coverage' });
  const b = mkFeed(mid, { target: 'her_handle', origin: 'discovered', kind: 'search' });
  const tag = mkFeed(null, { target: '#gym', origin: 'discovered', kind: 'search' });
  mkItem(mid, a.id, 'her_handle'); mkItem(mid, b.id, 'her_handle'); mkItem(mid, b.id, 'her_handle'); mkItem(null, tag.id, 'her_handle');
  pipeline._blockFemaleCreator({ author: 'her_handle' }, a, 'female:girl');
  assert.equal(repo.creators.get(mid).status, 'active');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE lower(author) = 'her_handle' AND publish_state = 'published'").get().n, 0);
  assert.deepEqual([repo.feeds.get(a.id).enabled, repo.feeds.get(b.id).enabled, repo.feeds.get(own.id).enabled], [0, 0, 1]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE creator_id = ? AND author = 'qaman' AND publish_state = 'published'").get(mid).n, 3);
});

test('a page feed filed by image match (cbir) quarantines the feed instead of blocking the creator', () => {
  const man = repo.creators.create({ handle: 'qaman2', displayName: 'QA Man 2', scope: 'in' }); const mid = man.id || man;
  const page = mkFeed(mid, { platform: 'web', kind: 'page', target: 'https://example.com/her-page', origin: 'cbir' });
  mkItem(mid, page.id, 'herpage', 'web');
  pipeline._blockFemaleCreator({ author: 'herpage' }, page, 'female:girl');
  assert.equal(repo.creators.get(mid).status, 'active');
  assert.equal(repo.feeds.get(page.id).enabled, 0);
});
