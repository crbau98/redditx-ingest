'use strict';
/**
 * Wave 3: discovery adapter hardening. Each test pins one production failure seen in /api/admin/logs?level=problems:
 *   1. Bluesky getProfiles / getSuggestedFollowsByActor HTTP 400 on bare names ("Invalid AT identifier")
 *   2. Misskey people search HTTP 404 on users/search-by-username (current servers serve users/search)
 *   3. Reddit subreddit search refused (old.reddit 403/404 from datacenter IPs): Arctic Shift fallback
 *   4. Reddit archive HTTP 422: a rate limit is a wait, a quirky name is cleaned and retried once, else empty
 *   5. gayforfans directory 403/503: the JustTheGays sister directory is read instead
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const http = require('../src/sources/http');

// One fake client for every platform. Routes decide the answer per URL; `calls` records what was asked.
const calls = [];
let route = () => { throw new Error('no route set'); };
const fake = {
  json: async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET', body: opts.body }); return route(url, opts); },
  text: async (url, opts = {}) => { calls.push({ url, method: 'GET', body: undefined }); return route(url, opts); },
};
http.forPlatform = () => fake;

const httpErr = (status, body = '') => Object.assign(new Error(`HTTP ${status}`), { status, body });
const { normalizeBskyActor } = require('../src/lib/bsky-actor');
const discovery = require('../src/engine/discovery');
const bluesky = require('../src/sources/bluesky');
const misskey = require('../src/sources/misskey');
const reddit = require('../src/sources/reddit');
const settings = require('../src/settings');

// ---------------------------------------------------------------- 1. Bluesky actor normalizing

test('normalizeBskyActor turns a bare name into its bsky.social handle and keeps valid actors', () => {
  assert.equal(normalizeBskyActor('Trick'), 'trick.bsky.social');
  assert.equal(normalizeBskyActor('ANONANIMEME'), 'anonanimeme.bsky.social');
  assert.equal(normalizeBskyActor('  @vadimromanovxxx  '), 'vadimromanovxxx.bsky.social');
  assert.equal(normalizeBskyActor('teninchtopx.bsky.social'), 'teninchtopx.bsky.social');
  assert.equal(normalizeBskyActor('Foo.Example.COM'), 'foo.example.com');
  assert.equal(normalizeBskyActor('did:plc:abc123XYZ'), 'did:plc:abc123XYZ', 'a DID keeps its case');
  assert.equal(normalizeBskyActor('did:web:example.com'), 'did:web:example.com');
});

test('normalizeBskyActor returns null for anything the AppView would refuse', () => {
  assert.equal(normalizeBskyActor('my_name'), null, 'underscore is not a Bluesky handle character');
  assert.equal(normalizeBskyActor('two words'), null);
  assert.equal(normalizeBskyActor('ab'), null, 'a bare name needs 3 to 63 characters');
  assert.equal(normalizeBskyActor('a.b'), null, 'a one-letter label and a one-letter TLD are not a domain');
  assert.equal(normalizeBskyActor('trailing.dot.'), null);
  assert.equal(normalizeBskyActor('-leading'), null);
  assert.equal(normalizeBskyActor('https://bsky.app/profile/x.bsky.social'), null);
  assert.equal(normalizeBskyActor(''), null);
  assert.equal(normalizeBskyActor(null), null);
  assert.equal(normalizeBskyActor(undefined), null);
});

test('discovery exports the same normalizer the source adapters use', () => {
  assert.equal(discovery.normalizeBskyActor, normalizeBskyActor);
});

// ---------------------------------------------------------------- 1b. Bluesky batch: one bad actor must not kill the rest

/** A stand-in for the AppView: any actor without a DID or a dot is an "Invalid AT identifier" (HTTP 400) for the whole request. */
function bskyAppView(url) {
  if (!url.includes('getProfiles')) return null;
  const actors = new URL(url).searchParams.getAll('actors');
  const bad = actors.find((a) => !a.startsWith('did:') && !a.includes('.'));
  if (bad) throw httpErr(400, `{"error":"InvalidRequest","message":"Invalid AT identifier (got \\"${bad}\\")"}`);
  return { profiles: actors.map((a) => ({ handle: a.startsWith('did:') ? `${a.slice(-6)}.bsky.social` : a, did: a.startsWith('did:') ? a : `did:plc:${a.length}`, displayName: a })) };
}

