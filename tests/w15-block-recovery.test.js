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
function scenario({ rows = 5, suspects = 1, reason = REASON, actor = 'system', block = true, extra = null, origin = 'admin' } = {}) {
  n++;
  const h = `recman${n}`;
  const c = repo.creators.create({ handle: h, displayName: h, origin });
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
let mediaN = 0;
const pub = (cid, fid, platform = 'bluesky') => { mediaN++; return repo.media.insert({ creator_id: cid, feed_id: fid, platform, source_id: `pq${mediaN}`, source_key: `${platform}:pq${mediaN}:0`, hash: `pqh${mediaN}`, media_type: 'image', media_url: `https://cdn.example/pq${mediaN}.jpg`, title: 'x' }); };
const stateOf = (id) => repo.media.get(id).publish_state;

test('the dry run shows exactly what the block did and what would be undone, and changes nothing', () => {
  const s = scenario({ rows: 5, suspects: 1 });
  assert.equal(repo.creators.get(s.c.id).status, 'blocked');
  const d = rec.dryRun(s.c.id);
  assert.equal(d.eligible, true, JSON.stringify(d.refusals));
  assert.equal(d.blockedBy.actor, 'system'); assert.equal(d.blockedBy.reason, REASON);
  assert.equal(d.plan.rowsToDelete, 5);
  assert.deepEqual({ ...d.plan.blocklist, note: undefined }, { method: 'trace', creatorEntry: 1, hashEntries: 5, phashEntries: 5, feedAccountEntries: 2, keptAccountEntries: [`web:https://leaks0.example/${s.h}`], anchorFound: true, note: undefined });
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
  assert.equal(dn.eligible, true); assert.match(dn.evidence.note, /no automatic feed supplied the evidence/);
});

test('REFUSED: a block by an admin, a safety block, another reason, a takedown, a report, media removed under a takedown, a creator not blocked, and an unchosen creator whose evidence is his own', () => {
  const refusedFor = (s) => { const d = rec.dryRun(s.c.id); assert.equal(d.eligible, false, JSON.stringify(d)); const out = rec.apply(s.c.id); assert.equal(out.applied, false); assert.equal(repo.creators.get(s.c.id).status, 'blocked'); return d.refusals.join(' | '); };
  assert.match(refusedFor(scenario({ actor: 'admin' })), /made by admin/);
  assert.match(refusedFor(scenario({ reason: 'safety:kid (profile)' })), /safety block is never recovered/);
  assert.match(refusedFor(scenario({ reason: 'safety:minor (profile)', origin: 'seed' })), /safety block is never recovered/);
  assert.match(refusedFor(scenario({ reason: 'report:spam' })), /not a scope or image-filter rule/);
  const td = scenario(); repo.db.prepare("INSERT INTO takedowns (kind, value, reason) VALUES ('handle', ?, 'x')").run(td.h);
  assert.match(refusedFor(td), /takedown/);
  const tc = scenario(); repo.db.prepare("INSERT INTO takedowns (kind, value, reason) VALUES ('creator', ?, 'x')").run(tc.c.id);
  assert.match(refusedFor(tc), /takedown/);
  const rp = scenario(); repo.db.prepare("INSERT INTO reports (id, creator_id, kind) VALUES (?, ?, 'other')").run(`rp${n}`, rp.c.id);
  assert.match(refusedFor(rp), /report/);
  const tm = scenario({ extra: ({ ids }) => repo.db.prepare("UPDATE media SET review_reason = 'takedown: dmca' WHERE id = ?").run(ids[0]) });
  assert.match(refusedFor(tm), /takedown/);
  const own = scenario({ origin: 'discovered', suspects: 0 });
  assert.match(refusedFor(own), /not admin- or seed-followed and no automatic feed/);
  const live = scenario({ block: false }); const dl = rec.dryRun(live.c.id);
  assert.equal(dl.eligible, false); assert.match(dl.refusals.join(), /not blocked/);
  assert.equal(rec.apply(live.c.id).applied, false);
});

test('a discovered creator IS recoverable when an automatic feed supplied the evidence; an admin/seed one is recoverable either way', () => {
  assert.equal(rec.dryRun(scenario({ origin: 'discovered', suspects: 1 }).c.id).eligible, true);
  assert.equal(rec.dryRun(scenario({ origin: 'seed', suspects: 0 }).c.id).eligible, true);
});

test('image-filter blocks: evidence is the feed whose account collected the strikes; an automatic one = recover, his own = review', async () => {
  const mk = (strikeOrigin, origin) => {
    const s = scenario({ reason: 'image filter: 3 pictures with women', origin, suspects: 0, extra: ({ c }) => {
      const f = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: `strk${++n}.bsky.social`, creatorId: c.id, origin: strikeOrigin, runNow: false }).feed;
      repo.db.prepare('UPDATE feeds SET items_total = 5, created_at = ? WHERE id = ?').run('2026-01-03T00:00:00.000Z', f.id);
      for (let i = 0; i < 3; i++) repo.logAction('account', `bluesky:strk${n}.bsky.social`, 'image-female', 'picture shows a woman', 'system');
      s0.f = f;
    } });
    return s;
  };
  const s0 = {};
  const auto = mk('discovered', 'seed'); const fAuto = s0.f;
  const da = rec.dryRun(auto.c.id);
  assert.equal(da.eligible, true); assert.equal(da.evidence.kind, 'strike account'); assert.deepEqual(da.evidence.suspects.map((x) => x.id), [fAuto.id]);
  const own = mk('admin', 'seed'); const fOwn = s0.f;
  const dow = rec.dryRun(own.c.id);
  assert.equal(dow.eligible, true, 'admin/seed-followed: eligible'); assert.deepEqual(dow.evidence.suspects, []); assert.deepEqual(dow.evidence.ownFeedsWithEvidence.map((x) => x.id), [fOwn.id]);
  const cands = Object.fromEntries((await rec.candidates({})).items.map((x) => [x.creatorId, x]));
  assert.equal(cands[auto.c.id].recommendation, 'recover'); assert.equal(cands[auto.c.id].rule, 'image-filter');
  assert.equal(cands[own.c.id].recommendation, 'review');
  // apply on the automatic one leaves the strike-collecting feed off
  const out = rec.apply(auto.c.id); assert.equal(out.applied, true); assert.equal(enabled(fAuto.id), 0);
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

test('candidates: every blocked creator with feeds, with rule, blocker, evidence feed and a recover / review / keep recommendation', async () => {
  const falsy = scenario({ suspects: 1, origin: 'discovered' });          // system scope, automatic evidence: recover
  const seedOnly = scenario({ suspects: 0, origin: 'seed' });             // system scope, admin/seed only: review
  const genuine = scenario({ suspects: 0, origin: 'ingest' });            // system scope, nobody chose him, no automatic evidence: keep
  const adm = scenario({ actor: 'admin' });                                // an admin blocked him: keep
  const safe = scenario({ reason: 'safety:kid (profile)', origin: 'seed' }); // safety: keep, always
  const tkd = scenario({ origin: 'seed' }); repo.db.prepare("INSERT INTO takedowns (kind, value, reason) VALUES ('handle', ?, 'x')").run(tkd.h);
  const r = await rec.candidates({ limit: 5000 });
  const by = Object.fromEntries(r.items.map((x) => [x.creatorId, x]));
  assert.equal(by[falsy.c.id].recommendation, 'recover'); assert.equal(by[falsy.c.id].rule, 'scope'); assert.equal(by[falsy.c.id].blockedBy, 'system');
  assert.equal(by[falsy.c.id].evidence.automaticFeeds[0].id, falsy.sus[0].id);
  assert.equal(by[seedOnly.c.id].recommendation, 'review');
  for (const k of [genuine, adm, safe, tkd]) { assert.equal(by[k.c.id].recommendation, 'keep'); assert.equal(by[k.c.id].call, null); assert.ok(by[k.c.id].why); }
  assert.equal(by[adm.c.id].rule, 'admin'); assert.equal(by[safe.c.id].rule, 'safety');
  assert.equal(by[falsy.c.id].rowsRemovedByBlock, 5); assert.equal(by[falsy.c.id].call, `GET /api/admin/creators/${falsy.c.id}/recover-block`);
  assert.ok(r.byRecommendation.recover >= 1 && r.byRecommendation.review >= 1 && r.byRecommendation.keep >= 4);
  const idx = (k) => r.items.findIndex((x) => x.creatorId === k.c.id);
  assert.ok(idx(falsy) < idx(seedOnly) && idx(seedOnly) < idx(genuine), 'recover, then review, then keep');
  assert.ok(r.items.every((x) => x.feeds >= 1), 'only creators that have feeds');
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

// ---- the real trigger: a profile read from a feed PRISM attached (thefap's page description says "leaked girls")
test('applyProfile: the "profile" of an automatic web page feed can no longer block the creator; the feed is quarantined instead', () => {
  const { applyProfile } = require('../src/engine/creators');
  const settings = require('../src/settings').get();
  const thefap = { displayName: 'BigggWild Nude Leaks (7 Photos) - TheFap', bio: 'The best social network with a lot of leaked girls from Onlyfans, Patreon and other nude content platforms with high quality and free', links: [] };
  for (const origin of ['deep-search', 'discovered', 'linked', 'coverage', 'cbir']) {
    const s = scenario({ rows: 0, suspects: 0, block: false });
    const page = repo.feeds.upsert({ platform: 'web', kind: 'page', target: `https://de.thefap.net/feed/tf${++n}`, creatorId: s.c.id, origin, runNow: false }).feed;
    const kept = pub(s.c.id, page.id, 'web');
    const out = applyProfile(repo.feeds.get(page.id), thefap, settings);
    assert.equal(out.blocked, false, `${origin}: not blocked`); assert.equal(out.quarantined, true);
    assert.equal(repo.creators.get(s.c.id).status, 'active'); assert.equal(enabled(page.id), 0);
    assert.equal(stateOf(kept), 'review', 'what the page published is held for review');
    assert.notEqual(repo.creators.get(s.c.id).bio, thefap.bio, 'his profile is not overwritten by the page description');
    assert.equal(repo.blocklist.has('creator', s.c.id), false);
  }
});

test('applyProfile: a female profile read from HIS OWN feed (admin, seed, ingest) still blocks him; a safety profile from an automatic feed holds him', () => {
  const { applyProfile } = require('../src/engine/creators');
  const settings = require('../src/settings').get();
  for (const origin of ['admin', 'seed', 'ingest']) {
    const s = scenario({ rows: 0, suspects: 0, block: false });
    const f = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: `own${++n}.bsky.social`, creatorId: s.c.id, origin, runNow: false }).feed;
    const out = applyProfile(repo.feeds.get(f.id), { displayName: 'Jess', bio: 'she/her. girl next door' }, settings);
    assert.equal(out.blocked, true, origin); assert.equal(repo.creators.get(s.c.id).status, 'blocked');
  }
  const s2 = scenario({ rows: 0, suspects: 0, block: false });
  const f2 = repo.feeds.upsert({ platform: 'web', kind: 'page', target: `https://x.example/s${++n}`, creatorId: s2.c.id, origin: 'deep-search', runNow: false }).feed;
  const { checkText } = require('../src/lib/safety');
  const word = ['teen', 'schoolboy', 'underage'].find((w) => checkText(`a ${w}`, '').level === 'block');
  if (word) { applyProfile(repo.feeds.get(f2.id), { displayName: 'x', bio: `${word} content` }, settings); assert.equal(repo.creators.get(s2.c.id).status, 'hidden', 'a safety profile from an AUTOMATIC feed puts the creator on hold (tests/w15-safety-hold.test.js); his own feed still blocks'); }
});

test('the whole story: a thefap feed attached by deep search no longer blocks; and a creator it blocked before can be recovered', () => {
  // before the fix this block came from applyProfile; reproduce its record and recover him
  const s = scenario({ suspects: 1 });
  const d = rec.dryRun(s.c.id);
  assert.equal(d.eligible, true); assert.equal(d.evidence.pinned, true);
  assert.equal(rec.apply(s.c.id).applied, true);
  assert.equal(repo.creators.get(s.c.id).status, 'active');
});
