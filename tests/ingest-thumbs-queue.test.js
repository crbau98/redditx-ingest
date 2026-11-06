'use strict';
/**
 * Thumbnails and tints: items whose picture cannot be read right now (a dead host answering 5xx, a timeout) used to stay at the
 * head of the newest-first queue and be retried every minute for ever. With `thumbnailsPerMinute` of them the rest of the library
 * never got a thumbnail.
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { prepareEnv } = require('./helpers/mock');

let repo; let thumbs; let sharp; let GOOD;
const MIN = 60000;

before(async () => {
  prepareEnv();
  repo = require('../src/db/repo');
  thumbs = require('../src/engine/thumbs');
  sharp = require('sharp');
  GOOD = await sharp({ create: { width: 500, height: 300, channels: 3, background: '#336699' } }).jpeg().toBuffer();
});

let n = 0;
function item(url) {
  const id = crypto.randomUUID();
  repo.db.prepare(`INSERT INTO media (id, platform, source_key, post_key, media_type, media_url, hash, publish_state, width, height)
    VALUES (?, 'rss', ?, ?, 'image', ?, ?, 'published', 500, 300)`).run(id, `rss:t${++n}:0`, `rss:t${n}`, url, crypto.createHash('md5').update(url + n).digest('hex'));
  return id;
}
// compare the parsed host, not a URL prefix
const isDead = (url) => new URL(url).hostname === 'dead.example';
const tint = (id) => repo.db.prepare('SELECT tint FROM media WHERE id = ?').get(id).tint;

test('items that keep failing do not hold the queue: the rest of the library is served, and the failing ones are given up on', async () => {
  repo.db.prepare('DELETE FROM media').run();
  const good = [1, 2, 3, 4, 5, 6].map((i) => item(`https://good.example/${i}.jpg`));
  const dead = Array.from({ length: 30 }, (_, i) => item(`https://dead.example/${i}.jpg`)); // newer than the good ones
  const calls = new Map();
  const fetch = async (url) => {
    calls.set(url, (calls.get(url) || 0) + 1);
    if (isDead(url)) throw new Error('http 503');
    return { status: 200, buffer: GOOD };
  };
  let now = Date.now();
  await thumbs.sweep({ limit: 30, fetch, now });
  assert.equal(good.filter((id) => tint(id) === null).length, 6, 'round one: the dead ones took the whole page');
  await thumbs.sweep({ limit: 30, fetch, now });
  for (const id of good) assert.match(tint(id), /^#[0-9a-f]{6}$/, 'round two reaches the readable items behind them');
  const secondRoundDead = [...calls.entries()].filter(([u]) => isDead(u)).map(([, c]) => c);
  assert.ok(secondRoundDead.every((c) => c === 1), 'a failed item waits before it is tried again');

  // time passes: they are retried with growing gaps, then given up on (tint "" = unreadable), never for ever
  for (let i = 0; i < 12; i++) { now += 20 * MIN; await thumbs.sweep({ limit: 30, fetch, now }); }
  for (const id of dead) assert.equal(tint(id), '', 'given up');
  assert.ok([...calls.entries()].filter(([u]) => isDead(u)).every(([, c]) => c <= 4), 'at most four tries each');
  const before = calls.size;
  now += 24 * 60 * MIN;
  const r = await thumbs.sweep({ limit: 30, fetch, now });
  assert.equal(r.checked, 0); assert.equal(calls.size, before);
});

test('a round where nothing at all can be read (the network is down) does not use up anybody\'s tries', async () => {
  repo.db.prepare('DELETE FROM media').run();
  const ids = Array.from({ length: 5 }, (_, i) => item(`https://flaky${i}.example/a.jpg`));
  let up = false; let now = Date.now();
  const fetch = async () => { if (!up) throw new Error('getaddrinfo ENOTFOUND flaky.example'); return { status: 200, buffer: GOOD }; };
  for (let i = 0; i < 8; i++) { now += 60 * MIN; await thumbs.sweep({ limit: 30, fetch, now }); }
  for (const id of ids) assert.equal(tint(id), null, 'still waiting, not given up');
  up = true; now += 60 * MIN;
  await thumbs.sweep({ limit: 30, fetch, now });
  for (const id of ids) assert.match(tint(id), /^#[0-9a-f]{6}$/);
});

test('several dead hosts look like an outage, but their items still WAIT so the ones behind them are served, without spending tries', async () => {
  repo.db.prepare('DELETE FROM media').run();
  const good = [1, 2, 3].map((i) => item(`https://good.example/${i}.jpg`));
  const dead = ['https://expired-a.example/1.jpg', 'https://expired-b.example/2.jpg', 'https://expired-c.example/3.jpg'].map((u) => item(u)); // newer than the good ones
  const fetch = async (url) => { if (/expired/.test(url)) throw new Error('getaddrinfo ENOTFOUND expired.example'); return { status: 200, buffer: GOOD }; };
  const now = Date.now();
  const first = await thumbs.sweep({ limit: 3, fetch, now });
  assert.equal(first.retry, 3, 'the whole page failed: a suspected outage');
  assert.equal(first.given_up, 0, 'and nobody is given up on');
  const second = await thumbs.sweep({ limit: 3, fetch, now });
  for (const id of good) assert.match(tint(id), /^#[0-9a-f]{6}$/, 'the items behind them are served by the next round, not starved');
  assert.equal(second.checked, 3);
  for (const id of dead) assert.equal(tint(id), null, 'the dead ones are still waiting, not given up on');
});

test('an item that sits through many suspected outages is eventually treated as failing for itself', async () => {
  repo.db.prepare('DELETE FROM media').run();
  const dead = ['https://expired-a.example/1.jpg', 'https://expired-b.example/2.jpg', 'https://expired-c.example/3.jpg'].map((u) => item(u));
  const fetch = async () => { throw new Error('getaddrinfo ENOTFOUND expired.example'); };
  let now = Date.now();
  for (let i = 0; i < 40; i++) { now += 60 * MIN; await thumbs.sweep({ limit: 3, fetch, now }); }
  for (const id of dead) assert.equal(tint(id), '', 'given up in the end: the outage rounds are capped');
});

test('a picture that is gone for good (404, not an image) is marked at once, as before', async () => {
  repo.db.prepare('DELETE FROM media').run();
  const gone = item('https://gone.example/a.jpg'); const junk = item('https://junk.example/b.jpg');
  const fetch = async (url) => (url.includes('gone') ? { status: 404, buffer: Buffer.alloc(0) } : { status: 200, buffer: Buffer.from('not an image at all') });
  await thumbs.sweep({ limit: 30, fetch });
  assert.equal(tint(gone), ''); assert.equal(tint(junk), '');
});

test('the work list is read from its partial index (not by sorting every published row), statistics or not', () => {
  repo.db.prepare('DELETE FROM media').run();
  const ins = repo.db.prepare("INSERT INTO media (id, platform, source_key, post_key, media_type, media_url, hash, publish_state, tint) VALUES (?, 'rss', ?, ?, 'image', ?, ?, ?, ?)");
  repo.db.transaction(() => { for (let i = 0; i < 6000; i++) ins.run(`p${i}`, `k${i}`, `k${i}`, `https://x.example/${i}.jpg`, `h${i}`, i % 20 === 0 ? 'review' : 'published', i % 3 ? '#aabbcc' : null); })();
  const plan = () => repo.db.prepare(`EXPLAIN QUERY PLAN ${thumbs.TODO_SQL}`).all(30).map((r) => r.detail).join(' | ');
  assert.match(plan(), /ix_media_tint_todo/); assert.doesNotMatch(plan(), /TEMP B-TREE/);
  repo.db.exec('ANALYZE');
  assert.match(plan(), /ix_media_tint_todo/); assert.doesNotMatch(plan(), /TEMP B-TREE/);
  assert.equal(thumbs.progress().remaining, repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE tint IS NULL AND publish_state = 'published'").get().n);
});