test('a valid batch of 25 actors is one request and returns all 25', async () => {
  calls.length = 0;
  const actors = Array.from({ length: 25 }, (_, i) => `user${i}.bsky.social`);
  route = (url) => bskyAppView(url);
  const profiles = await discovery.fetchBskyProfiles(actors);
  assert.equal(profiles.length, 25);
  assert.equal(calls.length, 1);
});

test('one invalid actor in a batch of 25 is isolated: the other 24 profiles come back and the bad one is reported', async () => {
  calls.length = 0;
  const actors = ['Trick', ...Array.from({ length: 24 }, (_, i) => `good${i}.bsky.social`)];
  route = (url) => bskyAppView(url);
  const rejected = [];
  const profiles = await discovery.fetchBskyProfiles(actors, rejected);
  assert.equal(profiles.length, 24);
  assert.deepEqual(rejected, ['Trick']);
  assert.ok(calls.length <= 11, `bisection stays logarithmic, saw ${calls.length} requests`);
});

test('a batch with a 400 in the middle of the list still returns the valid profiles on both sides', async () => {
  calls.length = 0;
  const actors = ['a1.bsky.social', 'a2.bsky.social', 'bad_one', 'a3.bsky.social', 'a4.bsky.social'];
  route = (url) => bskyAppView(url);
  const rejected = [];
  const profiles = await discovery.fetchBskyProfiles(actors, rejected);
  assert.deepEqual(profiles.map((p) => p.handle).sort(), ['a1.bsky.social', 'a2.bsky.social', 'a3.bsky.social', 'a4.bsky.social']);
  assert.deepEqual(rejected, ['bad_one']);
});

test('a non-400 failure is not swallowed: it reaches the caller as before', async () => {
  route = () => { throw httpErr(500, 'boom'); };
  await assert.rejects(() => discovery.fetchBskyProfiles(['x.bsky.social']), (e) => e.status === 500);
});

test('an empty actor list makes no request', async () => {
  calls.length = 0;
  assert.deepEqual(await discovery.fetchBskyProfiles([]), []);
  assert.equal(calls.length, 0);
});

test('suggested follows for a bare name ask for its bsky.social handle, and an unusable name makes no request', async () => {
  calls.length = 0;
  route = (url) => {
    if (!url.includes('getSuggestedFollowsByActor')) return null;
    const actor = new URL(url).searchParams.get('actor');
    if (!actor.includes('.')) throw httpErr(400, 'Invalid AT identifier');
    return { suggestions: [{ handle: 'similar.bsky.social', did: 'did:plc:similar', displayName: 'Similar' }] };
  };
  const out = await bluesky.suggestedFor('Trick');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('actor=trick.bsky.social'), calls[0].url);
  assert.equal(out.length, 1);
  calls.length = 0;
  assert.deepEqual(await bluesky.suggestedFor('two words'), []);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- 2. Misskey people search

test('Misskey people search uses users/search and does not touch the older endpoint', async () => {
  calls.length = 0;
  route = (url, opts) => {
    if (url.endsWith('/api/users/search')) {
      return [{ username: 'alice', host: null, name: 'Alice', description: 'hi', avatarUrl: null, followersCount: 4 }];
    }
    return null;
  };
  const users = await misskey.searchUsers('alice', 'misskey.io', 10);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/users/search'), calls[0].url);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.query, 'alice');
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 0);
  assert.equal(body.localOnly, true);
  assert.equal(users.length, 1);
  assert.equal(users[0].username, 'alice');
  assert.equal(users[0].host, 'misskey.io', 'a local user takes the instance it was asked on');
});

test('Misskey people search falls back to users/search-by-username only when users/search answers 404', async () => {
  calls.length = 0;
  route = (url) => {
    if (url.endsWith('/api/users/search')) throw httpErr(404, 'not found');
    if (url.endsWith('/api/users/search-by-username')) return [{ username: 'bob', host: 'other.social', name: 'Bob' }];
    return null;
  };
  const users = await misskey.searchUsers('bob', 'misskey.social', 5);
  assert.deepEqual(calls.map((c) => c.url.split('/api/')[1]), ['users/search', 'users/search-by-username']);
  const body = JSON.parse(calls[1].body);
  assert.equal(body.username, 'bob');
  assert.equal(body.limit, 5);
  assert.equal(body.local, true);
  assert.equal(users[0].host, 'other.social');
});

