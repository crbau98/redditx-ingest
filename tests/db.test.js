'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const dir = require('./helpers/mock').prepareEnv();

// Build a genuine PRISM v3 database (schema captured from git history) BEFORE the app opens it.
const legacyPath = path.join(dir, 'legacy.db');
{
  const db = new Database(legacyPath);
  db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-schema.sql'), 'utf8'));
  db.prepare("INSERT INTO creators (id, primary_handle, display_name, orientation_scope, media_count, total_score) VALUES ('c1','alice_bro','Alice Bro','gay',2,150),('c2','xuser','X User','uncertain',1,3)").run();
  db.prepare("INSERT INTO creator_sources (id, creator_id, source_platform, source_creator_id, handle) VALUES ('s1','c1','reddit','alice_bro','alice_bro'),('s2','c2','x','xuser','xuser')").run();
  const ins = db.prepare('INSERT INTO media (id,title,media_type,media_url,source_platform,source_url,source_id,subreddit,author,score,hash,orientation_scope,publish_state,creator_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('m1', 'Gym selfie', 'image', 'https://i.redd.it/abc.jpg?s=zzz', 'reddit', 'u', 'p1', 'gaybrosgonewild', 'alice_bro', 100, 'h1', 'gay', 'published', 'c1', '2025-01-02 03:04:05');
  ins.run('m2', 'Clip', 'video', 'https://v.redd.it/x/DASH_720.mp4', 'reddit', 'u', 'p2', 'twinks', 'alice_bro', 50, 'h2', 'gay', 'published', 'c1', '2025-01-03 03:04:05');
  ins.run('m3', 'Tweet pic', 'image', 'https://pbs.twimg.com/media/q.jpg', 'x', 'u', 'x-1-0', 'x', 'xuser', 3, 'h3', 'uncertain', 'review', 'c2', '2025-01-04 03:04:05');
  ins.run('m4', 'Removed', 'image', 'https://i.imgur.com/gone.jpg', 'reddit', 'u', 'p4', 'cock', 'alice_bro', 1, 'h4', 'excluded_straight', 'removed', 'c1', '2025-01-05 03:04:05');
  ins.run('m5', 'Old unsafe row', 'image', 'https://i.redd.it/unsafe.jpg', 'reddit', 'u', 'p5', 'twinks', 'alice_bro', 1, 'h5', 'gay', 'published', 'c1', '2025-01-06 03:04:05');
  db.prepare("INSERT INTO tags (name, usage_count) VALUES ('gaybrosgonewild',1),('reddit',2)").run();
  db.prepare("INSERT INTO media_tags (media_id, tag_id, source) VALUES ('m1',1,'ingest'),('m1',2,'ingest'),('m2',2,'manual')").run();
  db.prepare("INSERT INTO moderation_actions (target_type,target_id,action,reason) VALUES ('media','m4','hide','junk')").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('foo','bar')").run();
  db.prepare("UPDATE media SET title = 'im 16 lol' WHERE id = 'm5'").run();
  db.close();
}
process.env.DB_PATH = legacyPath;

const { db, migration } = require('../src/db');
const repo = require('../src/db/repo');

describe('migration from a real v3 database', () => {
  test('upgrades in place and reports it', () => {
    assert.deepEqual(migration, { from: 0, to: 12 });
    assert.equal(db.pragma('user_version', { simple: true }), 12);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
  test('keeps every media row with remapped scope/state, platform and community', () => {
    const rows = Object.fromEntries(db.prepare('SELECT * FROM media').all().map((r) => [r.id, r]));
    assert.equal(Object.keys(rows).length, 5);
    assert.equal(rows.m1.platform, 'reddit'); assert.equal(rows.m1.community, 'gaybrosgonewild'); assert.equal(rows.m1.scope, 'in');
    assert.equal(rows.m3.scope, 'uncertain'); assert.equal(rows.m3.publish_state, 'review');
    assert.equal(rows.m4.scope, 'excluded'); assert.equal(rows.m4.publish_state, 'removed');
    assert.equal(rows.m1.posted_at, '2025-01-02T03:04:05.000Z', 'legacy timestamps become ISO-8601 UTC');
    assert.equal(rows.m1.source_key, 'reddit:p1:0');
  });
  test('re-hashes media so new ingests dedupe against old rows', () => {
    const m1 = db.prepare("SELECT hash FROM media WHERE id='m1'").get().hash;
    const { canonicalUrl } = require('../src/lib/mediaurl');
    assert.equal(m1, crypto.createHash('md5').update(canonicalUrl('https://i.redd.it/abc.jpg?s=zzz')).digest('hex'));
    assert.equal(m1, crypto.createHash('md5').update(canonicalUrl('https://i.redd.it/abc.jpg?s=different-signature')).digest('hex'));
  });
  test('creators, accounts (as feeds), tags, settings and moderation history survive', () => {
    assert.equal(repo.creators.get('c1').handle, 'alice_bro');
    assert.equal(repo.creators.get('c2').scope, 'uncertain');
    const f = repo.feeds.find('reddit', 'user', 'alice_bro');
    assert.equal(f.creator_id, 'c1'); assert.equal(f.enabled, 0, 'legacy accounts are not auto-followed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM media_tags').get().n, 3);
    assert.equal(repo.settings.get('foo'), 'bar');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM moderation_actions').get().n, 1);
    assert.equal(repo.media.getFull('m1').tags.join(), 'gaybrosgonewild,reddit');
  });
  test('legacy tables are gone and search works on migrated rows', () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const gone of ['media_legacy', 'creators_legacy', 'creator_sources', 'creator_sources_legacy']) assert.ok(!names.includes(gone), gone);
    assert.equal(repo.media.list({ q: 'gym' }).total, 1);
    assert.equal(repo.media.list({ q: 'twinks' }).total, 2, 'community is searchable (m2 and the not-yet-swept m5)');
  });
  test('the safety sweep retro-blocks legacy content that predates the gate', async () => {
    assert.equal(repo.media.get('m5').publish_state, 'published', 'old rows are untouched by the migration itself');
    const { sweep } = require('../src/engine/maintenance');
    const r = await sweep();
    assert.ok(r.blocked >= 1);
    assert.equal(repo.media.get('m5').publish_state, 'removed');
    assert.ok(repo.blocklist.has('hash', repo.media.get('m5').hash), 'and it can never be re-imported');
  });
  test('opening again is a no-op', () => {
    const { migrate } = require('../src/db/schema');
    assert.deepEqual(migrate(db), { from: 12, to: 12 });
  });
});

