'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let engine; let backup; let cache; let sharp; let markBox;
const AGE = { cookie: 'prism_age=1' };
const IMG = 'https://i.redd.it/prism-watermark-test.png';

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  cache = require('../src/lib/media-cache'); sharp = require('sharp'); ({ markBox } = require('../src/lib/watermark'));
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });

const raw = async (buf) => sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const fetchBytes = async (path) => {
  const res = await fetch(`${base}${path}`, { headers: AGE });
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('x-cache'), buf: Buffer.from(await res.arrayBuffer()) };
};

describe('downloads carry the PRISM mark; viewing does not', () => {
  let source;
  before(async () => {
    // A demo-sized picture: a gradient, so the mark box has something to differ from.
    source = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#2a6fdb' } })
      .composite([{ input: Buffer.from('<svg width="600" height="400"><rect width="600" height="200" fill="#e4572e"/></svg>'), top: 0, left: 0 }])
      .png().toBuffer();
    assert.ok(cache.put, 'media cache is available');
    cache.put(IMG, source, 'image/png');
  });

  test('the marked download is a valid image of the same size', async () => {
    const r = await fetchBytes(`/api/proxy?url=${encodeURIComponent(IMG)}&mark=prism`);
    assert.equal(r.status, 200);
    assert.equal(r.type, 'image/png');
    const meta = await sharp(r.buf).metadata();
    assert.equal(meta.width, 600); assert.equal(meta.height, 400);
  });

  test('inside the mark box the pixels differ; everywhere else they are identical', async () => {
    const r = await fetchBytes(`/api/proxy?url=${encodeURIComponent(IMG)}&mark=prism`);
    const plain = await fetchBytes(`/api/proxy?url=${encodeURIComponent(IMG)}`);
    assert.equal(plain.buf.equals(source), true, 'the normal serve is the original file, untouched');
    const a = await raw(source); const b = await raw(r.buf);
    const box = markBox(600, 400);
    let inside = 0; let outsideDiff = 0;
    for (let y = 0; y < 400; y++) for (let x = 0; x < 600; x++) {
      const i = (y * 600 + x) * 3;
      const diff = a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2];
      const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      if (inBox && diff) inside++;
      if (!inBox && diff) outsideDiff++;
    }
    assert.ok(inside > box.w * box.h * 0.3, `mark box changed on ${inside} of ${box.w * box.h} pixels`);
    assert.equal(outsideDiff, 0, 'nothing outside the mark box is changed');
  });

  test('the marked copy is cached under its own key', async () => {
    await fetchBytes(`/api/proxy?url=${encodeURIComponent(IMG)}&mark=prism`);
    const again = await fetchBytes(`/api/proxy?url=${encodeURIComponent(IMG)}&mark=prism`);
    assert.equal(again.cache, 'HIT');
  });

  test('a non-image is refused rather than passed through', async () => {
    cache.put('https://i.redd.it/not-an-image.png', Buffer.from('<html>'.repeat(60)), 'image/png');
    const r = await fetchBytes(`/api/proxy?url=${encodeURIComponent('https://i.redd.it/not-an-image.png')}&mark=prism`);
    assert.equal(r.status, 502);
  });
});
