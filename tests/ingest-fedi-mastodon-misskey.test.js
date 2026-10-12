'use strict';
/**
 * Mastodon + Misskey-family ingestion against mock servers ("instances" are 127.0.0.1:<port> hosts):
 * paging, tag feeds over every configured instance, sign-in walls, NodeInfo detection, token scoping.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let open; let walled; let misskeyHost; let repo; let engine; let mastodon; let misskey;
const seen = { statuses: [], mkBodies: [], mkAuth: [] };

const media = (n) => ({ type: 'image', url: `https://files.example/${n}.jpg`, preview_url: `https://files.example/${n}s.jpg`, description: 'gay gym', meta: { original: { width: 800, height: 1000 } } });
const status = (id, at, extra = {}) => ({
  id, created_at: at, url: `https://open.example/@zed/${id}`, content: '<p>Gay gym selfie <a href="#">#gay</a></p>', sensitive: false, favourites_count: 2, reblogs_count: 0, tags: [{ name: 'gay' }],
  account: { acct: 'zed', display_name: 'Zed', avatar: 'https://files.example/zed.png' }, media_attachments: [media(`m${id}`)], ...extra,
});
const note = (id, at, extra = {}) => ({
  id, createdAt: at, text: 'Gay gym selfie #gay', tags: ['gay'], user: { username: 'zed', host: null, name: 'Zed', avatarUrl: 'https://files.example/zed.png' }, reactionCount: 4, renoteCount: 1,
  files: [{ id: `f${id}`, type: 'image/jpeg', url: `https://files.example/n${id}.jpg`, thumbnailUrl: `https://files.example/n${id}t.jpg`, isSensitive: true, properties: { width: 640, height: 800 } }], ...extra,
});

before(async () => {
  open = await start({
    '/api/v1/accounts/lookup': (req, res, url) => (url.searchParams.get('acct') === 'zed' ? { json: { id: '7', username: 'zed', acct: 'zed', display_name: 'Zed', note: '<p>gay fitness <a href="https://x.com/zedfit">x</a></p>', avatar: 'https://files.example/zed.png', fields: [] } } : { status: 404, json: { error: 'Record not found' } }),
    '/api/v1/accounts/7/statuses': (req, res, url) => {
      seen.statuses.push(url.search);
      assert.equal(url.searchParams.get('only_media'), 'true');
      assert.equal(url.searchParams.get('limit'), '40');
      if (!url.searchParams.get('max_id')) return { json: [status('300', '2026-10-03T10:00:00Z'), status('299', '2026-10-03T09:00:00Z', { reblog: { id: 'x' } }), status('298', '2026-10-03T08:00:00Z', { sensitive: true })] };
      return { json: url.searchParams.get('max_id') === '298' ? [status('200', '2026-10-02T10:00:00Z', { media_attachments: [{ type: 'gifv', url: 'https://files.example/g.mp4', preview_url: 'https://files.example/g.png' }] })] : [] };
    },
    '/api/v1/timelines/tag/gay': (req, res, url) => ({ json: url.searchParams.get('max_id') ? [] : [status('900', '2026-10-04T10:00:00Z')] }),
    '/.well-known/nodeinfo': () => ({ json: { links: [] } }),
  });
  walled = await start({
    '/api/v1/timelines/tag/gay': () => ({ status: 401, json: { error: 'This API requires an authenticated user' } }),
    '/api/v1/accounts/lookup': () => ({ status: 401, json: { error: 'This API requires an authenticated user' } }),
    '/.well-known/nodeinfo': () => ({ status: 404, body: '' }),
  });
  const mkHostRef = {};
  misskey = null;
  const mk = await start({
    '/api/users/show': (req) => { seen.mkBodies.push(['users/show', JSON.parse(req.bodyText)]); return { json: { id: 'u1', username: 'zed', name: 'Zed', description: 'gay fitness https://bsky.app/profile/zed.bsky.social', fields: [] } }; },
    '/api/users/notes': (req) => {
      const b = JSON.parse(req.bodyText); seen.mkBodies.push(['users/notes', b]); seen.mkAuth.push(b.i || null);
      assert.equal(b.userId, 'u1'); assert.equal(b.withFiles, true);
      if (!b.untilId) return { json: [note('n3', '2026-10-03T10:00:00Z'), note('n2', '2026-10-03T09:00:00Z', { files: [], renote: { id: 'r' }, text: null }), note('n1', '2026-10-03T08:00:00Z', { cw: 'spicy', files: [{ id: 'v', type: 'video/mp4', url: 'https://files.example/v.mp4', thumbnailUrl: null, isSensitive: false, properties: {} }, { id: 'a', type: 'audio/mpeg', url: 'https://files.example/a.mp3' }] })] };
      return { json: [] };
    },
    '/api/notes/search-by-tag': (req) => { const b = JSON.parse(req.bodyText); seen.mkBodies.push(['search-by-tag', b]); assert.equal(b.tag, 'gay'); assert.equal(b.withFiles, true); return { json: b.untilId ? [] : [note('t1', '2026-10-04T10:00:00Z')] }; },
    '/.well-known/nodeinfo': (req) => ({ json: { links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${mkHostRef.origin}/nodeinfo/2.0` }] } }),
    '/nodeinfo/2.0': () => ({ json: { software: { name: 'sharkey', version: '2025.4.0' } } }),
    // Mastodon API does not exist on Misskey proper
  });
  mkHostRef.origin = mk.url;
  misskeyHost = mk;
  prepareEnv({
    MASTODON_INSTANCES: `${open.url.replace('http://', '')} ${walled.url.replace('http://', '')}`,
    MISSKEY_INSTANCES: misskeyHost.url.replace('http://', ''),
    MASTODON_ACCESS_TOKEN: 'mast-secret', MISSKEY_ACCESS_TOKEN: 'mk-secret',
  });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  mastodon = require('../src/sources/mastodon');
  misskey = require('../src/sources/misskey');
});
after(async () => { engine.shutdown(); await open.close(); await walled.close(); await misskeyHost.close(); });

const ctx = (extra = {}) => ({ cursor: {}, aborted: () => false, needProfile: false, ...extra });
const hostOf = (m) => m.url.replace('http://', '');

test('Mastodon user: lookup -> only_media statuses, max_id paging, boosts skipped, end to end into media rows', async () => {
  const target = `zed@${hostOf(open)}`;
  const feed = repo.feeds.upsert({ platform: 'mastodon', kind: 'user', target, trusted: 1, origin: 'admin' }).feed;
  const r = await engine.runFeed(feed, 'manual');
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(seen.statuses.length, 3, 'pages until an empty one');
  assert.match(seen.statuses[1], /max_id=298/);
  const rows = repo.media.list({ limit: 50, state: 'any', admin: true }).items.filter((m) => m.platform === 'mastodon');
  assert.deepEqual(rows.map((m) => m.source_id).sort(), [`${hostOf(open)}:200`, `${hostOf(open)}:298`, `${hostOf(open)}:300`]);
  assert.equal(rows.find((m) => /:298$/.test(m.source_id)).nsfw_level, 'explicit');
  assert.equal(rows.find((m) => /:200$/.test(m.source_id)).media_type, 'video', 'gifv plays as video');
  assert.equal(rows.find((m) => /:300$/.test(m.source_id)).source_url, 'https://open.example/@zed/300');
});

test('Mastodon user that does not exist is a 404 (so the engine can disable the feed)', async () => {
  await assert.rejects(() => mastodon.fetch({ kind: 'user', target: `nobody@${hostOf(open)}` }, ctx()), (e) => e.status === 404);
});

test('Mastodon tag: queries EVERY configured instance; one sign-in wall is a note, not a failure', async () => {
  const out = await mastodon.fetch({ kind: 'tag', target: 'gay' }, ctx());
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].query, 'gay');
  assert.ok(open.hits.some((h) => h.includes('/timelines/tag/gay')) && walled.hits.some((h) => h.includes('/timelines/tag/gay')), 'both instances were asked');
  assert.ok(out.notes.some((n) => /requires sign-in/.test(n) && /MASTODON_ACCESS_TOKEN/.test(n)), out.notes.join());
});

test('Mastodon tag@instance pins one server and honours a leading #', async () => {
  const before = walled.hits.length;
  const out = await mastodon.fetch({ kind: 'tag', target: `#gay@${hostOf(open)}` }, ctx());
  assert.equal(out.items.length, 1);
  assert.equal(walled.hits.length, before, 'the other instance was not touched');
});

test('Mastodon: when every server wants a login the feed is rested (skip) with an actionable message', async () => {
  await assert.rejects(() => mastodon.fetch({ kind: 'tag', target: `gay@${hostOf(walled)}` }, ctx()),
    (e) => e.skip === true && /requires sign-in/.test(e.message) && /MASTODON_ACCESS_TOKEN/.test(e.message));
  await assert.rejects(() => mastodon.fetch({ kind: 'user', target: `zed@${hostOf(walled)}` }, ctx()), (e) => e.skip === true && /requires sign-in/.test(e.message));
});

test('Mastodon access token is only sent to the first configured instance', async () => {
  const auth = [];
  const probe = await start({ '/api/v1/timelines/tag/gay': (req) => { auth.push(req.headers.authorization || null); return { json: [] }; } });
  try {
    await mastodon.fetch({ kind: 'tag', target: `gay@${hostOf(probe)}` }, ctx());
    assert.deepEqual(auth, [null], 'an arbitrary host never sees the token');
  } finally { await probe.close(); }
});

/* ------------------------------------------------------------------ Misskey */

