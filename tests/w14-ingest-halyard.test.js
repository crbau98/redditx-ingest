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

test('revive leaves a discovered account that does not match its creator (the foreign-feed case) off', () => {
  const c = creator(`matchman${++n}`);
  const foreign = feed(c.id, 'coomer', 'user', `onlyfans/somebodyelse${n}`, { items: 50, enabled: 0, origin: 'discovered' });
  const mine = feed(c.id, 'coomer', 'user', `onlyfans/matchman${n}`, { items: 50, enabled: 0, origin: 'discovered' });
  const page = feed(c.id, 'web', 'page', `https://fapello.com/anything${n}/`, { items: 5, enabled: 0, origin: 'deep-search' });
  const dry = revive.reviveFeeds({ apply: false, creatorId: c.id });
  const ids = new Set(dry.examples.map((e) => e.id));
  assert.ok(!ids.has(foreign.id), 'mismatched account stays off'); assert.ok(ids.has(mine.id)); assert.ok(ids.has(page.id), 'page feeds name no account');
  assert.ok(dry.skipped['account name does not match creator'] >= 1);
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

test('confidentHandles: only TRUSTED sources (claimed paid page, admin/lookup/merge alias, trusted-origin productive feed); never a feed-made alias, a pending lead, or a discovered feed', () => {
  const c = creator(`covmain${++n}`);
  lead(c.id, `paidhandle${n}`);                                  // claimed: trusted
  lead(c.id, `pendinglead${n}x`, 'pending');                     // not claimed
  feed(c.id, 'tiktok', 'user', `tiktokacct${n}`, { items: 10, enabled: 0 }); // admin-origin, productive, disabled: trusted
  feed(c.id, 'bluesky', 'user', `discoveredacct${n}.bsky.social`, { items: 50, origin: 'discovered' });
  feed(c.id, 'redgifs', 'user', `deepsearchacct${n}`, { items: 50, origin: 'deep-search' });
  alias(c.id, `lookupalias${n}x`, 'lookup'); alias(c.id, `fromfeed${n}xyz`, 'account'); alias(c.id, `profalias${n}xy`, 'profile'); alias(c.id, `biograb${n}x`, 'bio');
  feed(c.id, 'x', 'user', `barrenacct${n}`, { items: 0 });
  feed(c.id, 'web', 'page', `https://pagefeed${n}.example/x`, { items: 9 });
  const h = coverage.confidentHandles(repo.creators.get(c.id));
  assert.equal(h.length, 2, 'at most two handles per pass');
  assert.deepEqual(h.map((x) => x.reason), ['paid page', 'productive feed']);
  const all = new Set();
  for (const r of coverage.confidentHandles({ id: c.id })) all.add(r.handle);
  assert.ok(![...all].some((x) => /pending|discovered|deepsearch|fromfeed|profalias|biograb|barren|pagefeed/.test(x)), [...all].join(','));
  // the trusted alias is reachable once the stronger sources are out of the way
  const d = creator(`covalias${++n}`); alias(d.id, `lookupalias${n}x`, 'lookup'); alias(d.id, `fromfeed${n}xyz`, 'account');
  assert.deepEqual(coverage.confidentHandles(repo.creators.get(d.id)).map((x) => x.handle), [`lookupalias${n}x`]);
});

test('coverage is OFF by default', () => {
  assert.equal(settingsStore.get().coverageEnabled, false);
});

test('coverage finds his account where the profile names him; follows it as an enabled, UNTRUSTED feed on that creator', async () => {
  const c = creator(`covfind${++n}`); const hd = `covfindpaid${n}`;
  lead(c.id, hd);
  const probe = fakeProbe((s) => (s.platform === 'redgifs' && s.target === hd) || (s.platform === 'web' && /fapello/.test(s.target)), () => ({ displayName: `covfind${n} on tube`, bio: 'gym' }));
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe });
  const got = out.created.map((x) => x.platform).sort();
  assert.deepEqual(got, ['redgifs', 'web']);
  for (const x of out.created) { const f = repo.feeds.get(x.id); assert.equal(f.enabled, 1); assert.equal(f.trusted, 0, 'coverage feeds are untrusted: items still need their own male signal'); assert.equal(f.creator_id, c.id); assert.equal(f.origin, 'coverage'); }
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
  assert.ok(out.skipped['exists but no evidence it is him'] >= 1, JSON.stringify(out.skipped));
});

