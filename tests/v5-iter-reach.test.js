'use strict';
/**
 * v5 iteration item 3: Misskey people search closes the people-search gap beyond Bluesky/RedGIFs.
 * Uses the public `users/search-by-username` endpoint (no sign-in on open servers); gated
 * instances raise a skip error that discovery logs instead of failing the run.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let host; let repo; let discovery; let misskey;

before(async () => {
  mock = await start({
    '/api/users/search-by-username': (req, res, url) => {
      let body = {};
      try { body = JSON.parse(req.bodyText || '{}'); } catch { /* ignore */ }
      if (!body.query) return { status: 400, json: { error: 'query required' } };
      return { json: [
        { id: 'u1', username: 'northpeak', host: null, name: 'North Peak', description: 'gay hiker 18+ · onlyfans link in bio', avatarUrl: 'https://files.example/np.png', followersCount: 1200 },
        { id: 'u2', username: 'plainfan', host: null, name: 'Just a fan', description: 'i like hiking', avatarUrl: null, followersCount: 30 },
      ] };
    },
  });
  host = `127.0.0.1:${mock.port}`;
  // Hermetic: the people-search wiring is tested against stubs (no live platforms); the HTTP
  // layer itself is covered by searchUsers above. Instance names stay realistic hostnames.
  prepareEnv({ MISSKEY_INSTANCES: 'mk.example', SEARCH_PROVIDERS: '', AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo');
  discovery = require('../src/engine/discovery');
  misskey = require('../src/sources/misskey');
  const registry = require('../src/sources');
  registry.get('bluesky').searchActors = async () => [];
  registry.get('redgifs').searchCreators = async () => [];
});
after(async () => { await mock.close(); });

describe('iter3: misskey people search', () => {
  test('searchUsers normalises public user hits', async () => {
    const users = await misskey.searchUsers('north', host, 10);
    assert.equal(users.length, 2);
    assert.deepEqual(users[0], { username: 'northpeak', host, displayName: 'North Peak', description: 'gay hiker 18+ · onlyfans link in bio', avatar: 'https://files.example/np.png', followers: 1200 });
  });
  test('peopleSearch queues creator-worded misskey accounts, skips plain fans', async () => {
    const real = misskey.searchUsers;
    misskey.searchUsers = async (q, h) => (h === 'mk.example' ? [
      { username: 'northpeak', host: 'mk.example', displayName: 'North Peak', description: 'gay hiker 18+ · onlyfans link in bio', avatar: null, followers: 1200 },
      { username: 'plainfan', host: 'mk.example', displayName: 'Just a fan', description: 'i like hiking', avatar: null, followers: 30 },
    ] : []);
    try {
      require('../src/settings').update({ discoveryKeywords: 'hiker' });
      const out = await discovery.peopleSearch({});
      assert.equal(out.misskey, 1, JSON.stringify(out));
      const c = repo.candidates.find('misskey', 'user', 'northpeak@mk.example');
      assert.ok(c, 'lead queued');
      assert.ok(c.signals.search.includes('misskey-people:hiker'));
      assert.equal(repo.candidates.find('misskey', 'user', 'plainfan@mk.example'), null, 'no creator wording, no lead');
      require('../src/settings').update({ discoveryKeywords: '' });
    } finally { misskey.searchUsers = real; }
  });
});
