'use strict';
/** Crucible v4.23.1 gate on recover-block: a neighbour's blocklist entries, candidates() cost, hold dedupe, physique resume, current-block evidence. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const rec = require('../src/engine/block-recovery');
const { applyProfile } = require('../src/engine/creators');
const settingsStore = require('../src/settings');
const REASON = 'scope:female:girl (profile)';
let n = 0; let mediaN = 0;
const hex = (k) => k.toString(16).padStart(32, '0');

function creator(origin = 'ingest') { n++; return repo.creators.create({ handle: `hard${n}`, displayName: `hard${n}`, origin }); }
function feed(c, platform, kind, target, origin, items = 5) {
  const f = repo.feeds.upsert({ platform, kind, target, creatorId: c.id, origin, runNow: false }).feed;
  repo.db.prepare('UPDATE feeds SET items_total = ?, enabled = 1, origin = ? WHERE id = ?').run(items, origin, f.id); return repo.feeds.get(f.id);
}
/** `k` published rows with a hash and a phash of their own (prefix keeps them identifiable), then the block. */
function blockedMan(k, { origin = 'seed', reason = REASON, actor = 'system', keptSafety = 0 } = {}) {
  const c = creator(origin); const own = feed(c, 'coomer', 'user', `onlyfans/hard${n}`, 'admin', 40);
  const hashes = []; const phashes = [];
  for (let i = 0; i < k + keptSafety; i++) {
    mediaN++; const hash = `hh${n}x${i}`; const phash = `${hex(n * 100000 + i)}`;
    const id = repo.media.insert({ creator_id: c.id, feed_id: own.id, platform: 'coomer', source_id: `hd${mediaN}`, source_key: `coomer:hd${mediaN}:0`, post_key: `coomer:hd${mediaN}`, hash, phash, media_type: 'image', media_url: `https://cdn.example/hd${mediaN}.jpg`, title: 't' });
    if (i >= k) repo.db.prepare("UPDATE media SET publish_state = 'removed', review_reason = 'safety:minor' WHERE id = ?").run(id); // removed earlier, for a safety reason
    hashes.push(hash); phashes.push(phash);
  }
  repo.creators.block(c.id, reason, actor);
  return { c, own, hashes, phashes };
}
const phashesLeft = (list) => list.filter((p) => repo.db.prepare('SELECT 1 AS ok FROM phash_blocklist WHERE phash = ?').get(p)).length;
const hashesLeft = (list) => list.filter((h) => repo.blocklist.has('hash', h)).length;
const dropTrace = (creatorId) => repo.db.prepare("DELETE FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'entries-trace'").run(creatorId);

test('MAJOR 1 (traced blocks): recovering one creator removes exactly his hash and phash entries, never the next creator\'s, at 3, 20, 100 and 400 rows', () => {
  for (const k of [3, 20, 100, 400]) {
    const a = blockedMan(k); const b = blockedMan(k);                       // blocked back to back, same reason, same millisecond range
    const d = rec.dryRun(a.c.id);
    assert.equal(d.plan.blocklist.method, 'trace');
    assert.equal(d.plan.blocklist.hashEntries, k); assert.equal(d.plan.blocklist.phashEntries, k, `${k}: exactly his phashes`);
    assert.ok(d.plan.blocklist.phashEntries <= d.plan.rowsToDelete, 'a block cannot have written more phash entries than he had rows');
    const out = rec.apply(a.c.id);
    assert.equal(out.counts.hashEntries, k); assert.equal(out.counts.phashEntries, k);
    assert.equal(phashesLeft(a.phashes), 0); assert.equal(hashesLeft(a.hashes), 0);
    assert.equal(phashesLeft(b.phashes), k, `${k}: the neighbour's phash entries all stay`); assert.equal(hashesLeft(b.hashes), k);
    assert.equal(repo.blocklist.has('creator', b.c.id), true); assert.equal(repo.creators.get(b.c.id).status, 'blocked');
  }
});

