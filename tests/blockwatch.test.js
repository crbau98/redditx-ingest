'use strict';
/**
 * The loop watchdog (lib/blockwatch.js): a stall is recorded against the job that was running,
 * which is what makes a multi-second pause in /api/health actionable instead of a bare number.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let blockwatch;

before(() => {
  prepareEnv({ PRISM_SLOW_BLOCK_MS: '60' }); // a 60 ms threshold keeps the test quick
  blockwatch = require('../src/lib/blockwatch');
});
after(() => { blockwatch.stop(); blockwatch.reset(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const block = (ms) => { const end = Date.now(); while (Date.now() - end < ms) { /* busy: this is the stall */ } };

describe('loop watchdog', () => {
  test('a stall is recorded against the job that was running', async () => {
    blockwatch.start();
    blockwatch.reset();
    blockwatch.work('testJob');
    await wait(120); // one full sample window, clean
    block(250);      // the stall
    await wait(400); // let the sampler notice it
    const b = blockwatch.lastBlock();
    assert.ok(b, 'a block was recorded');
    assert.ok(b.ms >= 60, `expected at least the threshold, got ${b.ms}`);
    assert.equal(b.job, 'testJob', 'attributed to the active job');
    assert.ok(b.at, 'and stamped');
    assert.ok(blockwatch.blocks().length >= 1, 'the recent list keeps it too');
    blockwatch.stop();
    blockwatch.work('idle');
    blockwatch.reset();
  });

  test('around() restores the previous label even when the job throws', async () => {
    blockwatch.work('outer');
    await assert.rejects(() => blockwatch.around('inner', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(blockwatch.current(), 'outer', 'the outer label is back after around()');
    blockwatch.work('idle');
    blockwatch.reset();
  });

  test('clean runs record nothing', async () => {
    blockwatch.start();
    blockwatch.reset();
    blockwatch.work('idle');
    await wait(200);
    assert.equal(blockwatch.lastBlock(), null, 'no stall, no warning');
    blockwatch.stop();
    blockwatch.reset();
  });
});