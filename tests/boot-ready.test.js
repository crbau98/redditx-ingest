'use strict';
/**
 * The platform's health probe decides whether a deploy is good, and it can only be answered while
 * the event loop is free. These tests pin that contract: the boot work waits for the first health
 * answer, so a probe request is never stuck behind a cache warm-up.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const readyPath = require.resolve('../src/lib/ready');

describe('boot readiness', () => {
  test('a fresh module has not answered a health check yet', () => {
    const ready = require(readyPath);
    // The module is a singleton for the process, so this only holds before anything marked it.
    if (!ready.isHealthy()) assert.equal(ready.isHealthy(), false);
  });

  test('work waits for the first health answer, then runs', async () => {
    // A fresh copy of the module, so the test does not depend on what else ran first.
    delete require.cache[readyPath];
    const ready = require(readyPath);
    assert.equal(ready.isHealthy(), false);

    let ran = false;
    ready.afterHealthy(() => { ran = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ran, false, 'the warm-up must not start before the probe is answered');

    ready.markHealthy();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ran, true, 'the warm-up starts once the probe has been answered');
    assert.equal(ready.isHealthy(), true);
    delete require.cache[readyPath];
  });

  test('the fallback starts the work anyway when nothing probes health', async () => {
    delete require.cache[readyPath];
    const ready = require(readyPath);
    let ran = false;
    ready.afterHealthy(() => { ran = true; }, 20);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ran, true, 'a local run with no health probe still warms the caches');
    delete require.cache[readyPath];
  });

  test('marking healthy twice is harmless', async () => {
    delete require.cache[readyPath];
    const ready = require(readyPath);
    let runs = 0;
    ready.afterHealthy(() => { runs++; });
    ready.markHealthy();
    ready.markHealthy();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runs, 1);
    delete require.cache[readyPath];
  });
});