test('MAJOR 1 (blocks without a trace, made before v4.23.1): the neighbour\'s entries are never removed; shared-millisecond phash entries stay and are said so', () => {
  for (const k of [3, 20, 100]) {
    const a = blockedMan(k); const b = blockedMan(k); const c3 = blockedMan(k);
    for (const x of [a, b, c3]) dropTrace(x.c.id);
    const d = rec.dryRun(b.c.id);                                       // the middle one: neighbours on both sides
    assert.equal(d.plan.blocklist.method, 'position');
    assert.equal(d.plan.blocklist.hashEntries, k, 'the hash run is exact: a neighbour\'s run is split off by its own creator entry');
    assert.ok(d.plan.blocklist.phashEntries <= d.plan.rowsToDelete, `${k}: phashEntries ${d.plan.blocklist.phashEntries} <= rows ${d.plan.rowsToDelete}`);
    rec.apply(b.c.id);
    assert.equal(phashesLeft(a.phashes), k, 'the block before it keeps every phash entry'); assert.equal(phashesLeft(c3.phashes), k, 'the block after it keeps every phash entry');
    assert.equal(hashesLeft(a.hashes), k); assert.equal(hashesLeft(c3.hashes), k);
    assert.ok(phashesLeft(b.phashes) >= 0 && phashesLeft(b.phashes) <= k);
    if (phashesLeft(b.phashes) > 0) assert.match(d.plan.blocklist.note || '', /left in place/, 'leftovers are reported, not silent');
  }
});

test('when rows of his were removed earlier for a safety reason, the hash and phash entries stay (the block may be their only record)', () => {
  const s = blockedMan(5, { keptSafety: 2 });
  const d = rec.dryRun(s.c.id);
  assert.equal(d.plan.rowsKept.safety, 2); assert.equal(d.plan.blocklist.hashEntries, 0); assert.equal(d.plan.blocklist.phashEntries, 0);
  assert.match(d.plan.blocklist.note, /safety or female reason/);
  const out = rec.apply(s.c.id);
  assert.equal(out.applied, true); assert.equal(hashesLeft(s.hashes), 7); assert.equal(phashesLeft(s.phashes), 7);
  assert.equal(repo.creators.get(s.c.id).status, 'active');
});

