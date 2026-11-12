'use strict';
/**
 * src/db/repo.js is a facade over src/db/repos/*: every domain module exports its factory, and the facade keeps the
 * exact shape callers use (namespaces and top-level functions).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');

const FACTORIES = {
  creators: 'buildCreators', media: 'buildMedia', takedowns: 'buildTakedowns', library: 'buildLibraryModule', graph: 'attachCreatorGraph',
  feeds: 'buildFeeds', runs: 'buildRuns', candidates: 'buildCandidates', onlyfans: 'buildOnlyfans', reports: 'buildReports',
  tags: 'buildTagIntel', analytics: 'buildAnalytics',
};

test('each module in src/db/repos exports its factory', () => {
  const files = fs.readdirSync(path.join(__dirname, '../src/db/repos')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(files, Object.keys(FACTORIES).sort(), 'no module without a known factory, and none missing');
  for (const [file, fn] of Object.entries(FACTORIES)) assert.equal(typeof require(`../src/db/repos/${file}`)[fn], 'function', `${file}.${fn}`);
});

test('repo exposes every namespace with its methods, and the top-level functions', () => {
  const NS = {
    creators: ['get', 'list', 'similar', 'collabs', 'duplicates', 'activity', 'graph', 'rising'],
    feeds: ['get', 'find', 'upsert', 'update', 'remove', 'due', 'finishRun', 'list', 'counts', 'countEnabled'],
    runs: ['start', 'finish', 'recent', 'activity', 'scoreboard', 'yieldSince', 'idleFeeds', 'recentAdded', 'prune', 'timeoutStale', 'abandonRunning'],
    candidates: ['get', 'find', 'insert', 'update', 'list', 'promotable', 'needingDetails', 'counts', 'prune'],
    discoveryState: ['get', 'set', 'touchedAt'],
    onlyfans: ['get', 'note', 'claim', 'update', 'workable', 'list', 'ownerOf', 'reachTargets', 'nameTargets', 'counts'],
    reports: ['create', 'get', 'list', 'resolve', 'openCount', 'recentCountFrom'],
    tagIntel: ['related', 'relatedUncached', 'topics', 'vocabulary'],
    media: ['list', 'insert'], takedowns: ['all', 'get', 'find', 'list'], settings: ['get', 'set', 'all'],
    hosts: ['add', 'has'], blocklist: ['add', 'has', 'list', 'remove'], audit: ['list'],
  };
  for (const [ns, methods] of Object.entries(NS)) for (const m of methods) assert.equal(typeof repo[ns][m], 'function', `repo.${ns}.${m}`);
  for (const fn of ['nowIso', 'clampInt', 'cleanTag', 'addTags', 'logAction', 'suggest', 'publicStats', 'adminOverview', 'discover', 'mentionSource',
    'discoveryTargets', 'communityHangouts', 'upsertDiscoveryLead', 'getDiscoveryLead', 'library', 'libraryWithIndex', 'purgeRemovedContent', 'ftsQuery', 'serializeMedia', 'serializeCreator']) {
    assert.equal(typeof repo[fn], 'function', `repo.${fn}`);
  }
  assert.equal(typeof repo.LibraryWarmingError, 'function');
  assert.ok(repo.db && repo.GENERIC_TAGS instanceof Set && Array.isArray(repo.PLATFORM_TAGS) && typeof repo.SELECT_CREATOR_CARD === 'string');
  assert.equal(typeof repo._ingestDaily.sql, 'string');
});

test('the facade works end to end: a feed, a run and the overview that reads them', () => {
  const { feed } = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'modsplit' });
  const run = repo.runs.start(feed.id, 'test');
  repo.runs.finish(run, { status: 'ok', fetched: 3, added: 2 });
  const o = repo.adminOverview();
  assert.ok(o.feeds.total >= 1 && o.last24h.added >= 2);
  assert.equal(repo.discover().stats.total >= 0, true);
});

test('src/db/repo.js stays a short facade', () => {
  const lines = fs.readFileSync(path.join(__dirname, '../src/db/repo.js'), 'utf8').split('\n').length;
  assert.ok(lines < 300, `${lines} lines`);
});
