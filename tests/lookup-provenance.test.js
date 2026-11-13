'use strict';
/**
 * Why each account matched (v4.20.0). Every visible candidate from lookup() carries `provenance`: the keys the Find page
 * labels (exact, backlink, alias, directory, web). A key is set only on evidence the lookup holds, so a fuzzy match gets
 * no key at all. The rules are checked one by one, then end to end on the fake internet the other lookup tests use.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareEnv } = require('./helpers/mock');

let repo; let registry; let lookup; let websearch; let engine; let imagefilter; let server; let base;
const post = (id, title = 'gym pic') => ({ sourceId: id, title, permalink: `https://www.reddit.com/r/gaybros/comments/${id}`, mediaType: 'image', mediaUrl: `https://i.redd.it/${id}.jpg`, previewUrl: `https://i.redd.it/${id}.jpg` });

// A small fake internet: reddit links out to bluesky, OnlyFans and a link-in-bio page; the link page names telegram and x.
const WORLD = {
  'reddit:user:jaxstone': { profile: { displayName: 'Jax Stone', bio: 'gay fitness model • bsky: https://bsky.app/profile/jaxstone.bsky.social • https://onlyfans.com/jaxstone • https://linktr.ee/jaxstone', links: [
    { platform: 'bluesky', kind: 'user', target: 'jaxstone.bsky.social', ingestable: true }, { platform: 'external', service: 'OnlyFans', label: 'OnlyFans', url: 'https://onlyfans.com/jaxstone', external: true, ingestable: false },
    { platform: 'linkinbio', kind: 'page', target: 'https://linktr.ee/jaxstone', ingestable: true }] }, items: [post('r1'), post('r2'), post('r3')] },
  'bluesky:user:jaxstone.bsky.social': { profile: { displayName: 'Jax Stone 💪', bio: 'gay model. nsfw', handle: 'jaxstone.bsky.social', links: [] }, items: [post('b1')] },
  'bluesky:user:jaxstone2.bsky.social': { profile: { displayName: 'Jax Stone', bio: 'gay model', handle: 'jaxstone2.bsky.social', links: [] }, items: [post('b2')] },
  'linkinbio:page:https://linktr.ee/jaxstone': { profile: { displayName: 'jaxstone', bio: 'all my links', links: [
    { platform: 'telegram', kind: 'user', target: 'jaxstone_official', ingestable: true }, { platform: 'x', kind: 'user', target: 'jaxstone', ingestable: true },
    { platform: 'external', service: 'Throne', label: 'Throne', url: 'https://throne.com/jaxstone', external: true, ingestable: false }] }, items: [] },
  'telegram:user:jaxstone_official': { profile: { displayName: 'Jax Stone official', bio: 'gay' }, items: [post('t1')] },
  'x:user:jaxstone': { profile: { displayName: 'Jax Stone', bio: 'gay muscle model' }, items: [post('x1')] },
};

before(async () => {
  prepareEnv({ MASTODON_INSTANCES: 'masto.test', MISSKEY_INSTANCES: 'miss.test' });
  repo = require('../src/db/repo');
  require('../src/settings').update({ redditEnabled: true }); // Reddit is off by default: these tests exercise it
  registry = require('../src/sources');
  lookup = require('../src/engine/lookup');
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
  // Bluesky's people search returns two accounts for the name; the second one is followed under a creator in a test below.
  registry.get('bluesky').searchActors = async (q) => (/jax/i.test(q) ? [
    { handle: 'jaxstone.bsky.social', displayName: 'Jax Stone 💪', description: 'gay model. nsfw', avatar: null, followers: 900 },
    { handle: 'jaxstone2.bsky.social', displayName: 'Jax Stone', description: 'gay model', avatar: null, followers: 40 },
  ] : []);
  registry.get('redgifs').searchCreators = async () => [];
  websearch.search = async () => { const r = [{ url: 'https://x.com/jaxstone', title: 'Jax Stone (@jaxstone) / X', description: 'gay muscle model' }, { url: 'https://example.com/unrelated', title: 'Weather', description: 'sunny' }]; Object.defineProperty(r, 'provider', { value: 'fake' }); return r; };
  websearch.configured = () => true;
  imagefilter._setAnalyzer(async () => ({ status: 'ok', faces: [] }));
  engine.enqueue = () => 0;
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
after(async () => { imagefilter._reset(); await new Promise((r) => server.close(r)); });

/** The keys for one shown account, given how the lookup found it. */
function kinds(query, shownTarget, pool = {}, opts = {}) {
  return lookup.provenanceKinds(
    { sources: new Set(pool.sources || []), revealed: !!pool.revealed },
    { target: shownTarget, sameAs: opts.sameAs || [] },
    { q: lookup.parseQuery(query), paidMatch: !!opts.paidMatch, creatorAliases: opts.creatorAliases || null });
}