test('Misskey user: users/show -> users/notes with withFiles, untilId paging, pure renotes and audio skipped', async () => {
  seen.mkBodies.length = 0;
  const out = await misskey.fetch({ kind: 'user', target: `zed@${hostOf(misskeyHost)}` }, ctx({ needProfile: true }));
  assert.deepEqual(seen.mkBodies.map(([e]) => e), ['users/show', 'users/notes', 'users/notes']);
  assert.equal(seen.mkBodies[2][1].untilId, 'n1');
  assert.deepEqual(out.items.map((i) => `${i.sourceId.split(':').pop()}/${i.mediaType}/${i.nsfw}`).sort(), ['n1/video/explicit', 'n3/image/explicit']);
  assert.equal(out.items.find((i) => i.mediaType === 'image').width, 640);
  assert.equal(out.items.find((i) => i.mediaType === 'image').author, `zed@${hostOf(misskeyHost)}`, 'local user qualified with the host');
  assert.ok(out.profile.links.some((l) => l.platform === 'bluesky'));
  assert.ok(seen.mkAuth.every((i) => i === 'mk-secret'), 'optional access token goes in the JSON body as `i` on the first configured instance');
});

test('Misskey tag: search-by-tag on the configured instance, end to end into media rows', async () => {
  const feed = repo.feeds.upsert({ platform: 'misskey', kind: 'tag', target: 'gay', trusted: 1, origin: 'admin' }).feed;
  const r = await engine.runFeed(feed, 'manual');
  assert.equal(r.status, 'ok', JSON.stringify(r));
  const rows = repo.media.list({ limit: 50, state: 'any', admin: true }).items.filter((m) => m.platform === 'misskey');
  assert.ok(rows.some((m) => /:t1$/.test(m.source_id)), rows.map((m) => m.source_id).join());
});

