'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let backup; let mock; let targets;
const AGE = { cookie: 'prism_age=1' };
const ADMIN = { 'x-admin-key': 'test-key' };
const call = async (path, { headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json };
};
const pub = (p) => call(p, { headers: AGE });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bskyPost = (rkey, embed, text = 'post') => ({
  post: {
    uri: `at://did:plc:author/app.bsky.feed.post/${rkey}`, author: { did: 'did:plc:author', handle: 'feedguy.bsky.social', displayName: 'Feed Guy' },
    record: { text, createdAt: '2026-10-01T10:00:00Z' }, likeCount: 3, embed,
  },
});
const IMG = { $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/img/full/a.jpg', thumb: 'https://cdn.bsky.app/img/thumb/a.jpg', alt: 'gym', aspectRatio: { width: 800, height: 1000 } }] };

before(async () => {
  mock = await start({
    '/xrpc/com.atproto.identity.resolveHandle': (req, res, url) => ({ json: url.searchParams.get('handle') === 'curator.bsky.social' ? { did: 'did:plc:curator' } : { error: 'nope' }, status: url.searchParams.get('handle') === 'curator.bsky.social' ? 200 : 400 }),
    '/xrpc/app.bsky.feed.getFeed': (req, res, url) => {
      if (url.searchParams.get('feed') !== 'at://did:plc:curator/app.bsky.feed.generator/hunks') return { status: 400, json: { error: 'bad feed uri' } };
      return { json: { feed: [bskyPost('p1', IMG, 'From the feed #muscle'), bskyPost('p2', null, 'text only')] } };
    },
    '/xrpc/app.bsky.feed.getListFeed': (req, res, url) => ({ json: { feed: url.searchParams.get('list') === 'at://did:plc:curator/app.bsky.graph.list/l1' ? [bskyPost('p3', IMG)] : [] } }),
  });
  prepareEnv({ AGE_GATE_ENFORCE: 'true', BSKY_BASE_URL: mock.url });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  targets = require('../src/services/targets');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await mock.close(); await new Promise((r) => server.close(r)); });

let n = 0;
const post = (cr, extra = {}, tags = []) => {
  n++;
  const id = repo.media.insert({ creator_id: cr.id, platform: 'reddit', source_id: `w${n}`, source_key: `reddit:w${n}:0`, post_key: `reddit:w${n}`, author: cr.handle, title: `v42 item ${n}`, media_type: 'image', media_url: `https://i.redd.it/w${n}.jpg`, hash: `v42h${n}`, ...extra }, tags);
  repo.creators.refreshStats(cr.id); return id;
};
const daysAgo = (d, hour = 12) => { const t = new Date(Date.now() - d * 86400000); t.setUTCHours(hour, 0, 0, 0); return t.toISOString(); };

describe('Misskey adapter', () => {
  const misskey = new Proxy({}, { get: (_, k) => require('../src/sources/misskey')[k] }); // required lazily, after prepareEnv
  const note = {
    id: '9xyz', createdAt: '2026-10-02T08:00:00.000Z', text: 'Pool day #summer', cw: null, renoteCount: 2, reactions: { '❤': 5, ':fire:': 3 },
    user: { username: 'bob', host: null, name: 'Bob', avatarUrl: 'https://misskey.io/avatar.webp' },
    files: [
      { type: 'image/jpeg', url: 'https://media.misskey.io/a.jpg', thumbnailUrl: 'https://media.misskey.io/a-thumb.webp', isSensitive: true, properties: { width: 1200, height: 1600 }, comment: 'alt text' },
      { type: 'video/mp4', url: 'https://media.misskey.io/b.mp4', thumbnailUrl: null, isSensitive: false, properties: {} },
      { type: 'application/pdf', url: 'https://media.misskey.io/c.pdf' },
    ],
    tags: ['summer'],
  };
  test('turns a note into one item per image/video, with author, reactions and sensitivity', () => {
    const items = misskey.parseNote(note, 'misskey.io');
    assert.equal(items.length, 2, 'non-media files are skipped');
    assert.equal(items[0].author, 'bob@misskey.io'); assert.equal(items[0].sourceId, 'misskey.io:9xyz');
    assert.equal(items[0].score, 8 + 2 * 2); assert.equal(items[0].nsfw, 'explicit'); assert.equal(items[0].width, 1200);
    assert.equal(items[0].previewUrl, 'https://media.misskey.io/a-thumb.webp'); assert.equal(items[0].altText, 'alt text');
    assert.equal(items[1].mediaType, 'video'); assert.equal(items[1].position, 1); assert.equal(items[1].nsfw, 'suggestive');
    assert.ok(items[0].tags.includes('summer'));
    assert.equal(items[0].permalink, 'https://misskey.io/notes/9xyz');
  });
  test('remote authors keep their own host; pure renotes are skipped', () => {
    assert.equal(misskey.parseNote({ ...note, user: { ...note.user, host: 'Sharkey.World' } }, 'misskey.io')[0].author, 'bob@sharkey.world');
    assert.deepEqual(misskey.parseNote({ id: 'r1', renote: { id: 'x' }, text: null, files: [] }, 'misskey.io'), []);
    assert.equal(misskey.parseNote({ ...note, reactions: undefined, reactionCount: 4, renoteCount: 0 }, 'misskey.io')[0].score, 4);
  });
  test('recognises Misskey-family server software', () => {
    for (const s of ['misskey', 'sharkey', 'firefish', 'iceshrimp', 'catodon']) assert.equal(misskey.isMisskeyFamily(s), true, s);
    for (const s of ['mastodon', 'pleroma', 'akkoma', 'gotosocial', null]) assert.equal(misskey.isMisskeyFamily(s), false, String(s));
  });
});

describe('link parsing (v4.2)', () => {
  const parseProfile = (...a) => require('../src/lib/links').parseProfile(...a);
  const profileUrl = (...a) => require('../src/lib/links').profileUrl(...a);
  test('Misskey accounts by URL, handle on a Misskey host, or explicit prefix', () => {
    assert.deepEqual(['@bob@misskey.io', 'https://misskey.io/@bob', 'misskey:bob@example.social'].map((x) => parseProfile(x).platform), ['misskey', 'misskey', 'misskey']);
    assert.equal(parseProfile('https://sharkey.world/@zed').target, 'zed@sharkey.world');
    assert.equal(parseProfile('@someone@mastodon.social').platform, 'mastodon', 'other servers stay Mastodon-compatible');
    assert.equal(parseProfile('@someone@example.social', { platform: 'misskey' }).platform, 'misskey', 'a hint decides');
    assert.equal(profileUrl('misskey', 'user', 'bob@misskey.io'), 'https://misskey.io/@bob');
  });
  test('Bluesky custom feeds and lists', () => {
    const f = parseProfile('https://bsky.app/profile/Curator.bsky.social/feed/hunks');
    assert.deepEqual([f.platform, f.kind, f.target], ['bluesky', 'feedgen', 'at://curator.bsky.social/app.bsky.feed.generator/hunks']);
    const l = parseProfile('https://bsky.app/profile/curator.bsky.social/lists/l1');
    assert.deepEqual([l.kind, l.target], ['list', 'at://curator.bsky.social/app.bsky.graph.list/l1']);
    assert.equal(parseProfile('at://did:plc:x/app.bsky.feed.generator/hot').kind, 'feedgen');
    assert.equal(parseProfile('https://bsky.app/profile/someone.bsky.social').kind, 'user', 'profiles unchanged');
    assert.equal(profileUrl('bluesky', 'feedgen', f.target), 'https://bsky.app/profile/curator.bsky.social/feed/hunks');
    assert.equal(profileUrl('bluesky', 'list', l.target), 'https://bsky.app/profile/curator.bsky.social/lists/l1');
  });
});

describe('Bluesky custom feeds and lists', () => {
  test('resolves the handle to a DID and keeps only posts with media', async () => {
    const bluesky = require('../src/sources/bluesky');
    const r = await bluesky.fetch({ kind: 'feedgen', target: 'at://curator.bsky.social/app.bsky.feed.generator/hunks' }, { cursor: {}, aborted: () => false });
    assert.equal(r.items.length, 1); assert.equal(r.via, 'appview-feedgen');
    assert.equal(r.items[0].author, 'feedguy.bsky.social'); assert.equal(r.items[0].mediaUrl, 'https://cdn.bsky.app/img/full/a.jpg');
    const l = await bluesky.fetch({ kind: 'list', target: 'at://curator.bsky.social/app.bsky.graph.list/l1' }, { cursor: {}, aborted: () => false });
    assert.equal(l.items.length, 1); assert.equal(l.items[0].sourceId, 'did:plc:author:p3');
  });
  test('ranked feeds never stop at an "already seen" post (their order is not chronological)', async () => {
    const bluesky = require('../src/sources/bluesky');
    const r = await bluesky.fetch({ kind: 'feedgen', target: 'at://did:plc:curator/app.bsky.feed.generator/hunks' }, { cursor: { newestAt: '2030-01-01T00:00:00.000Z' }, aborted: () => false });
    assert.equal(r.items.length, 1, 'an old-looking post in a ranked feed is still yielded (dedupe handles repeats)');
  });
  test('an unresolvable handle is a clear error', async () => {
    const bluesky = require('../src/sources/bluesky');
    await assert.rejects(bluesky.fetch({ kind: 'feedgen', target: 'at://nobody.example/app.bsky.feed.generator/x' }, { cursor: {}, aborted: () => false }));
  });
  test('the registry accepts the new kinds', () => {
    const registry = require('../src/sources');
    assert.ok(registry.get('bluesky').kinds.includes('feedgen') && registry.get('bluesky').kinds.includes('list'));
    assert.ok(registry.get('misskey'));
    assert.equal(registry.parseInput('https://bsky.app/profile/a.bsky.social/feed/x').kind, 'feedgen');
  });
});

describe('OPML import', () => {
  const opml = `<?xml version="1.0"?><opml version="2.0"><head><title>Reader export</title></head><body>
    <outline text="Creators" title="Creators">
      <outline type="rss" text="A &amp; B blog" title="A &amp; B blog" xmlUrl="https://ab-blog.example/posts?format=rss&amp;full=1" htmlUrl="https://ab-blog.example/"/>
      <outline type="rss" text="Sub" xmlUrl="https://www.reddit.com/r/opmltestsub/.rss"/>
      <outline type="rss" text="Tumblr" xmlUrl='https://opmlguy.tumblr.com/rss'/>
    </outline>
    <outline text="No feed here"/>
    <outline type="rss" text="Not http" xmlUrl="javascript:alert(1)"/>
  </body></opml>`;
  test('feeds become RSS feeds; recognised platform URLs become native feeds; junk is ignored', () => {
    const specs = targets.parseOpml(opml);
    assert.equal(specs.length, 3);
    assert.deepEqual(specs.map((s) => `${s.platform}/${s.kind}`), ['rss/feed', 'reddit/community', 'tumblr/user']);
    assert.equal(specs[0].target, 'https://ab-blog.example/posts?format=rss&full=1', 'XML entities decoded');
    assert.equal(specs[0].label, 'A & B blog');
  });
  test('the bulk importer detects OPML and is idempotent', () => {
    const first = targets.importTargets(opml);
    assert.equal(first.created, 3); assert.equal(first.invalid.length, 0);
    assert.ok(repo.feeds.find('reddit', 'community', 'opmltestsub'));
    assert.equal(targets.importTargets(opml).exists, 3);
  });
});

describe('v4.2 API', () => {
  test('`after` returns only items ingested after a timestamp (for smart-feed "new" counts)', async () => {
    const c = repo.creators.create({ handle: 'after_guy' });
    post(c, { community: 'aftersub' });
    await sleep(15);
    const mark = new Date().toISOString();
    await sleep(15);
    const fresh = post(c, { community: 'aftersub' });
    const r = await pub(`/api/media?community=aftersub&after=${encodeURIComponent(mark)}`);
    assert.equal(r.json.total, 1); assert.equal(r.json.items[0].id, fresh);
    assert.equal((await pub('/api/media?community=aftersub&after=not-a-date')).json.total, 2, 'invalid timestamps are ignored, not fatal');
    const offset = mark.replace('Z', '+00:00');
    assert.equal((await pub(`/api/media?community=aftersub&after=${encodeURIComponent(offset)}`)).json.total, 1, 'other ISO spellings are normalised');
  });
  test('creator activity: per-day counts, source split, posting hours; public creators only', async () => {
    const c = repo.creators.create({ handle: 'busy_guy' });
    post(c, { posted_at: daysAgo(1, 9) }); post(c, { posted_at: daysAgo(1, 9) }); post(c, { posted_at: daysAgo(3, 21), platform: 'bluesky' });
    post(c, { posted_at: daysAgo(500, 9) });
    const r = await pub(`/api/creators/${c.id}/activity`);
    assert.equal(r.status, 200);
    assert.equal(r.json.days.length, 2, 'older than a year is outside the heatmap');
    assert.equal(r.json.days.find((d) => d.day === daysAgo(1).slice(0, 10)).n, 2);
    assert.deepEqual(r.json.platforms.map((p) => [p.platform, p.n]), [['reddit', 3], ['bluesky', 1]]);
    assert.equal(r.json.hours.find((x) => x.hour === 9).n, 3);
    assert.ok(r.json.range.first < r.json.range.last);
    repo.creators.update(c.id, { status: 'hidden' });
    assert.equal((await pub(`/api/creators/${c.id}/activity`)).status, 404);
  });
  test('rising creators favour a burst this week over a steady back catalogue', async () => {
    const newbie = repo.creators.create({ handle: 'rising_new' }); const steady = repo.creators.create({ handle: 'rising_steady' }); const once = repo.creators.create({ handle: 'rising_once' });
    for (let i = 0; i < 4; i++) post(newbie, { posted_at: daysAgo(i + 1), score: 20 });
    for (let i = 0; i < 12; i++) post(steady, { posted_at: daysAgo(10 + i), score: 20 });
    post(steady, { posted_at: daysAgo(2), score: 20 }); post(steady, { posted_at: daysAgo(3), score: 20 });
    post(once, { posted_at: daysAgo(1), score: 500 });
    const d = (await pub('/api/discover')).json;
    const handles = d.rising.map((c) => c.handle);
    assert.ok(handles.indexOf('rising_new') >= 0 && handles.indexOf('rising_new') < handles.indexOf('rising_steady'), handles.join());
    assert.ok(!handles.includes('rising_once'), 'a single post is not a trend');
    assert.equal(d.rising.find((c) => c.handle === 'rising_new').week_count, 4);
    assert.ok(!('status' in d.rising[0]), 'public shape');
  });
  test('a creator\'s top tags never list platform names', async () => {
    const c = repo.creators.create({ handle: 'tag_guy' });
    post(c, {}, ['reddit', 'bluesky', 'lifting']);
    const r = await pub(`/api/creators/${c.id}`);
    assert.deepEqual(r.json.topTags.map((t) => t.name), ['lifting']);
  });
  test('admin overview includes daily ingest by source', async () => {
    const r = await call('/api/admin/overview', { headers: ADMIN });
    assert.equal(r.status, 200);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(r.json.ingestDaily.some((x) => x.day === today && x.platform === 'reddit' && x.n > 0));
  });
});