test('a block writes an entries-trace whose ranges cover exactly its blocklist and phash rows', () => {
  const before = { b: repo.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM blocklist').get().m, p: repo.db.prepare('SELECT COALESCE(MAX(rowid),0) AS m FROM phash_blocklist').get().m };
  const s = blockedMan(6);
  const t = JSON.parse(repo.db.prepare("SELECT reason FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'entries-trace'").get(s.c.id).reason);
  assert.equal(t.b[0], before.b); assert.equal(t.p[0], before.p);
  const inRange = repo.db.prepare('SELECT type, value FROM blocklist WHERE id > ? AND id <= ?').all(t.b[0], t.b[1]);
  assert.equal(inRange.length, 6 + 1 + 1, '6 hashes + the creator id + his one feed account: nothing foreign in range');
  assert.equal(inRange.filter((r) => r.type === 'hash').length, 6); assert.ok(inRange.some((r) => r.type === 'creator' && r.value === s.c.id.toLowerCase()));
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM phash_blocklist WHERE rowid > ? AND rowid <= ?').get(t.p[0], t.p[1]).n, 6);
});

test('NIT 8: the evidence is that of the CURRENT block: a genuine re-block from his own feed refuses; an old suspect window cannot make it recoverable', () => {
  const c = creator('discovered'); const own = feed(c, 'bluesky', 'user', `hardown${n}.bsky.social`, 'ingest'); const auto = feed(c, 'web', 'page', `https://thefap.example/${n}`, 'deep-search', 0);
  repo.creators.block(c.id, REASON, 'system'); require('../src/lib/quarantine').recordEvidenceFeed(c.id, auto);
  const d1 = rec.dryRun(c.id);
  assert.equal(d1.eligible, true); assert.equal(d1.evidence.source, 'recorded'); assert.deepEqual(d1.evidence.suspects.map((x) => x.id), [auto.id]);
  assert.equal(rec.apply(c.id).applied, true);
  // later: his OWN feed carries female profile text and blocks him genuinely (the automatic feed is still within 15 minutes of that)
  applyProfile(repo.feeds.get(own.id), { displayName: 'Jess', bio: 'she/her. girl next door' }, settingsStore.get());
  assert.equal(repo.creators.get(c.id).status, 'blocked');
  const d2 = rec.dryRun(c.id);
  assert.equal(d2.eligible, false, 'recover-block refuses: this block came from his own feed');
  assert.match(d2.refusals.join(' | '), /no automatic feed supplied the evidence of this block/);
  assert.equal(d2.evidence.source, 'recorded'); assert.deepEqual(d2.evidence.suspects, []); assert.equal(d2.evidence.ownFeedsWithEvidence[0].id, own.id);
  assert.equal(rec.apply(c.id).applied, false);
  // an admin-followed creator in the same situation is only a REVIEW, never an automatic recommendation
  const a = creator('admin'); const aown = feed(a, 'bluesky', 'user', `hardadm${n}.bsky.social`, 'admin'); feed(a, 'web', 'page', `https://thefap.example/a${n}`, 'deep-search', 0);
  applyProfile(repo.feeds.get(aown.id), { displayName: 'Jess', bio: 'she/her. girl' }, settingsStore.get());
  assert.equal(repo.creators.get(a.id).status, 'blocked');
  return rec.candidates({}).then((r) => { const x = r.items.find((i) => i.creatorId === a.id); assert.equal(x.recommendation, 'review'); assert.equal(x.evidence.source, 'recorded'); });
});

test('a feed attached AFTER the latest block cannot be its evidence', () => {
  const c = creator('discovered'); feed(c, 'bluesky', 'user', `hardlate${n}.bsky.social`, 'ingest');
  repo.creators.block(c.id, REASON, 'system');
  feed(c, 'web', 'page', `https://late.example/${n}`, 'deep-search', 0);
  repo.db.prepare("UPDATE feeds SET created_at = ? WHERE creator_id = ? AND origin = 'deep-search'").run(new Date(Date.now() + 60000).toISOString(), c.id);
  const d = rec.dryRun(c.id);
  assert.equal(d.eligible, false); assert.deepEqual(d.evidence.suspects, []);
});

test('MAJOR 3: candidates() aggregates the strikes once and yields to the event loop (1,500 blocked creators, 20,000 strikes)', async () => {
  const db = repo.db; const ids = [];
  db.transaction(() => {
    for (let i = 0; i < 1500; i++) {
      n++; const c = repo.creators.create({ handle: `perf${n}`, displayName: `perf${n}`, origin: 'seed' }); ids.push(c.id);
      repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: `perf${n}.bsky.social`, creatorId: c.id, origin: 'discovered', runNow: false });
      db.prepare("UPDATE creators SET status = 'blocked' WHERE id = ?").run(c.id);
      repo.logAction('creator', c.id, 'block', 'image filter: 3 pictures with women', 'system');
    }
    for (let i = 0; i < 20000; i++) repo.logAction('account', `bluesky:strikeacct${i % 4000}`, 'image-female', 'picture shows a woman', 'system');
  })();
  const realPrepare = db.prepare.bind(db); let strikeQueries = 0;
  db.prepare = (sql) => { if (/image-female/.test(sql)) strikeQueries++; return realPrepare(sql); };
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1);
  const t0 = Date.now(); let r;
  try { r = await rec.candidates({ limit: 5000 }); } finally { db.prepare = realPrepare; clearInterval(timer); }
  const ms = Date.now() - t0;
  assert.ok(r.total >= 1500);
  assert.ok(strikeQueries <= 2, `the strike table is read once, not per creator (${strikeQueries} reads)`);
  assert.ok(ms < 8000, `1,500 creators took ${ms} ms (was 19 s with the per-creator scan)`);
  assert.ok(ticks > 3, `the event loop got ${ticks} turns during the run`);
});

