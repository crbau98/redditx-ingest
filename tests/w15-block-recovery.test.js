'use strict';
/** Recovering a creator the system blocked on a wrong AUTOMATIC SCOPE block (Bigggwild 2026-11-17, Christian Hogue 2026-11-10). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let rec; let server; let base;
before(async () => {
  repo = require('../src/db/repo'); rec = require('../src/engine/block-recovery');
  server = require('../src/app').createApp().listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { require('../src/engine/engine').shutdown(); await new Promise((r) => server.close(r)); });

const REASON = 'scope:female:girl (profile)';
let n = 0;
const call = async (method, path, body) => { const res = await fetch(`${base}${path}`, { method, headers: { 'x-admin-key': 'test-key', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json() }; };
const hex = (k) => k.toString(16).padStart(32, '0');

/** A creator with an admin feed, an older productive automatic feed, a just-attached automatic feed (the suspect) and `rows` published items. */
function scenario({ rows = 5, suspects = 1, reason = REASON, actor = 'system', block = true, extra = null } = {}) {
  n++;
  const h = `recman${n}`;
  const c = repo.creators.create({ handle: h, displayName: h, origin: 'admin' });
  const mkFeed = (platform, kind, target, origin, items, createdAt) => {
    const f = repo.feeds.upsert({ platform, kind, target, creatorId: c.id, origin, runNow: false }).feed;
    repo.db.prepare('UPDATE feeds SET items_total = ?, origin = ?, enabled = 1, cursor = ? WHERE id = ?').run(items, origin, JSON.stringify({ newestAt: 'x', bfPage: 4 }), f.id);
    if (createdAt) repo.db.prepare('UPDATE feeds SET created_at = ? WHERE id = ?').run(createdAt, f.id);
    return f;
  };
  const own = mkFeed('coomer', 'user', `onlyfans/${h}`, 'admin', 40, '2026-01-01T00:00:00.000Z');
  const older = mkFeed('bluesky', 'user', `${h}.bsky.social`, 'discovered', 20, '2026-01-02T00:00:00.000Z');
  const sus = [];
  for (let i = 0; i < suspects; i++) sus.push(mkFeed('web', 'page', `https://leaks${i}.example/${h}`, 'deep-search', 0));
  const ids = []; const hashes = []; const phashes = []; const keys = [];
  for (let i = 0; i < rows; i++) {
    const hash = `rechash${n}x${i}`; const phash = hex(n * 1000 + i); const key = `coomer:rec${n}x${i}:0`;
    ids.push(repo.media.insert({ creator_id: c.id, feed_id: own.id, platform: 'coomer', source_id: `rec${n}x${i}`, source_key: key, post_key: `coomer:rec${n}x${i}`, hash, phash, media_type: 'image', media_url: `https://cdn.example/r${n}x${i}.jpg`, title: `t${i}` }));
    hashes.push(hash); phashes.push(phash); keys.push(key);
  }
  if (extra) extra({ c, own, older, sus, ids });
  if (block) repo.creators.block(c.id, reason, actor);
  return { c, h, own, older, sus, ids, hashes, phashes, keys };
}
const enabled = (id) => repo.feeds.get(id).enabled;

test('the dry run shows exactly what the block did and what would be undone, and changes nothing', () => {
  const s = scenario({ rows: 5, suspects: 1 });
  assert.equal(repo.creators.get(s.c.id).status, 'blocked');
  const d = rec.dryRun(s.c.id);
  assert.equal(d.eligible, true, JSON.stringify(d.refusals));
  assert.equal(d.blockedBy.actor, 'system'); assert.equal(d.blockedBy.reason, REASON);
  assert.equal(d.plan.rowsToDelete, 5);
  assert.deepEqual(d.plan.blocklist, { creatorEntry: 1, hashEntries: 5, phashEntries: 5, feedAccountEntries: 2, keptAccountEntries: [`web:https://leaks0.example/${s.h}`], anchorFound: true });
  assert.equal(d.evidence.pinned, true); assert.equal(d.evidence.suspects[0].id, s.sus[0].id);
  assert.deepEqual(d.plan.feedsToReenable.map((f) => f.id).sort(), [s.own.id, s.older.id].sort());
  assert.equal(d.plan.feedsLeftOff.length, 1); assert.match(d.plan.feedsLeftOff[0].why, /suspect/);
  assert.equal(repo.creators.get(s.c.id).status, 'blocked', 'a dry run changes nothing');
  assert.equal(repo.blocklist.has('creator', s.c.id), true);
});

