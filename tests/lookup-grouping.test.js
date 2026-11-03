'use strict';
/**
 * Find-a-creator, name collisions. A name match is not proof that two accounts are one man. The case this file is built on
 * (a real "Christian Hogue" lookup): hogueblog.bsky.social, hogue38.bsky.social, christianhogue9.bsky.social and
 * christianhogue912.bsky.social on Bluesky, Telegram "christian_hogue", and a RedGIFs/OnlyFans "alphabottom" whose display
 * name is just "Christian". "Found" only says an account exists. Accounts are grouped as ONE person only on evidence (one
 * profile links to the other, a shared link-in-bio page, the same paid page, an existing creator/identity link); everything
 * else is a separate possible match, and "follow as one creator" accepts an evidence group, never a crowd that shares a name.
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
  // christianhogue9 says where else he is: his Telegram. That is a profile link, so these two are tied together by evidence.
  'bluesky:user:christianhogue9.bsky.social': who('Christian Hogue', 'lifting. telegram below', [{ platform: 'telegram', kind: 'user', target: 'christian_hogue', ingestable: true }], 'b3'),
  'bluesky:user:christianhogue912.bsky.social': who('Christian Hogue', 'another one', [], 'b4'),
  'telegram:user:christian_hogue': who('Christian Hogue', '', [], 't1'),
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
    assert.ok(r.groups[0].evidence.some((e) => e.type === 'profile-link' && /links to/.test(e.detail)), JSON.stringify(r.groups[0].evidence));
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

describe('groupAccounts: what counts as evidence', () => {
  const acct = (platform, target, extra = {}) => ({ platform, kind: 'user', target, label: target, confidence: 0.5, ...extra });
  const poolOf = (c, extra = {}) => ({ platform: c.platform, kind: c.kind, target: c.target, label: c.label, links: [], bio: '', verified: true, ...extra });
  const groupKeys = (g) => g.groups.map((x) => x.members.slice().sort());

  test('five accounts that only share a name are five separate possible matches', () => {
    const v = ['hogueblog', 'hogue38', 'christianhogue9', 'christianhogue912'].map((h) => acct('bluesky', `${h}.bsky.social`)).concat(acct('telegram', 'christian_hogue'), acct('redgifs', 'alphabottom'));
    assert.deepEqual(lookup.groupAccounts(v.map((c) => poolOf(c)), v).groups, []);
  });

  test('one profile linking to the other groups them (either direction)', () => {
    const a = acct('bluesky', 'a.bsky.social'); const b = acct('telegram', 'a_tg'); const c = acct('x', 'stranger');
    const pool = [poolOf(a), poolOf(b, { links: [{ platform: 'bluesky', kind: 'user', target: 'a.bsky.social' }] }), poolOf(c)];
    assert.deepEqual(groupKeys(lookup.groupAccounts(pool, [a, b, c])), [['bluesky:user:a.bsky.social', 'telegram:user:a_tg']]);
  });

  test('two accounts on the same link-in-bio page are grouped, and so are accounts that link to it', () => {
    const a = acct('x', 'ax'); const b = acct('telegram', 'a_tg'); const c = acct('bluesky', 'a.bsky.social'); const d = acct('x', 'someone_else');
    const hub = { platform: 'linkinbio', kind: 'page', target: 'https://linktr.ee/a', label: 'linktr.ee/a', verified: true, bio: '', links: [{ platform: 'x', kind: 'user', target: 'ax' }, { platform: 'telegram', kind: 'user', target: 'a_tg' }] };
    const pool = [poolOf(a), poolOf(b), poolOf(c, { links: [{ platform: 'linkinbio', kind: 'page', target: 'https://linktr.ee/a' }] }), poolOf(d), hub];
    const g = lookup.groupAccounts(pool, [a, b, c, d]);
    assert.deepEqual(groupKeys(g), [['bluesky:user:a.bsky.social', 'telegram:user:a_tg', 'x:user:ax']]);
    assert.ok(g.groups[0].evidence.every((e) => e.type === 'link-page' && /linktr\.ee\/a/.test(e.detail)));
  });

  test('the same paid page promoted from two accounts groups them; different pages do not', () => {
    const of = (h) => [{ platform: 'external', service: 'OnlyFans', label: 'OnlyFans', url: `https://onlyfans.com/${h}`, handle: h, external: true }];
    const a = acct('x', 'ax'); const b = acct('telegram', 'bx'); const c = acct('bluesky', 'cx');
    const g = lookup.groupAccounts([poolOf(a, { links: of('zed') }), poolOf(b, { links: of('zed') }), poolOf(c, { links: of('someone') })], [a, b, c]);
    assert.deepEqual(groupKeys(g), [['telegram:user:bx', 'x:user:ax']]);
    assert.equal(g.groups[0].evidence[0].type, 'same-paid-page');
  });

  test('accounts PRISM already holds as one creator, or links as possibly the same man, are grouped', () => {
    const c1 = repo.creators.create({ handle: 'gp_one', origin: 'admin' });
    const c2 = repo.creators.create({ handle: 'gp_two', origin: 'admin' });
    const c3 = repo.creators.create({ handle: 'gp_three', origin: 'admin' });
    identity.noteLink(c1.id, c2.id, { type: 'bio-link', from: c1.id, detail: 'x' }, { autoMerge: false });
    const a = acct('x', 'gp1', { creatorId: c1.id }); const b = acct('telegram', 'gp2', { creatorId: c2.id }); const c = acct('bluesky', 'gp3.bsky.social', { creatorId: c3.id });
    const e = acct('reddit', 'gp1_alt', { creatorId: c1.id });
    const g = lookup.groupAccounts([a, b, c, e].map((x) => poolOf(x)), [a, b, c, e]);
    assert.deepEqual(groupKeys(g), [['reddit:user:gp1_alt', 'telegram:user:gp2', 'x:user:gp1']]);
    assert.ok(g.groups[0].evidence.some((x) => x.type === 'same-creator') && g.groups[0].evidence.some((x) => x.type === 'identity-link'));
  });

  test('an admin\'s "different people" verdict wins over a profile link', () => {
    const c1 = repo.creators.create({ handle: 'dp_one', origin: 'admin' });
    const c2 = repo.creators.create({ handle: 'dp_two', origin: 'admin' });
    const link = identity.noteLink(c1.id, c2.id, { type: 'bio-link', from: c1.id, detail: 'x' }, { autoMerge: false });
    assert.ok(identity.reject(link.id));
    const a = acct('x', 'dp1', { creatorId: c1.id }); const b = acct('telegram', 'dp2', { creatorId: c2.id });
    const pool = [poolOf(a, { links: [{ platform: 'telegram', kind: 'user', target: 'dp2' }] }), poolOf(b)];
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

  test('findAndFollow takes the best match and its evidence group, never a crowd that shares the name', async () => {
    const hogue = repo.feeds.find('bluesky', 'user', 'christianhogue9.bsky.social');
    repo.db.prepare('DELETE FROM feeds WHERE creator_id = ?').run(hogue.creator_id); // start from "not followed" for the pair
    const auto = await lookup.findAndFollow('Christian Hogue');
    assert.ok(auto.followed && auto.followed.ok, JSON.stringify(auto.followed || auto.note));
    const targets = auto.followed.feeds.map((f) => `${f.platform}:${f.target}`).sort();
    assert.deepEqual(targets, ['bluesky:christianhogue9.bsky.social', 'telegram:christian_hogue']);
  });
});
