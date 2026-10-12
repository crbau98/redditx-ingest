'use strict';
/**
 * Bluesky ingestion against a mock AppView + PDS: author feed paging, reposts, labels, video, search login
 * (JWT caching / refresh / bad credentials), "gone" mapping, and the end-to-end path into media rows.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let appview; let pds; let repo; let engine; let bsky;
const logins = []; // createSession bodies
let searchAuth = []; // Authorization headers seen by searchPosts
let rejectNextSearch = false; let badPassword = false;
const hits = { author: [] };

const jwt = (expSec) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.sig`;
const author = { did: 'did:plc:zed', handle: 'zed.bsky.social', displayName: 'Zed', avatar: 'https://cdn.bsky.app/img/avatar/zed' };
const img = (n) => ({ thumb: `https://cdn.bsky.app/img/feed_thumbnail/${n}`, fullsize: `https://cdn.bsky.app/img/feed_fullsize/${n}`, alt: 'gay gym selfie', aspectRatio: { width: 3, height: 4 } });
const post = (rkey, createdAt, embed, extra = {}) => ({
  post: { uri: `at://did:plc:zed/app.bsky.feed.post/${rkey}`, cid: 'c', author, record: { text: 'Gay gym selfie #gay', createdAt }, indexedAt: createdAt, likeCount: 3, repostCount: 1, embed, ...extra.post },
  ...(extra.reason ? { reason: extra.reason } : {}),
});
const images = (n) => ({ $type: 'app.bsky.embed.images#view', images: [img(n)] });
const video = { $type: 'app.bsky.embed.video#view', playlist: 'https://video.bsky.app/watch/did%3Aplc%3Azed/cid/playlist.m3u8', thumbnail: 'https://video.bsky.app/watch/did%3Aplc%3Azed/cid/thumbnail.jpg', aspectRatio: { width: 9, height: 16 } };

before(async () => {
  appview = await start({
    '/xrpc/app.bsky.feed.getAuthorFeed': (req, res, url) => {
      hits.author.push(url.search);
      const actor = url.searchParams.get('actor');
      if (actor === 'gone.bsky.social') return { status: 400, json: { error: 'InvalidRequest', message: 'Profile not found' } };
      assert.equal(url.searchParams.get('filter'), 'posts_with_media');
      assert.ok(Number(url.searchParams.get('limit')) <= 100);
      if (!url.searchParams.get('cursor')) {
        return { json: { cursor: 'page2', feed: [
          post('3kaaa', '2026-10-03T10:00:00Z', images('a')),
          // a repost of someone else's media: the original poster owns it
          post('3krep', '2026-10-03T09:00:00Z', images('r'), { reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: author } }),
          post('3kvid', '2026-10-03T08:00:00Z', video, { post: { labels: [{ val: 'porn' }] } }),
        ] } };
      }
      return { json: { feed: [
        // self-label lives only on the record here
        post('3kbbb', '2026-10-02T10:00:00Z', images('b'), { post: { record: { text: 'Gay beach day', createdAt: '2026-10-02T10:00:00Z', labels: { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'sexual' }] } } } }),
        post('3kinv', '2026-10-01T10:00:00Z', images('i'), { post: { author: { ...author, handle: 'handle.invalid' } } }),
      ] } };
    },
    '/xrpc/app.bsky.actor.getProfile': () => ({ json: { handle: 'zed.bsky.social', displayName: 'Zed', description: 'gay fitness. https://x.com/zedfit', avatar: 'https://cdn.bsky.app/img/avatar/zed' } }),
    '/xrpc/app.bsky.feed.searchPosts': () => ({ status: 403, json: { error: 'Forbidden', message: 'Bad token' } }),
    '/xrpc/com.atproto.identity.resolveHandle': (req, res, url) => (url.searchParams.get('handle') === 'zed.bsky.social' ? { json: { did: 'did:plc:zed' } } : { status: 400, json: { error: 'InvalidRequest', message: 'Unable to resolve handle' } }),
    '/xrpc/app.bsky.feed.getFeed': (req, res, url) => {
      assert.equal(url.searchParams.get('feed'), 'at://did:plc:zed/app.bsky.feed.generator/gaymuscle', 'handle resolved to a DID');
      return { json: { feed: [post('3kfeed', '2026-10-04T10:00:00Z', images('f'))] } };
    },
    '/xrpc/app.bsky.feed.getListFeed': (req, res, url) => {
      assert.equal(url.searchParams.get('list'), 'at://did:plc:zed/app.bsky.graph.list/muscle');
      return { json: { feed: [post('3klist', '2026-10-04T11:00:00Z', images('l'))] } };
    },
  });
  pds = await start({
    '/xrpc/com.atproto.server.createSession': (req) => {
      const body = JSON.parse(req.bodyText); logins.push(body);
      if (badPassword) return { status: 401, json: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } };
      assert.equal(body.identifier, 'me.bsky.social'); assert.equal(body.password, 'abcd-efgh-ijkl-mnop');
      return { json: { accessJwt: jwt(Math.floor(Date.now() / 1000) + 7200), refreshJwt: 'r', did: 'did:plc:me' } };
    },
    '/xrpc/app.bsky.feed.searchPosts': (req, res, url) => {
      searchAuth.push(req.headers.authorization);
      if (rejectNextSearch) { rejectNextSearch = false; return { status: 400, json: { error: 'ExpiredToken', message: 'Token has expired' } }; }
      assert.equal(url.searchParams.get('q'), 'gay muscle');
      return { json: { posts: [post('3ksearch', '2026-10-05T10:00:00Z', images('s')).post] } };
    },
  });
  prepareEnv({ BSKY_BASE_URL: appview.url, BSKY_PDS_URL: pds.url, BSKY_IDENTIFIER: 'me.bsky.social', BSKY_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  bsky = require('../src/sources/bluesky');
});
after(async () => { engine.shutdown(); await appview.close(); await pds.close(); });

const ctx = (extra = {}) => ({ cursor: {}, aborted: () => false, needProfile: false, ...extra });

test('author feed: follows the cursor, keeps originals, drops reposts, labels from the record count', async () => {
  const feed = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'zed.bsky.social', trusted: 1, origin: 'admin' }).feed;
  const r = await engine.runFeed(feed, 'manual');
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(hits.author.length, 2, 'second page requested via cursor');
  assert.match(hits.author[1], /cursor=page2/);
  const rows = repo.media.list({ limit: 50, state: 'any', admin: true }).items.filter((m) => m.platform === 'bluesky');
  assert.equal(rows.length, 4, rows.map((m) => m.source_id).join());
  assert.ok(!rows.some((m) => /3krep/.test(m.source_id)), 'repost skipped');
  const vid = rows.find((m) => /3kvid/.test(m.source_id));
  assert.equal(vid.media_type, 'video'); assert.match(vid.hls_url, /playlist\.m3u8$/); assert.equal(vid.nsfw_level, 'explicit');
  assert.equal(rows.find((m) => /3kbbb/.test(m.source_id)).nsfw_level, 'explicit', 'self-label on the record only');
  assert.equal(rows.find((m) => /3kaaa/.test(m.source_id)).nsfw_level, 'suggestive');
  assert.equal(rows.find((m) => /3kaaa/.test(m.source_id)).source_url, 'https://bsky.app/profile/zed.bsky.social/post/3kaaa');
  assert.equal(rows.find((m) => /3kinv/.test(m.source_id)).source_url, 'https://bsky.app/profile/did:plc:zed/post/3kinv', 'handle.invalid falls back to the DID');
});

test('a second run stops at the newest known post instead of paging on', async () => {
  const feed = repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'zed.bsky.social', trusted: 1, origin: 'admin' }).feed;
  hits.author.length = 0;
  const out = await bsky.fetch(feed, ctx({ cursor: { newestAt: '2026-10-03T10:00:00.000Z' } }));
  assert.equal(out.items.length, 0);
  assert.equal(hits.author.length, 1);
});

test('deleted / renamed accounts (HTTP 400 Profile not found) are reported as gone, not retried forever', async () => {
  await assert.rejects(() => bsky.fetch({ kind: 'user', target: 'gone.bsky.social' }, ctx()), (e) => e.status === 404 && /not found/i.test(e.message));
});

test('custom feeds and lists resolve at://handle/... to a DID first', async () => {
  const f = await bsky.fetch({ kind: 'feedgen', target: 'at://zed.bsky.social/app.bsky.feed.generator/gaymuscle' }, ctx());
  assert.equal(f.items.length, 1);
  const l = await bsky.fetch({ kind: 'list', target: 'at://zed.bsky.social/app.bsky.graph.list/muscle' }, ctx());
  assert.equal(l.items[0].sourceId, 'did:plc:zed:3klist');
  await assert.rejects(() => bsky.fetch({ kind: 'feedgen', target: 'at://nobody.example/app.bsky.feed.generator/x' }, ctx()), (e) => e.status === 404);
});

test('search logs in once, goes through the PDS with the bearer token and caches the session', async () => {
  bsky._resetSession(); logins.length = 0; searchAuth = [];
  const a = await bsky.fetch({ kind: 'search', target: 'gay muscle' }, ctx());
  const b = await bsky.fetch({ kind: 'search', target: 'gay muscle' }, ctx());
  assert.equal(a.items.length, 1); assert.equal(a.items[0].query, 'gay muscle'); assert.equal(b.items.length, 1);
  assert.equal(logins.length, 1, 'JWT cached across runs');
  assert.ok(searchAuth.every((h) => /^Bearer ey/.test(h) || /^Bearer [\w-]+\.[\w-]+\.sig$/.test(h)), searchAuth.join());
  assert.equal(appview.hits.filter((h) => /searchPosts/.test(h)).length, 0, 'never uses the public AppView for search (403 since 2025)');
});

test('search re-logs in when the access token has expired', async () => {
  bsky._resetSession(); logins.length = 0; searchAuth = [];
  await bsky.sessionToken();
  rejectNextSearch = true;
  const out = await bsky.fetch({ kind: 'search', target: 'gay muscle' }, ctx());
  assert.equal(out.items.length, 1);
  assert.equal(logins.length, 2, 'second login after ExpiredToken');
});

test('rejected app password is a clear, non-systemic (skip) error', async () => {
  bsky._resetSession(); badPassword = true;
  try {
    await assert.rejects(() => bsky.fetch({ kind: 'search', target: 'gay muscle' }, ctx()), (e) => e.skip === true && /BSKY_APP_PASSWORD/.test(e.message));
  } finally { badPassword = false; bsky._resetSession(); }
});

test('profile bio links are extracted for the creator', async () => {
  const out = await bsky.fetch({ kind: 'user', target: 'zed.bsky.social' }, ctx({ needProfile: true }));
  assert.ok(out.profile.links.some((l) => l.platform === 'x' && l.target === 'zedfit'));
});