test('Misskey people search does not fall back on any error other than 404', async () => {
  calls.length = 0;
  route = () => { throw httpErr(500, 'server error'); };
  await assert.rejects(() => misskey.searchUsers('carl', 'misskey.io', 10), (e) => e.status === 500);
  assert.equal(calls.length, 1, 'no second request');
});

// ---------------------------------------------------------------- 3. Reddit subreddit search with the Arctic Shift fallback

const archiveRow = {
  display_name: 'GayMuscleWorship', title: 'Muscle Worship', public_description: 'Sharing muscle worship.', subscribers: 51834, over18: true,
  community_icon: 'https://styles.redditmedia.com/t5_2xaak/communityIcon.jpg?width=256&s=abc', icon_img: '',
};

test('Reddit subreddit search: when Reddit refuses, the Arctic Shift subreddit search answers', async () => {
  calls.length = 0;
  settings.update({ redditEnabled: true });
  route = (url) => {
    if (url.includes('arctic-shift') && url.includes('/api/subreddits/search')) return { data: [archiveRow, { display_name: '' }] };
    if (url.includes('reddit.com')) throw httpErr(404, 'not found');
    return null;
  };
  const found = await reddit.searchSubreddits('gay muscle', 25);
  const archiveCall = calls.find((c) => c.url.includes('/api/subreddits/search'));
  assert.ok(archiveCall, 'archive was asked');
  assert.equal(new URL(archiveCall.url).searchParams.get('subreddit_prefix'), 'gaymuscle', 'spaces are removed from the prefix');
  assert.ok(archiveCall.url.includes('limit=15'));
  assert.equal(found.length, 1, 'rows without a name are dropped');
  assert.deepEqual(
    { name: found[0].name, title: found[0].title, subscribers: found[0].subscribers, over18: found[0].over18 },
    { name: 'GayMuscleWorship', title: 'Muscle Worship', subscribers: 51834, over18: true },
  );
  assert.equal(found[0].description, 'Sharing muscle worship.');
  assert.equal(found[0].icon, 'https://styles.redditmedia.com/t5_2xaak/communityIcon.jpg', 'the icon drops its query string');
});

test('Reddit subreddit search: an empty answer from Reddit is also checked against the archive', async () => {
  calls.length = 0;
  settings.update({ redditEnabled: true });
  route = (url) => {
    if (url.includes('arctic-shift')) return { data: [archiveRow] };
    if (url.includes('reddit.com')) return { data: { children: [] } };
    return null;
  };
  const found = await reddit.searchSubreddits('gay muscle', 25);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'GayMuscleWorship');
});

test('Reddit subreddit search: when both refuse, Reddit\'s own error is reported, not the archive\'s', async () => {
  calls.length = 0;
  settings.update({ redditEnabled: true });
  route = (url) => {
    if (url.includes('arctic-shift')) throw httpErr(500, 'archive down');
    throw httpErr(404, 'not found');
  };
  await assert.rejects(() => reddit.searchSubreddits('gay muscle', 25), (e) => e.status === 404);
});

test('Reddit subreddit search makes no request when Reddit is off', async () => {
  calls.length = 0;
  settings.update({ redditEnabled: false });
  route = () => { throw new Error('should not be called'); };
  assert.deepEqual(await reddit.searchSubreddits('gay muscle', 25), []);
  assert.equal(calls.length, 0);
  settings.update({ redditEnabled: true });
});

// ---------------------------------------------------------------- 4. Reddit archive posts: 422 handling

const archiveOk = [{ id: 'abc123', subreddit: 'tradesnsfw', created_utc: 1 }];

test('archive 422 on a quirky name is retried once with letters, digits, _ and - only', async () => {
  calls.length = 0;
  route = (url) => {
    if (!url.includes('/api/posts/search')) return null;
    const sub = new URL(url).searchParams.get('subreddit'); // decoded: the query string encodes spaces and "!"
    if (sub !== 'tradesnsfw' && /[^A-Za-z0-9_-]/.test(sub)) throw httpErr(422, '{"error":"invalid subreddit"}');
    if (sub === 'tradesnsfw') return { data: archiveOk };
    throw httpErr(500, 'unexpected');
  };
  const rows = await discovery.archivePosts({ subreddit: 'trade snsfw!' });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 2, 'one retry, not a loop');
  assert.ok(calls[1].url.includes('subreddit=tradesnsfw'), calls[1].url);
  assert.ok(calls[1].url.includes('limit=100'), 'the lookback stays at the archive maximum');
});

