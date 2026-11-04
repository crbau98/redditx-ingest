'use strict';
// A failing snapshot job is not re-run by every request (D8). Runs inline (tests have no worker); the
// refresh() path is the one the worker uses too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({});
const snapshots = require('../src/lib/snapshots');
const jobs = require('../src/lib/aggregate-jobs');

test('a failing job runs once per backoff window, not once per request', async () => {
  const original = jobs.JOB_FNS.topics;
  let runs = 0;
  jobs.JOB_FNS.topics = () => { runs++; throw new Error('simulated failure'); };
  try {
    for (let i = 0; i < 5; i++) await snapshots.snapshot('topics').catch((e) => assert.match(e.message, /simulated failure/));
    assert.equal(runs, 1, 'the failure is kept and returned, the job is not re-queued');
  } finally {
    jobs.JOB_FNS.topics = original;
    snapshots._forget('topics');
  }
});

test('after the backoff window the job runs again, and a success clears the failure', async () => {
  const original = jobs.JOB_FNS.graph;
  let runs = 0; let fail = true;
  jobs.JOB_FNS.graph = () => { runs++; if (fail) throw new Error('simulated failure'); return { nodes: [], links: [] }; };
  try {
    await snapshots.snapshot('graph').catch(() => {});
    fail = false;
    snapshots._forget('graph'); // stands in for the backoff window passing
    const v = await snapshots.snapshot('graph');
    assert.deepEqual(v, { nodes: [], links: [] });
    assert.equal(runs, 2);
  } finally {
    jobs.JOB_FNS.graph = original;
    snapshots._forget('graph');
  }
});

test('other jobs are not held up by a failing one', async () => {
  const original = jobs.JOB_FNS.topics;
  jobs.JOB_FNS.topics = () => { throw new Error('simulated failure'); };
  try {
    await snapshots.snapshot('topics').catch(() => {});
    const t = Date.now();
    await snapshots.snapshot('stats');
    assert.ok(Date.now() - t < 5000);
  } finally {
    jobs.JOB_FNS.topics = original;
    snapshots._forget('topics');
  }
});
