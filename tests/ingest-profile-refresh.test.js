'use strict';
/**
 * Creator profiles are re-read now and then. A creator's profile (avatar, bio, the links in it) used to be read on the feed's first
 * run only (and on a manual run): a new avatar, a dead avatar link, or a Fansly page added to the bio later were never seen.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let engine; let registry; let settingsStore; let adapter; let realFetch;
const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
let asked = []; let reply;
let n = 0;

before(() => {
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  registry = require('../src/sources');
  settingsStore = require('../src/settings');
  adapter = registry.get('bluesky');
  realFetch = adapter.fetch;
  adapter.fetch = async (feed, ctx) => { asked.push({ needProfile: ctx.needProfile, cursor: ctx.cursor }); return reply(feed, ctx); };
});
after(() => { adapter.fetch = realFetch; engine.shutdown(); });
beforeEach(() => { asked = []; reply = () => ({ items: [], cursor: { newestAt: iso(DAY) }, via: 'stub' }); settingsStore.update({ profileRefreshDays: 14 }); });

/** A followed creator with a bluesky feed that has already succeeded `lastOkMsAgo` ago, holding `cursor`. */
function creator({ lastOkMsAgo = 2 * DAY, cursor = { newestAt: iso(3 * DAY) }, avatar = null, bio = null, platform = 'bluesky' } = {}) {
  const handle = `person${++n}.bsky.social`;
  const c = repo.creators.create({ handle, displayName: handle, avatarUrl: avatar, bio, origin: 'admin' });
  const f = repo.feeds.upsert({ platform, kind: 'user', target: handle, creatorId: c.id, origin: 'admin' }).feed;
  repo.db.prepare('UPDATE feeds SET last_success_at = ?, last_run_at = ?, cursor = ? WHERE id = ?').run(iso(lastOkMsAgo), iso(lastOkMsAgo), JSON.stringify(cursor), f.id);
  return { c, f };
}
const run = (f, trigger = 'schedule') => engine.runFeed(repo.feeds.get(f.id), trigger);
const cursorOf = (f) => JSON.parse(repo.feeds.get(f.id).cursor);

test('a profile read long ago is read again; one read lately is not', async () => {
  const stale = creator({ cursor: { newestAt: iso(3 * DAY), profiledAt: iso(20 * DAY) } });
  const fresh = creator({ cursor: { newestAt: iso(3 * DAY), profiledAt: iso(1 * DAY) } });
  await run(stale.f); await run(fresh.f);
  assert.equal(asked[0].needProfile, true, 'stale: asked');
  assert.equal(asked[1].needProfile, false, 'fresh: not asked');
});

test('a feed that has never had its profile stamped (older cursors) gets one refresh, then waits', async () => {
  reply = () => ({ items: [], cursor: { newestAt: iso(DAY) }, profile: { displayName: 'P', avatarUrl: null, bio: 'hello' }, via: 'stub' });
  const { f } = creator({ cursor: { newestAt: iso(3 * DAY) } });
  await run(f);
  assert.equal(asked[0].needProfile, true);
  assert.ok(cursorOf(f).profiledAt, 'stamped');
  assert.ok(cursorOf(f).newestAt, 'the adapter cursor is kept');
  await run(f);
  assert.equal(asked[1].needProfile, false, 'not again straight away');
  assert.ok(cursorOf(f).profiledAt, 'the stamp survives a run that returns a fresh cursor');
});

test('a profile that could not be read is retried the next day, not every run', async () => {
  const { f } = creator({ cursor: { newestAt: iso(3 * DAY), profiledAt: iso(30 * DAY) } });
  await run(f); // asked, the adapter returns no profile
  assert.equal(asked[0].needProfile, true);
  assert.equal(cursorOf(f).profileTryAt !== undefined, true);
  await run(f);
  assert.equal(asked[1].needProfile, false, 'tried a moment ago');
  repo.db.prepare('UPDATE feeds SET cursor = ? WHERE id = ?').run(JSON.stringify({ ...cursorOf(f), profileTryAt: iso(2 * DAY) }), f.id);
  await run(f);
  assert.equal(asked[2].needProfile, true, 'a day later: again');
});