test('a long handle alone is NOT evidence; the claimed paid page\'s coomer mirror, a profile that links to his paid page, or to an account he has, is', async () => {
  const c = creator(`unique${++n}longname`); lead(c.id, `uniquehandle${n}zz`);
  const bare = await coverage.coverCreator(repo.creators.get(c.id), { probe: fakeProbe((s) => s.platform === 'bluesky' || s.platform === 'reddit') });
  assert.equal(bare.created.length, 0, 'no profile evidence, however distinctive the handle');
  const mirror = await coverage.coverCreator(repo.creators.get(c.id), { probe: fakeProbe((s) => s.platform === 'coomer' && /^onlyfans\//.test(s.target)) });
  assert.deepEqual(mirror.created.map((x) => x.why), ['mirror of his claimed paid page']);
  const d = creator(`linker${++n}`); lead(d.id, `lnk${n}hnd`);
  const out = await coverage.coverCreator(repo.creators.get(d.id), { probe: fakeProbe((s) => s.platform === 'tumblr', () => ({ displayName: 'x', links: [{ target: `https://onlyfans.com/lnk${n}hnd` }] })) });
  assert.deepEqual(out.created.map((x) => x.why), ['profile links to his paid page']);
  const e = creator(`knownacct${++n}`); lead(e.id, `kna${n}hnd`); feed(e.id, 'redgifs', 'user', `kna${n}redgifs`, { items: 5 });
  const out2 = await coverage.coverCreator(repo.creators.get(e.id), { probe: fakeProbe((s) => s.platform === 'bluesky', () => ({ displayName: 'x', links: [{ target: `https://www.redgifs.com/users/kna${n}redgifs` }] })) });
  assert.deepEqual(out2.created.map((x) => x.why), ['profile links to his known accounts']);
});

test('NAMESAKE: "Alexander K (a different man)" is not "alexander"; a profile repeating only the shared handle proves nothing', async () => {
  const c = creator('alexander'); lead(c.id, 'alexander');
  const probe = fakeProbe((s) => s.platform !== 'coomer', () => ({ displayName: 'Alexander K (a different man, Moscow)', bio: 'photographer' }));
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe });
  assert.equal(out.created.length, 0);
  assert.ok(out.skipped['exists but no evidence it is him'] >= 3, JSON.stringify(out.skipped));
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM feeds WHERE creator_id = ? AND origin = 'coverage'").get(c.id).n, 0);
  assert.equal(coverage.readsAsHim({ display_name: 'Ben Batchelor', handle: 'benb' }, 'benb', { profile: { displayName: 'Ben Batchelor | model' }, spec: {} }, { claimed: new Set(), others: [] }), 'profile names him', 'his full two-word name is evidence');
  assert.equal(coverage.readsAsHim({ display_name: 'Ben Batchelor', handle: 'benb' }, 'benb', { profile: { displayName: 'Ben Smith' }, spec: {} }, { claimed: new Set(), others: [] }), null, 'one shared word of a two-word name is not');
  assert.equal(coverage.readsAsHim({ display_name: 'Ben', handle: 'ben' }, 'bigman', { profile: { displayName: 'Ben' }, spec: {} }, { claimed: new Set(), others: [] }), null, 'a short single name is too common');
});

test('the probed profile is run through the female and safety gates before anything is followed', async () => {
  const c = creator(`gateman${++n}x`); lead(c.id, `gatemanpaid${n}x`);
  const named = { displayName: `gateman${n}x`, bio: 'she/her. girl next door. mom of two' };
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe: fakeProbe((s) => s.platform === 'bluesky', () => named) });
  assert.equal(out.created.length, 0, 'it names him, but the bio reads female');
  assert.ok(out.skipped['profile reads female'] >= 1, JSON.stringify(out.skipped));
  const { checkText } = require('../src/lib/safety');
  const word = ['teen', 'schoolboy', 'underage', 'minor', 'kid', 'child', 'loli', 'young'].find((w) => checkText(`a ${w}`, '').level === 'block');
  if (word) {
    const d = creator(`gatesafe${++n}x`); lead(d.id, `gatesafepaid${n}x`);
    const o2 = await coverage.coverCreator(repo.creators.get(d.id), { probe: fakeProbe((s) => s.platform === 'bluesky', () => ({ displayName: `gatesafe${n}x`, bio: `${word} content` })) });
    assert.equal(o2.created.length, 0); assert.ok(o2.skipped['safety gate'] >= 1);
  }
});

