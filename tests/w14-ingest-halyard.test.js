'use strict';
/** Wave 14 (Halyard): productive feeds are not left disabled; coverage and depth of ingestion. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let engine; let revive; let server; let base;
before(async () => {
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); revive = require('../src/engine/feed-revive');
  server = require('../src/app').createApp().listen(0); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

let n = 0;
const creator = (handle) => repo.creators.create({ handle, displayName: handle, origin: 'admin' });
const feed = (cid, platform, kind, target, { items = 0, enabled = 1, origin = 'admin' } = {}) => {
  const f = repo.feeds.upsert({ platform, kind, target, creatorId: cid, runNow: false, origin }).feed;
  repo.db.prepare('UPDATE feeds SET items_total = ?, enabled = ?, origin = ? WHERE id = ?').run(items, enabled, origin, f.id);
  return repo.feeds.get(f.id);
};
const enabledOf = (id) => repo.feeds.get(id).enabled;
const call = async (method, path, body) => (await fetch(`${base}${path}`, { method, headers: { 'x-admin-key': 'test-key', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

test('blocking a creator logs each feed it switches off (so a later move can tell the block did it)', () => {
  const c = creator(`blk${++n}`);
  const f = feed(c.id, 'coomer', 'user', `onlyfans/blk${n}`, { items: 5 });
  repo.creators.block(c.id, 'test', 'admin');
  assert.equal(enabledOf(f.id), 0);
  const act = repo.db.prepare("SELECT action FROM moderation_actions WHERE target_type = 'feed' AND target_id = ?").all(f.id).map((r) => r.action);
  assert.ok(act.includes('creator-block-off'), JSON.stringify(act));
});

test('Bigggwild: productive feeds on a blocked fragment come back on when moved to his real creator', () => {
  const frag = creator(`fragment${++n}`); const real = creator(`realman${n}`);
  const coomer = feed(frag.id, 'coomer', 'user', `onlyfans/realman${n}`, { items: 553 });
  const tiktok = feed(frag.id, 'tiktok', 'user', `realman${n}`, { items: 10 });
  const empty = feed(frag.id, 'x', 'user', `realman_x${n}`, { items: 0 });
  repo.creators.block(frag.id, 'scope:female:girl (profile)', 'system');
  assert.deepEqual([coomer, tiktok, empty].map((f) => enabledOf(f.id)), [0, 0, 0]);
  repo.media.reassignFeed(coomer.id, real.id);
  repo.media.reassignFeed(tiktok.id, real.id);
  repo.media.reassignFeed(empty.id, real.id);
  assert.equal(enabledOf(coomer.id), 1, 'coomer revived');
  assert.equal(enabledOf(tiktok.id), 1, 'tiktok revived');
  assert.equal(enabledOf(empty.id), 0, 'a feed that never produced stays off');
});

test('a scope block is cleared with the revive; a safety block or an admin block on the account is not', () => {
  const frag = creator(`bl${++n}`); const real = creator(`blreal${n}`);
  const scope = feed(frag.id, 'coomer', 'user', `onlyfans/scopeacct${n}`, { items: 5 });
  repo.creators.block(frag.id, 'scope:female:girl (profile)', 'system');
  const frag2 = creator(`bs${n}`);
  const safe = feed(frag2.id, 'coomer', 'user', `onlyfans/safeacct${n}`, { items: 5 });
  repo.creators.block(frag2.id, 'safety:teen (profile)', 'system');
  const frag3 = creator(`ba${n}`);
  const adm = feed(frag3.id, 'coomer', 'user', `onlyfans/admacct${n}`, { items: 5 });
  repo.creators.block(frag3.id, 'admin', 'admin');
  for (const f of [scope, safe, adm]) repo.media.reassignFeed(f.id, real.id);
  assert.equal(enabledOf(scope.id), 1); assert.equal(repo.blocklist.has('creator', `coomer:onlyfans/scopeacct${n}`), false, 'the scope entry is cleared');
  assert.equal(enabledOf(safe.id), 0, 'safety block stays'); assert.equal(repo.blocklist.has('creator', `coomer:onlyfans/safeacct${n}`), true);
  assert.equal(enabledOf(adm.id), 0, 'admin block stays');
});

test('merging a blocked fragment into the real creator revives its productive feeds', () => {
  const frag = creator(`mfrag${++n}`); const real = creator(`mreal${n}`);
  const f = feed(frag.id, 'gff', 'user', `https://justthegays.tv/performer/mreal${n}-1`, { items: 40 });
  repo.creators.block(frag.id, 'scope sweep (creator): girl', 'system');
  repo.creators.merge(real.id, frag.id);
  assert.equal(repo.feeds.get(f.id).creator_id, real.id);
  assert.equal(enabledOf(f.id), 1);
});

test('revive dry run reports; it never revives admin-disabled, engine-disabled, body-filtered, seed, telegram, broken or dead-host feeds', () => {
  const c = creator(`rv${++n}`);
  const ok = feed(c.id, 'coomer', 'user', `onlyfans/rvok${n}`, { items: 9, enabled: 0 });
  const adminOff = feed(c.id, 'bluesky', 'user', `adminoff${n}.bsky.social`, { items: 9, enabled: 0 });
  repo.logAction('feed', adminOff.id, 'disable', 'admin', 'admin');
  const swept = feed(c.id, 'redgifs', 'user', `swept${n}`, { items: 9, enabled: 0 });
  repo.logAction('feed', swept.id, 'sweep-disable', 'x', 'system');
  const seed = feed(c.id, 'reddit', 'user', `seedu${n}`, { items: 9, enabled: 0, origin: 'seed' });
  const tg = feed(c.id, 'telegram', 'user', `tgchan${n}`, { items: 9, enabled: 0 });
  const broken = feed(c.id, 'tumblr', 'user', `brokentb${n}`, { items: 9, enabled: 0 });
  repo.db.prepare("UPDATE feeds SET consecutive_failures = 6, last_error = 'Not found (404)' WHERE id = ?").run(broken.id);
  const never = feed(c.id, 'x', 'user', `neverx${n}`, { items: 0, enabled: 0 });
  const other = creator(`rvblocked${n}`); repo.creators.block(other.id, 'x', 'admin');
  const onBlocked = feed(other.id, 'coomer', 'user', `onlyfans/onblocked${n}`, { items: 9, enabled: 0 });
  const dry = revive.reviveFeeds({ apply: false });
  assert.equal(dry.dryRun, true);
  const ids = new Set(dry.examples.map((e) => e.id));
  assert.ok(ids.has(ok.id), 'the productive feed is a candidate');
  for (const f of [adminOff, swept, seed, tg, broken, never, onBlocked]) assert.ok(!ids.has(f.id), `${f.platform}:${f.target} must not be a candidate`);
  assert.equal(enabledOf(ok.id), 0, 'a dry run changes nothing');
  assert.ok(dry.skipped['last action'] >= 2 && dry.skipped['seed feed'] >= 1 && dry.skipped.broken >= 1);
});

test('revive apply switches candidates on, staggered, resets errors, and logs each one', () => {
  const c = creator(`ra${++n}`);
  const f = feed(c.id, 'fapello', 'user', `ra${n}`, { items: 4, enabled: 0 });
  repo.db.prepare("UPDATE feeds SET consecutive_failures = 1, last_error = 'old' WHERE id = ?").run(f.id);
  const out = revive.reviveFeeds({ apply: true, creatorId: c.id });
  assert.equal(out.revived, 1);
  const row = repo.feeds.get(f.id);
  assert.equal(row.enabled, 1); assert.equal(row.consecutive_failures, 0); assert.equal(row.last_error, null);
  assert.ok(row.next_run_at && Date.parse(row.next_run_at) < Date.now() + 361 * 60000);
  const last = repo.db.prepare("SELECT action, reason FROM moderation_actions WHERE target_type = 'feed' AND target_id = ? ORDER BY id DESC LIMIT 1").get(f.id);
  assert.equal(last.action, 'enable'); assert.match(last.reason, /revived/);
  assert.equal(revive.reviveFeeds({ apply: true, creatorId: c.id }).revived, 0, 'idempotent');
});

test('admin routes: GET is a dry run, POST without apply is a dry run, POST apply:true revives; admin only', async () => {
  const c = creator(`rr${++n}`);
  const f = feed(c.id, 'gff', 'user', `https://justthegays.tv/performer/rr${n}-9`, { items: 7, enabled: 0 });
  assert.equal((await fetch(`${base}/feeds/revive`)).status, 401);
  const g = await call('GET', '/feeds/revive');
  assert.equal(g.dryRun, true); assert.ok(g.candidates >= 1); assert.equal(enabledOf(f.id), 0);
  const p0 = await call('POST', '/feeds/revive', { creatorId: c.id });
  assert.equal(p0.dryRun, true); assert.equal(enabledOf(f.id), 0);
  const p1 = await call('POST', '/feeds/revive', { apply: true, creatorId: c.id });
  assert.equal(p1.dryRun, false); assert.equal(p1.revived, 1); assert.equal(enabledOf(f.id), 1);
});

test('chronic failures do not switch off a productive feed on an active creator; a permanent 404 or a zero-yield feed still goes off', async () => {
  const registry = require('../src/sources'); const real = registry.get;
  const bad = { platform: 'w14chronic', kinds: ['user'], isConfigured: () => ({ ok: true }), fetch: async () => { throw Object.assign(new Error('Unexpected response: HTML page'), { status: 200 }); } };
  registry.get = (p) => (p === 'w14chronic' ? bad : real(p));
  try {
    const c = creator(`chron${++n}`);
    const productive = feed(c.id, 'w14chronic', 'user', `prod${n}`, { items: 30 });
    const barren = feed(c.id, 'w14chronic', 'user', `barren${n}`, { items: 0 });
    for (let i = 0; i < 6; i++) { await engine.runFeed(productive.id, 'manual'); await engine.runFeed(barren.id, 'manual'); }
    assert.equal(enabledOf(productive.id), 1, 'productive feed stays on and keeps backing off');
    assert.ok(repo.feeds.get(productive.id).consecutive_failures >= 5);
    assert.equal(enabledOf(barren.id), 0, 'a feed with no yield is still ended by the chronic rule');
  } finally { registry.get = real; }
});
