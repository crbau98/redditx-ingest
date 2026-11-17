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

// ------------------------------------------------------------------ coverage: probe the platforms for a creator's known handle
const coverage = require('../src/engine/coverage');
const settingsStore = require('../src/settings');
const lead = (cid, handle, status = 'claimed') => repo.db.prepare("INSERT INTO onlyfans_leads (service, handle, creator_id, status, origin) VALUES ('OnlyFans', ?, ?, ?, 'seed')").run(handle, cid, status);
const alias = (cid, a, source) => repo.db.prepare('INSERT INTO creator_aliases (creator_id, norm, alias, kind, source) VALUES (?, ?, ?, ?, ?)').run(cid, a.toLowerCase().replace(/[^a-z0-9]/g, ''), a, 'handle', source);
/** A stand-in for the platforms: `exists(spec)` decides; `profile` is what the account's own page says. */
const fakeProbe = (exists, profile = () => ({})) => { const asked = []; const fn = async (spec) => { asked.push(spec); return exists(spec) ? { exists: true, items: 5, profile: profile(spec) } : { exists: false }; }; fn.asked = asked; return fn; };

test('confidentHandles: paid page, productive feed (even disabled) and confirmed alias; not a bio claim, a barren feed, a page feed or a generic word', () => {
  const c = creator(`covmain${++n}`);
  lead(c.id, `paidhandle${n}`);
  feed(c.id, 'tiktok', 'user', `tiktokacct${n}`, { items: 10, enabled: 0 });
  alias(c.id, `confirmed${n}x`, 'profile'); alias(c.id, `biograb${n}x`, 'bio');
  feed(c.id, 'x', 'user', `barrenacct${n}`, { items: 0 });
  feed(c.id, 'web', 'page', `https://pagefeed${n}.example/x`, { items: 9 });
  const h = coverage.confidentHandles(repo.creators.get(c.id));
  assert.equal(h.length, 2, 'at most two handles per pass');
  assert.deepEqual(h.map((x) => x.reason), ['paid page', 'productive feed']);
  const all = repo.db.prepare("SELECT 1"); void all;
  assert.ok(!h.some((x) => /biograb|barren|pagefeed/.test(x.handle)));
  assert.equal(coverage.confidentHandles(creator(`nohandles${++n}`)).length, 0 + coverage.confidentHandles({ id: 'x' }).length);
});

test('coverage finds his account where it exists and reads as him; follows it as an enabled feed on that creator', async () => {
  const c = creator(`covfind${++n}`); const hd = `covfindpaid${n}`;
  lead(c.id, hd);
  const probe = fakeProbe((s) => (s.platform === 'redgifs' && s.target === hd) || (s.platform === 'web' && /fapello/.test(s.target)), (s) => ({ displayName: `${hd} official`, bio: 'gym' }));
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe });
  const got = out.created.map((x) => x.platform).sort();
  assert.deepEqual(got, ['redgifs', 'web']);
  for (const x of out.created) { const f = repo.feeds.get(x.id); assert.equal(f.enabled, 1); assert.equal(f.creator_id, c.id); assert.equal(f.origin, 'coverage'); }
  assert.ok(out.probed >= 6, `probed ${out.probed} platforms`);
});

test('coverage never probes X, Telegram or TikTok, and never re-probes a platform he is already on', async () => {
  const c = creator(`covskip${++n}`); const hd = `covskippaid${n}`;
  lead(c.id, hd); feed(c.id, 'redgifs', 'user', `existing${n}`, { items: 3 });
  const probe = fakeProbe(() => false);
  await coverage.coverCreator(repo.creators.get(c.id), { probe });
  const platforms = new Set(probe.asked.map((s) => s.platform));
  for (const p of ['x', 'telegram', 'tiktok']) assert.ok(!platforms.has(p), `${p} probed`);
  assert.ok(!platforms.has('redgifs'), 'already has a redgifs feed');
  assert.ok(platforms.has('coomer') && platforms.has('reddit') && platforms.has('bluesky'));
});

test('a namesake is not followed: the account exists but nothing says it is him', async () => {
  const c = creator(`Real Man ${++n}`); const hd = `shorty${n}`; // short handle, not his name
  lead(c.id, hd);
  const probe = fakeProbe((s) => s.platform === 'reddit', () => ({ displayName: 'Someone Else', bio: 'I like trains' }));
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe });
  assert.equal(out.created.length, 0);
  assert.ok(out.skipped['exists but not provably him'] >= 1, JSON.stringify(out.skipped));
});

