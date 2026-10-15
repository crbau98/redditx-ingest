'use strict';
/**
 * v5 sources and playback: the leak blocklist, reposts credited to the original poster, copies of videos whose links
 * expire, and fresh links for stale RedGIFs / X videos.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let pipeline; let leaks; let links; let vault; let playback; let registry; let store; let feed;
const settings = { probeUnknownHosts: false, scopeMode: 'open' };
const VIDEO = Buffer.alloc(40000, 3);

let n = 0;
const item = (o) => ({
  sourceId: `v5-${++n}`, title: 'Gym pump, gay jock', author: 'jockone', community: 'gaybrosgonewild', mediaType: 'image', trusted: true,
  mediaUrl: `https://i.redd.it/v5img${n}.jpg`, ...o,
});

before(async () => {
  mock = await start({
    '/clip.mp4': () => ({ headers: { 'content-type': 'video/mp4', 'content-length': String(VIDEO.length) }, body: VIDEO }),
    '/huge.mp4': () => ({ headers: { 'content-type': 'video/mp4', 'content-length': String(500 * 1024 * 1024) }, body: VIDEO }),
    '/page.mp4': () => ({ headers: { 'content-type': 'text/html' }, body: '<html></html>' }),
  });
  prepareEnv({ MEDIA_STORE: 'disk' });
  repo = require('../src/db/repo');
  pipeline = require('../src/engine/pipeline');
  leaks = require('../src/lib/leaks');
  links = require('../src/lib/links');
  vault = require('../src/lib/vault');
  playback = require('../src/engine/playback');
  registry = require('../src/sources');
  store = require('../src/lib/objectstore');
  feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1, origin: 'admin' }).feed;
});
after(async () => { await mock.close(); });

/* ------------------------------------------------------------------ leaks */

test('GayForFans, its sister sites, leak mirrors and file lockers are leak hosts; creator platforms are not', () => {
  for (const u of ['https://gayforfans.com/video/abc', 'https://www.fetishforfans.com/x', 'https://gffshorts.com/s/1', 'https://cdn7.adultcdn.media/v/1.mp4',
    'https://coomer.su/onlyfans/user/x', 'https://mega.nz/folder/abc', 'https://bunkr.si/a/xyz', 'https://gofile.io/d/abc']) {
    assert.equal(leaks.isLeakUrl(u), true, u);
  }
  for (const u of ['https://onlyfans.com/jake', 'https://www.redgifs.com/watch/abc', 'https://x.com/jake', 'https://justfor.fans/jake', 'https://i.redd.it/a.jpg']) {
    assert.equal(leaks.isLeakUrl(u), false, u);
  }
});

test('posts that sell themselves as leaks are recognised; ordinary wording is not', () => {
  for (const t of ['Hot jock OF leak 🔥', 'leaked onlyfans pack', 'DM for mega link', 'DM for folder', 'DM me for the siterip', 'onlyfans bypass', 'full onlyfans siterip', '#ofleaks', 'his leaked videos', 'all here https://gofile.io/d/xyz']) {
    assert.ok(leaks.leakText(t), t);
  }
  for (const t of [
    'precum leaking', 'a lot of leaks in my roof', 'free OnlyFans, link in bio', 'gym pump', 'Subscribe to my OnlyFans',
    'DM me for the link to my VIP page', 'DM for full video on my OnlyFans', 'OnlyFans free access trial link in bio',
    'Fansly free access for 7 days', 'my VIP OnlyFans is 50% off', 'full OnlyFans collection on my page',
  ]) {
    assert.equal(leaks.leakText(t), null, t);
  }
});

test('leak links are never parsed as a source or a creator link', () => {
  assert.equal(links.parseProfile('https://gayforfans.com/creator/jake'), null);
  assert.equal(links.parseProfile('https://www.gffshorts.com/jake'), null);
  assert.deepEqual(links.extractLinks('my vids: mega.nz/folder/abc · https://onlyfans.com/jake').map((p) => p.service), ['OnlyFans']);
});

