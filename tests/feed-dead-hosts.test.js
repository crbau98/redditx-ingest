'use strict';
// Dead or wrong-platform hosts: the guard decides, and no path that turns a feed on can get around it.
// Holes covered: (1) a scheme-less target with a port, (2) a trailing-dot host, (3) an admin re-enable of an existing
// dead-host feed. The cases that must keep working are at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// The database is set up before anything loads the repo (seed-feeds does), so the test never touches the default database.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deadhosts-')), 't.db');
process.env.SCHEDULER_ENABLED = 'false';
const { deadReason, normalizeHost, hostOfTarget } = require('../src/lib/deadhosts');
const { deriveFeeds } = require('../src/sources/seed-feeds');

test('normalizeHost: one form for every target shape', () => {
  const cases = [
    ['nsfw.lgbt:8080', 'nsfw.lgbt'],          // scheme-less with a port (hole 1)
    ['nsfw.lgbt', 'nsfw.lgbt'],
    ['nsfw.lgbt.', 'nsfw.lgbt'],              // trailing dot (hole 2)
    ['https://nsfw.lgbt./path?q=1#f', 'nsfw.lgbt'],
    ['HTTP://NSFW.LGBT:443/', 'nsfw.lgbt'],   // case and port on a URL
    ['nsfw.lgbt/some/path', 'nsfw.lgbt'],     // scheme-less with a path
    ['@gaymerninja@mastodon.lol', 'mastodon.lol'],  // Mastodon "user@host"
    ['jack@gayfr.social', 'gayfr.social'],
    ['user:pass@h5q.net/a', 'h5q.net'],       // credentials in a URL keep the host
    ['', ''],
  ];
  for (const [input, want] of cases) assert.equal(normalizeHost(input), want, `normalizeHost(${JSON.stringify(input)})`);
  assert.equal(hostOfTarget('nsfw.lgbt:8080'), 'nsfw.lgbt', 'hostOfTarget is the same function');
});

test('hole 1: a scheme-less target with a port is caught on a dead host', () => {
  assert.match(deadReason('web', 'nsfw.lgbt:8080'), /parked/);
  assert.match(deadReason('web', 'h5q.net:443/feed'), /ENOTFOUND/);
  assert.match(deadReason('mastodon', 'gaymerninja@mastodon.lol:443'), /ENOTFOUND/);
});

test('hole 2: a trailing-dot host is caught on every dead host', () => {
  assert.match(deadReason('web', 'nsfw.lgbt.'), /parked/);
  assert.match(deadReason('web', 'https://nsfw.lgbt./'), /parked/);
  assert.match(deadReason('web', 'h5q.net.'), /ENOTFOUND/);
  assert.match(deadReason('web', 'mastodon.lol.'), /ENOTFOUND/);
  assert.match(deadReason('misskey', 'jack@gayfr.social.'), /Mastodon/, 'wrong-platform host with a trailing dot');
});

test('the dead and wrong-platform rules still match as before', () => {
  assert.match(deadReason('mastodon', 'gaymerninja@mastodon.lol'), /ENOTFOUND/);
  assert.match(deadReason('misskey', 'wrecked@h5q.net'), /ENOTFOUND/);
  assert.match(deadReason('mastodon', 'sockbttm@nsfw.lgbt'), /parked/);
  assert.match(deadReason('misskey', 'jack@gayfr.social'), /Mastodon/);
});

test('a sub-domain of a dead host is blocked; a look-alike domain is not', () => {
  assert.match(deadReason('web', 'feed.nsfw.lgbt'), /parked/);
  assert.match(deadReason('web', 'https://a.b.h5q.net/x'), /ENOTFOUND/);
  assert.equal(deadReason('web', 'notnsfw.lgbt'), null, 'a look-alike is not a sub-domain');
  assert.equal(deadReason('web', 'mastodon.lol.example.com'), null, 'a dead name inside another domain is not that host');
});

test('live hosts and correct URLs keep working', () => {
  assert.equal(deadReason('mastodon', 'jack@gayfr.social'), null, 'gayfr Mastodon user is fine on mastodon');
  assert.equal(deadReason('mastodon', 'jack@gayfr.social:443'), null);
  assert.equal(deadReason('mastodon', 'jack@gayfr.social.'), null, 'trailing dot on a live host is still live');
  assert.equal(deadReason('bluesky', 'cademaddox'), null);
  assert.equal(deadReason('tumblr', 'dragonmax75'), null, 'tumblr 403 is not a dead host');
  assert.equal(deadReason('web', 'https://example.com/nsfw.lgbt/page'), null, 'a dead name in a path is not the host');
  assert.equal(deadReason('web', 'https://example.com/some/path?x=1'), null, 'a correct URL with a path');
  assert.equal(deadReason('web', ''), null);
});