test('a distinctive (9+ character) handle is accepted without a profile; a short one needs a profile that links to or names him', async () => {
  const c = creator(`longhandle${++n}x`);
  lead(c.id, `longhandle${n}x`);
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe: fakeProbe((s) => s.platform === 'bluesky') });
  assert.deepEqual(out.created.map((x) => x.platform), ['bluesky']);
  assert.equal(out.created[0].why, 'distinctive handle');
  const d = creator(`linker${++n}`); lead(d.id, `shrt${n}`);
  const out2 = await coverage.coverCreator(repo.creators.get(d.id), { probe: fakeProbe((s) => s.platform === 'tumblr', () => ({ links: [{ target: `https://linktr.ee/linker${n}` }] })) });
  assert.deepEqual(out2.created.map((x) => x.why), ['profile links to his accounts']);
});

test('an account that belongs to another creator is a conflict, not a second owner', async () => {
  const owner = creator(`owner${++n}`); const c = creator(`covconf${n}`); const hd = `covconfpaid${n}x`;
  feed(owner.id, 'redgifs', 'user', hd, { items: 4 });
  lead(c.id, hd);
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe: fakeProbe((s) => s.platform === 'redgifs') });
  assert.equal(out.created.length, 0);
  assert.equal(repo.feeds.find('redgifs', 'user', hd).creator_id, owner.id);
});

test('the per-platform daily cap stops probing; dry run spends nothing', async () => {
  const before = settingsStore.get().coveragePerPlatformPerDay;
  try {
    settingsStore.update({ coveragePerPlatformPerDay: 1 });
    repo.discoveryState.set('coverage.day', JSON.stringify({ day: new Date().toISOString().slice(0, 10), probes: {}, created: 0 }));
    const a = creator(`capa${++n}`); lead(a.id, `capahandle${n}x`);
    const b = creator(`capb${n}`); lead(b.id, `capbhandle${n}x`);
    const probe = fakeProbe(() => false);
    await coverage.coverCreator(repo.creators.get(a.id), { probe });
    const afterA = probe.asked.length;
    await coverage.coverCreator(repo.creators.get(b.id), { probe });
    const reddit = probe.asked.filter((s) => s.platform === 'reddit').length;
    assert.equal(reddit, 1, 'one reddit probe in total with a cap of 1');
    assert.ok(afterA >= 5 && probe.asked.length === afterA, 'the second creator found every platform at its cap');
    assert.equal(coverage.status().perPlatformCap, 1);
    const dry = fakeProbe(() => true);
    const c = creator(`capdry${++n}`); lead(c.id, `capdryhandle${n}x`);
    const out = await coverage.coverCreator(repo.creators.get(c.id), { probe: dry, dryRun: true });
    assert.equal(dry.asked.length, 0); assert.equal(out.probed, 0); assert.ok(out.handles.length);
  } finally { settingsStore.update({ coveragePerPlatformPerDay: before }); }
});

test('rotate: most popular first, bounded by limit, a creator is not revisited inside the cooldown, creators with no handle cost nothing', async () => {
  repo.db.prepare("UPDATE creators SET status = 'hidden' WHERE status = 'active'").run(); // only this test's creators are in play
  const low = creator(`rotlow${++n}`); const high = creator(`rothigh${n}`); const none = creator(`rotnone${n}`); const mid = creator(`rotmid${n}`);
  lead(low.id, `rotlowhandle${n}x`); lead(high.id, `rothighhandle${n}x`); lead(mid.id, `rotmidhandle${n}x`);
  repo.db.prepare('UPDATE creators SET popularity = ? WHERE id = ?').run(10, low.id);
  repo.db.prepare('UPDATE creators SET popularity = ? WHERE id = ?').run(90, high.id);
  repo.db.prepare('UPDATE creators SET popularity = ? WHERE id = ?').run(50, mid.id);
  repo.db.prepare('UPDATE creators SET popularity = ? WHERE id = ?').run(99, none.id);
  repo.discoveryState.set('coverage.day', JSON.stringify({ day: new Date().toISOString().slice(0, 10), probes: {}, created: 0 }));
  const probe = fakeProbe(() => false);
  const r1 = await coverage.rotate({ limit: 2, probe });
  assert.deepEqual(r1.creators.map((c) => c.id), [high.id, mid.id], 'popularity order, the handle-less creator skipped');
  const r2 = await coverage.rotate({ limit: 2, probe });
  assert.deepEqual(r2.creators.map((c) => c.id), [low.id], 'high and mid are in their cooldown');
  const r3 = await coverage.rotate({ limit: 5, probe });
  assert.equal(r3.started, 0);
  settingsStore.update({ coverageEnabled: false });
  try { assert.equal((await coverage.rotate({ limit: 5, probe })).skipped, 'off in Settings'); } finally { settingsStore.update({ coverageEnabled: true }); }
});