test('the pipeline drops leaked content before any download: by host, by permalink, by a link in the text, by wording', async () => {
  const cases = [
    item({ mediaUrl: 'https://cdn3.adultcdn.media/clip.mp4', mediaType: 'video' }),
    item({ permalink: 'https://gayforfans.com/video/123' }),
    item({ text: 'full vid → https://pixeldrain.com/u/abc' }),
    item({ title: 'Jake OF leaked videos' }),
  ];
  for (const c of cases) {
    const r = await pipeline.processItem(c, feed, null, settings);
    assert.equal(r.outcome, 'blocked', JSON.stringify(c));
    assert.match(r.reason, /^leak-/);
  }
  assert.equal((await pipeline.processItem(item({}), feed, null, settings)).outcome, 'added', 'a clean post still publishes');
});

test('admins can add more leak domains in settings', () => {
  const settingsStore = require('../src/settings');
  assert.equal(leaks.isLeakUrl('https://newleaks.example/x'), false);
  settingsStore.update({ leakDomains: 'newleaks.example\nhttps://other-leaks.example/path' });
  assert.equal(leaks.isLeakUrl('https://cdn.newleaks.example/x'), true);
  assert.equal(leaks.isLeakUrl('https://other-leaks.example/'), true);
  settingsStore.update({ leakDomains: '' });
  assert.equal(leaks.isLeakUrl('https://newleaks.example/x'), false);
});

test('a leak link hidden behind innocent anchor text is caught (RSS / Tumblr and Mastodon keep every link of the post)', async () => {
  const rss = registry.get('rss');
  const [it] = rss.entryToItems({ id: 'e1', link: 'https://blog.example/p/1', title: 'gym', text: 'download', published: '2026-10-10T00:00:00Z', categories: [],
    links: ['https://mega.nz/file/abc'], media: [{ type: 'image', url: 'https://blog.example/img.jpg' }] }, { title: 'blog' });
  assert.deepEqual(it.links, ['https://mega.nz/file/abc']);
  const r = await pipeline.processItem({ ...it, sourceId: 'hidden-leak', title: 'Gym selfie, gay jock', trusted: true }, feed, null, settings);
  assert.equal(r.outcome, 'blocked'); assert.match(r.reason, /leak-site:mega\.nz/);
  const [m] = registry.get('mastodon').parseStatus({ id: '1', created_at: '2026-10-10T00:00:00Z', url: 'https://m.example/@a/1', account: { acct: 'a' },
    content: '<p>new set <a href="https://gofile.io/d/xyz">here</a></p>', media_attachments: [{ type: 'image', url: 'https://m.example/a.jpg' }] }, 'm.example');
  assert.deepEqual(m.links, ['https://gofile.io/d/xyz']);
});

/* ---------------------------------------------------------------- reposts */