test('archive 422 on a name with nothing to clean is a clean empty result, not an error', async () => {
  calls.length = 0;
  route = (url) => { if (url.includes('/api/posts/search')) throw httpErr(422, '{"error":"invalid author"}'); return null; };
  assert.deepEqual(await discovery.archivePosts({ author: 'validname' }), []);
  assert.equal(calls.length, 1, 'no retry when the cleaned name is the same');
});

test('archive 422 "slow down" is a rate limit: it is thrown as a wait, never an empty result', async () => {
  calls.length = 0;
  route = (url) => { if (url.includes('/api/posts/search')) throw httpErr(422, 'Timeout. Maybe slow down a bit'); return null; };
  await assert.rejects(() => discovery.archivePosts({ subreddit: 'gaymuscle' }), (e) => e.status === 429 && e.retryAfter > 0);
});

test('archive 422 on the retry that turns out to be a rate limit is also a wait', async () => {
  calls.length = 0;
  route = (url) => {
    if (url.includes('subreddit=tradesnsfw')) throw httpErr(422, 'Timeout. Maybe slow down a bit');
    throw httpErr(422, 'invalid');
  };
  await assert.rejects(() => discovery.archivePosts({ subreddit: 'trade snsfw!' }), (e) => e.status === 429);
});

test('archive errors other than 422 are not swallowed', async () => {
  calls.length = 0;
  route = () => { throw httpErr(503, 'unavailable'); };
  await assert.rejects(() => discovery.archivePosts({ subreddit: 'gaymuscle' }), (e) => e.status === 503);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- 5. gayforfans directory: JustTheGays fallback

const gffHtml = '<a href="/performer/alex-stone-1a2b">#1 Alex Stone</a>';
const jtgHtml = '<a href="/performer/mark-hill-c3d4">#1 Mark Hill</a>';

test('a gayforfans directory page that loads is read from gayforfans, not JustTheGays', async () => {
  calls.length = 0;
  route = (url) => (url.startsWith('https://gayforfans.com/performer') ? gffHtml : null);
  const r = await discovery.fetchPerformerDirectory(fake, 0);
  assert.equal(r.host, 'https://gayforfans.com');
  assert.equal(r.html, gffHtml);
  assert.equal(calls.length, 1);
});

test('gayforfans 403 falls back to the JustTheGays directory for the same page', async () => {
  calls.length = 0;
  route = (url) => {
    if (url.startsWith('https://gayforfans.com/')) throw httpErr(403, 'forbidden');
    if (url.startsWith('https://justthegays.tv/performer')) return jtgHtml;
    return null;
  };
  const r = await discovery.fetchPerformerDirectory(fake, 1);
  assert.equal(r.host, 'https://justthegays.tv');
  assert.equal(r.html, jtgHtml);
  assert.deepEqual(calls.map((c) => c.url), ['https://gayforfans.com/performer?page=2', 'https://justthegays.tv/performer?page=2']);
});

test('gayforfans 503 also falls back to JustTheGays', async () => {
  calls.length = 0;
  route = (url) => {
    if (url.startsWith('https://gayforfans.com/')) throw httpErr(503, 'unavailable');
    return jtgHtml;
  };
  const r = await discovery.fetchPerformerDirectory(fake, 0);
  assert.equal(r.host, 'https://justthegays.tv');
  assert.equal(calls[1].url, 'https://justthegays.tv/performer');
});

test('a gayforfans 404 is not a refusal: it is thrown and JustTheGays is not asked', async () => {
  calls.length = 0;
  route = () => { throw httpErr(404, 'gone'); };
  await assert.rejects(() => discovery.fetchPerformerDirectory(fake, 0), (e) => e.status === 404);
  assert.equal(calls.length, 1);
});

test('when JustTheGays also refuses, its error is what the caller sees', async () => {
  calls.length = 0;
  route = (url) => { throw httpErr(url.startsWith('https://gayforfans.com') ? 403 : 429, 'refused'); };
  await assert.rejects(() => discovery.fetchPerformerDirectory(fake, 0), (e) => e.status === 429);
  assert.equal(calls.length, 2);
});