test('a Misskey-family server behind a Mastodon-looking link is read through its own API (NodeInfo)', async () => {
  // Mastodon lookup 404s on the Misskey host (no Mastodon API there); NodeInfo says "sharkey".
  const out = await mastodon.fetch({ kind: 'user', target: `zed@${hostOf(misskeyHost)}` }, ctx());
  assert.equal(out.via, 'misskey-api');
  assert.ok(out.items.length >= 1);
});

test('hashtag feeds on a Misskey host listed as a "Mastodon" instance fall back to its tag search', async () => {
  const out = await mastodon.fetch({ kind: 'tag', target: `gay@${hostOf(misskeyHost)}` }, ctx());
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].query, `gay@${hostOf(misskeyHost)}`);
  assert.ok(out.notes.some((n) => /Misskey-family/.test(n)));
});

test('Misskey sign-in wall is a clear skip error', async () => {
  const wall = await start({ '/api/users/show': () => ({ status: 401, json: { error: { code: 'CREDENTIAL_REQUIRED', message: 'Credential required.' } } }) });
  try {
    await assert.rejects(() => misskey.fetch({ kind: 'user', target: `zed@${hostOf(wall)}` }, ctx()), (e) => e.skip === true && /requires sign-in/.test(e.message) && /MISSKEY_ACCESS_TOKEN/.test(e.message));
  } finally { await wall.close(); }
});
