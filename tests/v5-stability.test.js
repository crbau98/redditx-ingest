'use strict';
/**
 * Stability: inputs that used to throw inside a socket callback (an uncaught exception takes the whole server down) now
 * fail just the one request, and the health check reports memory and event-loop delay.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
process.env.IMAGE_WORKERS = '1';
process.env.IMAGE_WORKER_RECYCLE = '3';
const { prepareEnv } = require('./helpers/mock');

const haveModel = (() => { try { require.resolve('sharp'); require.resolve('@tensorflow/tfjs-backend-wasm'); return fs.existsSync(path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'assets', 'screenshot-faceid.jpg')); } catch { return false; } })();
let server; let base; let net;
before(async () => {
  prepareEnv();
  net = require('../src/lib/net');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('a malformed redirect Location rejects the request instead of crashing the process', async () => {
  const up = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://[not-a-host/x' }); res.end(); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  let crashed = null;
  const onCrash = (e) => { crashed = e; };
  process.once('uncaughtException', onCrash);
  try {
    await assert.rejects(() => net.open(`http://127.0.0.1:${up.address().port}/`), /Invalid redirect/);
    await new Promise((r) => setImmediate(r));
    assert.equal(crashed, null);
  } finally { process.removeListener('uncaughtException', onCrash); up.close(); }
});

test('health reports memory and event-loop delay', async () => {
  const res = await fetch(`${base}/api/health`);
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.ok(j.memMb.rss > 0 && j.memMb.heap > 0);
  assert.ok(Number.isFinite(j.loop.p99Ms) && Number.isFinite(j.loop.maxMs));
});

test('a worker is swapped for a fresh one after IMAGE_WORKER_RECYCLE pictures, without losing any picture', { skip: !haveModel && 'image model not installed' }, async () => {
  const imagefilter = require('../src/lib/imagefilter');
  const img = fs.readFileSync(path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'assets', 'screenshot-faceid.jpg'));
  await imagefilter.init();
  try {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(await imagefilter.readBuffer(img, { hash: false }));
    assert.ok(out.every((r) => r.status === 'ok'), JSON.stringify(out.map((r) => r.reason || r.status)));
    assert.ok(imagefilter.status().recycled >= 2, `recycled ${imagefilter.status().recycled}`);
    for (let i = 0; i < 100 && imagefilter.status().workers !== 1; i++) await new Promise((r) => setTimeout(r, 50)); // the old one exits
    assert.equal(imagefilter.status().workers, 1);
  } finally { await imagefilter.shutdown(); }
});

test('memory watchdog: refreshes the image workers at the soft limit (once per 10 min) and restarts at the hard limit', () => {
  const memwatch = require('../src/engine/memwatch');
  const prev = { s: process.env.MEM_SOFT_MB, h: process.env.MEM_HARD_MB };
  process.env.MEM_SOFT_MB = '1000'; process.env.MEM_HARD_MB = '2000';
  try {
    memwatch._reset();
    let recycled = 0; let critical = 0; let t = 1e12;
    const opts = (rssMb) => ({ rss: () => rssMb * 1048576, recycle: () => { recycled++; }, onCritical: () => { critical++; }, now: () => t });
    assert.equal(memwatch.check(opts(500)), null);
    assert.equal(memwatch.check(opts(1200)), 'soft');
    assert.equal(memwatch.check(opts(1300)), null, 'not again within 10 minutes');
    t += 11 * 60000;
    assert.equal(memwatch.check(opts(1300)), 'soft');
    assert.equal(memwatch.check(opts(2100)), 'hard');
    assert.equal(recycled, 2); assert.equal(critical, 1);
    const lim = memwatch.limits();
    assert.equal(lim.soft, 1000 * 1048576); assert.equal(lim.hard, 2000 * 1048576);
  } finally {
    for (const [k, v] of [['MEM_SOFT_MB', prev.s], ['MEM_HARD_MB', prev.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
