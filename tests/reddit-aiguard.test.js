'use strict';
/** Reddit posts stay stored. Their text does not go to a hosted model (Data API Terms §2.4 and §3.2). */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

let aiguard; let reddit; let settings;

before(() => {
  prepareEnv();
  aiguard = require('../src/lib/aiguard');
  reddit = require('../src/sources/reddit');
  settings = require('../src/settings');
});

describe('Reddit content is kept, and kept off hosted models', () => {
  test('a post is still parsed, and its title cannot be sent to a model', () => {
    const title = 'Monday pull day with a long caption about the session';
    const items = reddit.parsePost({ data: {
      id: 'abc123', title, selftext: 'full notes from the session that should stay in the library', author: 'lifter',
      subreddit: 'gaybros', created_utc: 1700000000, permalink: '/r/gaybros/comments/abc123/monday_pull_day/',
      url: 'https://i.redd.it/example.jpg', post_hint: 'image', over_18: true,
    } });
    assert.ok(items.length >= 1, 'the post is still an ingest item');
    assert.equal(items[0].title, title);
    const out = aiguard.scrub({
      accounts: [
        { id: 1, bio: title },
        { id: 2, bio: 'a bluesky bio that is unrelated to this post' },
      ],
    }, 'triage');
    assert.deepEqual(out.accounts.map((a) => a.id), [2]);
    assert.throws(() => aiguard.scrub({ q: 'see https://www.reddit.com/r/gaybros/comments/abc123/monday for more' }, 'search'), (e) => e.aiGuard && e.refusal && e.source === 'reddit');
    assert.throws(() => aiguard.scrub({ accounts: [{ platform: 'reddit', bio: 'x' }] }, 'triage'), (e) => e.aiGuard && e.source === 'reddit');
    assert.equal(aiguard.tainted({ creators: [{ text: 'a bluesky bio with nothing from reddit in it' }] }), false);
  });

  test('tests stay off so they do not hit Reddit, production migration turns reads on, and the body filter does not import face matching', () => {
    assert.equal(settings.get().redditEnabled, false);
    const { spawnSync } = require('child_process');
    const root = path.join(__dirname, '..');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'prism-reddit-on-'));
    const prod = spawnSync(process.execPath, ['-e', `
      const s = require('./src/settings');
      process.stdout.write(JSON.stringify({ on: s.get().redditEnabled, table: !!require('./src/db/repo').db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'reddit_text'").get() }));
    `], { cwd: root, env: { ...process.env, NODE_ENV: 'production', DB_PATH: path.join(dir, 'prod.db'), ADMIN_KEY: 'test-key' }, encoding: 'utf8' });
    assert.equal(prod.status, 0, prod.stderr);
    assert.deepEqual(JSON.parse(prod.stdout.trim()), { on: true, table: true });
    const map = fs.readFileSync(path.join(__dirname, '..', 'ARCHITECTURE.md'), 'utf8');
    for (const name of fs.readdirSync(path.join(__dirname, '..', 'src'))) assert.ok(map.includes(name), `${name} is missing from ARCHITECTURE.md`);
    for (const f of ['src/lib/physique.js', 'src/engine/physique.js', 'src/lib/buildbias.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/require\([^)]*face-match/.test(code), `${f} imports face matching`);
    }
  });
});