test('apply: creator active, his rows deleted so the posts can be re-ingested, his blocklist entries gone, the suspect stays off and blocklisted, feeds restart from scratch', () => {
  const s = scenario({ rows: 5, suspects: 1 });
  assert.equal(repo.media.insert({ creator_id: s.c.id, platform: 'coomer', source_key: s.keys[0], hash: 'x-conflict', media_type: 'image', media_url: 'https://cdn.example/x.jpg', title: 't' }), null, 'before: the purged row keeps source_key, so a re-ingest is refused');
  const out = rec.apply(s.c.id);
  assert.equal(out.applied, true);
  assert.deepEqual(out.counts, { rowsDeleted: 5, creatorEntry: 1, hashEntries: 5, phashEntries: 5, feedAccountEntries: 2, feedsReenabled: 2 });
  assert.equal(repo.creators.get(s.c.id).status, 'active');
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE creator_id = ?").get(s.c.id).n, 0);
  assert.equal(repo.blocklist.has('creator', s.c.id), false);
  for (const hsh of s.hashes) assert.equal(repo.blocklist.has('hash', hsh), false);
  for (const ph of s.phashes) assert.equal(repo.db.prepare('SELECT 1 AS ok FROM phash_blocklist WHERE phash = ?').get(ph), undefined);
  assert.equal(repo.blocklist.has('creator', `coomer:onlyfans/${s.h}`), false); assert.equal(repo.blocklist.has('creator', `bluesky:${s.h}.bsky.social`), false);
  assert.equal(repo.blocklist.has('creator', `web:https://leaks0.example/${s.h}`), true, 'the suspect account stays blocklisted');
  assert.equal(enabled(s.own.id), 1); assert.equal(enabled(s.older.id), 1); assert.equal(enabled(s.sus[0].id), 0);
  const f = repo.feeds.get(s.own.id); assert.equal(f.cursor, null, 'backfill from scratch'); assert.ok(f.next_run_at);
  assert.ok(repo.media.insert({ creator_id: s.c.id, platform: 'coomer', source_key: s.keys[0], hash: 'x-reingest', media_type: 'image', media_url: 'https://cdn.example/x.jpg', title: 't' }), 'after: the same post can be imported again');
  const acts = repo.db.prepare("SELECT action, actor FROM moderation_actions WHERE target_type = 'creator' AND target_id = ?").all(s.c.id).map((a) => a.action);
  assert.ok(acts.includes('recover-block'));
  assert.equal(rec.apply(s.c.id).applied, false, 'a second apply is refused: he is no longer blocked');
});

test('the blocklist entries of OTHER creators with the same reason text are untouched (found by position, not by reason)', () => {
  const before = scenario({ rows: 3 }); const mid = scenario({ rows: 4 }); const after = scenario({ rows: 3 });
  const out = rec.apply(mid.c.id);
  assert.equal(out.counts.hashEntries, 4); assert.equal(out.counts.phashEntries, 4);
  for (const o of [before, after]) {
    assert.equal(repo.blocklist.has('creator', o.c.id), true); assert.equal(repo.creators.get(o.c.id).status, 'blocked');
    for (const hsh of o.hashes) assert.equal(repo.blocklist.has('hash', hsh), true, 'their hash entries stay');
    for (const ph of o.phashes) assert.ok(repo.db.prepare('SELECT 1 AS ok FROM phash_blocklist WHERE phash = ?').get(ph));
  }
});

test('several automatic feeds attached just before the block: none can be pinned, all stay off and blocklisted; none: a human must confirm', () => {
  const many = scenario({ suspects: 2 });
  const d = rec.dryRun(many.c.id);
  assert.equal(d.evidence.pinned, false); assert.equal(d.evidence.suspects.length, 2); assert.match(d.evidence.note, /cannot be pinned/);
  assert.equal(d.plan.blocklist.keptAccountEntries.length, 2);
  rec.apply(many.c.id);
  for (const f of many.sus) { assert.equal(enabled(f.id), 0); assert.equal(repo.blocklist.has('creator', `web:${f.target.toLowerCase()}`), true); }
  const none = scenario({ suspects: 0 });
  const dn = rec.dryRun(none.c.id);
  assert.equal(dn.eligible, true); assert.match(dn.evidence.note, /own profile or feed/);
});

test('REFUSED: a block by an admin, a block that is not a scope rule, a takedown, a report, media removed under a takedown, a creator that is not blocked', () => {
  const refusedFor = (s) => { const d = rec.dryRun(s.c.id); assert.equal(d.eligible, false); const out = rec.apply(s.c.id); assert.equal(out.applied, false); assert.equal(repo.creators.get(s.c.id).status === 'blocked' || s.notBlocked, true); return d.refusals.join(' | '); };
  assert.match(refusedFor(scenario({ actor: 'admin' })), /made by admin/);
  assert.match(refusedFor(scenario({ reason: 'safety:kid (profile)' })), /not a scope rule/);
  assert.match(refusedFor(scenario({ reason: 'image filter: 3 pictures with women' })), /not a scope rule/);
  assert.match(refusedFor(scenario({ reason: 'report:spam' })), /not a scope rule/);
  const td = scenario(); repo.db.prepare("INSERT INTO takedowns (kind, value, reason) VALUES ('handle', ?, 'x')").run(td.h);
  assert.match(refusedFor(td), /takedown/);
  const tc = scenario(); repo.db.prepare("INSERT INTO takedowns (kind, value, reason) VALUES ('creator', ?, 'x')").run(tc.c.id);
  assert.match(refusedFor(tc), /takedown/);
  const rp = scenario(); repo.db.prepare("INSERT INTO reports (id, creator_id, kind) VALUES (?, ?, 'other')").run(`rp${n}`, rp.c.id);
  assert.match(refusedFor(rp), /report/);
  const tm = scenario({ extra: ({ ids }) => repo.db.prepare("UPDATE media SET review_reason = 'takedown: dmca' WHERE id = ?").run(ids[0]) });
  assert.match(refusedFor(tm), /takedown/);
  const live = scenario({ block: false }); const dl = rec.dryRun(live.c.id);
  assert.equal(dl.eligible, false); assert.match(dl.refusals.join(), /not blocked/);
  assert.equal(rec.apply(live.c.id).applied, false);
});