test('X: reposts and quotes are kept and credited to the original author (syndication and API)', () => {
  const x = registry.get('x');
  const media = { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/orig.jpg', original_info: { width: 800, height: 1000 } };
  const original = { id_str: '10', full_text: 'gym day', user: { screen_name: 'jockone', name: 'Jock' }, extended_entities: { media: [media] }, created_at: 'Mon Oct 12 10:00:00 +0000 2026' };
  const rt = { id_str: '11', full_text: 'RT', user: { screen_name: 'fanacct' }, retweeted_status: original };
  const [it] = x.parseLegacyTweet(rt);
  assert.equal(it.author, 'jockone');
  assert.deepEqual(it.repostOf, { platform: 'x', handle: 'jockone', via: 'fanacct' });
  assert.equal(x.parseLegacyTweet(original)[0].repostOf, undefined, 'his own post is not a repost');
  assert.equal(x.parseLegacyTweet({ ...rt, created_at: 'Wed Oct 14 09:00:00 +0000 2026' })[0].cursorAt, '2026-10-14T09:00:00.000Z', 'the feed cursor follows the retweet time');
  // flatMap passes an index as the 2nd argument: it must not be read as a reposter
  assert.equal([original, original].flatMap(x.parseLegacyTweet)[1].repostOf, undefined);

  const json = {
    data: [
      { id: '20', text: 'RT @jockone', author_id: 'u2', referenced_tweets: [{ type: 'retweeted', id: '19' }] },
      { id: '21', text: 'look at him', author_id: 'u2', attachments: { media_keys: ['m2'] }, referenced_tweets: [{ type: 'quoted', id: '19' }] },
    ],
    includes: {
      users: [{ id: 'u1', username: 'jockone', name: 'Jock' }, { id: 'u2', username: 'fanacct', name: 'Fan' }],
      media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }, { media_key: 'm2', type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg' }],
      tweets: [{ id: '19', text: 'pump', author_id: 'u1', attachments: { media_keys: ['m1'] } }],
    },
  };
  const items = x.parseApi(json);
  assert.deepEqual(items.map((i) => [i.sourceId, i.author, i.repostOf ? i.repostOf.via : null]), [['19', 'jockone', 'fanacct'], ['21', 'fanacct', null], ['19', 'jockone', 'fanacct']]);
});

test('Bluesky: a repost by somebody else is kept for the original poster; self-reposts and unknown reposters are not', () => {
  const bsky = registry.get('bluesky');
  const post = { uri: 'at://did:plc:a/app.bsky.feed.post/3k1', author: { did: 'did:plc:a', handle: 'jock.bsky.social' }, record: { text: 'gym', createdAt: '2026-10-10T00:00:00Z' },
    embed: { $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/img/a.jpg', thumb: 'https://cdn.bsky.app/img/t.jpg' }] } };
  const [it] = bsky.parsePostView({ post, reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { handle: 'fan.bsky.social' } } });
  assert.equal(it.author, 'jock.bsky.social');
  assert.deepEqual(it.repostOf, { platform: 'bluesky', handle: 'jock.bsky.social', via: 'fan.bsky.social' });
  const [later] = bsky.parsePostView({ post, reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { handle: 'fan.bsky.social' }, indexedAt: '2026-10-14T08:00:00Z' } });
  assert.equal(later.cursorAt, '2026-10-14T08:00:00.000Z', 'the feed cursor follows the repost time');
  assert.equal(bsky.parsePostView({ post, reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { handle: 'jock.bsky.social' } } }).length, 0);
  assert.equal(bsky.parsePostView({ post, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }).length, 0);
});

test('Reddit: a crosspost of somebody else\'s post is credited to him; the source subreddit is remembered', () => {
  const reddit = registry.get('reddit');
  const parent = { id: 'p1', author: 'jockone', subreddit: 'gaymuscle', url: 'https://i.redd.it/abc.jpg', title: 'pump' };
  const [cross] = reddit.parsePost({ data: { id: 'c1', author: 'curator', subreddit: 'gaybrosgonewild', title: 'look', crosspost_parent_list: [parent], url: 'https://i.redd.it/abc.jpg', permalink: '/r/x/c1' } });
  assert.equal(cross.author, 'jockone');
  assert.deepEqual(cross.repostOf, { platform: 'reddit', handle: 'jockone', via: 'curator' });
  assert.equal(cross.crosspostFrom, 'gaymuscle');
  const [own] = reddit.parsePost({ data: { id: 'c2', author: 'jockone', subreddit: 'gaybrosgonewild', title: 'me again', crosspost_parent_list: [parent], url: 'https://i.redd.it/abc.jpg', permalink: '/r/x/c2' } });
  assert.equal(own.author, 'jockone'); assert.equal(own.repostOf, undefined);
  // a video crosspost carries is_video on the wrapper too: still the parent author's
  const vparent = { ...parent, is_video: true, media: { reddit_video: { fallback_url: 'https://v.redd.it/abc/DASH_720.mp4' } } };
  const [vid] = reddit.parsePost({ data: { id: 'c3', author: 'curator', subreddit: 'gaybrosgonewild', title: 'clip', is_video: true, crosspost_parent_list: [vparent], media: vparent.media, permalink: '/r/x/c3' } });
  assert.equal(vid.author, 'jockone'); assert.equal(vid.repostOf.via, 'curator');
  // reposts switched off: crossposts stay with the crossposter
  const settingsStore = require('../src/settings');
  settingsStore.update({ reposts: false });
  try {
    const [off] = reddit.parsePost({ data: { id: 'c4', author: 'curator', subreddit: 'gaybrosgonewild', title: 'look', crosspost_parent_list: [parent], url: 'https://i.redd.it/abc.jpg', permalink: '/r/x/c4' } });
    assert.equal(off.author, 'curator'); assert.equal(off.repostOf, undefined);
  } finally { settingsStore.update({ reposts: true }); }
});

