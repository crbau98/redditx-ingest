'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let repo; let pipeline; let maintenance; let targets; let discovery; let portability; let feed; let openFeed;
const settings = { probeUnknownHosts: false, scopeMode: 'open' }; // 'open' publishes unclear items: soft wording must still be held

let n = 0;
const item = (o) => ({
  sourceId: `p${++n}`, title: 'Gym selfie', author: 'someguy', community: 'gaybrosgonewild', mediaType: 'image', trusted: true,
  mediaUrl: `https://i.redd.it/img${n}.jpg`, ...o,
});

before(() => {
  prepareEnv();
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  maintenance = require('../src/engine/maintenance');
  targets = require('../src/services/targets');
  discovery = require('../src/engine/discovery');
  portability = require('../src/services/portability');
  feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
  openFeed = repo.feeds.upsert({ platform: 'redgifs', kind: 'search', target: 'gay', trusted: 0, origin: 'admin' }).feed;
});

test('a clean male post is published on a trusted feed', async () => {
  const r = await pipeline.processItem(item({ title: 'Gym selfie' }), feed, null, settings);
  assert.equal(r.outcome, 'added');
});

test('m4f / f4m tags are excluded even on a trusted feed', async () => {
  for (const title of ['m4f anyone?', 'f4m gay bi', '[F] hi']) {
    const r = await pipeline.processItem(item({ title }), feed, null, settings);
    assert.equal(r.outcome, 'excluded', title);
  }
});

test('femboy / trans-feminine posts on a gay community are excluded; so are tags and alt text', async () => {
  assert.equal((await pipeline.processItem(item({ title: 'new pic', tags: ['femboy'] }), feed, null, settings)).outcome, 'excluded');
  assert.equal((await pipeline.processItem(item({ title: 'new pic', altText: 'a trans girl at the beach' }), feed, null, settings)).outcome, 'excluded');
  assert.equal((await pipeline.processItem(item({ title: 'new pic', community: 'sissy_gay' }), feed, null, settings)).outcome, 'excluded');
});

test('an open search needs a male signal; female wording still wins over it', async () => {
  assert.equal((await pipeline.processItem(item({ title: 'sunset', community: null }), openFeed, null, { ...settings, scopeMode: 'strict' })).outcome, 'review');
  assert.equal((await pipeline.processItem(item({ title: 'gay hotwife', community: null }), openFeed, null, settings)).outcome, 'excluded');
});

test('feminine-adjacent wording is held for review whatever the feed trust and scope mode', async () => {
  const r = await pipeline.processItem(item({ title: 'gay man in lingerie' }), feed, null, settings);
  assert.equal(r.outcome, 'review');
  assert.match(r.reason, /^scope:soft:/);
});

test('a female creator profile is blocked as a creator and never re-followed', async () => {
  const ok = await pipeline.processItem(item({ author: 'bro_one', title: 'ok pic' }), feed, null, settings);
  assert.equal(ok.outcome, 'added');
  const cid = ok.creatorId;
  // same account later posts with a profile that reads feminine -> creator blocked, media removed
  const bad = await pipeline.processItem(item({ author: 'bro_one', authorBio: 'trans girl, 22', title: 'pic 2' }), feed, null, settings);
  assert.equal(bad.outcome, 'excluded');
  assert.equal(repo.creators.get(cid).status, 'blocked');
  assert.equal(repo.media.get(ok.mediaId).publish_state, 'removed');
  // a brand-new poster whose name is female is remembered and blocked
  await pipeline.processItem(item({ author: 'SexyGirl92', title: 'pic 3' }), feed, null, settings);
  assert.ok(repo.blocklist.has('creator', 'reddit:sexygirl92'));
  assert.equal((await pipeline.processItem(item({ author: 'SexyGirl92', title: 'pic 4' }), feed, null, settings)).outcome, 'excluded');
});

test('admin cannot add a female creator or community', () => {
  assert.equal(targets.addSpec({ platform: 'reddit', kind: 'community', target: 'girlsgonewild', ingestable: true }).status, 'invalid');
  assert.equal(targets.addSpec({ platform: 'reddit', kind: 'user', target: 'femboy_uwu', ingestable: true }).status, 'invalid');
  assert.match(targets.addCreator({ name: 'Trans Girl Jen', inputs: 'https://x.com/jen' }).error, /male/);
  assert.equal(targets.addSpec({ platform: 'reddit', kind: 'community', target: 'twinks', ingestable: true }).status, 'created');
});

