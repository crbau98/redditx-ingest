'use strict';
/** Safety hold: under-18 wording in the profile of an AUTOMATIC feed quarantines the feed and holds the creator; his own feed still blocks him. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const { applyProfile } = require('../src/engine/creators');
const { checkText } = require('../src/lib/safety');
const settings = () => require('../src/settings').get();

// a profile text the safety gate really blocks, found rather than assumed
const WORD = ['schoolboy', 'underage', 'teen', 'minor', 'child', 'kid'].find((w) => checkText(`${w}`, '').level === 'block' || checkText(`a ${w}`, '').level === 'block');
const PROFILE = { displayName: 'Some Page', bio: `${WORD} content, ${WORD} videos` };

let n = 0; let mediaN = 0;
const man = (origin = 'admin') => { n++; return repo.creators.create({ handle: `holdman${n}`, displayName: `holdman${n}`, origin }); };
const feed = (cid, platform, kind, target, origin, items = 0) => {
  const f = repo.feeds.upsert({ platform, kind, target, creatorId: cid, origin, runNow: false }).feed;
  repo.db.prepare('UPDATE feeds SET items_total = ?, enabled = 1 WHERE id = ?').run(items, f.id); return repo.feeds.get(f.id);
};
const pub = (cid, fid, platform = 'coomer') => { mediaN++; return repo.media.insert({ creator_id: cid, feed_id: fid, platform, source_id: `h${mediaN}`, source_key: `${platform}:h${mediaN}:0`, hash: `hh${mediaN}`, phash: mediaN.toString(16).padStart(32, '0'), media_type: 'image', media_url: `https://cdn.example/h${mediaN}.jpg`, title: 't' }); };
const state = (id) => repo.media.get(id).publish_state;
const lastCreatorAction = (id) => repo.db.prepare("SELECT action, reason, actor FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? ORDER BY id DESC LIMIT 1").get(id);

test('the vocabulary this test relies on exists', () => { assert.ok(WORD, 'no probe word blocks in this build'); });

test('automatic feed + under-18 profile: the feed is quarantined and the creator is put on HOLD (hidden, feeds paused, review entry); nothing is removed, purged or blocklisted for him', () => {
  for (const origin of ['deep-search', 'discovered', 'linked', 'coverage']) {
    const c = man(); const own = feed(c.id, 'coomer', 'user', `onlyfans/holdman${n}`, 'admin', 40); const other = feed(c.id, 'redgifs', 'user', `holdred${n}`, 'ingest', 5);
    const page = feed(c.id, 'web', 'page', `https://leaks.example/p${n}`, origin, 2);
    const mine = pub(c.id, own.id); const theirs = pub(c.id, page.id, 'web');
    const hashesBefore = repo.db.prepare('SELECT COUNT(*) AS n FROM blocklist WHERE type = ?').get('hash').n;
    const out = applyProfile(repo.feeds.get(page.id), PROFILE, settings());
    assert.equal(out.held, true, origin); assert.equal(out.quarantined, true); assert.equal(out.blocked, false);
    const cr = repo.creators.get(c.id);
    assert.equal(cr.status, 'hidden', `${origin}: hidden, not blocked`);
    const last = lastCreatorAction(c.id); assert.equal(last.action, 'safety-hold'); assert.equal(last.actor, 'system');
    assert.match(last.reason, new RegExp(`web:https://leaks\\.example/p${n}`)); assert.match(last.reason, /matched safety:/);
    for (const f of [own, other, page]) assert.equal(repo.feeds.get(f.id).enabled, 0, 'every feed of his is paused');
    assert.equal(state(mine), 'published', 'his items are NOT removed'); assert.equal(repo.media.get(mine).hash, `hh${mediaN - 1}`, 'nothing purged');
    assert.equal(state(theirs), 'review', 'what the quarantined page published is held');
    assert.equal(repo.blocklist.has('creator', c.id), false, 'no creator blocklist entry');
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM blocklist WHERE type = ?').get('hash').n, hashesBefore, 'no hash blocklisting');
    const rep = repo.db.prepare("SELECT * FROM reports WHERE creator_id = ?").all(c.id);
    assert.equal(rep.length, 1); assert.equal(rep[0].status, 'open'); assert.equal(rep[0].kind, 'underage'); assert.match(rep[0].reason, /safety-hold/);
    assert.ok(repo.reports.list({ status: 'open' }).items.some((r) => r.creator_id === c.id), 'it is in the admin review queue');
  }
});

test('the creator\'s OWN feed (admin, seed, ingest) with the same evidence still blocks him', () => {
  for (const origin of ['admin', 'seed', 'ingest']) {
    const c = man(); const f = feed(c.id, 'bluesky', 'user', `holdown${n}.bsky.social`, origin, 3);
    const out = applyProfile(repo.feeds.get(f.id), PROFILE, settings());
    assert.equal(out.blocked, true, origin); assert.equal(repo.creators.get(c.id).status, 'blocked');
    assert.match(repo.db.prepare("SELECT reason FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'block' ORDER BY id DESC LIMIT 1").get(c.id).reason, /^safety:/);
  }
});

test('a second automatic feed with the same evidence does not duplicate the hold or the review entry; a blocked creator is not held', () => {
  const c = man(); const a = feed(c.id, 'web', 'page', `https://a.example/${n}`, 'deep-search'); const b = feed(c.id, 'web', 'page', `https://b.example/${n}`, 'deep-search');
  applyProfile(repo.feeds.get(a.id), PROFILE, settings());
  applyProfile(repo.feeds.get(b.id), PROFILE, settings());
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'safety-hold'").get(c.id).n, 1);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE creator_id = ?').get(c.id).n, 1);
  assert.equal(repo.feeds.get(b.id).enabled, 0, 'the second page is still quarantined');
  const d = man(); repo.creators.block(d.id, 'admin', 'admin'); const p = feed(d.id, 'web', 'page', `https://c.example/${n}`, 'deep-search');
  applyProfile(repo.feeds.get(p.id), PROFILE, settings());
  assert.equal(repo.creators.get(d.id).status, 'blocked');
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'safety-hold'").get(d.id).n, 0);
});

test('a safety hold is REFUSED by recover-block and by both unhide paths: it stays until a human acts', () => {
  const rec = require('../src/engine/block-recovery'); const repair = require('../src/engine/identity-repair'); const physique = require('../src/engine/physique');
  const c = man(); const page = feed(c.id, 'web', 'page', `https://held.example/${n}`, 'deep-search');
  applyProfile(repo.feeds.get(page.id), PROFILE, settings());
  assert.equal(repo.creators.get(c.id).status, 'hidden');
  const d = rec.dryRun(c.id);
  assert.equal(d.eligible, false); assert.match(d.refusals.join(' | '), /safety hold/);
  assert.equal(rec.apply(c.id).applied, false);
  assert.equal(physique.unhideCreator(repo.creators.get(c.id)), false, 'the body-filter unhide is not ours to undo');
  const before = repair.hiddenReport({ limit: 5000 }).top.find((r) => r.id === c.id);
  assert.equal(before.unhideable, false);
  repair.unhide({ apply: true, limit: 5000 });
  assert.equal(repo.creators.get(c.id).status, 'hidden', 'the identity-repair unhide leaves him hidden');
  // a human can still decide: the admin restore is the explicit act
  repo.creators.update(c.id, { status: 'active' });
  assert.equal(repo.creators.get(c.id).status, 'active');
});

test('the female-profile path from an automatic feed is unchanged by the hold: quarantine only, the creator stays active', () => {
  const c = man(); const page = feed(c.id, 'web', 'page', `https://f.example/${n}`, 'deep-search');
  const out = applyProfile(repo.feeds.get(page.id), { displayName: 'Leaks', bio: 'a lot of leaked girls from Onlyfans' }, settings());
  assert.equal(out.quarantined, true); assert.equal(out.held, undefined); assert.equal(repo.creators.get(c.id).status, 'active');
});