test('a repost read from a creator\'s own feed is credited to the original creator, not the feed owner', async () => {
  const owner = repo.creators.create({ handle: 'fanblog', displayName: 'Fan blog', origin: 'admin' });
  const own = repo.feeds.upsert({ platform: 'tumblr', kind: 'user', target: 'fanblog', creatorId: owner.id, trusted: 1, origin: 'admin' }).feed;
  const r1 = await pipeline.processItem(item({ author: 'fanblog', mediaUrl: 'https://64.media.tumblr.com/own/1.jpg' }), own, null, settings);
  assert.equal(r1.creatorId, owner.id);
  const r2 = await pipeline.processItem(item({ author: 'jockblog', mediaUrl: 'https://64.media.tumblr.com/re/1.jpg', repostOf: { platform: 'tumblr', handle: 'jockblog', via: 'fanblog' } }), own, null, settings);
  assert.equal(r2.outcome, 'added');
  assert.notEqual(r2.creatorId, owner.id);
  assert.equal(repo.creators.get(r2.creatorId).handle, 'jockblog');
  const f = repo.feeds.find('tumblr', 'user', 'jockblog');
  assert.ok(f, 'the original blog gets a (dormant) feed, auto-followed once proven');
});

/* ---------------------------------------------------------- keep videos */

test('expiring links are recognised; stable and refreshable ones are not', () => {
  assert.equal(vault.expiring('https://video.xx.fbcdn.net/v/t42/abc.mp4?oe=6700&oh=00_x'), true);
  assert.equal(vault.expiring('https://cdn.example/v.mp4?Expires=1700000000&Signature=abc'), true);
  assert.equal(vault.expiring('https://preview.redd.it/a.gif?format=mp4&s=abc123'), false, 'Reddit signs previews but they do not expire');
  assert.equal(vault.expiring('https://v.redd.it/abc/DASH_720.mp4'), false);
  assert.equal(vault.expiring('https://media.example.social/files/1.mp4'), false);
  const v = (o) => ({ mediaType: 'video', mediaUrl: 'https://cdn.example/v.mp4?expires=1&signature=2', ...o });
  assert.equal(vault.wanted(v(), 'reddit', {}), true);
  assert.equal(vault.wanted(v({ mediaType: 'image' }), 'reddit', {}), false);
  assert.equal(vault.wanted(v(), 'redgifs', {}), false, 'RedGIFs links are refreshed instead');
  assert.equal(vault.wanted(v({ mediaUrl: 'https://cdn.example/stable.mp4' }), 'reddit', {}), false);
  assert.equal(vault.wanted(v({ mediaUrl: 'https://cdn.example/stable.mp4' }), 'reddit', { keepVideos: 'all' }), true);
  assert.equal(vault.wanted(v(), 'reddit', { keepVideos: 'off' }), false);
});