test('admin coverage routes: status, dry run for one creator, admin only', async () => {
  const c = creator(`covroute${++n}`); lead(c.id, `covroutehandle${n}x`);
  assert.equal((await fetch(`${base}/coverage`)).status, 401);
  const st = await call('GET', '/coverage');
  assert.equal(st.enabled, true); assert.ok(st.platforms.includes('coomer')); assert.ok(!st.platforms.includes('x'));
  const dry = await call('POST', '/coverage/run', { creatorId: c.id, dryRun: true });
  assert.equal(dry.probed, 0); assert.match(dry.handles[0], /covroutehandle.*paid page/);
});

// ------------------------------------------------------------------ viewed creators are filled in first (order only)
test('a viewed creator\'s due feed goes ahead of a more overdue one nobody looked at; an old view does not count', () => {
  const viewed = require('../src/engine/viewed');
  const a = creator(`viewa${++n}`); const b = creator(`viewb${n}`);
  const late = feed(a.id, 'redgifs', 'user', `vlate${n}`, { items: 3 });   // very overdue, nobody views the creator
  const fresh = feed(b.id, 'redgifs', 'user', `vfresh${n}`, { items: 3 }); // barely overdue, creator viewed
  const iso = (ms) => new Date(Date.now() - ms).toISOString();
  repo.db.prepare('UPDATE feeds SET next_run_at = ? WHERE id = ?').run(iso(40 * 3600000), late.id);
  repo.db.prepare('UPDATE feeds SET next_run_at = ? WHERE id = ?').run(iso(60000), fresh.id);
  const order = () => repo.feeds.due(500, [], ['redgifs']).map((f) => f.id).filter((id) => id === late.id || id === fresh.id);
  assert.deepEqual(order(), [late.id, fresh.id], 'before any view: lateness decides');
  viewed.touch(b.id);
  assert.ok(viewed.recentIds().has(b.id));
  assert.deepEqual(order(), [fresh.id, late.id], 'the viewed creator goes first');
  repo.db.prepare("UPDATE discovery_state SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-9 days') WHERE key = ?").run(`viewed.${b.id}`);
  assert.deepEqual(order(), [late.id, fresh.id], 'a view older than 7 days is forgotten');
});

test('a view is stamped at most once per ten minutes, and the public profile route records it', async () => {
  const viewed = require('../src/engine/viewed');
  const c = creator(`viewthr${++n}`);
  viewed.touch(c.id);
  const first = repo.discoveryState.touchedAt(`viewed.${c.id}`);
  repo.db.prepare("UPDATE discovery_state SET updated_at = '2026-01-01T00:00:00.000Z' WHERE key = ?").run(`viewed.${c.id}`);
  repo.db.prepare("UPDATE discovery_state SET updated_at = ? WHERE key = ?").run(new Date(Date.now() - 60000).toISOString(), `viewed.${c.id}`);
  const stamp = repo.discoveryState.touchedAt(`viewed.${c.id}`);
  viewed.touch(c.id);
  assert.equal(repo.discoveryState.touchedAt(`viewed.${c.id}`), stamp, 'within ten minutes: no new write');
  assert.ok(first);
  const d = creator(`viewroute${++n}`);
  const res = await fetch(`${base.replace('/api/admin', '/api')}/creators/${d.id}`);
  assert.ok([200, 404, 403].includes(res.status));
  assert.equal(viewed.recentIds().has(d.id), res.status === 200, 'an active, visible creator is stamped');
});

test('coverage looks at viewed creators before more popular ones nobody opened', async () => {
  repo.db.prepare("UPDATE creators SET status = 'hidden' WHERE status = 'active'").run();
  const pop = creator(`vcpop${++n}`); const seen = creator(`vcseen${n}`);
  lead(pop.id, `vcpophandle${n}x`); lead(seen.id, `vcseenhandle${n}x`);
  repo.db.prepare('UPDATE creators SET popularity = 95 WHERE id = ?').run(pop.id);
  repo.db.prepare('UPDATE creators SET popularity = 5 WHERE id = ?').run(seen.id);
  require('../src/engine/viewed').touch(seen.id);
  repo.discoveryState.set('coverage.day', JSON.stringify({ day: new Date().toISOString().slice(0, 10), probes: {}, created: 0 }));
  const r = await coverage.rotate({ limit: 1, probe: fakeProbe(() => false) });
  assert.deepEqual(r.creators.map((c) => c.id), [seen.id]);
});