test('NIT 4: a second automatic page tripping the safety rule while a hold\'s review entry is OPEN adds no second report and no second hold; after it is resolved, a new trip is a new hold', () => {
  const { checkText } = require('../src/lib/safety');
  const word = ['schoolboy', 'underage', 'teen', 'minor', 'child', 'kid'].find((w) => checkText(`a ${w}`, '').level === 'block' || checkText(w, '').level === 'block');
  assert.ok(word);
  const profile = { displayName: 'Some Page', bio: `${word} content` };
  const c = creator('admin'); const p1 = feed(c, 'web', 'page', `https://hold1.example/${n}`, 'deep-search', 0); const p2 = feed(c, 'web', 'page', `https://hold2.example/${n}`, 'deep-search', 0); const p3 = feed(c, 'web', 'page', `https://hold3.example/${n}`, 'deep-search', 0);
  const holds = () => repo.db.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'safety-hold'").get(c.id).n;
  const reports = () => repo.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE creator_id = ? AND status = 'open'").get(c.id).n;
  applyProfile(repo.feeds.get(p1.id), profile, settingsStore.get());
  assert.equal(holds(), 1); assert.equal(reports(), 1); assert.equal(repo.creators.get(c.id).status, 'hidden');
  repo.creators.update(c.id, { status: 'active' });                         // a human restores him but has not resolved the report
  applyProfile(repo.feeds.get(p2.id), profile, settingsStore.get());
  assert.equal(holds(), 1, 'no second hold'); assert.equal(reports(), 1, 'no second open report');
  assert.equal(repo.feeds.get(p2.id).enabled, 0, 'the second page is still quarantined');
  assert.equal(repo.creators.get(c.id).status, 'active', 'the human\'s restore stands while the review is open');
  const rid = repo.db.prepare("SELECT id FROM reports WHERE creator_id = ? AND status = 'open'").get(c.id).id;
  repo.reports.resolve(rid, 'resolved', 'looked, page problem', 'admin');
  applyProfile(repo.feeds.get(p3.id), profile, settingsStore.get());
  assert.equal(holds(), 2, 'a trip after the human decided is a new hold'); assert.equal(reports(), 1); assert.equal(repo.creators.get(c.id).status, 'hidden');
});

test('NIT 6: the body filter switching off resumes only feeds that revive\'s checks allow: a blocklisted or taken-down account stays off, a clean one runs again', () => {
  const physique = require('../src/engine/physique');
  settingsStore.update({ physiqueFilter: true });
  try {
    const ok = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'superchubs_ok', enabled: 1, trusted: 1, origin: 'import' });
    const blocked = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'superchubs_blocked', enabled: 1, trusted: 1, origin: 'import' });
    const failing = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'superchubs_failing', enabled: 1, trusted: 1, origin: 'import' });
    for (const r of [ok, blocked, failing]) assert.equal(physique.screenFeed(r), true);
    repo.blocklist.add('creator', 'reddit:superchubs_blocked', 'takedown');
    repo.db.prepare("UPDATE feeds SET consecutive_failures = 6, last_error = 'Not found (404)' WHERE id = ?").run(failing.feed.id);
    physique.reapply({ ...settingsStore.get(), physiqueFilter: false });
    assert.equal(repo.feeds.get(ok.feed.id).enabled, 1, 'the clean feed runs again');
    assert.equal(repo.feeds.get(blocked.feed.id).enabled, 0, 'a blocklisted account stays off');
    assert.equal(repo.feeds.get(failing.feed.id).enabled, 0, 'a permanently failing feed stays off');
  } finally { settingsStore.update({ physiqueFilter: false }); }
});

test('NIT 6: unhiding a creator the body filter hid does not resume a feed whose account is blocklisted', () => {
  const physique = require('../src/engine/physique');
  const c = creator('admin'); const good = feed(c, 'bluesky', 'user', `physgood${n}.bsky.social`, 'admin'); const bad = feed(c, 'bluesky', 'user', `physbad${n}.bsky.social`, 'admin');
  physique.hideCreator(repo.creators.get(c.id), 'body filter: test');
  assert.equal(repo.creators.get(c.id).status, 'hidden'); assert.equal(repo.feeds.get(good.id).enabled, 0);
  repo.blocklist.add('creator', `bluesky:physbad${n}.bsky.social`, 'takedown');
  assert.equal(physique.unhideCreator(repo.creators.get(c.id)), true);
  assert.equal(repo.feeds.get(good.id).enabled, 1); assert.equal(repo.feeds.get(bad.id).enabled, 0);
});