describe('provenance rules', () => {
  test('the handle typed is exact, with or without the separators and case of the typed name', () => {
    assert.deepEqual(kinds('jaxstone', 'jaxstone', { sources: ['direct'] }), ['exact']);
    assert.deepEqual(kinds('Jax Stone', 'jaxstone', { sources: ['direct'] }), ['exact'], 'a name typed with a space matches the handle written without one');
    assert.deepEqual(kinds('Jax Stone', 'jax_stone', { sources: ['direct'] }), ['exact'], 'punctuation is not part of the name');
    assert.deepEqual(kinds('@jaxstone', 'jaxstone@mastodon.social', { sources: ['direct'] }), ['exact'], 'a fediverse handle compares by its user part');
  });

  test('another spelling of the typed name is an alias, never an exact match', () => {
    assert.deepEqual(kinds('Jax Stone', 'jaxstone_official', { sources: ['direct'] }), ['alias']);
    assert.deepEqual(kinds('Jax Stone', 'jaxstone.bsky.social', { sources: ['direct'] }), ['alias'], 'the platform suffix is not part of the name');
  });

  test('a fuzzy or unrelated match gets no provenance at all', () => {
    assert.deepEqual(kinds('Jax Stone', 'christianhogue912', { sources: ['direct'] }), []);
    assert.deepEqual(kinds('Jax Stone', 'randomperson', { sources: [] }), []);
  });

  test('backlink: a bio or link-in-bio names it, a paid page points at the query, or a link page or mutual link ties it', () => {
    assert.deepEqual(kinds('Jax Stone', 'jaxstone912', { sources: ['bio-link'] }), ['backlink']);
    assert.deepEqual(kinds('Jax Stone', 'kittyfit99', { sources: ['direct'] }, { paidMatch: true }), ['backlink']);
    assert.deepEqual(kinds('Jax Stone', 'kittyfit99', { sources: ['direct'] }, { sameAs: [{ type: 'link-page', detail: 'both on the link page' }] }), ['backlink']);
    assert.deepEqual(kinds('Jax Stone', 'kittyfit99', { sources: ['direct'] }, { sameAs: [{ type: 'profile-link', detail: 'a and b link to each other' }] }), ['backlink']);
  });

  test('a one-way profile link does not label the account that links out, and a same-creator edge is not a backlink', () => {
    assert.deepEqual(kinds('Jax Stone', 'kittyfit99', { sources: ['direct'] }, { sameAs: [{ type: 'profile-link', detail: 'a links to b' }] }), []);
    assert.deepEqual(kinds('Jax Stone', 'kittyfit99', { sources: ['direct'] }, { sameAs: [{ type: 'same-creator', detail: 'already one creator' }] }), []);
  });

  test('directory: a platform people search or performer directory returned it; web: a web or media search did', () => {
    assert.deepEqual(kinds('Jax Stone', 'mike99', { sources: ['people-search'] }), ['directory']);
    assert.deepEqual(kinds('Jax Stone', 'jaxstone912', { sources: ['web-search'] }), ['web']);
    assert.deepEqual(kinds('Jax Stone', 'jaxstone912', { sources: ['media-search'] }), ['web']);
  });

  test('alias also covers a handle a bio or paid page revealed, and a name PRISM already holds for the creator', () => {
    assert.deepEqual(kinds('Jax Stone', 'hitid42', { sources: ['bio-link'], revealed: true }), ['backlink', 'alias']);
    assert.deepEqual(kinds('Jax Stone', 'jaxstone2', { sources: ['people-search'] }, { creatorAliases: ['jaxstone'] }), ['alias', 'directory']);
    assert.deepEqual(kinds('jaxstone', 'jaxstone', { sources: ['direct'] }, { creatorAliases: ['jaxstone'] }), ['exact'], 'a creator name never relabels the typed handle');
  });

  test('keys come once each, in the canonical order the Find page shows them', () => {
    assert.deepEqual(kinds('Jax Stone', 'jaxstone2', { sources: ['web-search', 'people-search', 'bio-link'] }), ['backlink', 'directory', 'web']);
    assert.deepEqual(lookup.PROVENANCE_ORDER, ['exact', 'backlink', 'alias', 'directory', 'web']);
  });
});

