'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { MIGRATIONS, migrate } = require('../src/db/schema');
const registry = require('../src/sources');
const { parseProfile } = require('../src/lib/links');
test('retirement disables existing Lemmy feeds and preserves other feeds', () => {
  const db = new Database(':memory:');
  for (let i = 0; i < 18; i++) MIGRATIONS[i](db);
  db.pragma('user_version = 18');
  db.prepare('INSERT INTO feeds (id, platform, kind, target) VALUES (?, ?, ?, ?)').run('l', 'lemmy', 'community', 'one@example.org');
  db.prepare('INSERT INTO feeds (id, platform, kind, target) VALUES (?, ?, ?, ?)').run('m', 'mastodon', 'tag', 'example');
  migrate(db);
  assert.equal(db.prepare('SELECT enabled FROM feeds WHERE id = ?').get('l').enabled, 0);
  assert.equal(db.prepare('SELECT enabled FROM feeds WHERE id = ?').get('m').enabled, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM feeds').get().n, 2);
  db.close();
});
test('Lemmy cannot be seeded or registered as an ingestible source', () => {
  assert.equal(registry.get('lemmy'), null);
  assert.equal(registry.SEEDS.some(s => s.platform === 'lemmy'), false);
  assert.notEqual(parseProfile('https://lemmynsfw.com/c/example')?.platform, 'lemmy');
});

test('free discovery includes SearXNG and rejects incoherent provider answers', async () => {
  const ws = require('../src/lib/websearch');
  const names = Object.keys(ws.PROVIDERS);
  const originals = Object.fromEntries(names.map(n => [n, { ...ws.PROVIDERS[n] }]));
  try {
    for (const name of names) ws.PROVIDERS[name].configured = () => false;
    for (const name of ['ddg', 'searxng']) ws.PROVIDERS[name].configured = () => true;
    ws.PROVIDERS.ddg.search = async () => [{ url: 'https://example.org/alpha', title: 'alpha creator' }];
    ws.PROVIDERS.searxng.search = async () => [{ url: 'https://example.com/alpha', title: 'alpha creator' }];
    ws._clear();
    const results = await ws.search('alpha creator', { fresh: true, preferKeyless: true });
    assert.deepEqual(new Set(results.map(r => r.provider)), new Set(['ddg', 'searxng']));
    for (const name of ['ddg', 'searxng']) ws.PROVIDERS[name].search = async () => [{ url: 'https://example.com/other', title: 'unrelated' }];
    await assert.rejects(ws.search('alpha creator', { fresh: true, preferKeyless: true }), /incoherent/);
  } finally {
    for (const name of names) Object.assign(ws.PROVIDERS[name], originals[name]);
    ws._clear();
  }
});