describe('repository behaviour', () => {
  const mk = (i, extra = {}) => ({ platform: 'reddit', source_id: `q${i}`, source_key: `reddit:q${i}:0`, post_key: `reddit:q${i}`, community: 'testsub', author: 'tester', title: `Item ${i} gym`, media_type: i % 2 ? 'image' : 'video', media_url: `https://i.redd.it/q${i}.jpg`, hash: `qh${i}`, score: i * 10, posted_at: new Date(Date.now() - i * 3600000).toISOString(), ...extra });

  test('inserts de-duplicate on hash and source key, other constraint errors still throw', () => {
    const c = repo.creators.create({ handle: 'tester' });
    assert.ok(repo.media.insert(mk(1, { creator_id: c.id }), ['Gym', '#Big Bro']));
    assert.equal(repo.media.insert(mk(1, { source_key: 'other', creator_id: c.id })), null, 'same hash');
    assert.equal(repo.media.insert(mk(1, { hash: 'different', creator_id: c.id })), null, 'same source key');
    assert.throws(() => repo.media.insert(mk(2, { media_type: 'audio' })), /CHECK/);
  });
  test('tags are normalised and searchable', () => {
    assert.deepEqual(repo.media.tags(50).map((t) => t.name).filter((n) => ['gym', 'big-bro'].includes(n)).sort(), ['big-bro', 'gym']);
    assert.equal(repo.media.list({ tag: '#Big Bro' }).total, 1);
  });
  test('sorting, paging, filters and the stable shuffle', () => {
    const c = repo.creators.create({ handle: 'tester2' });
    for (let i = 2; i <= 9; i++) repo.media.insert(mk(i, { creator_id: c.id }));
    repo.creators.refreshStats(c.id);
    const titles = (f) => repo.media.list({ community: 'testsub', ...f }).items.map((m) => m.source_id);
    assert.deepEqual(titles({ sort: 'recent', limit: 3 }), ['q1', 'q2', 'q3']);
    assert.deepEqual(titles({ sort: 'top', limit: 2 }), ['q9', 'q8']);
    assert.deepEqual(titles({ sort: 'oldest', limit: 2 }), ['q9', 'q8']);
    assert.deepEqual(titles({ sort: 'recent', limit: 3, page: 1 }), ['q4', 'q5', 'q6']);
    assert.equal(repo.media.list({ community: 'TESTSUB', type: 'video' }).items.every((m) => m.media_type === 'video'), true, 'community is case-insensitive');
    const a = titles({ sort: 'random', seed: 7, limit: 9 }); const b = titles({ sort: 'random', seed: 7, limit: 9 }); const d = titles({ sort: 'random', seed: 8, limit: 9 });
    assert.deepEqual(a, b); assert.notDeepEqual(a, d);
    assert.deepEqual([...titles({ sort: 'random', seed: 7, limit: 4, page: 0 }), ...titles({ sort: 'random', seed: 7, limit: 4, page: 1 })], a.slice(0, 8), 'shuffle pages never repeat');
    assert.equal(c && repo.creators.get(c.id).media_count, 8);
  });
  test('search ranks and survives hostile input', () => {
    assert.ok(repo.media.list({ q: 'gym' }).total >= 9);
    for (const q of ['"', '(', 'a OR', '* *', 'NEAR(', '\\', "'; DROP TABLE media;--"]) assert.doesNotThrow(() => repo.media.list({ q }), q);
    assert.equal(repo.media.list({ q: '***' }).total, 0);
  });
  test('unpublished, excluded and blocked-creator content never reaches public lists', () => {
    const c = repo.creators.create({ handle: 'shady' });
    const id = repo.media.insert(mk(50, { creator_id: c.id, title: 'visible shady' }));
    assert.equal(repo.media.list({ q: 'visible shady' }).total, 1);
    repo.media.setState(id, 'review'); assert.equal(repo.media.list({ q: 'visible shady' }).total, 0);
    repo.media.setState(id, 'published'); repo.media.update(id, { scope: 'excluded' }); assert.equal(repo.media.list({ q: 'visible shady' }).total, 0);
    repo.media.update(id, { scope: 'in' }); assert.equal(repo.media.list({ q: 'visible shady' }).total, 1);
    repo.creators.update(c.id, { status: 'hidden' }); assert.equal(repo.media.list({ q: 'visible shady' }).total, 0, 'hidden creator hides their media');
    assert.equal(repo.media.list({ q: 'visible shady', admin: true, state: 'all' }).total, 1, 'admin still sees it');
  });
  test('blocking media or creators is permanent and recorded', () => {
    const c = repo.creators.create({ handle: 'blockme' });
    repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'blockme', creatorId: c.id });
    const id = repo.media.insert(mk(60, { creator_id: c.id }));
    repo.media.block(id, 'test');
    assert.equal(repo.media.get(id).publish_state, 'removed');
    assert.ok(repo.blocklist.has('hash', 'qh60') && repo.blocklist.has('source_key', 'reddit:q60:0'));
    repo.creators.block(c.id, 'optout');
    assert.equal(repo.creators.get(c.id).status, 'blocked');
    assert.ok(repo.blocklist.has('creator', 'reddit:blockme') && repo.blocklist.has('creator', c.id));
    assert.equal(repo.feeds.find('reddit', 'user', 'blockme').enabled, 0);
  });
  test('merging creators moves media and accounts', () => {
    const a = repo.creators.create({ handle: 'merge_a' }); const b = repo.creators.create({ handle: 'merge_b', bio: 'bio from b' });
    repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'merge_b', creatorId: b.id });
    repo.media.insert(mk(70, { creator_id: b.id }));
    const kept = repo.creators.merge(a.id, b.id);
    assert.equal(kept.bio, 'bio from b'); assert.equal(repo.creators.get(b.id), null);
    assert.equal(repo.feeds.find('x', 'user', 'merge_b').creator_id, a.id);
    assert.equal(repo.media.list({ creator: a.id }).total, 1);
    assert.equal(repo.creators.merge(a.id, a.id), null);
  });
  test('feeds upsert idempotently, case-insensitively', () => {
    const f1 = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'MixedCase' });
    const f2 = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'mixedcase' });
    assert.equal(f1.created, true); assert.equal(f2.created, false); assert.equal(f1.feed.id, f2.feed.id);
  });
  test('trending recompute orders by recency-weighted popularity', () => {
    const c = repo.creators.create({ handle: 'hotcreator' });
    repo.media.insert(mk(80, { creator_id: c.id, title: 'old banger zzzhot', score: 5000, posted_at: new Date(Date.now() - 60 * 86400000).toISOString() }));
    repo.media.insert(mk(81, { creator_id: c.id, title: 'fresh good zzzhot', score: 800, posted_at: new Date(Date.now() - 3600000).toISOString() }));
    repo.media.recomputeHot();
    const order = repo.media.list({ q: 'zzzhot', sort: 'trending' }).items.map((m) => m.title);
    assert.deepEqual(order, ['fresh good zzzhot', 'old banger zzzhot']);
  });
  test('reports persist and the open count tracks them', () => {
    const before = repo.reports.openCount();
    const id = repo.reports.create({ mediaId: 'm1', kind: 'takedown', reason: 'mine', contact: 'a@b.c' });
    assert.equal(repo.reports.openCount(), before + 1);
    assert.equal(repo.reports.list().items.find((r) => r.id === id).kind, 'takedown');
    repo.reports.resolve(id, 'resolved', 'removed', 'admin');
    assert.equal(repo.reports.openCount(), before);
  });
  test('proxy host allow-list learns hosts from ingested media', () => {
    assert.equal(repo.hosts.has('i.redd.it'), true);
    assert.equal(repo.hosts.has('never-seen.example'), false);
  });
});