describe('provenance on real lookups', () => {
  test('every shown account has a provenance list made only of canonical keys, and the typed handle is exact on its own platform', async () => {
    const r = await lookup.lookup('Jax Stone');
    assert.ok(r.candidates.length >= 4, JSON.stringify(r.candidates.map((c) => c.platform)));
    for (const c of r.candidates) {
      assert.ok(Array.isArray(c.provenance), `${c.platform}:${c.target} has provenance`);
      assert.ok(c.provenance.every((k) => lookup.PROVENANCE_ORDER.includes(k)), JSON.stringify(c.provenance));
    }
    const by = Object.fromEntries(r.candidates.map((c) => [`${c.platform}:${c.target}`, c]));
    assert.deepEqual(by['x:jaxstone'].provenance, ['exact', 'backlink', 'web'], 'typed handle on x, named on the link page, and in the web search');
    assert.deepEqual(by['reddit:jaxstone'].provenance, ['exact', 'backlink'], 'typed handle; the OnlyFans page it names is the query');
    assert.deepEqual(by['telegram:jaxstone_official'].provenance, ['backlink', 'alias'], 'named on the link page, and another spelling of the name');
    assert.deepEqual(by['bluesky:jaxstone.bsky.social'].provenance, ['backlink', 'alias', 'directory'], 'linked from reddit, in the people search, and the name with a platform suffix');
  });

  test('a creator PRISM already follows: a name it holds for him gives the account an alias, and the follow state is kept', async () => {
    const creator = repo.creators.create({ handle: 'jaxstone_followed', displayName: 'Jax Stone' });
    repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'jaxstone2.bsky.social', creatorId: creator.id, runNow: false });
    repo.db.prepare("INSERT INTO creator_aliases (creator_id, norm, alias, kind, source) VALUES (?, 'jaxstone', 'jaxstone', 'handle', 'admin')").run(creator.id);
    const r = await lookup.lookup('Jax Stone');
    const c = r.candidates.find((x) => x.platform === 'bluesky' && x.target === 'jaxstone2.bsky.social');
    assert.ok(c, 'the followed account is still a candidate');
    assert.equal(c.creatorId, creator.id);
    assert.equal(c.status, 'following');
    assert.deepEqual(c.provenance, ['alias', 'directory'], JSON.stringify(c.provenance));
  });
});

describe('the Find page shows the server keys', () => {
  test('a linked group member row renders its provenance, and the pills come from the server list when it is sent', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'find.js'), 'utf8');
    const member = src.match(/function memberRow\(c\) \{[\s\S]*?\n  \}\n/);
    assert.ok(member, 'memberRow is defined');
    assert.match(member[0], /provenanceRow\(c\)/, 'a grouped account shows why it matched, like a single result');
    assert.match(src, /function provenancePills\(c\)[\s\S]*?Array\.isArray\(c\.provenance\)/, 'the server list is authoritative when present');
    assert.match(src, /function provenanceRow\(c\)[\s\S]*?provenancePills\(c\)/);
  });
});
