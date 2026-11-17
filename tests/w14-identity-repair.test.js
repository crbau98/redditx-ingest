'use strict';
/**
 * Wave 14 identity repair, modelled on the Bigggwild case: one man split over several creator rows, his accounts filed on another
 * creator by searches and aggregator pages, aggregator page dumps in the links, and an identity queue full of path segments read
 * as paid handles.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
const repo = require('../src/db/repo'); const { db } = repo;
const paid = require('../src/lib/paid');
const identity = require('../src/engine/identity');
const repair = require('../src/engine/identity-repair');

let n = 0;
const media = (creatorId, feedId, k = 1) => { for (let i = 0; i < k; i++) { n++; repo.media.insert({ creator_id: creatorId, feed_id: feedId, platform: 'reddit', source_id: `w14i${n}`, source_key: `reddit:w14i${n}:0`, post_key: `reddit:w14i${n}`, media_type: 'image', media_url: `https://i.redd.it/w14i${n}.jpg`, hash: `w14ih${n}`, posted_at: new Date().toISOString() }, []); } };
const feed = (creatorId, platform, kind, target, origin) => repo.feeds.upsert({ platform, kind, target, creatorId, origin, trusted: 1 }).feed;
const link = (a, b, evidence, status = 'pending') => { const [x, y] = a < b ? [a, b] : [b, a]; return db.prepare('INSERT INTO identity_links (a_id, b_id, a_label, b_label, evidence, strength, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(x, y, 'a', 'b', JSON.stringify(evidence), 4, status).lastInsertRowid; };
const C = {};

before(() => {
  // Bigggwild: an active reddit row, an active telegram row, a hidden "OnlyFans Official" row with no recorded reason, a blocked row
  C.reddit = repo.creators.create({ handle: 'bigggwild', origin: 'admin' }).id;
  const fr = feed(C.reddit, 'reddit', 'user', 'bigggwild', 'admin'); media(C.reddit, fr.id, 6);
  C.tg = repo.creators.create({ handle: 'Bigggwild', displayName: 'big wild guy 🔥', origin: 'ingest' }).id;
  const ft = feed(C.tg, 'telegram', 'channel', 'bigggwild', 'telegram-sync'); media(C.tg, ft.id, 3);
  C.hidden = repo.creators.create({ handle: 'bigggwild OnlyFans Official', origin: 'ingest' }).id;
  repo.creators.update(C.hidden, { status: 'hidden', links: [paid.paidLink('OnlyFans', 'bigggwild')] });
  const fh = feed(C.hidden, 'coomer', 'user', 'onlyfans/bigggwild', 'paid-mirror'); media(C.hidden, fh.id, 9);
  C.blocked = repo.creators.create({ handle: 'BigggWild', origin: 'ingest' }).id;
  repo.creators.update(C.blocked, { status: 'blocked' });
  // chasingfit: his own reddit, plus Bigggwild's accounts attached by searches / an aggregator page, and an aggregator page dump
  C.chasing = repo.creators.create({ handle: 'chasingfit', origin: 'admin' }).id;
  const fc = feed(C.chasing, 'reddit', 'user', 'chasingfit', 'admin'); media(C.chasing, fc.id, 4);
  C.redgifs = feed(C.chasing, 'redgifs', 'user', 'bigggwild', 'deep-search').id; media(C.chasing, C.redgifs, 5);
  C.bsky = feed(C.chasing, 'bluesky', 'user', 'bigggwild.bsky.social', 'discovered').id; media(C.chasing, C.bsky, 2);
  C.page = feed(C.chasing, 'web', 'page', 'https://onlypedia.org/bigggwild', 'discovered').id;
  repo.creators.update(C.chasing, { links: [paid.paidLink('OnlyFans', 'chasingfit'), paid.paidLink('OnlyFans', 'poppy.lawson'), paid.paidLink('OnlyFans', 'alyssarain'),
    paid.paidLink('OnlyFans', 'kittyquinnxoxo'), { platform: 'external', url: 'https://www.instagram.com/onlypedia' }, { platform: 'external', url: 'https://www.amazon.com/hz/wishlist/ls/ABC' }] });
  // junk queue pairs, a mixed one, a strong pair, a conflicting pair, a common short name
  C.j1 = repo.creators.create({ handle: 'randomjoe', origin: 'admin' }).id; C.j2 = repo.creators.create({ handle: 'otherguy', origin: 'admin' }).id;
  C.j3 = repo.creators.create({ handle: 'thirdman', origin: 'admin' }).id;
  C.junkLink = link(C.j1, C.j2, [{ type: 'same-paid', detail: 'JustFor.Fans:images' }, { type: 'same-linkpage', detail: 'justfor.fans/wallet-topup.php' }]);
  C.mixedLink = link(C.j1, C.j3, [{ type: 'same-paid', detail: 'JustFor.Fans:media' }, { type: 'bio-link', from: C.j1, detail: 'x:thirdman' }]);
  C.mike = repo.creators.create({ handle: 'mikeliftsheavy', origin: 'admin' }).id; feed(C.mike, 'reddit', 'user', 'mikeliftsheavy', 'admin'); media(C.mike, null, 3);
  C.mike2 = repo.creators.create({ handle: 'mike_hl', origin: 'admin' }).id;
  C.strongLink = link(C.mike, C.mike2, [{ type: 'same-onlyfans', detail: 'mikeliftsheavy' }]);
  C.sam1 = repo.creators.create({ handle: 'samuraiboy', origin: 'admin' }).id; feed(C.sam1, 'reddit', 'user', 'samuraiboy', 'admin');
  C.sam2 = repo.creators.create({ handle: 'SamuraiBoy', origin: 'admin' }).id; feed(C.sam2, 'x', 'user', 'SamuraiBoy', 'admin');
  repo.creators.update(C.sam1, { links: [paid.paidLink('OnlyFans', 'samuraiboy')] }); repo.creators.update(C.sam2, { links: [paid.paidLink('OnlyFans', 'samurai_other')] });
  C.jake1 = repo.creators.create({ handle: 'jake', origin: 'admin' }).id; feed(C.jake1, 'reddit', 'user', 'jake', 'admin');
  C.jake2 = repo.creators.create({ handle: 'Jake', origin: 'admin' }).id; feed(C.jake2, 'x', 'user', 'Jake', 'admin');
  // hidden creators: body filter, an open underage report, no record
  C.phys = repo.creators.create({ handle: 'physhidden', origin: 'admin' }).id; repo.creators.update(C.phys, { status: 'hidden' }); repo.logAction('creator', C.phys, 'physique-hide', 'body filter: x', 'system');
  C.rep = repo.creators.create({ handle: 'reportedone', origin: 'admin' }).id; repo.creators.update(C.rep, { status: 'hidden' }); repo.logAction('creator', C.rep, 'report-hide', 'underage', 'visitor');
  db.prepare("INSERT INTO reports (id, creator_id, kind, status) VALUES ('w14rep', ?, 'underage', 'open')").run(C.rep);
  for (const id of Object.values(C)) if (typeof id === 'string' && repo.creators.get(id)) repo.creators.refreshStats(id);
});

describe('1. paid-handle parsing rejects site paths and assets', () => {
  test('JustFor.Fans and OnlyFans path segments, files and reserved words are not handles', () => {
    for (const u of ['https://justfor.fans/images/a.jpg', 'https://justfor.fans/media/12', 'https://justfor.fans/wallet-topup.php', 'https://justfor.fans/http',
      'https://justfor.fans/ShowPost.php?id=1', 'https://onlyfans.com/media', 'https://onlyfans.com/my/subscriptions', 'https://fansly.com/profile', 'https://onlyfans.com/leaks']) {
      assert.equal(paid.paidHandle(paid.serviceOf(u), u), null, u);
    }
    assert.equal(paid.paidHandle('JustFor.Fans', 'https://justfor.fans/bigggwild'), 'bigggwild');
    assert.equal(paid.paidHandle('OnlyFans', 'https://onlyfans.com/bigggwild'), 'bigggwild');
    assert.deepEqual(paid.findPaidHandles('JFF: images · JustForFans: http://x · jff: realguy').map((p) => p.handle), ['realguy']);
    assert.equal(identity.pageKey('https://justfor.fans/wallet-topup.php'), null);
    assert.equal(identity.pageKey('https://justfor.fans/bigggwild'), 'justfor.fans/bigggwild');
  });
  test('queue cleanup: a junk-only pair is rejected, a mixed pair keeps its real evidence (dry run changes nothing)', () => {
    const dry = repair.cleanQueue();
    assert.equal(dry.apply, false); assert.ok(dry.junkPairs >= 2 && dry.rejected >= 1 && dry.trimmed >= 1, JSON.stringify(dry));
    assert.equal(db.prepare('SELECT status FROM identity_links WHERE id = ?').get(C.junkLink).status, 'pending');
    repair.cleanQueue({ apply: true });
    assert.equal(db.prepare('SELECT status FROM identity_links WHERE id = ?').get(C.junkLink).status, 'rejected');
    const mixed = db.prepare('SELECT status, evidence FROM identity_links WHERE id = ?').get(C.mixedLink);
    assert.equal(mixed.status, 'pending'); assert.deepEqual(JSON.parse(mixed.evidence).map((e) => e.type), ['bio-link']);
    assert.equal(repair.cleanQueue().junkPairs, 0, 'idempotent');
  });
});

describe('3. auto-merge (before the feed repair: it decides who a handle belongs to)', () => {
  test('dry run: same handle on 2+ platforms and a strong pair merge; hidden, blocked, conflicting and common names do not', async () => {
    const r = await repair.autoMerge();
    assert.equal(r.apply, false);
    const keepOf = (id) => r.top.find((m) => m.keep.id === id || m.gone.some((g) => g.id === id));
    const bw = keepOf(C.reddit);
    assert.ok(bw, JSON.stringify(r.top));
    assert.deepEqual([bw.keep.id, bw.gone.map((g) => g.id)], [C.reddit, [C.tg]], 'the richest active row is kept; hidden and blocked rows are not in it');
    assert.ok(r.hiddenExamples.some((h) => h.aStatus === 'hidden' || h.bStatus === 'hidden'), 'the hidden row is reported, not merged');
    assert.ok(keepOf(C.mike), 'the same OnlyFans page: merged although the handles differ');
    assert.ok(!keepOf(C.sam1), 'two distinct paid pages: never merged');
    assert.ok(r.conflictExamples.some((c) => /distinct paid pages/.test(c.why)));
    assert.ok(!keepOf(C.jake1), 'a short common name is not proof');
    assert.ok(!r.top.some((m) => m.keep.id === C.blocked || m.gone.some((g) => g.id === C.blocked)));
    assert.equal(repo.creators.get(C.tg).status, 'active', 'dry run: nothing merged');
  });
  test('apply merges and audits each fold', async () => {
    const r = await repair.autoMerge({ apply: true });
    assert.ok(r.merged >= 2);
    assert.equal(repo.creators.get(C.tg), null); assert.equal(repo.creators.get(C.mike2), null);
    assert.ok(db.prepare("SELECT 1 FROM moderation_actions WHERE target_id = ? AND action = 'merge' AND actor = 'identity-auto'").get(C.reddit));
    assert.equal(repo.creators.get(C.reddit).media_count, 9);
    assert.ok(repo.creators.get(C.hidden), 'the hidden row stays for the user to decide');
  });
});

describe('2. aggregator pollution', () => {
  test('feeds: his accounts on another creator are re-filed on him; an aggregator page that does not name its creator is detached', async () => {
    const dry = await repair.repairFeeds();
    const by = new Map(dry.items.map((f) => [f.id, f]));
    assert.equal(by.get(C.redgifs).reattachTo, C.reddit);
    assert.equal(by.get(C.bsky).reattachTo, C.reddit);
    assert.ok(by.has(C.page), 'onlypedia page about bigggwild on chasingfit');
    assert.ok(![...by.values()].some((f) => f.target === 'chasingfit'), 'his own account stays');
    assert.equal(repo.feeds.get(C.redgifs).creator_id, C.chasing, 'dry run');
    const r = await repair.repairFeeds({ apply: true });
    assert.equal(r.applied, dry.foreign);
    assert.equal(repo.feeds.get(C.redgifs).creator_id, C.reddit);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media WHERE feed_id = ? AND creator_id = ?').get(C.redgifs, C.reddit).n, 5, 'its media moved with it');
    assert.equal(repo.creators.get(C.chasing).media_count, 4);
    assert.ok(db.prepare("SELECT 1 FROM moderation_actions WHERE target_id = ? AND action = 'identity-reattach'").get(String(C.redgifs)));
    assert.equal((await repair.repairFeeds()).foreign, 0, 'idempotent');
  });
  test('links: an aggregator page dump goes, his own paid page stays', () => {
    const dry = repair.repairLinks();
    const item = dry.items.find((i) => i.id === C.chasing);
    assert.ok(item && item.remove.length >= 5, JSON.stringify(item));
    repair.repairLinks({ apply: true });
    const left = repo.creators.get(C.chasing).links.map((l) => l.handle || l.url);
    assert.deepEqual(left, ['chasingfit']);
    assert.ok(db.prepare("SELECT 1 FROM moderation_actions WHERE target_id = ? AND action = 'identity-prune-links'").get(C.chasing));
    assert.equal(repo.creators.get(C.sam2).links.length, 1, 'one paid page in another name is not a dump');
  });
  test('going forward: a profile read off an aggregator page files only his own links; an aggregator page not naming him is not attached to him', () => {
    const c = repo.creators.create({ handle: 'newguy99', origin: 'admin' });
    const page = feed(c.id, 'web', 'page', 'https://fanstats.com/newguy99', 'admin');
    require('../src/engine/creators').applyProfile(page, { displayName: 'New Guy', links: [
      { external: true, service: 'OnlyFans', handle: 'newguy99', url: 'https://onlyfans.com/newguy99' },
      { external: true, service: 'OnlyFans', handle: 'somegirl', url: 'https://onlyfans.com/somegirl' },
      { external: true, url: 'https://www.tiktok.com/@anothergirl' }, { external: true, url: 'https://onlypedia.org/newguy99' }] }, require('../src/settings').get());
    assert.deepEqual(repo.creators.get(c.id).links.map((l) => l.handle || l.url), ['newguy99']);
    const t = require('../src/services/targets');
    const other = t.addSpec('https://onlypedia.org/someoneelse', { creatorId: c.id, origin: 'deep-search', trusted: true });
    assert.equal(other.feed && other.feed.creator_id, null, 'detached');
    const his = t.addSpec('https://onlypedia.org/newguy99-onlyfans', { creatorId: c.id, origin: 'deep-search', trusted: true });
    assert.equal(his.feed && his.feed.creator_id, c.id);
  });
});

describe('4. hidden creators', () => {
  let server; let base;
  before(async () => { server = require('../src/app').createApp().listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
  after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const H = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
  test('report by last action; unhide dry run covers no-record and body-filter rows, never an open report; apply unhides and audits', async () => {
    const rep = await (await fetch(`${base}/api/admin/creators/hidden/report`, { headers: H })).json();
    assert.ok(rep.byAction.none >= 1 && rep.byAction['physique-hide'] >= 1 && rep.byAction['report-hide'] >= 1, JSON.stringify(rep.byAction));
    const dry = await (await fetch(`${base}/api/admin/creators/hidden/unhide`, { headers: H })).json();
    const ids = dry.items.map((i) => i.id);
    assert.ok(ids.includes(C.hidden) && ids.includes(C.phys) && !ids.includes(C.rep), JSON.stringify(dry.items));
    assert.equal(repo.creators.get(C.hidden).status, 'hidden', 'GET is a dry run');
    assert.equal((await (await fetch(`${base}/api/admin/creators/hidden/unhide`, { method: 'POST', headers: H, body: '{}' })).json()).apply, false, 'POST without apply is a dry run too');
    const done = await (await fetch(`${base}/api/admin/creators/hidden/unhide?apply=1`, { method: 'POST', headers: H, body: '{}' })).json();
    assert.equal(done.unhidden, dry.creators);
    assert.equal(repo.creators.get(C.hidden).status, 'active'); assert.equal(repo.creators.get(C.phys).status, 'active'); assert.equal(repo.creators.get(C.rep).status, 'hidden');
    assert.ok(db.prepare("SELECT 1 FROM moderation_actions WHERE target_id = ? AND action = 'unhide'").get(C.hidden));
    // now the unhidden "OnlyFans Official" row is folded in by the next auto-merge (same OnlyFans page and handle key)
    const m = await (await fetch(`${base}/api/admin/identity/repair/auto-merge?apply=1`, { method: 'POST', headers: H, body: '{}' })).json();
    assert.ok(m.merged >= 1); assert.equal(repo.creators.get(C.hidden), null);
    assert.equal(repo.creators.get(C.reddit).media_count, 9 + 5 + 2 + 9);
  });
  test('an admin status change is audited', async () => {
    const c = repo.creators.create({ handle: 'patchme', origin: 'admin' });
    await fetch(`${base}/api/admin/creators/${c.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'hidden' }) });
    assert.ok(db.prepare("SELECT 1 FROM moderation_actions WHERE target_id = ? AND action = 'admin-hide'").get(c.id));
  });
});
