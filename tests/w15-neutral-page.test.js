'use strict';
/** Crucible nit 5: the "profile" of a neutral aggregator page (a feed PRISM attached on its own) never enriches the man. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const { applyProfile } = require('../src/engine/creators');
const settings = () => require('../src/settings').get();

let n = 0;
// display name = handle and no bio: exactly the state enrich() would fill from a page
const man = () => { n++; return repo.creators.create({ handle: `neutralman${n}`, displayName: `neutralman${n}`, origin: 'admin' }); };
const feed = (cid, platform, kind, target, origin) => repo.feeds.get(repo.feeds.upsert({ platform, kind, target, creatorId: cid, origin, runNow: false }).feed.id);
const PAGE = { displayName: 'Bigggwild - Free OnlyFans Leaks Hub', bio: 'Free leaks hub, thousands of videos, download now', avatarUrl: 'https://img.example/a.jpg', links: [] };
const aliases = (id) => repo.db.prepare('SELECT alias, source FROM creator_aliases WHERE creator_id = ?').all(id);

test('automatic feed on an aggregator host: no display name, bio or alias from the page', () => {
  for (const origin of ['deep-search', 'discovered', 'linked', 'coverage']) {
    const c = man(); const before = repo.creators.get(c.id); const aliasesBefore = aliases(c.id).length;
    assert.equal(before.bio || null, null);
    const f = feed(c.id, 'web', 'page', `https://thefap.net/neutral${n}-${origin}`, origin);
    const out = applyProfile(f, PAGE, settings());
    assert.equal(out.blocked, false, origin);
    const after = repo.creators.get(c.id);
    assert.equal(after.display_name, before.display_name, `${origin}: display name untouched`);
    assert.ok(!after.bio, `${origin}: bio untouched`);
    assert.equal(aliases(c.id).length, aliasesBefore, `${origin}: no alias added`);
    assert.ok(!aliases(c.id).some((a) => a.source === 'profile' || /Leaks Hub/i.test(a.alias)), 'no profile alias');
  }
});

test('his OWN feed (admin) on the same page, and an automatic feed on a non-aggregator page, still enrich as before', () => {
  const c = man(); const f = feed(c.id, 'web', 'page', `https://thefap.net/neutralown${n}`, 'admin');
  applyProfile(f, PAGE, settings());
  assert.equal(repo.creators.get(c.id).display_name, PAGE.displayName, 'own feed: profile applied');
  assert.ok(aliases(c.id).some((a) => a.source === 'profile'), 'own feed: profile alias written');
  const d = man(); const g = feed(d.id, 'web', 'page', `https://his-own-site.example/neutral${n}`, 'discovered');
  applyProfile(g, { displayName: 'His Own Site', bio: 'real bio here', links: [] }, settings());
  assert.equal(repo.creators.get(d.id).display_name, 'His Own Site', 'non-aggregator host: profile applied');
});

test('the safety and scope checks still run on a neutral page (the feed is quarantined, he is not touched)', () => {
  const c = man(); const f = feed(c.id, 'web', 'page', `https://thefap.net/neutralfem${n}`, 'deep-search');
  const out = applyProfile(f, { displayName: 'x', bio: 'leaked girls from Onlyfans, her nudes, she is a model' }, settings());
  assert.equal(out.blocked, false);
  assert.equal(repo.creators.get(c.id).display_name, `neutralman${n}`);
});
