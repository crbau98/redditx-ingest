'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');
const F = require('./fixtures/reddit');

let mock; let repo; let engine; let feed; let newPosts = false;

before(async () => {
  const gif = { id: 'blueduck', userName: 'someone', createDate: F.t0, likes: 50, views: 900, tags: ['gay', 'muscle'], type: 1, hasAudio: false, width: 720, height: 1280, duration: 8,
    urls: { hd: 'https://media.redgifs.com/BlueDuck.mp4', sd: 'https://media.redgifs.com/BlueDuck-mobile.mp4', poster: 'https://media.redgifs.com/BlueDuck-poster.jpg', thumbnail: 'https://media.redgifs.com/BlueDuck-thumb.jpg' } };
  const all = [F.post({}).data && F.post({}), F.gallery, F.video, F.redgifsLink, F.gifAsMp4, F.unsafe, F.female, F.album, F.text, F.stock, F.removed, F.crosspost];
  mock = await start({
    '/r/gaybrosgonewild/top.json': () => ({ json: F.listing(all) }),
    '/r/gaybrosgonewild/hot.json': () => ({ json: F.listing(all) }),
    '/r/gaybrosgonewild/new.json': () => ({ json: F.listing(newPosts ? [F.fresh, ...all] : all) }),
    '/v2/auth/temporary': () => ({ json: { token: 'tok' } }),
    '/v2/gifs/blueduck': (req) => (req.headers.authorization === 'Bearer tok' ? { json: { gif } } : { status: 401 }),
  });
  prepareEnv({ REDDIT_BASE_URL: mock.url, REDGIFS_BASE_URL: mock.url });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
});
after(async () => { engine.shutdown(); await mock.close(); });

test('first run ingests every valid media item and applies all gates', async () => {
  const r = await engine.runFeed(feed, 'manual');
  assert.equal(r.status, 'ok');
  assert.equal(r.via, 'json');
  const rows = repo.media.list({ limit: 100, state: 'any', admin: true }).items;
  const titles = rows.map((m) => `${m.title}|${m.position}`).sort();

  // image + 3 gallery + video + redgifs(resolved) + gif->mp4 + crosspost(media from parent)
  assert.equal(r.added, 8, JSON.stringify({ r, titles }));
  assert.ok(titles.includes('Beach weekend|0') && titles.includes('Beach weekend|2'), 'all gallery images ingested');
  assert.equal(r.blocked, 1, 'underage-signal title blocked');
  assert.ok(!rows.some((m) => m.title === 'im 16 lol'), 'blocked item never stored');
  assert.ok(!rows.some((m) => m.title === '[F] new here'), 'female-tagged post excluded even on trusted feed');
  assert.ok(!rows.some((m) => /unsplash/.test(m.media_url)), 'stock host dropped');
  assert.ok(!rows.some((m) => m.title === 'Album dump' || m.title === 'Question for the group'));
});

test('parsed fields: dimensions, preview, hls, video flags, post time, tags', () => {
  const rows = repo.media.list({ limit: 100 }).items;
  const img = rows.find((m) => m.title === 'Gym selfie');
  assert.equal(img.media_type, 'image');
  assert.equal(img.width, 1080); assert.equal(img.height, 1350);
  assert.match(img.preview_url, /width=640/, 'picks a ~640px preview, not the 1080 source');
  assert.ok(!img.preview_url.includes('&amp;'), 'html entities decoded');
  assert.equal(new Date(img.posted_at).getTime(), F.t0 * 1000, 'uses the original post time');

  const vid = rows.find((m) => m.title === 'Pool day');
  assert.equal(vid.media_type, 'video');
  assert.equal(vid.media_url, 'https://v.redd.it/vid1/DASH_720.mp4', 'fallback ?source param stripped');
  assert.match(vid.hls_url, /HLSPlaylist\.m3u8\?a=1&v=1$/);
  assert.equal(vid.has_audio, true);
  assert.equal(vid.duration, 12);

  const rg = rows.find((m) => m.title === 'Clip from my page');
  assert.equal(rg.media_url, 'https://media.redgifs.com/BlueDuck.mp4', 'redgifs page link resolved to a file');
  assert.equal(rg.media_type, 'video');

  const anim = rows.find((m) => m.title === 'Beach weekend' && m.position === 2);
  assert.equal(anim.media_type, 'video', 'animated gallery entry becomes mp4');

  const flex = rows.find((m) => m.title === 'Flex');
  assert.match(flex.media_url, /format=mp4/);
  assert.equal(flex.media_type, 'video', 'gif link uses reddit\'s mp4 variant');

  const cp = rows.find((m) => m.title === 'Shared from elsewhere');
  assert.equal(cp.media_url, 'https://i.redd.it/cross.jpg', 'crosspost media taken from parent');
  assert.ok(img.tags_text.includes('gym') && img.tags_text.includes('gaybrosgonewild') && img.tags_text.includes('reddit'));
});

test('creators are created with a disabled user feed, then auto-followed once proven', () => {
  const zed = repo.creators.byAccount('reddit', 'zed_fit');
  assert.ok(zed, 'creator created from author');
  assert.ok(zed.media_count >= 2);
  const uf = repo.feeds.find('reddit', 'user', 'zed_fit');
  assert.ok(uf, 'user feed exists');
  assert.equal(uf.creator_id, zed.id);
  assert.equal(uf.enabled, 1, 'auto-follow enabled it (>= autoTrackMinItems posts)');
  assert.ok(uf.next_run_at, 'and staggered');
});

test('second run: incremental + dedupe, only new content added', async () => {
  newPosts = true;
  const r = await engine.runFeed(repo.feeds.get(feed.id), 'manual');
  assert.equal(r.added, 1, JSON.stringify(r));
  assert.ok(repo.media.list({ q: 'brand new' }).total === 1);
  const again = await engine.runFeed(repo.feeds.get(feed.id), 'manual');
  assert.equal(again.added, 0);
  const f = repo.feeds.get(feed.id);
  assert.ok(['ok', 'empty'].includes(f.last_status), f.last_status); // "nothing new" is healthy
  assert.equal(f.consecutive_failures, 0);
  assert.ok(JSON.parse(f.cursor).newestAt);
});

test('run history is recorded', () => {
  const runs = repo.runs.recent({ feedId: feed.id });
  assert.ok(runs.length >= 3);
  assert.ok(runs.every((r) => r.finished_at && r.status));
});
