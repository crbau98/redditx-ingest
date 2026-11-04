'use strict';
// The library snapshot is built by the aggregate worker in production and handed to the main thread
// with its similarity index. These tests pin the shape of that hand-off and the adopt() contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({});
const repo = require('../src/db/repo');
const similarity = require('../src/lib/similarity');
const snapshots = require('../src/lib/snapshots');
const { JOB_FNS, JOB_TTL_MS } = require('../src/lib/aggregate-jobs');

test('tests run without the worker, so the library is built inline and exact', () => {
  assert.equal(snapshots.USE_WORKER, false);
  const lib = repo.library();
  assert.ok(Array.isArray(lib.tagList));
  assert.ok(lib.visibleCreators instanceof Set);
});

test('the library job returns the snapshot together with its similarity index', () => {
  assert.equal(typeof JOB_FNS.library, 'function');
  assert.ok(JOB_TTL_MS.library > 0);
  const { lib, index } = JOB_FNS.library();
  assert.ok(lib.creatorTags instanceof Map);
  assert.ok(Array.isArray(lib.tagList));
  assert.equal(similarity.indexFor(lib, repo.GENERIC_TAGS), index, 'the index is built for this snapshot');
});

test('adopt() attaches a received index to the copy of its snapshot, so nothing rebuilds it', () => {
  const { lib, index } = JOB_FNS.library();
  const received = structuredClone({ lib, index }); // what postMessage delivers on the main thread
  similarity.adopt(received.lib, received.index);
  assert.equal(similarity.indexFor(received.lib, repo.GENERIC_TAGS), received.index);
});