// ---- the database: creation and every re-enable path --------------------------------------------------------
const repo = require('../src/db/repo');
const { db } = repo;

test('creation: a dead-host feed is created disabled, whatever the spelling of the target', () => {
  for (const target of ['nsfw.lgbt:8080', 'nsfw.lgbt.', 'https://nsfw.lgbt./feed', 'x@mastodon.lol']) {
    const platform = target.includes('@') ? 'mastodon' : 'web';
    const r = repo.feeds.upsert({ platform, kind: target.includes('@') ? 'user' : 'page', target, enabled: 1, origin: 'seed' });
    assert.equal(r.created, true, target);
    assert.equal(!!r.feed.enabled, false, `created enabled on ${target}`);
  }
});

test('re-enable (hole 3): an admin enable of an existing dead-host feed stays off', () => {
  // A row that already exists and is off (for example from before the guard): the upsert path does not enable it,
  // and the admin's enable goes through repo.feeds.update.
  db.prepare("INSERT INTO feeds (id, platform, kind, target, label, enabled, trusted, origin, interval_min) VALUES ('dead-row', 'web', 'page', 'old.h5q.net', 'x', 0, 1, 'admin', 180)").run();
  const after = repo.feeds.update('dead-row', { enabled: true, runNow: true, resetErrors: true });
  assert.equal(!!after.enabled, false, 'admin re-enable of a dead host must not turn it on');
  const viaFlag = repo.feeds.update('dead-row', { enabled: 1 });
  assert.equal(!!viaFlag.enabled, false, 'enabled: 1 is the same as true');
});

test('re-enable: moving an off feed onto a dead host and enabling it is refused', () => {
  const live = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://example.com/blog', enabled: 0, origin: 'admin' });
  assert.equal(!!live.feed.enabled, false);
  const moved = repo.feeds.update(live.feed.id, { target: 'mastodon.lol:443', enabled: true });
  assert.equal(!!moved.enabled, false, 'a target change onto a dead host cannot leave the feed on');
});

test('a feed that is enabled and changed onto a dead host is switched off', () => {
  const live = repo.feeds.upsert({ platform: 'web', kind: 'page', target: 'https://example.com/other', enabled: 1, origin: 'admin' });
  assert.equal(!!live.feed.enabled, true);
  const moved = repo.feeds.update(live.feed.id, { target: 'h5q.net.' });
  assert.equal(!!moved.enabled, false);
});

test('re-enable of a live feed still works, and an unrelated edit leaves a dead feed alone', () => {
  const live = repo.feeds.upsert({ platform: 'mastodon', kind: 'user', target: 'jack@gayfr.social', enabled: 0, origin: 'admin' });
  assert.equal(!!live.feed.enabled, false);
  const on = repo.feeds.update(live.feed.id, { enabled: true, runNow: true });
  assert.equal(!!on.enabled, true, 'a live host can be enabled');
  const edited = repo.feeds.update(live.feed.id, { label: 'renamed' });
  assert.equal(!!edited.enabled, true, 'an unrelated edit keeps it on');
});

test('the seed loop does not switch a dead host on, and still seeds the live ones', () => {
  const seed = {
    creators: [{ id: 'c1', handle: 'someone', display_name: 'Someone' }],
    feeds: [
      { platform: 'mastodon', kind: 'user', target: 'x@nsfw.lgbt.', creator_id: 'c1' },
      { platform: 'web', kind: 'page', target: 'https://nsfw.lgbt:8080/x', creator_id: 'c1' },
      { platform: 'mastodon', kind: 'user', target: 'jack@gayfr.social', creator_id: 'c1' },
    ],
  };
  const out = deriveFeeds(seed).map((f) => f.target);
  assert.ok(!out.some((t) => /nsfw\.lgbt/.test(t)), `seed derived a dead host: ${out.join(', ')}`);
  assert.ok(out.includes('jack@gayfr.social'), 'the live Mastodon seed is kept');
});