test('rows removed for a takedown or safety reason, and feeds an admin or a sweep switched off, are not brought back', () => {
  const s = scenario({ rows: 4, extra: ({ c, own, ids }) => {
    repo.db.prepare("UPDATE media SET publish_state = 'removed', review_reason = 'safety:minor' WHERE id = ?").run(ids[0]);
    const adm = repo.feeds.upsert({ platform: 'redgifs', kind: 'user', target: `admoff${n}`, creatorId: c.id, origin: 'admin', runNow: false }).feed;
    repo.db.prepare('UPDATE feeds SET items_total = 9 WHERE id = ?').run(adm.id);
    repo.feeds.update(adm.id, { enabled: false }); repo.logAction('feed', adm.id, 'disable', 'admin', 'admin');
  } });
  const d = rec.dryRun(s.c.id);
  assert.equal(d.plan.rowsToDelete, 3); assert.equal(d.plan.rowsKept.safety, 1);
  assert.ok(d.plan.feedsLeftOff.some((f) => /last action: disable/.test(f.why)));
  rec.apply(s.c.id);
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE creator_id = ? AND review_reason = 'safety:minor'").get(s.c.id).n, 1, 'the safety-removed row stays');
});

test('candidates: system scope blocks only; an automatic feed attached just before the block marks the likely false ones', () => {
  const falsy = scenario({ suspects: 1 }); const genuine = scenario({ suspects: 0 });
  const adm = scenario({ actor: 'admin' }); const safe = scenario({ reason: 'safety:kid (profile)' });
  const r = rec.candidates({ limit: 1000 });
  const by = Object.fromEntries(r.items.map((x) => [x.creatorId, x]));
  assert.equal(by[falsy.c.id].likelyFalse, true); assert.equal(by[falsy.c.id].evidenceFrom, 'automatic feed'); assert.equal(by[falsy.c.id].suspects[0].id, falsy.sus[0].id);
  assert.equal(by[genuine.c.id].likelyFalse, false); assert.equal(by[genuine.c.id].evidenceFrom, 'own profile or feed');
  assert.ok(!by[adm.c.id] && !by[safe.c.id]);
  assert.ok(r.likelyFalse >= 1);
  assert.ok(r.items.findIndex((x) => x.creatorId === falsy.c.id) < r.items.findIndex((x) => x.creatorId === genuine.c.id), 'likely false first');
  assert.equal(by[falsy.c.id].rowsRemovedByBlock, 5);
  assert.equal(by[falsy.c.id].call, `GET /api/admin/creators/${falsy.c.id}/recover-block`);
  const td = scenario(); repo.db.prepare("INSERT INTO takedowns (kind, value, reason) VALUES ('handle', ?, 'x')").run(td.h);
  const rr = rec.candidates({ limit: 1000 }).items.find((x) => x.creatorId === td.c.id);
  assert.equal(rr.recoverable, false); assert.equal(rr.call, null);
});

test('admin routes: GET is a dry run, POST without apply is a dry run, POST ?apply=1 applies, a refused apply is 409; candidates; admin only', async () => {
  const s = scenario({ suspects: 1 });
  assert.equal((await fetch(`${base}/creators/${s.c.id}/recover-block`)).status, 401);
  assert.equal((await call('GET', '/creators/nope/recover-block')).status, 404);
  const g = await call('GET', `/creators/${s.c.id}/recover-block`);
  assert.equal(g.status, 200); assert.equal(g.body.eligible, true); assert.equal(repo.creators.get(s.c.id).status, 'blocked');
  const p0 = await call('POST', `/creators/${s.c.id}/recover-block`);
  assert.equal(p0.status, 200); assert.equal(p0.body.applied, undefined); assert.equal(repo.creators.get(s.c.id).status, 'blocked');
  const p1 = await call('POST', `/creators/${s.c.id}/recover-block?apply=1`);
  assert.equal(p1.status, 200); assert.equal(p1.body.applied, true); assert.equal(p1.body.counts.rowsDeleted, 5); assert.equal(repo.creators.get(s.c.id).status, 'active');
  const bad = scenario({ actor: 'admin' });
  const p2 = await call('POST', `/creators/${bad.c.id}/recover-block?apply=1`);
  assert.equal(p2.status, 409); assert.equal(p2.body.applied, false); assert.equal(repo.creators.get(bad.c.id).status, 'blocked');
  const cand = await call('GET', '/creators/recover-block/candidates');
  assert.equal(cand.status, 200); assert.ok(Array.isArray(cand.body.items));
  assert.equal((await fetch(`${base}/creators/recover-block/candidates`)).status, 401);
});
