'use strict';
/**
 * Wave 12: a takedown never holds the loop for the length of the library. Phase 1 (takedown row, feed and creator blocks) is one short
 * transaction; the retroactive sweep walks the stored media in seq slices, a transaction each, with its cursor stored, so a restart
 * resumes. Every compliance property of the one-shot version is kept.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let db; let server; let base; let engine; let backup;
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
let n = 0;
const mk = (o = {}) => { n++; return repo.media.insert({ platform: 'web', source_id: `w12-${n}`, source_key: `web:w12-${n}:0`, post_key: `web:w12-${n}`, media_type: 'image', media_url: `https://cdn.w12.example/${n}.jpg`, hash: `w12h${n}`, phash: `${String(n).padStart(32, 'a')}`.slice(-32), title: `title ${n}`, posted_at: new Date().toISOString(), ...o }, []); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const untilDone = async (id) => { for (let i = 0; i < 400; i++) { const j = repo.takedowns.job(id); if (j && j.done) return j; await wait(10); } throw new Error('job did not finish'); };

before(async () => {
  repo = require('../src/db/repo'); db = repo.db; engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

describe('chunked retroactive purge', () => {
  test('phase 1 puts the takedown in place before any row is swept; slices then finish the job', () => {
    const ids = []; for (let i = 0; i < 40; i++) ids.push(mk({ source_url: 'https://gone.w12.example/p/' + i }));
    const keep = mk({ source_url: 'https://fine.w12.example/p/1' });
    const job = repo.takedowns.begin({ kind: 'domain', value: 'gone.w12.example', reason: 'asked' });
    assert.ok(repo.takedowns.find('domain', 'gone.w12.example'), 'the takedown row exists');
    assert.equal(repo.media.get(ids[0]).publish_state, 'published', 'nothing swept yet');
    assert.equal(require('../src/lib/takedowns').checkItem({ source_url: 'https://gone.w12.example/p/new', mediaUrl: 'https://x/y.jpg' }, null, repo.takedowns.all()) ? true : false, true, 'new items are refused from this moment');
    let steps = 0; let r;
    do { r = repo.takedowns.step(job.id, 7); steps++; } while (!r.done && steps < 100);
    assert.ok(steps >= 7, `many small slices (${steps})`);
    for (const id of ids) assert.equal(repo.media.get(id).publish_state, 'removed');
    assert.equal(repo.media.get(keep).publish_state, 'published');
    assert.equal(repo.takedowns.job(job.id).purged, 40);
  });

  test('compliance: hashes and phashes are blocklisted before identifiers are cleared; states and blocks are announced', () => {
    const seen = []; repo.media.onState((id, st) => { if (st === 'removed') seen.push(id); });
    const a = mk({ author: 'w12-compliance-guy' }); const b = mk({ author: 'w12-compliance-guy' });
    const hashes = [db.prepare('SELECT hash, phash FROM media WHERE id = ?').get(a), db.prepare('SELECT hash, phash FROM media WHERE id = ?').get(b)];
    const out = repo.takedowns.add({ kind: 'handle', value: 'w12-compliance-guy', reason: 'creator request' });
    assert.equal(out.purged, 2); assert.equal(out.done, true);
    for (const h of hashes) {
      assert.ok(repo.blocklist.has('hash', h.hash), 'exact hash blocked');
      assert.ok(db.prepare('SELECT 1 FROM phash_blocklist WHERE phash = ?').get(h.phash), 'phash blocked');
    }
    for (const id of [a, b]) {
      const row = db.prepare('SELECT hash, media_url, author, title, phash, publish_state FROM media WHERE id = ?').get(id);
      assert.deepEqual([row.publish_state, row.media_url, row.author, row.title, row.phash], ['removed', '', null, null, null]);
      assert.ok(row.hash.startsWith('purged:'));
      assert.ok(seen.includes(id), 'notifyState ran');
    }
  });

  test('the chunked result equals the one-shot result on the same data (creator takedown with older removed rows)', () => {
    const run = (tag, chunked) => {
      const c = repo.creators.create({ handle: `w12eq${tag}`, origin: 'admin' });
      const own = []; for (let i = 0; i < 25; i++) own.push(mk({ creator_id: c.id, author: `w12eq${tag}` }));
      const old = mk({ creator_id: c.id, author: `w12eq${tag}` }); repo.media.setState(old, 'removed', 'admin'); // an older removed row keeps its hash
      repo.creators.refreshStats(c.id);
      const oldHash = db.prepare('SELECT hash FROM media WHERE id = ?').get(old).hash;
      const out = chunked ? repo.takedowns.finishNow(repo.takedowns.begin({ kind: 'creator', value: c.id, reason: 'x' }).id) : repo.takedowns.add({ kind: 'creator', value: c.id, reason: 'x' });
      void out;
      return { states: own.map((id) => repo.media.get(id).publish_state), old: db.prepare('SELECT hash, media_url FROM media WHERE id = ?').get(old), oldBlocked: repo.blocklist.has('hash', oldHash), status: repo.creators.get(c.id).status, count: repo.creators.get(c.id).media_count };
    };
    const a = run('a', false); const b = run('b', true);
    assert.deepEqual({ ...b, old: { ...b.old, hash: b.old.hash.startsWith('purged:') } }, { ...a, old: { ...a.old, hash: a.old.hash.startsWith('purged:') } });
    assert.equal(a.status, 'blocked'); assert.equal(a.oldBlocked, true); assert.equal(a.count, 0);
  });

  test('progress is readable while it runs; a job interrupted by a restart resumes from its stored cursor', async () => {
    for (let i = 0; i < 60; i++) mk({ source_url: `https://resume.w12.example/p/${i}` });
    const job = repo.takedowns.begin({ kind: 'domain', value: 'resume.w12.example', reason: 'asked' });
    repo.takedowns.step(job.id, 10);
    const mid = repo.takedowns.job(job.id);
    assert.equal(mid.done, false);
    assert.ok(mid.cursor > 0 && mid.scanned > 0, JSON.stringify(mid));
    assert.ok(repo.takedowns.jobs().some((j) => j.jobId === job.id), 'listed as open');
    // "restart": nothing in memory knows this job; resume() reads the stored record
    assert.ok(repo.takedowns.resume() >= 1);
    const end = await untilDone(job.id);
    assert.equal(end.purged, 60);
    assert.ok(!repo.takedowns.jobs().some((j) => j.jobId === job.id), 'closed');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE source_key LIKE 'web:w12-%' AND publish_state != 'removed' AND hash NOT LIKE 'purged:%' AND id IN (SELECT id FROM media WHERE media_url = '')").get().n, 0);
  });
});

describe('admin route', () => {
  test('POST answers with a job id and counts; a small library is finished inside the request', async () => {
    for (let i = 0; i < 5; i++) mk({ source_url: `https://route.w12.example/p/${i}` });
    const r = await fetch(`${base}/api/admin/takedowns`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ kind: 'domain', value: 'route.w12.example', reason: 'asked' }) });
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.ok(j.jobId && j.takedown.id); assert.equal(j.done, true); assert.equal(j.purged, 5);
    const g = await fetch(`${base}/api/admin/takedowns/jobs/${j.jobId}`, { headers: ADMIN });
    assert.equal(g.status, 200); assert.equal((await g.json()).purged, 5);
    assert.equal((await fetch(`${base}/api/admin/takedowns/jobs/nope`, { headers: ADMIN })).status, 404);
    assert.ok(Array.isArray((await (await fetch(`${base}/api/admin/takedowns/jobs`, { headers: ADMIN })).json()).jobs));
  });
  test('a big library returns before the sweep ends, with the counts so far', async () => {
    for (let i = 0; i < 3000; i++) mk({ source_url: `https://big.w12.example/p/${i}` });
    const out = repo.takedowns.start({ kind: 'domain', value: 'big.w12.example', reason: 'asked' }, { budgetMs: 0 });
    assert.equal(out.done, false); assert.ok(out.jobId);
    const end = await untilDone(out.jobId);
    assert.equal(end.purged, 3000);
  });
});

describe('Wave 12 nits', () => {
  const { ipKey } = require('../src/lib/ipkey');
  const { cleanHandle } = require('../src/lib/creator-names');
  test('every spelling of an IPv4-mapped address is that IPv4 address', () => {
    for (const a of ['::ffff:1.2.3.4', '::ffff:102:304', '0:0:0:0:0:ffff:1.2.3.4', '0:0:0:0:0:ffff:102:304', '0000:0000:0000:0000:0000:FFFF:0102:0304', '::FFFF:1.2.3.4']) assert.equal(ipKey(a), '1.2.3.4', a);
    assert.equal(ipKey('::ffff:0:1.2.3.4') === '1.2.3.4', false, 'not the mapped prefix');
    assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), ipKey('2001:db8:1:2::9'));
    assert.match(ipKey('::1'), /::\/64$/);
  });
  test('a handle made only of format characters is empty and refused', () => {
    for (const h of ['‍', '‌‍', '️', '​‍‌', ' ‍ ', '́']) assert.equal(cleanHandle(h), '', JSON.stringify(h));
    assert.equal(cleanHandle('❤️‍🔥'), '❤️‍🔥', 'emoji sequences stay');
    assert.equal(cleanHandle('می‌خواهم'), 'می‌خواهم');
    assert.throws(() => repo.creators.create({ handle: '‍‌', origin: 'admin' }), /needs a handle/);
    assert.throws(() => repo.creators.create({ handle: '', origin: 'admin' }), /needs a handle/);
    assert.ok(repo.creators.create({ handle: 'fine-w12', origin: 'admin' }).id);
  });
});