test('profileRefreshDays = 0 turns the refresh off; first runs and manual runs still read the profile', async () => {
  settingsStore.update({ profileRefreshDays: 0 });
  const stale = creator({ cursor: { newestAt: iso(3 * DAY), profiledAt: iso(90 * DAY) } });
  await run(stale.f);
  assert.equal(asked[0].needProfile, false);
  await run(stale.f, 'manual');
  assert.equal(asked[1].needProfile, true, 'manual');
  const never = creator({ lastOkMsAgo: 0 }); repo.db.prepare('UPDATE feeds SET last_success_at = NULL WHERE id = ?').run(never.f.id);
  await run(never.f);
  assert.equal(asked[2].needProfile, true, 'first run');
});

test('feeds without a creator, and platforms where a profile read is not free, are not asked', async () => {
  const noCreator = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'nobody.bsky.social', origin: 'admin' }).feed;
  repo.db.prepare('UPDATE feeds SET last_success_at = ?, cursor = ? WHERE id = ?').run(iso(DAY), JSON.stringify({ newestAt: iso(DAY) }), noCreator.id);
  await run(noCreator);
  assert.equal(asked[0].needProfile, false);
  const due = (platform) => engine._profileDue({ platform, kind: 'user', creator_id: 'c', last_success_at: iso(DAY) }, { profiledAt: iso(90 * DAY) }, settingsStore.get(), 'schedule');
  assert.equal(due('bluesky'), true);
  assert.equal(due('telegram'), false, 'a Telegram profile read costs MTProto budget: only first/manual');
  assert.equal(due('coomer'), false, 'platforms that return the profile with every run need no extra read');
  const dueKind = (platform, kind) => engine._profileDue({ platform, kind, creator_id: 'c', last_success_at: iso(DAY) }, { profiledAt: iso(90 * DAY) }, settingsStore.get(), 'schedule');
  assert.equal(dueKind('peertube', 'channel'), true, 'a creator attached as a PeerTube channel is refreshed like a user');
  assert.equal(dueKind('peertube', 'user'), true);
  assert.equal(dueKind('peertube', 'search'), false, 'a search feed has no creator profile');
  assert.equal(dueKind('mastodon', 'channel'), false, 'only PeerTube has the channel kind with a profile');
});

test('a refreshed profile replaces a stale avatar from the same site, fills blanks, and leaves other sites alone', async () => {
  const same = creator({ avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:a/oldcid@jpeg', cursor: { newestAt: iso(3 * DAY), profiledAt: iso(40 * DAY) } });
  const other = creator({ avatar: 'https://elsewhere.example/me.jpg', cursor: { newestAt: iso(3 * DAY), profiledAt: iso(40 * DAY) } });
  const blank = creator({ avatar: null, cursor: { newestAt: iso(3 * DAY), profiledAt: iso(40 * DAY) } });
  reply = () => ({ items: [], cursor: { newestAt: iso(DAY) }, profile: { displayName: 'X', avatarUrl: 'https://cdn.bsky.app/img/avatar/plain/did:plc:a/newcid@jpeg', bio: null }, via: 'stub' });
  await run(same.f); await run(other.f); await run(blank.f);
  assert.equal(repo.creators.get(same.c.id).avatar_url, 'https://cdn.bsky.app/img/avatar/plain/did:plc:a/newcid@jpeg');
  assert.equal(repo.creators.get(other.c.id).avatar_url, 'https://elsewhere.example/me.jpg', 'an avatar from another site is kept');
  assert.equal(repo.creators.get(blank.c.id).avatar_url, 'https://cdn.bsky.app/img/avatar/plain/did:plc:a/newcid@jpeg');
});

test('a link added to the bio later is picked up by the refresh', async () => {
  const { c, f } = creator({ bio: 'old bio', cursor: { newestAt: iso(3 * DAY), profiledAt: iso(40 * DAY) } });
  reply = () => ({ items: [], cursor: { newestAt: iso(DAY) }, profile: { displayName: 'P', avatarUrl: null, bio: 'old bio. new page: https://fansly.com/freshpage' }, via: 'stub' });
  await run(f);
  const links = repo.creators.get(c.id).links;
  assert.ok(links.some((l) => /freshpage/i.test(`${l.handle || ''}${l.url || ''}`)), JSON.stringify(links));
});