test('a kept video is streamed into the store; too big, not a video, or unreachable keeps the original link', async () => {
  const kept = await vault.keep({ mediaUrl: `${mock.url}/clip.mp4?expires=1&signature=x` }, { sourceKey: 'reddit:k1:0', maxMb: 5 });
  assert.ok(kept && store.isStoreUrl(kept.url), JSON.stringify(kept));
  assert.equal(kept.bytes, VIDEO.length);
  assert.ok(await store.has(kept.key));
  assert.equal(await vault.keep({ mediaUrl: `${mock.url}/huge.mp4` }, { sourceKey: 'k2', maxMb: 5 }), null, 'declared size over the cap');
  assert.equal(await vault.keep({ mediaUrl: `${mock.url}/page.mp4` }, { sourceKey: 'k3' }), null, 'not a video');
  assert.equal(await vault.keep({ mediaUrl: `${mock.url}/missing.mp4` }, { sourceKey: 'k4' }), null, '404');
  assert.ok(!fs.readdirSync(require('os').tmpdir()).some((f) => f.startsWith(`prism-keep-${process.pid}-`)), 'temp files cleaned up');
});

test('the pipeline stores an expiring video and publishes the stored copy', async () => {
  const url = `${mock.url}/clip.mp4?expires=1&signature=y`;
  const r = await pipeline.processItem(item({ mediaType: 'video', mediaUrl: url, sourceId: 'keepme' }), feed, null, settings);
  assert.equal(r.outcome, 'added', JSON.stringify(r));
  const row = repo.db.prepare('SELECT media_url FROM media WHERE id = ?').get(r.mediaId);
  assert.ok(store.isStoreUrl(row.media_url), row.media_url);
});

/* --------------------------------------------------------- stale links */

test('a stale RedGIFs link is refreshed at the source and saved on the item', async () => {
  const old = 'https://media.redgifs.com/BigHappyJock.mp4';
  const r = await pipeline.processItem(item({ mediaType: 'video', mediaUrl: old, sourceId: 'redgifs-bighappyjock', permalink: 'https://www.redgifs.com/watch/bighappyjock' }),
    repo.feeds.upsert({ platform: 'redgifs', kind: 'user', target: 'jockone', trusted: 1, origin: 'admin' }).feed, null, settings);
  assert.equal(r.outcome, 'added', JSON.stringify(r));
  const rg = registry.get('redgifs');
  const real = rg.resolve;
  const asked = [];
  rg.resolve = async (u) => { asked.push(u); return { mediaUrl: 'https://media.redgifs.com/BigHappyJock-new.mp4', previewUrl: 'https://media.redgifs.com/BigHappyJock-poster.jpg' }; };
  try {
    assert.equal(playback.canRefresh('media.redgifs.com'), true);
    assert.equal(playback.canRefresh('i.redd.it'), false);
    const fresh = await playback.refresh(old);
    assert.equal(fresh, 'https://media.redgifs.com/BigHappyJock-new.mp4');
    assert.deepEqual(asked, ['https://www.redgifs.com/watch/bighappyjock']);
    assert.equal(repo.db.prepare('SELECT media_url FROM media WHERE id = ?').get(r.mediaId).media_url, fresh);
    assert.equal(await playback.refresh(old), fresh, 'answered from the window, no second call');
    assert.equal(asked.length, 1);
    assert.equal(await playback.refresh('https://media.redgifs.com/NobodyKnows.mp4'), null, 'unknown links are left alone');
  } finally { rg.resolve = real; }
});

test('the RedGIFs id is read from the watch page, the media file name or the source id', () => {
  assert.equal(playback.redgifsId({ source_url: 'https://www.redgifs.com/watch/abcdef' }), 'abcdef');
  assert.equal(playback.redgifsId({ media_url: 'https://media.redgifs.com/TallBraveOtter-mobile.mp4' }), 'tallbraveotter');
  assert.equal(playback.redgifsId({ source_id: 'redgifs-quietgreenfox' }), 'quietgreenfox');
});