test('addSpec checks safety even when a creator is supplied', () => {
  const { checkText } = require('../src/lib/safety');
  const forms = [];
  for (const w of ['teen', 'schoolboy', 'underage', 'minor', 'kid', 'child', 'loli', 'young']) for (const f of [(x) => x, (x) => `${x}boyz`, (x) => `${x}_boy`, (x) => `boy_${x}`]) forms.push(f(w));
  const target = forms.find((x) => checkText(x, '').level === 'block');
  if (!target) return; // this build's safety vocabulary has none of the probe words
  const c = creator(`addspecsafe${++n}`);
  const r = require('../src/services/targets').addSpec({ platform: 'redgifs', kind: 'user', target }, { creatorId: c.id, origin: 'coverage', trusted: false });
  assert.equal(r.status, 'invalid', `${target} -> ${r.status}`);
  assert.equal(repo.feeds.find('redgifs', 'user', target), null);
});

test('an account that belongs to another creator is a conflict, not a second owner', async () => {
  const owner = creator(`owner${++n}`); const c = creator(`covconf${n}`); const hd = `covconfpaid${n}x`;
  feed(owner.id, 'redgifs', 'user', hd, { items: 4 });
  lead(c.id, hd);
  const out = await coverage.coverCreator(repo.creators.get(c.id), { probe: fakeProbe((s) => s.platform === 'redgifs', () => ({ displayName: `covconf${n}`, bio: '' })) });
  assert.equal(out.created.length, 0);
  assert.ok(out.skipped['already followed'] >= 1 || out.skipped['belongs to another creator'] >= 1);
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
  settingsStore.update({ coverageEnabled: true });
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
  try { assert.equal((await coverage.rotate({ limit: 5, probe })).skipped, 'off in Settings'); } finally { settingsStore.update({ coverageEnabled: false }); }
});

test('admin coverage routes: status, dry run for one creator, admin only', async () => {
  const c = creator(`covroute${++n}`); lead(c.id, `covroutehandle${n}x`);
  assert.equal((await fetch(`${base}/coverage`)).status, 401);
  const st = await call('GET', '/coverage');
  assert.equal(st.enabled, false, 'off until a dry run has been read'); assert.ok(st.platforms.includes('coomer')); assert.ok(!st.platforms.includes('x'));
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
  settingsStore.update({ coverageEnabled: true });
  repo.discoveryState.set('coverage.day', JSON.stringify({ day: new Date().toISOString().slice(0, 10), probes: {}, created: 0 }));
  const r = await coverage.rotate({ limit: 1, probe: fakeProbe(() => false) });
  settingsStore.update({ coverageEnabled: false });
  assert.deepEqual(r.creators.map((c) => c.id), [seen.id]);
});

// ------------------------------------------------------------------ Crucible v4.23.0: a wrong attach must never block or purge a real man
let mediaN = 0;
const pub = (cid, fid, platform = 'bluesky') => { mediaN++; return repo.media.insert({ creator_id: cid, feed_id: fid, platform, source_id: `q${mediaN}`, source_key: `${platform}:q${mediaN}:0`, hash: `qh${mediaN}`, media_type: 'image', media_url: `https://cdn.example/q${mediaN}.jpg`, title: 'x' }); };
const stateOf = (id) => repo.media.get(id).publish_state;