test('discovery rejects female leads for good and never follows them', () => {
  const c = discovery.consider({ platform: 'bluesky', kind: 'user', target: 'jen.bsky.social', label: 'jen', ingestable: true }, 'mention', 'x', { displayName: 'Jen 💕', bio: 'trans girl creator, 18+ onlyfans' });
  assert.ok(c && c.status === 'rejected' && /scope/.test(c.reason), JSON.stringify(c));
  const ok = discovery.consider({ platform: 'bluesky', kind: 'user', target: 'mark.bsky.social', label: 'mark', ingestable: true }, 'mention', 'x', { displayName: 'Mark', bio: 'gay muscle creator, 18+' });
  assert.equal(ok.status, 'pending');
  repo.candidates.update(ok.id, { bio: 'wife and I, f4m', scope: 'in' });
  assert.equal(discovery.follow(ok.id).ok, false);
});

test('config import skips female creators and feeds', () => {
  const out = portability.importConfig({
    format: portability.FORMAT,
    creators: [{ ref: 'a', handle: 'ladyboy_lola', display_name: 'Lola' }, { ref: 'b', handle: 'strongmark', display_name: 'Mark' }],
    feeds: [{ platform: 'reddit', kind: 'community', target: 'milfs', creatorRef: null }, { platform: 'reddit', kind: 'community', target: 'bulges', creatorRef: null }],
  });
  assert.equal(out.creators.rejected, 1); assert.equal(out.creators.created, 1); assert.equal(out.feeds.skipped, 1); assert.equal(out.feeds.created, 1);
});

test('retroactive sweep removes pre-existing female content, blocklists it, blocks creators and switches feeds off', async () => {
  const ins = (title, extra = {}) => repo.media.insert({
    creator_id: null, feed_id: feed.id, platform: 'reddit', source_id: `old${++n}`, source_key: `reddit:old${n}:0`, post_key: `reddit:old${n}`, position: 0,
    source_url: 'https://reddit.com/x', community: 'gaybrosgonewild', author: 'olduser', title, media_type: 'image', media_url: `https://i.redd.it/old${n}.jpg`,
    hash: `hash${n}`, nsfw_level: 'explicit', scope: 'in', publish_state: 'published', posted_at: new Date().toISOString(), ...extra,
  }, ['gay']);
  const good = ins('Nice beach pic');
  const hard = ins('f4m looking for fun');
  const soft = ins('gay guy in panties');
  const viaTag = repo.media.insert({
    creator_id: null, feed_id: feed.id, platform: 'reddit', source_id: 'oldtag', source_key: 'reddit:oldtag:0', post_key: 'reddit:oldtag', position: 0, source_url: 'https://reddit.com/y',
    community: 'gaybrosgonewild', author: 'olduser', title: 'cute pic', media_type: 'image', media_url: 'https://i.redd.it/oldtag.jpg', hash: 'hashtag', nsfw_level: 'explicit', scope: 'in',
    publish_state: 'published', posted_at: new Date().toISOString(),
  }, ['femboy']);
  const femCreator = repo.creators.create({ handle: 'tgirl_amy', displayName: 'Amy', origin: 'ingest' });
  const femFeed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'sexywomen', trusted: 1, origin: 'admin' }).feed;

  const res = await maintenance.sweep();
  assert.ok(res.female >= 2, JSON.stringify(res));
  assert.equal(repo.media.get(good).publish_state, 'published');
  assert.equal(repo.media.get(hard).publish_state, 'removed');
  assert.equal(repo.media.get(viaTag).publish_state, 'removed');
  assert.equal(repo.media.get(soft).publish_state, 'review');
  assert.ok(repo.blocklist.has('hash', 'hash' + (n - 3)) || repo.blocklist.has('hash', 'hashtag'), 'removed items are remembered by hash');
  assert.equal(repo.creators.get(femCreator.id).status, 'blocked');
  assert.equal(repo.feeds.get(femFeed.id).enabled, 0);
  assert.ok(repo.blocklist.has('creator', 'reddit:sexywomen'));
});

test('default settings (strict + drop): soft-female items WITH male wording still reach the review queue; evidence-free items are dropped', async () => {
  const dflt = { probeUnknownHosts: false, scopeMode: 'strict', untrustedUnclear: 'drop' };
  const soft = await pipeline.processItem(item({ title: 'gay guy in panties', community: null }), openFeed, null, dflt);
  assert.equal(soft.outcome, 'review'); assert.match(soft.reason, /^scope:soft:/);
  const none = await pipeline.processItem(item({ title: 'Amateur Cum Cumshot', community: null }), openFeed, null, dflt);
  assert.equal(none.outcome, 'excluded'); assert.equal(none.reason, 'scope:no male signal');
  const kept = await pipeline.processItem(item({ title: 'Amateur Cum Cumshot', community: null }), openFeed, null, { ...dflt, untrustedUnclear: 'review' });
  assert.equal(kept.outcome, 'review', 'the setting can keep them for a human instead');
});
