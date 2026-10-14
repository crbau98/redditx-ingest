'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/mock').prepareEnv();

const repo = require('../src/db/repo');
const settingsStore = require('../src/settings');
const identity = require('../src/engine/identity');
const { applyProfile } = require('../src/engine/creators');
const { normAlias, usableAlias } = require('../src/lib/alias');

const settings = () => settingsStore.get();
const person = (handle, platform = 'x', extra = {}) => {
  const c = repo.creators.create({ handle, origin: 'admin', ...extra });
  const f = repo.feeds.upsert({ platform, kind: 'user', target: handle, creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin', runNow: false }).feed;
  return { c, f: repo.feeds.get(f.id) };
};

describe('alias keys', () => {
  test('case, punctuation, @, instance and bsky suffix all collapse', () => {
    for (const s of ['@Jake.Fit', 'jake_fit@mastodon.social', 'jakefit.bsky.social', 'JAKE FIT']) assert.equal(normAlias(s), 'jakefit');
    assert.equal(usableAlias('jakefit'), true);
    assert.equal(usableAlias('gym'), false);
    assert.equal(usableAlias('1234'), false);
  });

  test('aliases his own bio names as other accounts, not shout-outs', () => {
    assert.deepEqual(identity.bioAliases('backup account: @jakefit2 | new acc @JakeLifts. formerly @jake_old'), ['jakefit2', 'JakeLifts', 'jake_old']);
    assert.deepEqual(identity.bioAliases('main got banned, now @jakeagain'), ['jakeagain']);
    assert.deepEqual(identity.bioAliases('go follow my bf @tomlifts and @gymbuddy'), []);
  });
});

describe('creator identity', () => {
  test('a profile records his handles and names, and search finds him by any of them', () => {
    const { c, f } = person('marcus_lifts');
    applyProfile(f, { displayName: 'Marcus Steel', bio: 'aka @steelmarcus' }, settings());
    const names = identity.aliasesOf(c.id).map((a) => a.norm);
    for (const n of ['marcuslifts', 'marcussteel', 'steelmarcus']) assert.ok(names.includes(n), n);
    assert.ok(repo.creators.list({ q: 'steelmarcus', admin: true }).items.some((x) => x.id === c.id));
    assert.ok(identity.findByAlias('@Steel.Marcus').some((x) => x.id === c.id));
    const detail = repo.creators.detail(c.id);
    assert.ok(detail.aliases.some((a) => a.alias === 'Marcus Steel'));
    assert.ok(!detail.aliases.some((a) => a.alias === 'steelmarcus'), 'bio-claimed handles are not shown as confirmed names');
  });

  test('a bio-named backup handle nobody has yet becomes a discovery lead for him', () => {
    const { c, f } = person('ollie_runs');
    applyProfile(f, { displayName: 'Ollie', bio: 'backup: @ollie_runs2' }, settings());
    const cand = repo.candidates.find('x', 'user', 'ollie_runs2');
    assert.ok(cand, 'queued in discovery');
    assert.equal(cand.creator_id, c.id);
  });

  test('profiles that link each other with the same name merge on their own; media and names move across', () => {
    const a = person('dante_fit', 'x');
    const b = person('dante_fit.bsky.social', 'bluesky');
    repo.media.insert({ creator_id: b.c.id, feed_id: b.f.id, platform: 'bluesky', source_id: 'd1', source_key: 'bluesky:d1:0', post_key: 'bluesky:d1', source_url: 'https://bsky.app/x', title: 'pump', media_type: 'image', media_url: 'https://cdn.bsky.app/d1.jpg', hash: 'h-d1', publish_state: 'published' });
    applyProfile(a.f, { displayName: 'Dante', bio: 'gym', links: [{ platform: 'bluesky', kind: 'user', target: 'dante_fit.bsky.social', ingestable: true }] }, settings());
    // one direction + same handle key: 2 points, below the bar
    assert.ok(repo.creators.get(a.c.id) && repo.creators.get(b.c.id));
    applyProfile(b.f, { displayName: 'Dante', bio: 'gym', links: [{ platform: 'x', kind: 'user', target: 'dante_fit', ingestable: true }] }, settings());
    const left = [a.c.id, b.c.id].filter((id) => repo.creators.get(id));
    assert.equal(left.length, 1, 'merged into one');
    const kept = left[0];
    assert.equal(repo.feeds.find('x', 'user', 'dante_fit').creator_id, kept);
    assert.equal(repo.feeds.find('bluesky', 'user', 'dante_fit.bsky.social').creator_id, kept);
    assert.ok(repo.db.prepare('SELECT COUNT(*) AS n FROM media WHERE creator_id = ?').get(kept).n >= 1);
  });

  test('a merge triggered mid-profile finishes the profile first, then keeps the decision as history', () => {
    const a = person('kai_strong', 'x');
    const b = person('kai_strong.bsky.social', 'bluesky');
    for (const k of ['k1', 'k2']) repo.media.insert({ creator_id: b.c.id, feed_id: b.f.id, platform: 'bluesky', source_id: k, source_key: `bluesky:${k}:0`, post_key: `bluesky:${k}`, source_url: 'https://bsky.app/x', title: 'lift', media_type: 'image', media_url: `https://cdn.bsky.app/${k}.jpg`, hash: `h-${k}`, publish_state: 'published' });
    repo.creators.refreshStats(b.c.id);
    applyProfile(b.f, { displayName: 'Kai', bio: 'gym', links: [{ platform: 'x', kind: 'user', target: 'kai_strong', ingestable: true }] }, settings());
    // A has fewer posts, so A is the one merged away, in the middle of his own profile: a link that tips the merge,
    // then another account and an OnlyFans page that must still land on the creator who survives.
    let r;
    assert.doesNotThrow(() => { r = applyProfile(a.f, { displayName: 'Kai', bio: 'gym', links: [
      { platform: 'bluesky', kind: 'user', target: 'kai_strong.bsky.social', ingestable: true },
      { platform: 'redgifs', kind: 'user', target: 'kaistrongclips', ingestable: true },
      { external: true, service: 'OnlyFans', handle: 'kaistrongfree', url: 'https://onlyfans.com/kaistrongfree' },
    ] }, settings()); });
    assert.equal(r.mergedInto, b.c.id);
    assert.equal(repo.creators.get(a.c.id), null);
    assert.equal(repo.feeds.find('redgifs', 'user', 'kaistrongclips').creator_id, b.c.id);
    assert.ok(repo.creators.get(b.c.id).links.some((l) => l.handle === 'kaistrongfree'));
    assert.equal(repo.onlyfans.get('kaistrongfree').creator_id, b.c.id);
    const done = identity.queue({ status: 'merged' }).items.find((l) => l.kept_id === b.c.id);
    assert.ok(done, 'decision kept as history');
    const gone = [done.a, done.b].find((c) => c.id === a.c.id);
    assert.equal(gone.gone, true); assert.equal(gone.handle, 'kai_strong');
  });

  test('an admin merge from the Creators tab is recorded too, and moves open suggestions to the survivor', () => {
    const a = person('noah_keep'); const b = person('noah_gone'); const c = person('noahthird');
    identity.noteLink(b.c.id, c.c.id, { type: 'bio-link', from: b.c.id, detail: 'x:noahthird' });
    identity.mergeCreators(a.c.id, b.c.id);
    assert.ok(identity.queue({ status: 'merged' }).items.some((l) => l.kept_id === a.c.id && l.evidence.some((e) => e.type === 'admin')));
    const moved = identity.queue().items.find((l) => [l.a.id, l.b.id].includes(c.c.id));
    assert.ok(moved && [moved.a.id, moved.b.id].includes(a.c.id), 'suggestion now points at the survivor');
  });

  test('a couple who link each other but use different names wait for the admin', () => {
    const a = person('ryan_and_co', 'x');
    const b = person('lukepump', 'x');
    applyProfile(a.f, { displayName: 'Ryan', bio: 'with my bf', links: [{ platform: 'x', kind: 'user', target: 'lukepump', ingestable: true }] }, settings());
    applyProfile(b.f, { displayName: 'Luke', bio: 'with my bf', links: [{ platform: 'x', kind: 'user', target: 'ryan_and_co', ingestable: true }] }, settings());
    assert.ok(repo.creators.get(a.c.id) && repo.creators.get(b.c.id), 'both still there');
    const q = identity.queue();
    const link = q.items.find((l) => [l.a.id, l.b.id].sort().join() === [a.c.id, b.c.id].sort().join());
    assert.ok(link, 'queued');
    assert.equal(link.strength, 4); // a bio link each way (2) + mutual (2)
    assert.equal(link.sameName, false);
    assert.equal(identity.reject(link.id), true);
    applyProfile(a.f, { displayName: 'Ryan', bio: 'with my bf', links: [{ platform: 'x', kind: 'user', target: 'lukepump', ingestable: true }] }, settings());
    assert.equal(identity.queue({ status: 'rejected' }).items.filter((l) => l.id === link.id).length, 1, 'stays rejected');
  });

  test('scan pairs creators who promote the same OnlyFans page; the admin merges, aliases carried over', () => {
    const a = person('benny_x', 'x');
    const b = person('bennyreds', 'redgifs');
    repo.creators.enrich(a.c.id, { links: [{ platform: 'external', service: 'OnlyFans', handle: 'bennyfree', url: 'https://onlyfans.com/bennyfree' }] });
    repo.creators.update(b.c.id, { bio: 'free page onlyfans.com/bennyfree' });
    const r = identity.scan();
    assert.ok(r.links >= 1);
    const link = identity.queue().items.find((l) => [l.a.id, l.b.id].includes(a.c.id));
    assert.ok(link && link.evidence.some((e) => e.type === 'same-onlyfans'));
    const kept = identity.merge(link.id, { keepId: a.c.id });
    assert.equal(kept.id, a.c.id);
    assert.equal(repo.creators.get(b.c.id), null);
    assert.ok(identity.aliasesOf(a.c.id).some((x) => x.norm === 'bennyreds'));
  });

  test('the admin can add and remove an alias', () => {
    const { c } = person('quinnlift');
    identity.addAlias(c.id, 'Quinn Harper', { kind: 'name', source: 'admin' });
    assert.ok(repo.creators.list({ q: 'quinnharp', admin: true }).items.some((x) => x.id === c.id));
    assert.equal(identity.removeAlias(c.id, 'Quinn Harper'), true);
  });
});