test('a woman\'s account attached by coverage/discovery: THE FEED is switched off and blocklisted, its items held for review, the creator and his other items untouched', () => {
  const pipeline = require('../src/engine/pipeline');
  for (const origin of ['coverage', 'discovered', 'deep-search', 'search', 'linked', 'account']) {
    const man = creator(`quarman${++n}`);
    const own = feed(man.id, 'redgifs', 'user', `quarown${n}`, { items: 40, origin: 'admin' });
    const bad = feed(man.id, 'bluesky', 'user', `jessicasmith${n}.bsky.social`, { items: 1, origin });
    const mine = pub(man.id, own.id, 'redgifs'); const theirs = pub(man.id, bad.id);
    pipeline._blockFemaleCreator({ author: `jessicasmith${n}.bsky.social`, authorName: 'Jessica', authorBio: 'she/her. girl next door' }, repo.feeds.get(bad.id), 'female:girl');
    assert.equal(repo.creators.get(man.id).status, 'active', `${origin}: the creator is not blocked`);
    assert.equal(enabledOf(bad.id), 0, `${origin}: the feed is off`);
    assert.equal(enabledOf(own.id), 1, 'his own feed is untouched');
    assert.equal(repo.blocklist.has('creator', `bluesky:jessicasmith${n}.bsky.social`), true, 'the account is blocklisted');
    assert.equal(stateOf(theirs), 'review', 'what that feed published is held for review');
    assert.equal(stateOf(mine), 'published', 'his own items stay published');
    const acts = repo.db.prepare("SELECT action, actor FROM moderation_actions WHERE target_type = 'feed' AND target_id = ?").all(bad.id);
    assert.ok(acts.some((a) => a.action === 'scope-feed-off' && a.actor === 'system'));
    assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'block'").get(man.id).n, 0);
  }
});

test('evidence on the creator\'s OWN feed (admin, seed, ingest) still blocks the creator; female content must never publish', () => {
  const pipeline = require('../src/engine/pipeline');
  for (const origin of ['admin', 'seed', 'ingest']) {
    const c = creator(`ownfem${++n}`);
    const f = feed(c.id, 'bluesky', 'user', `ownfem${n}.bsky.social`, { items: 5, origin });
    const m = pub(c.id, f.id);
    pipeline._blockFemaleCreator({ author: `ownfem${n}.bsky.social`, authorName: 'Jessica', authorBio: 'she/her. girl' }, repo.feeds.get(f.id), 'female:girl');
    assert.equal(repo.creators.get(c.id).status, 'blocked', `${origin}: blocked as before`);
    assert.equal(stateOf(m), 'removed');
  }
});

test('three image strikes against an automatic feed\'s account quarantine the feed; against his own feed they still block the creator', () => {
  const pipeline = require('../src/engine/pipeline');
  const man = creator(`strikeman${++n}`);
  const auto = feed(man.id, 'bluesky', 'user', `strikeacct${n}.bsky.social`, { items: 1, origin: 'coverage' });
  const m = pub(man.id, auto.id);
  for (let i = 0; i < 3; i++) pipeline._noteImageStrike({ author: `strikeacct${n}.bsky.social` }, repo.feeds.get(auto.id));
  assert.equal(repo.creators.get(man.id).status, 'active'); assert.equal(enabledOf(auto.id), 0); assert.equal(stateOf(m), 'review');
  const own = repo.creators.create({ handle: `strikeown${++n}`, displayName: `strikeown${n}`, origin: 'ingest' }); // an admin-origin creator is never auto-blocked by strikes
  const mine = feed(own.id, 'bluesky', 'user', `strikeown${n}.bsky.social`, { items: 1, origin: 'ingest' });
  for (let i = 0; i < 3; i++) pipeline._noteImageStrike({ author: `strikeown${n}.bsky.social` }, repo.feeds.get(mine.id));
  assert.equal(repo.creators.get(own.id).status, 'blocked', 'the creator\'s own feed: as before');
});

