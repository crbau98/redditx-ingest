'use strict';
/** The three env reads that lived outside config.js go through config getters, read at the same moment as before. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const config = require('../src/config');

test('the getters follow the environment when asked', () => {
  const saved = { a: process.env.DEMO_ART, b: process.env.PRISM_DB_READONLY, c: process.env.PRISM_AGGREGATE_WORKER };
  try {
    delete process.env.DEMO_ART; delete process.env.PRISM_DB_READONLY; delete process.env.PRISM_AGGREGATE_WORKER;
    assert.equal(config.demoArt, false); assert.equal(config.dbReadonly, false); assert.equal(config.aggregateWorker, true);
    process.env.DEMO_ART = '1'; process.env.PRISM_DB_READONLY = '1'; process.env.PRISM_AGGREGATE_WORKER = '0';
    assert.equal(config.demoArt, true); assert.equal(config.dbReadonly, true); assert.equal(config.aggregateWorker, false);
  } finally {
    for (const [k, v] of [['DEMO_ART', saved.a], ['PRISM_DB_READONLY', saved.b], ['PRISM_AGGREGATE_WORKER', saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('app.js, db/index.js and lib/snapshots.js no longer read those variables themselves', () => {
  for (const [f, k] of [['src/app.js', 'DEMO_ART'], ['src/db/index.js', 'PRISM_DB_READONLY'], ['src/lib/snapshots.js', 'PRISM_AGGREGATE_WORKER']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, new RegExp(`process\\.env\\.${k}`), f);
  }
});
