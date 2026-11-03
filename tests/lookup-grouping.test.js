'use strict';
/**
 * Find-a-creator, name collisions. A name match is not proof that two accounts are one man. The case this file is built on
 * (a real "Christian Hogue" lookup): hogueblog.bsky.social, hogue38.bsky.social, christianhogue9.bsky.social and
 * christianhogue912.bsky.social on Bluesky, Telegram "christian_hogue", and a RedGIFs/OnlyFans "alphabottom" whose display
 * name is just "Christian". "Found" only says an account exists. Accounts are grouped as ONE person only on STRONG evidence
 * (identity.js's thresholds, per pair: weight >= 4 plus a shared name, or two STRONG kinds of evidence, or already one creator;
 * a mutual link alone is not enough, a couple link to each other); weak evidence (a one-way link, a link page listing 3+ accounts,
 * a paid page promoted by a friend) never groups, alone, combined with another weak kind, or by chaining. Everything else is a separate possible match, and "follow as one creator" accepts an evidence
 * group, never a crowd that shares a name.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let registry; let lookup; let websearch; let server; let base; let engine; let imagefilter; let identity;
const AGE = { cookie: 'prism_age=1', 'content-type': 'application/json' };
const post = (id) => ({ sourceId: id, title: 'gym pic', permalink: `https://example.test/p/${id}`, mediaType: 'image', mediaUrl: `https://i.example.test/${id}.jpg`, previewUrl: `https://i.example.test/${id}.jpg` });
const who = (displayName, bio = '', links = [], id = 'x') => ({ profile: { displayName, bio, links }, items: [post(id)] });

const WORLD = {
  'bluesky:user:hogueblog.bsky.social': who('Christian Hogue', 'blog about lifting', [], 'b1'),
  'bluesky:user:hogue38.bsky.social': who('Christian Hogue', 'gym. coffee.', [], 'b2'),
  // christianhogue9 says where else he is: his Telegram.
  'bluesky:user:christianhogue9.bsky.social': who('Christian Hogue', 'lifting. telegram below', [{ platform: 'telegram', kind: 'user', target: 'christian_hogue', ingestable: true }], 'b3'),
  'bluesky:user:christianhogue912.bsky.social': who('Christian Hogue', 'another one', [], 'b4'),
  // ...and his Telegram links back: a MUTUAL link is what ties the pair together (one-way would be weak)
  'telegram:user:christian_hogue': who('Christian Hogue', 'lifting. bluesky: christianhogue9', [{ platform: 'bluesky', kind: 'user', target: 'christianhogue9.bsky.social', ingestable: true }], 't1'),
  // a different man whose page just says "Christian"
  'redgifs:user:alphabottom': who('Christian', 'bottom', [{ platform: 'external', service: 'OnlyFans', label: 'OnlyFans', url: 'https://onlyfans.com/alphabottom', handle: 'alphabottom', external: true, ingestable: false }], 'g1'),
};
const ACTORS = ['hogueblog', 'hogue38', 'christianhogue9', 'christianhogue912'].map((h) => ({ handle: `${h}.bsky.social`, displayName: 'Christian Hogue', description: '', avatar: null, followers: 50 }));

before(() => {
  prepareEnv({ MASTODON_INSTANCES: 'masto.test', MISSKEY_INSTANCES: 'miss.test' });
  repo = require('../src/db/repo');
  registry = require('../src/sources');
  lookup = require('../src/engine/lookup');
  identity = require('../src/engine/identity');
  websearch = require('../src/lib/websearch');
  engine = require('../src/engine/engine');
  imagefilter = require('../src/lib/imagefilter');
  for (const a of registry.list()) {
    a.fetch = async (feed) => {
      const hit = WORLD[`${feed.platform}:${feed.kind}:${feed.target}`];
      if (!hit) throw Object.assign(new Error('not found'), { status: 404 });
      return { items: hit.items, profile: hit.profile, via: 'fake' };
    };
  }
  registry.get('bluesky').searchActors = async (q) => (/christian|hogue/i.test(q) ? ACTORS : []);
  registry.get('redgifs').searchCreators = async (q) => (/christian|hogue/i.test(q) ? [{ username: 'alphabottom', name: 'Christian', description: '', avatar: null, followers: 900 }] : []);
  websearch.search = async () => { const r = []; Object.defineProperty(r, 'provider', { value: 'fake' }); return r; };
  websearch.configured = () => true;
  imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [] }));
  engine.enqueue = (ids) => ids.length;
  server = require('../src/app').createApp().listen(0);
  return new Promise((r) => server.once('listening', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
after(async () => { imagefilter._reset(); await new Promise((r) => server.close(r)); });

const key = (c) => `${c.platform}:${c.target}`;
const http = async (path, body) => { const r = await fetch(`${base}/api${path}`, { method: 'POST', headers: AGE, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };

describe('"Christian Hogue": found is not the same person', () => {
  test('all six accounts are found, and only the two that link to each other are grouped', async () => {
    const r = await lookup.lookup('Christian Hogue');
    const by = Object.fromEntries(r.candidates.map((c) => [key(c), c]));
    for (const k of ['bluesky:hogueblog.bsky.social', 'bluesky:hogue38.bsky.social', 'bluesky:christianhogue9.bsky.social', 'bluesky:christianhogue912.bsky.social', 'telegram:christian_hogue', 'redgifs:alphabottom']) {
      assert.ok(by[k], `${k} was found (${Object.keys(by).join()})`);
      assert.equal(by[k].found, true, `${k} is "found"`);
    }
    assert.equal(r.groups.length, 1, 'exactly one evidence group');
    const members = r.groups[0].members.sort();
    assert.deepEqual(members, ['bluesky:user:christianhogue9.bsky.social', 'telegram:user:christian_hogue']);
    assert.ok(r.groups[0].evidence.some((e) => e.type === 'profile-link' && /link to each other/.test(e.detail)), JSON.stringify(r.groups[0].evidence));
    // everyone else is a separate possible match: no group, nothing "same person" about them
    for (const k of ['bluesky:hogueblog.bsky.social', 'bluesky:hogue38.bsky.social', 'bluesky:christianhogue912.bsky.social', 'redgifs:alphabottom']) {
      assert.equal(by[k].groupId, null, `${k} is not grouped`);
      assert.deepEqual(by[k].sameAs, [], `${k} has no evidence tying it to another account`);
    }
    assert.equal(by['bluesky:christianhogue9.bsky.social'].groupId, by['telegram:christian_hogue'].groupId);
    assert.ok(r.lookupId && typeof r.lookupId === 'string');
  });

  test('a paid page belongs to the account it was found on, not to the whole result', async () => {
    const r = await lookup.lookup('Christian Hogue');
    const alpha = r.candidates.find((c) => c.target === 'alphabottom');
    assert.ok(alpha.externalLinks.some((l) => /onlyfans\.com\/alphabottom/i.test(l.url)), 'alphabottom carries its own OnlyFans page');
    for (const c of r.candidates.filter((x) => x.target !== 'alphabottom')) assert.ok(!(c.externalLinks || []).some((l) => /alphabottom/i.test(l.url)), `${c.target} does not carry it`);
    assert.ok(!(r.queryLinks || []).some((l) => /alphabottom/i.test(l.url)), 'and it is not a link from the query itself');
  });

  test('checkSelections: one account always; several only inside one evidence group', async () => {
    const r = await lookup.lookup('Christian Hogue');
    const sel = (...t) => t.map((x) => { const [platform, target] = x.split(':'); return { platform, kind: 'user', target }; });
    assert.equal(lookup.checkSelections(r.lookupId, sel('bluesky:hogue38.bsky.social')).ok, true, 'a single name match may be followed on its own');
    assert.equal(lookup.checkSelections(null, sel('bluesky:hogue38.bsky.social')).ok, true);
    assert.equal(lookup.checkSelections(r.lookupId, sel('bluesky:christianhogue9.bsky.social', 'telegram:christian_hogue')).ok, true, 'the linked pair');
    for (const bad of [
      sel('bluesky:hogueblog.bsky.social', 'bluesky:hogue38.bsky.social'),                       // two namesakes
      sel('bluesky:christianhogue9.bsky.social', 'bluesky:christianhogue912.bsky.social'),      // one grouped, one only a name
      sel('bluesky:christianhogue9.bsky.social', 'telegram:christian_hogue', 'redgifs:alphabottom'), // the pair plus a stranger
    ]) {
      const c = lookup.checkSelections(r.lookupId, bad);
      assert.equal(c.status, 409, JSON.stringify(bad));
      assert.match(c.error, /not linked by evidence/);
    }
    const stale = lookup.checkSelections('no-such-lookup', sel('bluesky:christianhogue9.bsky.social', 'telegram:christian_hogue'));
    assert.equal(stale.status, 409);
    assert.match(stale.error, /Search again/);
  });
});

describe('groupAccounts: what counts as strong evidence', () => {
  const acct = (platform, target, extra = {}) => ({ platform, kind: 'user', target, label: target, confidence: 0.5, ...extra });
  const poolOf = (c, extra = {}) => ({ platform: c.platform, kind: c.kind, target: c.target, label: c.label, links: [], bio: '', verified: true, ...extra });
  const groupKeys = (g) => g.groups.map((x) => x.members.slice().sort());
  const L = (platform, target, kind = 'user') => ({ platform, kind, target, ingestable: true });
  const of = (h) => [{ platform: 'external', service: 'OnlyFans', label: 'OnlyFans', url: `https://onlyfans.com/${h}`, handle: h, external: true }];
  const hub = (links, target = 'https://linktr.ee/a') => ({ platform: 'linkinbio', kind: 'page', target, label: target.replace('https://', ''), verified: true, bio: '', links });

  test('five accounts that only share a name are five separate possible matches', () => {
    const v = ['hogueblog', 'hogue38', 'christianhogue9', 'christianhogue912'].map((h) => acct('bluesky', `${h}.bsky.social`, { displayName: 'Christian Hogue' })).concat(acct('telegram', 'christian_hogue', { displayName: 'Christian Hogue' }), acct('redgifs', 'alphabottom', { displayName: 'Christian' }));
    assert.deepEqual(lookup.groupAccounts(v.map((c) => poolOf(c)), v).groups, []);
  });

  test('a MUTUAL profile link groups two accounts; a one-way link does not, even with the same name', () => {
    const a = acct('bluesky', 'a.bsky.social', { displayName: 'Zed Calloway' }); const b = acct('telegram', 'a_tg', { displayName: 'Zed Calloway' }); const c = acct('x', 'stranger');
    const oneWay = [poolOf(a, { links: [L('telegram', 'a_tg')] }), poolOf(b), poolOf(c)];
    assert.deepEqual(lookup.groupAccounts(oneWay, [a, b, c]).groups, [], 'A -> B only (a partner, a shout-out)');
    const mutual = [poolOf(a, { links: [L('telegram', 'a_tg')] }), poolOf(b, { links: [L('bluesky', 'a.bsky.social')] }), poolOf(c)];
    const g = lookup.groupAccounts(mutual, [a, b, c]);
    assert.deepEqual(groupKeys(g), [['bluesky:user:a.bsky.social', 'telegram:user:a_tg']]);
    assert.ok(g.groups[0].evidence.every((e) => e.type === 'profile-link' && /link to each other/.test(e.detail)));
  });

  test('a mutual link alone is not enough without a shared name (a couple); with the same name, or with a second STRONG kind, it is', () => {
    const alex = acct('bluesky', 'alexrivera.bsky.social', { displayName: 'Alex Rivera' }); const jordan = acct('bluesky', 'jordanblake.bsky.social', { displayName: 'Jordan Blake' });
    const mutual = (extraAlex = [], extraJordan = []) => [poolOf(alex, { links: [L('bluesky', 'jordanblake.bsky.social'), ...extraAlex] }), poolOf(jordan, { links: [L('bluesky', 'alexrivera.bsky.social'), ...extraJordan] })];
    assert.deepEqual(lookup.groupAccounts(mutual(), [alex, jordan]).groups, [], 'my husband is alexrivera: a couple link to each other');
    const withHub = [...mutual([L('linkinbio', 'https://linktr.ee/duo', 'page')], [L('linkinbio', 'https://linktr.ee/duo', 'page')]), hub([L('bluesky', 'alexrivera.bsky.social'), L('bluesky', 'jordanblake.bsky.social')], 'https://linktr.ee/duo')];
    assert.deepEqual(groupKeys(lookup.groupAccounts(withHub, [alex, jordan])), [['bluesky:user:alexrivera.bsky.social', 'bluesky:user:jordanblake.bsky.social']], 'a mutual link AND the same link page: two strong kinds');
  });

  test('weak kinds never combine: a one-way link plus the same paid page (a friend\'s shout-out) does not group; with a shared name it does', () => {
    const owner = acct('bluesky', 'ownerx.bsky.social', { displayName: 'Owen Hart' }); const friend = acct('bluesky', 'finnx.bsky.social', { displayName: 'Finn Gray' });
    const pool = [poolOf(owner, { links: of('ownerof') }), poolOf(friend, { links: [L('bluesky', 'ownerx.bsky.social'), ...of('ownerof')] })];
    assert.deepEqual(lookup.groupAccounts(pool, [owner, friend]).groups, []);
    const a = acct('x', 'zed_x', { displayName: 'Zed Calloway' }); const b = acct('telegram', 'zed_tg', { displayName: 'Zed Calloway' });
    assert.deepEqual(groupKeys(lookup.groupAccounts([poolOf(a, { links: [L('telegram', 'zed_tg'), ...of('zed')] }), poolOf(b, { links: of('zed') })], [a, b])), [['telegram:user:zed_tg', 'x:user:zed_x']]);
  });

  test('chains of mutual links between different men never group (A=B, B=C), however long', () => {
    const names = ['Alex Rivera', 'Bailey Stone', 'Cam Holt'];
    const [a, b, c] = names.map((n, i) => acct('bluesky', `m${i}.bsky.social`, { displayName: n }));
    const link = (t) => L('bluesky', t);
    const pool = [poolOf(a, { links: [link(b.target)] }), poolOf(b, { links: [link(a.target), link(c.target)] }), poolOf(c, { links: [link(b.target)] })];
    assert.deepEqual(lookup.groupAccounts(pool, [a, b, c]).groups, []);
  });

  test('a link-in-bio page that lists two accounts needs a shared name; one that lists three or more never groups', () => {
    const named = (t, p) => acct(p, t, { displayName: 'Zed Calloway' });
    const a = named('ax', 'x'); const b = named('a_tg', 'telegram'); const c = named('a.bsky.social', 'bluesky'); const d = acct('x', 'someone_else', { displayName: 'Someone Else' });
    const two = lookup.groupAccounts([poolOf(a), poolOf(b), poolOf(d), hub([L('x', 'ax'), L('telegram', 'a_tg')])], [a, b, d]);
    assert.deepEqual(groupKeys(two), [['telegram:user:a_tg', 'x:user:ax']]);
    assert.ok(two.groups[0].evidence.every((e) => e.type === 'link-page' && /linktr\.ee\/a/.test(e.detail)));
    const x = acct('x', 'ax'); const y = acct('telegram', 'a_tg'); // different names: weight 4 alone is not enough
    assert.deepEqual(lookup.groupAccounts([poolOf(x), poolOf(y), hub([L('x', 'ax'), L('telegram', 'a_tg')])], [x, y]).groups, []);
    const three = lookup.groupAccounts([poolOf(a), poolOf(b), poolOf(c), hub([L('x', 'ax'), L('telegram', 'a_tg'), L('bluesky', 'a.bsky.social')])], [a, b, c]);
    assert.deepEqual(three.groups, [], 'a page listing three accounts is an agency / studio / favourites page, even with one shared name');
  });

  test('the same paid page promoted by two accounts: not alone (owner and a friend), yes with a shared name or a second kind of evidence', () => {
    const friend = [acct('bluesky', 'owner.bsky.social', { displayName: 'Owen Owner' }), acct('bluesky', 'friend.bsky.social', { displayName: 'Fred Friend' })];
    assert.deepEqual(lookup.groupAccounts([poolOf(friend[0], { links: of('ownerof') }), poolOf(friend[1], { links: of('ownerof') })], friend).groups, [], 'a friend\'s shout-out of the owner\'s page');
    const same = [acct('x', 'zed_x', { displayName: 'Zed Calloway' }), acct('telegram', 'zed_tg', { displayName: 'Zed Calloway' })];
    const g = lookup.groupAccounts([poolOf(same[0], { links: of('zed') }), poolOf(same[1], { links: of('zed') })], same);
    assert.deepEqual(groupKeys(g), [['telegram:user:zed_tg', 'x:user:zed_x']]);
    assert.equal(g.groups[0].evidence[0].type, 'same-paid-page');
    const other = lookup.groupAccounts([poolOf(same[0], { links: of('zed') }), poolOf(same[1], { links: of('someone') })], same);
    assert.deepEqual(other.groups, [], 'different pages');
  });

  test('no chaining on weak evidence: A -> B one-way, B and C on a two-account page: only B and C are tied', () => {
    const a = acct('bluesky', 'a.bsky.social', { displayName: 'Zed Calloway' }); const b = acct('bluesky', 'b.bsky.social', { displayName: 'Zed Calloway' }); const c = acct('bluesky', 'c.bsky.social', { displayName: 'Zed Calloway' });
    const g = lookup.groupAccounts([poolOf(a, { links: [L('bluesky', 'b.bsky.social')] }), poolOf(b), poolOf(c), hub([L('bluesky', 'b.bsky.social'), L('bluesky', 'c.bsky.social')], 'https://linktr.ee/bc')], [a, b, c]);
    assert.deepEqual(groupKeys(g), [['bluesky:user:b.bsky.social', 'bluesky:user:c.bsky.social']]);
  });

  test('accounts PRISM already holds as one creator are grouped; an identity link awaiting review is only weak; a merged one is strong', () => {
    const c1 = repo.creators.create({ handle: 'gp_one', origin: 'admin' });
    const c2 = repo.creators.create({ handle: 'gp_two', origin: 'admin' });
    const c3 = repo.creators.create({ handle: 'gp_three', origin: 'admin' });
    const c4 = repo.creators.create({ handle: 'gp_four', origin: 'admin' });
    identity.noteLink(c1.id, c2.id, { type: 'bio-link', from: c1.id, detail: 'x' }, { autoMerge: false }); // pending
    const a = acct('x', 'gp1', { creatorId: c1.id }); const b = acct('telegram', 'gp2', { creatorId: c2.id }); const c = acct('bluesky', 'gp3.bsky.social', { creatorId: c3.id });
    const e = acct('reddit', 'gp1_alt', { creatorId: c1.id });
    const g = lookup.groupAccounts([a, b, c, e].map((x) => poolOf(x)), [a, b, c, e]);
    assert.deepEqual(groupKeys(g), [['reddit:user:gp1_alt', 'x:user:gp1']], 'same creator groups; a pending identity link alone does not');
    assert.ok(g.groups[0].evidence.every((x) => x.type === 'same-creator'));
    // pending + a one-way link are both WEAK kinds: they do not stand in for a name
    const both = lookup.groupAccounts([poolOf(a, { links: [L('telegram', 'gp2')] }), poolOf(b)], [a, b]);
    assert.deepEqual(both.groups, []);
    // merged by an admin: strong alone
    const link = identity.noteLink(c3.id, c4.id, { type: 'bio-link', from: c3.id, detail: 'y' }, { autoMerge: false });
    require('../src/db/repo').db.prepare("UPDATE identity_links SET status = 'merged' WHERE id = ?").run(link.id);
    const d = acct('x', 'gp4', { creatorId: c4.id });
    assert.deepEqual(groupKeys(lookup.groupAccounts([poolOf(c), poolOf(d)], [c, d])), [['bluesky:user:gp3.bsky.social', 'x:user:gp4']]);
  });

  test('an admin\'s "different people" verdict wins even over a mutual link', () => {
    const c1 = repo.creators.create({ handle: 'dp_one', origin: 'admin' });
    const c2 = repo.creators.create({ handle: 'dp_two', origin: 'admin' });
    const link = identity.noteLink(c1.id, c2.id, { type: 'bio-link', from: c1.id, detail: 'x' }, { autoMerge: false });
    assert.ok(identity.reject(link.id));
    const a = acct('x', 'dp1', { creatorId: c1.id }); const b = acct('telegram', 'dp2', { creatorId: c2.id });
    const pool = [poolOf(a, { links: [L('telegram', 'dp2')] }), poolOf(b, { links: [L('x', 'dp1')] })];
    assert.deepEqual(lookup.groupAccounts(pool, [a, b]).groups, []);
  });
});

describe('following (public API): several accounts only as an evidence group', () => {
  test('two accounts that share only a name are refused, and nothing is created', async () => {
    const found = await http('/lookup', { query: 'Christian Hogue' });
    assert.equal(found.status, 200);
    const before = repo.db.prepare('SELECT COUNT(*) AS n FROM creators').get().n;
    const sel = [{ platform: 'bluesky', kind: 'user', target: 'hogueblog.bsky.social' }, { platform: 'bluesky', kind: 'user', target: 'hogue38.bsky.social' }];
    const r = await http('/lookup/follow', { name: 'Christian Hogue', selections: sel, lookupId: found.json.lookupId });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not linked by evidence/);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM creators').get().n, before, 'no creator was created');
    const noId = await http('/lookup/follow', { name: 'Christian Hogue', selections: sel });
    assert.equal(noId.status, 409, 'several accounts need the lookup they came from');
  });

  test('the evidence group is followed as one creator, and only its own paid pages come with it', async () => {
    const found = await http('/lookup', { query: 'Christian Hogue' });
    const sel = [{ platform: 'bluesky', kind: 'user', target: 'christianhogue9.bsky.social' }, { platform: 'telegram', kind: 'user', target: 'christian_hogue' }];
    // a client that also claims a namesake's paid page: the server ignores client links when it knows the lookup
    const r = await http('/lookup/follow', { name: 'Christian Hogue', selections: sel, lookupId: found.json.lookupId, externalLinks: [{ service: 'OnlyFans', label: 'OnlyFans', url: 'https://onlyfans.com/alphabottom' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.feeds.length, 2);
    assert.ok(r.json.feeds.every((f) => f.creator_id === r.json.creator.id), 'one creator owns both');
    assert.ok(!JSON.stringify(repo.creators.get(r.json.creator.id).links).includes('alphabottom'), 'the namesake\'s OnlyFans page is not attached');
    assert.ok(!repo.feeds.find('bluesky', 'user', 'hogue38.bsky.social') && !repo.feeds.find('redgifs', 'user', 'alphabottom'), 'no namesake was followed');
  });

  test('a possible match is followed on its own, under its own name, with its own paid page', async () => {
    const found = await http('/lookup', { query: 'Christian Hogue' });
    const r = await http('/lookup/follow', { name: 'Christian', selections: [{ platform: 'redgifs', kind: 'user', target: 'alphabottom' }], lookupId: found.json.lookupId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.feeds.length, 1);
    const c = repo.creators.get(r.json.creator.id);
    assert.ok(JSON.stringify(c.links).includes('onlyfans.com/alphabottom'));
    const other = repo.feeds.find('bluesky', 'user', 'christianhogue9.bsky.social');
    assert.notEqual(other.creator_id, c.id, 'a different creator from the linked pair');
  });

  test('findAndFollow takes the single best account, never a crowd that shares the name and not even its linked partner', async () => {
    const hogue = repo.feeds.find('bluesky', 'user', 'christianhogue9.bsky.social');
    repo.db.prepare('DELETE FROM feeds WHERE creator_id = ?').run(hogue.creator_id); // start from "not followed" for the pair
    const auto = await lookup.findAndFollow('Christian Hogue');
    assert.ok(auto.followed && auto.followed.ok, JSON.stringify(auto.followed || auto.note));
    const targets = auto.followed.feeds.map((f) => `${f.platform}:${f.target}`);
    assert.equal(targets.length, 1, `one account: ${targets.join()}`);
    assert.ok(['bluesky:christianhogue9.bsky.social', 'telegram:christian_hogue'].includes(targets[0]));
  });
});