test('a quarantined feed is never revived (scope-feed-off is final)', () => {
  const pipeline = require('../src/engine/pipeline');
  const man = creator(`quarrev${++n}`);
  const bad = feed(man.id, 'bluesky', 'user', `quarrev${n}.bsky.social`, { items: 9, origin: 'coverage' });
  pipeline._blockFemaleCreator({ author: `quarrev${n}.bsky.social`, authorName: 'Jess', authorBio: 'she/her' }, repo.feeds.get(bad.id), 'female:she');
  const dry = revive.reviveFeeds({ apply: false, creatorId: man.id });
  assert.ok(!dry.examples.some((e) => e.id === bad.id));
});

// ------------------------------------------------------------------ revive hardening (M1)
test('revive: lemmy is retired; an ADMIN block whose reason starts with "scope" is never undone; a system scope block is', () => {
  const man = creator(`m1man${++n}`);
  const lem = feed(man.id, 'lemmy', 'community', `gaymen${n}@lemmy.example`, { items: 9, enabled: 0 });
  assert.ok(!revive.reviveFeeds({ apply: false, creatorId: man.id }).examples.some((e) => e.id === lem.id), 'lemmy stays off');
  const real = creator(`m1real${n}`);
  const fa = creator(`m1adm${n}`); const adminOff = feed(fa.id, 'coomer', 'user', `onlyfans/m1adm${n}`, { items: 9 });
  repo.creators.block(fa.id, 'scope: this account is a woman, keep out', 'admin');
  const fs = creator(`m1sys${n}`); const sysOff = feed(fs.id, 'coomer', 'user', `onlyfans/m1sys${n}`, { items: 9 });
  repo.creators.block(fs.id, 'scope:female:girl (profile)', 'system');
  repo.media.reassignFeed(adminOff.id, real.id); repo.media.reassignFeed(sysOff.id, real.id);
  assert.equal(enabledOf(adminOff.id), 0, 'admin block stays, whatever its reason says');
  assert.equal(repo.blocklist.has('creator', `coomer:onlyfans/m1adm${n}`), true);
  assert.equal(enabledOf(sysOff.id), 1, 'the system\'s own scope block is undone');
});

test('revive: a block made before per-feed logging counts as system only when the system alone wrote that reason', () => {
  const man = creator(`m1old${++n}`);
  const sysFeed = feed(man.id, 'coomer', 'user', `onlyfans/m1oldsys${n}`, { items: 9, enabled: 0 });
  repo.blocklist.add('creator', `coomer:onlyfans/m1oldsys${n}`, `scope:female:oldrule${n} (profile)`);
  repo.logAction('creator', 'someone', 'block', `scope:female:oldrule${n} (profile)`, 'system');
  const adminFeed = feed(man.id, 'coomer', 'user', `onlyfans/m1oldadm${n}`, { items: 9, enabled: 0 });
  repo.blocklist.add('creator', `coomer:onlyfans/m1oldadm${n}`, `scope: shared reason ${n}`);
  repo.logAction('creator', 'a', 'block', `scope: shared reason ${n}`, 'system'); repo.logAction('creator', 'b', 'block', `scope: shared reason ${n}`, 'admin');
  const ids = new Set(revive.reviveFeeds({ apply: false, creatorId: man.id }).examples.map((e) => e.id));
  assert.ok(ids.has(sysFeed.id)); assert.ok(!ids.has(adminFeed.id), 'an admin wrote the same reason: not undone');
});

test('revive: an automatic-origin account must be the creator by exact handle or alias, never by containment', () => {
  const man = creator(`reviveman${++n}`);
  alias(man.id, `otherhandle${n}xyz`, 'admin');
  const exact = feed(man.id, 'bluesky', 'user', `reviveman${n}.bsky.social`, { items: 9, enabled: 0, origin: 'discovered' });
  const viaAlias = feed(man.id, 'redgifs', 'user', `otherhandle${n}xyz`, { items: 9, enabled: 0, origin: 'linked' });
  const contains = feed(man.id, 'bluesky', 'user', `reviveman${n}xo.bsky.social`, { items: 9, enabled: 0, origin: 'discovered' });
  const unrelated = feed(man.id, 'bluesky', 'user', `somebodyelse${n}.bsky.social`, { items: 9, enabled: 0, origin: 'linked' });
  const admin = feed(man.id, 'bluesky', 'user', `adminpicked${n}.bsky.social`, { items: 9, enabled: 0, origin: 'admin' });
  const dry = revive.reviveFeeds({ apply: false, creatorId: man.id });
  const ids = new Set(dry.examples.map((e) => e.id));
  assert.ok(ids.has(exact.id) && ids.has(viaAlias.id) && ids.has(admin.id));
  assert.ok(!ids.has(contains.id), 'containment is not a match'); assert.ok(!ids.has(unrelated.id));
});

