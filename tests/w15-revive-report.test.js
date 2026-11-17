'use strict';
/** The revive report shows the feeds it leaves alone because their creator is blocked or hidden (w15). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const revive = require('../src/engine/feed-revive');
let n = 0;
const creator = (h, origin = 'admin') => repo.creators.create({ handle: h, displayName: h, origin });
const feed = (cid, target, items) => { const f = repo.feeds.upsert({ platform: 'coomer', kind: 'user', target, creatorId: cid, runNow: false }).feed; repo.db.prepare('UPDATE feeds SET items_total = ?, enabled = 0 WHERE id = ?').run(items, f.id); return f; };

test('dry run counts productive feeds on blocked and hidden creators, with who blocked them and why', () => {
  const blocked = creator(`inb${++n}`, 'seed'); feed(blocked.id, `onlyfans/inb${n}a`, 700); feed(blocked.id, `onlyfans/inb${n}b`, 50);
  repo.creators.block(blocked.id, 'scope:female:girl (profile)', 'system');
  const hidden = creator(`inh${n}`, 'ingest'); feed(hidden.id, `onlyfans/inh${n}`, 20); repo.creators.update(hidden.id, { status: 'hidden' });
  const active = creator(`ina${n}`); feed(active.id, `onlyfans/ina${n}`, 9);
  const zero = creator(`inz${n}`); feed(zero.id, `onlyfans/inz${n}`, 0); repo.creators.block(zero.id, 'x', 'admin');
  const r = revive.reviveFeeds({ apply: false });
  assert.equal(r.scanned, 1, 'scanned means feeds on ACTIVE creators only');
  const ic = r.inactiveCreators;
  assert.equal(ic.creators, 2); assert.equal(ic.feeds, 3); assert.equal(ic.items, 770);
  assert.deepEqual(ic.feedsByCreatorStatus, { blocked: 2, hidden: 1 });
  assert.deepEqual(ic.creatorsByOrigin, { seed: 1, ingest: 1 });
  const top = ic.top[0];
  assert.equal(top.creatorId, blocked.id); assert.equal(top.items, 750);
  assert.equal(top.blockedBy.actor, 'system'); assert.match(top.blockedBy.reason, /^scope:female:girl/);
  assert.equal(ic.top[1].blockedBy, null, 'a hidden creator has no block record');
});

test('apply never touches feeds on blocked or hidden creators', () => {
  const c = creator(`apb${++n}`); const f = feed(c.id, `onlyfans/apb${n}`, 500); repo.creators.block(c.id, 'scope:female:girl (profile)', 'system');
  const out = revive.reviveFeeds({ apply: true, limit: 5000 });
  assert.equal(repo.feeds.get(f.id).enabled, 0);
  assert.ok(out.inactiveCreators.feeds >= 1);
});

test('the report can be limited to one creator', () => {
  const c = creator(`one${++n}`, 'seed'); feed(c.id, `onlyfans/one${n}`, 33); repo.creators.block(c.id, 'safety:kid (profile)', 'system');
  const r = revive.reviveFeeds({ apply: false, creatorId: c.id });
  assert.equal(r.inactiveCreators.creators, 1); assert.equal(r.inactiveCreators.items, 33);
});
