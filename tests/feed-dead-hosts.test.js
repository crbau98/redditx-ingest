'use strict';
// Dead or wrong-platform hosts: decisions, and that repo.feeds.upsert never creates them enabled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deadReason } = require('../src/lib/deadhosts');

test('dead hosts and the gayfr Misskey mismatch are flagged; live hosts are not', () => {
  assert.match(deadReason('mastodon', 'gaymerninja@mastodon.lol'), /ENOTFOUND/);
  assert.match(deadReason('misskey', 'wrecked@h5q.net'), /ENOTFOUND/);
  assert.match(deadReason('mastodon', 'sockbttm@nsfw.lgbt'), /parked/);
  assert.match(deadReason('misskey', 'jack@gayfr.social'), /Mastodon/);
  assert.equal(deadReason('mastodon', 'jack@gayfr.social'), null, 'bot-challenge, not dead: left enabled');
  assert.equal(deadReason('bluesky', 'cademaddox'), null);
  assert.equal(deadReason('tumblr', 'dragonmax75'), null, 'tumblr 403 is not a dead host');
});

test('repo.feeds.upsert creates a feed on a dead host disabled, even when asked to enable it', () => {
  process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deadhosts-')), 't.db');
  process.env.SCHEDULER_ENABLED = 'false';
  const repo = require('../src/db/repo');
  const dead = repo.feeds.upsert({ platform: 'mastodon', kind: 'user', target: 'x@mastodon.lol', enabled: 1, origin: 'seed' });
  assert.equal(dead.created, true);
  assert.equal(!!dead.feed.enabled, false);
  const live = repo.feeds.upsert({ platform: 'mastodon', kind: 'user', target: 'jack@gayfr.social', enabled: 1, origin: 'seed' });
  assert.equal(!!live.feed.enabled, true);
});