test('revive: female names on the creator side or the account side keep a feed off even when its target looks neutral', () => {
  const shes = repo.creators.create({ handle: `shecreator${++n}`, displayName: `Sunny ${n}`, bio: 'she/her. girl next door' });
  const a = feed(shes.id, 'bluesky', 'user', `sunnydays${n}.bsky.social`, { items: 9, enabled: 0 });
  const man = creator(`neutralman${++n}`);
  const b = feed(man.id, 'bluesky', 'user', `jessicarose${n}.bsky.social`, { items: 9, enabled: 0 });
  repo.db.prepare("INSERT INTO media (id, creator_id, feed_id, platform, source_key, hash, media_type, media_url, title, author, publish_state) VALUES (?, ?, ?, 'bluesky', ?, ?, 'image', 'https://x.example/a.jpg', 't', 'Jessica (she/her)', 'review')").run(`aq${n}`, man.id, b.id, `bluesky:aq${n}:0`, `aqh${n}`);
  const ok = feed(man.id, 'bluesky', 'user', `plainperson${n}.bsky.social`, { items: 9, enabled: 0 });
  const ids = new Set([...revive.reviveFeeds({ apply: false, creatorId: shes.id }).examples, ...revive.reviveFeeds({ apply: false, creatorId: man.id }).examples].map((e) => e.id));
  assert.ok(!ids.has(a.id), 'creator bio reads female'); assert.ok(!ids.has(b.id), 'the account posted under a female name'); assert.ok(ids.has(ok.id));
});

// ------------------------------------------------------------------ the coverage budget is reserved before each probe
test('budget: concurrent passes cannot spend more than the daily cap, and a pass aborted after a probe still paid for it', async () => {
  const before = settingsStore.get().coveragePerPlatformPerDay;
  try {
    settingsStore.update({ coveragePerPlatformPerDay: 3 });
    repo.discoveryState.set('coverage.day', JSON.stringify({ day: new Date().toISOString().slice(0, 10), probes: {}, created: 0 }));
    const cs = []; for (let i = 0; i < 6; i++) { const c = creator(`cc${++n}x`); lead(c.id, `ccpaid${n}xyz`); cs.push(c); }
    let made = 0;
    const slow = async () => { made++; await new Promise((r) => setTimeout(r, 15)); return { exists: false }; };
    await Promise.all(cs.map((c) => coverage.coverCreator(repo.creators.get(c.id), { probe: slow })));
    const perPlatform = coverage.status().probesToday;
    assert.ok(Math.max(...Object.values(perPlatform)) <= 3, JSON.stringify(perPlatform));
    assert.equal(made, Object.values(perPlatform).reduce((a, b) => a + b, 0), 'every probe made was counted, none counted twice');
    // an aborted pass
    repo.discoveryState.set('coverage.day', JSON.stringify({ day: new Date().toISOString().slice(0, 10), probes: {}, created: 0 }));
    settingsStore.update({ coveragePerPlatformPerDay: 50 });
    const d = creator(`abort${++n}x`); lead(d.id, `abortpaid${n}xyz`);
    let probes = 0; const stop = () => probes >= 1;
    await coverage.coverCreator(repo.creators.get(d.id), { probe: async () => { probes++; return { exists: false }; }, aborted: stop });
    assert.equal(probes, 1);
    assert.equal(Object.values(coverage.status().probesToday).reduce((a, b) => a + b, 0), 1, 'the probe the aborted pass started is on the budget');
  } finally { settingsStore.update({ coveragePerPlatformPerDay: before }); }
});
