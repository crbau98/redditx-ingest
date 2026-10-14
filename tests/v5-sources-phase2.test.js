'use strict';
/**
 * v5 sources phase 2: Mastodon boosts and Misskey renotes credited to the original poster, Telegram forwards as discovery
 * leads, RedGIFs niches and related creators, feed health, and the ingest queue order.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let registry; let settingsStore; let engine; let discovery; let sourcehealth;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600000; const DAY = 24 * HOUR;

let BIG; let SMALL;
before(async () => {
  const sharp = require('sharp');
  BIG = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 30, b: 40 } } }).jpeg().toBuffer();
  SMALL = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 20, g: 60, b: 200 } } }).jpeg().toBuffer();
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(30000, 5)]);
  mock = await start({
    '/bin.mp4': () => ({ headers: { 'content-type': 'application/octet-stream' }, body: MP4 }),
    '/untyped': () => ({ headers: {}, body: MP4 }),
    '/junk.bin': () => ({ headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(30000, 7) }),
    '/big.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: BIG }),
    '/small.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: SMALL }),
  });
  prepareEnv({ MEDIA_STORE: 'disk' });
  repo = require('../src/db/repo');
  registry = require('../src/sources');
  settingsStore = require('../src/settings');
  engine = require('../src/engine/engine');
  discovery = require('../src/engine/discovery');
  sourcehealth = require('../src/engine/sourcehealth');
});
after(async () => { await mock.close(); });

const withReposts = (on, fn) => { const prev = settingsStore.get().reposts; settingsStore.update({ reposts: on }); try { return fn(); } finally { settingsStore.update({ reposts: prev }); } };

/* ------------------------------------------ leaks and kept videos (PR #41 review) */

test('X: links hidden behind t.co are expanded, so the leak gate sees where they point', async () => {
  const x = registry.get('x');
  const legacy = { id_str: '9', full_text: 'new set https://t.co/abc', user: { screen_name: 'jockone' }, created_at: 'Mon Oct 12 10:00:00 +0000 2026',
    entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://mega.nz/folder/xyz' }] },
    extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg' }] } };
  const [it] = x.parseLegacyTweet(legacy);
  assert.deepEqual(it.links, ['https://mega.nz/folder/xyz']);
  const api = { data: [{ id: '10', text: 'more https://t.co/def', author_id: 'u1', created_at: '2026-10-12T10:00:00Z', attachments: { media_keys: ['m1'] },
    entities: { urls: [{ url: 'https://t.co/def', expanded_url: 'https://t.co/def', unwound_url: 'https://gofile.io/d/q' }] } }],
  includes: { users: [{ id: 'u1', username: 'jockone' }], media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg' }] } };
  assert.deepEqual(x.parseApi(api, null)[0].links, ['https://gofile.io/d/q']);
  const pipeline = require('../src/engine/pipeline');
  const feed = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'jockone', origin: 'admin' }).feed;
  const r = await pipeline.processItem({ ...it, title: 'Gym selfie, gay jock', trusted: true }, feed, null, { probeUnknownHosts: false, scopeMode: 'open' });
  assert.equal(r.outcome, 'blocked'); assert.match(r.reason, /leak-site:mega\.nz/);
});

test('a video served as a generic binary is kept when its bytes are a video, and refused otherwise', async () => {
  const vault = require('../src/lib/vault');
  const kept = await vault.keep({ mediaUrl: `${mock.url}/bin.mp4`, mediaType: 'video' }, { sourceKey: 'bin-1' });
  assert.ok(kept && /\.mp4$/.test(kept.key), 'octet-stream mp4 kept');
  assert.ok(await vault.keep({ mediaUrl: `${mock.url}/untyped`, mediaType: 'video' }, { sourceKey: 'bin-2' }), 'untyped mp4 kept');
  assert.equal(await vault.keep({ mediaUrl: `${mock.url}/junk.bin`, mediaType: 'video' }, { sourceKey: 'bin-3' }), null);
  assert.equal(vault.sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), 'video/webm');
});

/* ------------------------------------------------------------ Fediverse */

const original = {
  id: '200', created_at: '2026-10-01T10:00:00Z', url: 'https://other.example/@jock/200', account: { acct: 'jock@other.example', display_name: 'Jock' },
  content: '<p>gym day #gaymuscle</p>', tags: [{ name: 'gaymuscle' }], media_attachments: [{ type: 'image', url: 'https://other.example/a.jpg' }],
};

test('Mastodon: a boost is kept, credited to the original author, and ordered by the boost time', () => {
  const m = registry.get('mastodon');
  const boost = { id: '300', created_at: '2026-10-12T08:00:00Z', account: { acct: 'fanpage' }, reblog: original };
  const items = withReposts(true, () => m.parseStatus(boost, 'm.example'));
  assert.equal(items.length, 1);
  assert.equal(items[0].author, 'jock@other.example');
  assert.deepEqual(items[0].repostOf, { platform: 'mastodon', handle: 'jock@other.example', via: 'fanpage@m.example' });
  assert.equal(items[0].cursorAt, '2026-10-12T08:00:00.000Z');
  assert.equal(items[0].postedAt, '2026-10-01T10:00:00.000Z');
  // a self-boost adds nothing, and with reposts off boosts are skipped as before
  assert.deepEqual(withReposts(true, () => m.parseStatus({ ...boost, account: { acct: 'jock@other.example' } }, 'm.example')), []);
  assert.deepEqual(withReposts(false, () => m.parseStatus(boost, 'm.example')), []);
  // an ordinary post is unchanged
  const own = m.parseStatus(original, 'm.example');
  assert.equal(own[0].repostOf, undefined);
});

test('Misskey: a pure renote is kept and credited to the original author; a quote stays the renoter\'s own note', () => {
  const k = registry.get('misskey');
  const note = { id: 'n1', createdAt: '2026-10-01T10:00:00Z', text: 'pump', user: { username: 'jock', host: 'other.example' },
    files: [{ url: 'https://other.example/f.jpg', type: 'image/jpeg' }] };
  const renote = { id: 'r1', createdAt: '2026-10-12T09:00:00Z', text: null, files: [], user: { username: 'fan', host: null }, renote: note };
  const items = withReposts(true, () => k.parseNote(renote, 'misskey.example'));
  assert.equal(items.length, 1);
  assert.equal(items[0].author, 'jock@other.example');
  assert.deepEqual(items[0].repostOf, { platform: 'misskey', handle: 'jock@other.example', via: 'fan@misskey.example' });
  assert.equal(items[0].cursorAt, '2026-10-12T09:00:00.000Z');
  assert.deepEqual(withReposts(false, () => k.parseNote(renote, 'misskey.example')), []);
  const quote = { ...renote, text: 'look at this', files: [{ url: 'https://misskey.example/q.jpg', type: 'image/jpeg' }] };
  assert.equal(k.parseNote(quote, 'misskey.example')[0].author, 'fan@misskey.example');
});

test('the engine treats Mastodon boosters as reposter leads', () => {
  const w = { originals: new Set(), reposters: new Map(), hangouts: new Set(), forwards: new Set() };
  const c = repo.creators.create({ handle: 'jock', displayName: 'Jock' });
  const feed = { platform: 'mastodon', kind: 'tag', target: 'gaymuscle', label: '#gaymuscle' };
  engine._waysIn.noteWaysIn({ repostOf: { platform: 'mastodon', handle: 'jock@other.example', via: 'fanpage@m.example' } }, { outcome: 'added', creatorId: c.id }, feed, w);
  engine._waysIn.followWaysIn(w, feed);
  const cand = repo.candidates.find('mastodon', 'user', 'fanpage@m.example');
  assert.ok(cand, 'booster became a candidate');
  assert.deepEqual(cand.signals.mention, ['reposts jock@other.example']);
});

/* ------------------------------------------------------------- Telegram */

const PREVIEW = `<div class="tgme_channel_info"></div>
<div class="tgme_widget_message" data-post="gymchan/10">
  <div class="tgme_widget_message_forwarded_from">Forwarded from <a class="tgme_widget_message_forwarded_from_name" href="https://t.me/musclestudio/77">Muscle Studio</a></div>
  <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn4.telesco.pe/file/a.jpg')"></a>
  <div class="tgme_widget_message_text">leg day</div>
  <a class="tgme_widget_message_date" href="https://t.me/gymchan/10"><time datetime="2026-10-12T10:00:00+00:00"></time></a>
</div>
<div class="tgme_widget_message" data-post="gymchan/11">
  <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn4.telesco.pe/file/b.jpg')"></a>
  <a class="tgme_widget_message_date" href="https://t.me/gymchan/11"><time datetime="2026-10-12T11:00:00+00:00"></time></a>
</div>`;

test('Telegram: "Forwarded from" is read from the web preview and from MTProto messages', () => {
  const tg = registry.get('telegram');
  const page = tg.parsePage(PREVIEW, 'gymchan');
  const [fwd, own] = page.messages.sort((a, b) => a.id - b.id);
  assert.deepEqual(fwd.forwardFrom, { handle: 'musclestudio', name: 'Muscle Studio' });
  assert.equal(own.forwardFrom, null);
  assert.deepEqual(tg.toItems(fwd, 'gymchan')[0].forwardFrom, { handle: 'musclestudio', name: 'Muscle Studio' });
  for (const [href, h] of [['https://t.me/musclestudio', 'musclestudio'], ['https://t.me/c/12345/9', null], ['https://t.me/joinchat/abc', null], ['https://t.me/+abcDEF', null], ['https://evil.example/t.me/x', null]]) {
    assert.equal(tg.forwardHandle(href), h, href);
  }
  assert.deepEqual(tg.mtForward({ fwdFrom: { fromName: null }, forward: { chat: { username: 'musclestudio', title: 'Muscle Studio' } } }), { handle: 'musclestudio', name: 'Muscle Studio' });
  assert.deepEqual(tg.mtForward({ fwdFrom: { fromName: 'Hidden Sender' } }), { handle: null, name: 'Hidden Sender' });
  assert.equal(tg.mtForward({}), null);
});

test('a channel that posts are forwarded from becomes a discovery lead, one signal per forwarding channel', () => {
  const run = (feed) => {
    const w = { originals: new Set(), reposters: new Map(), hangouts: new Set(), forwards: new Set() };
    for (let i = 0; i < 3; i++) engine._waysIn.noteWaysIn({ author: feed.target, forwardFrom: { handle: 'musclestudio' } }, { outcome: 'added' }, feed, w);
    engine._waysIn.noteWaysIn({ author: feed.target, forwardFrom: { handle: feed.target } }, { outcome: 'added' }, feed, w); // its own post: no lead
    engine._waysIn.followWaysIn(w, feed);
  };
  run({ platform: 'telegram', kind: 'user', target: 'gymchan', label: '@gymchan' });
  run({ platform: 'telegram', kind: 'channel', target: 'liftclub', label: 'Lift Club' });
  const c = repo.candidates.find('telegram', 'user', 'musclestudio');
  assert.ok(c);
  assert.deepEqual(c.signals.mention.sort(), ['forwarded in @gymchan', 'forwarded in Lift Club']);
  assert.equal(repo.candidates.find('telegram', 'user', 'gymchan'), null);
  // a channel the account already joined is read through MTProto, so it is not a lead
  repo.feeds.upsert({ platform: 'telegram', kind: 'channel', target: 'joinedalready', origin: 'admin' });
  const w = { originals: new Set(), reposters: new Map(), hangouts: new Set(), forwards: new Set() };
  engine._waysIn.noteWaysIn({ author: 'gymchan', forwardFrom: { handle: 'joinedalready' } }, { outcome: 'added' }, { platform: 'telegram', kind: 'user', target: 'gymchan' }, w);
  engine._waysIn.followWaysIn(w, { platform: 'telegram', kind: 'user', target: 'gymchan' });
  assert.equal(repo.candidates.find('telegram', 'user', 'joinedalready'), null);
});

/* -------------------------------------------------------------- RedGIFs */

test('RedGIFs: posters in a niche are tallied, verified first', () => {
  const rg = registry.get('redgifs');
  const list = rg.tallyCreators({
    gifs: [{ userName: 'Alpha', tags: ['Gay', 'Muscle'] }, { userName: 'alpha', tags: ['Jock'] }, { userName: 'Beta', tags: ['Gay'] }, { userName: 'Beta' }, { userName: 'Beta' }, {}],
    users: [{ username: 'alpha', name: 'Alpha', verified: true, followers: 900 }, { username: 'Beta', followers: 10 }],
  });
  assert.deepEqual(list.map((u) => [u.username, u.gifs, u.verified]), [['Beta', 3, false], ['Alpha', 2, true]]);
  assert.deepEqual(list[1].tags, ['Gay', 'Muscle', 'Jock']);
});

test('RedGIFs niches followed creators post in become niche leads', () => {
  const ins = repo.db.prepare(`INSERT INTO media (id, creator_id, platform, community, media_type, media_url, hash, title) VALUES (?, ?, 'redgifs', ?, 'video', ?, ?, 'gay muscle')`);
  for (const h of ['rg1', 'rg2']) {
    const c = repo.creators.create({ handle: h, displayName: `Gay muscle jock ${h}` });
    for (let i = 0; i < 2; i++) { const u = `https://media.redgifs.com/${h}${i}.mp4`; ins.run(crypto.randomUUID(), c.id, 'gay-muscle-hunks', u, crypto.createHash('md5').update(u).digest('hex')); }
  }
  discovery.creatorHangouts();
  const c = repo.candidates.find('redgifs', 'niche', 'gay-muscle-hunks');
  assert.ok(c, 'niche became a candidate');
  assert.equal(c.signals.hangout.length, 2);
  // already followed: no lead
  repo.feeds.upsert({ platform: 'redgifs', kind: 'niche', target: 'gay-muscle-hunks', trusted: 0, origin: 'admin' });
  assert.equal(repo.communityHangouts().some((h) => h.community === 'gay-muscle-hunks'), false);
});

test('RedGIFs related creators: top posters of a followed niche become leads (verified as "similar")', async () => {
  const rg = registry.get('redgifs'); const bsky = registry.get('bluesky');
  const saved = { niche: rg.nicheCreators, search: rg.searchCreators, actors: bsky.searchActors };
  const asked = [];
  rg.nicheCreators = async (n) => { asked.push(n); return [
    { username: 'verifiedhunk', name: 'Verified Hunk', description: 'gay muscle, 18+ creator', gifs: 2, verified: true, followers: 5000, tags: ['Gay', 'Muscle'] },
    { username: 'onegif', gifs: 1, verified: false, tags: [] },
    { username: 'busyposter', name: 'Busy', description: 'gay jock 18+', gifs: 4, verified: false, followers: 50, tags: ['Gay'] },
  ]; };
  rg.searchCreators = async () => []; bsky.searchActors = async () => [];
  try {
    const out = await discovery.peopleSearch();
    assert.equal(out.niche, 'gay-muscle-hunks');
    assert.deepEqual(asked, ['gay-muscle-hunks']);
    assert.deepEqual(repo.candidates.find('redgifs', 'user', 'verifiedhunk').signals.similar, ['redgifs-niche:gay-muscle-hunks']);
    assert.deepEqual(repo.candidates.find('redgifs', 'user', 'busyposter').signals.search, ['redgifs-niche:gay-muscle-hunks']);
    assert.equal(repo.candidates.find('redgifs', 'user', 'onegif'), null);
  } finally { Object.assign(rg, { nicheCreators: saved.niche, searchCreators: saved.search }); bsky.searchActors = saved.actors; }
});

/* ---------------------------------------------------------- feed health */

test('feed health lists failing, stale and dead feeds, and the best ones', () => {
  const mk = (target, o = {}) => {
    const f = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target, origin: 'admin' }).feed;
    repo.db.prepare(`UPDATE feeds SET created_at = @created, last_run_at = @lastRun, last_success_at = @lastOk, consecutive_failures = @fails, last_error = @err WHERE id = @id`)
      .run({ id: f.id, created: iso(60 * DAY), lastRun: o.lastRun || iso(HOUR), lastOk: o.lastOk === undefined ? iso(HOUR) : o.lastOk, fails: o.fails || 0, err: o.err || null });
    return f;
  };
  const runs = repo.db.prepare(`INSERT INTO feed_runs (id, feed_id, started_at, finished_at, status, fetched, added) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const broken = mk('brokenfeed', { fails: 5, err: 'HTTP 403 for https://reddit.com', lastOk: iso(10 * DAY) });
  const resting = mk('restingfeed', { lastOk: iso(5 * DAY), fails: 1 });
  const dead = mk('deadfeed');
  for (let i = 0; i < 10; i++) runs.run(crypto.randomUUID(), dead.id, iso(i * DAY + HOUR), iso(i * DAY), 'empty', 25, 0);
  const good = mk('goodfeed');
  for (let i = 0; i < 3; i++) runs.run(crypto.randomUUID(), good.id, iso(i * DAY + HOUR), iso(i * DAY), 'ok', 30, 12);

  const r = sourcehealth.report();
  assert.deepEqual(r.failing.map((f) => f.target), ['brokenfeed']);
  assert.match(r.failing[0].lastError, /403/);
  assert.ok(r.stale.some((f) => f.target === 'restingfeed'));
  assert.ok(!r.stale.some((f) => f.target === 'brokenfeed'), 'a failing feed is listed once, as failing');
  assert.deepEqual(r.dead.map((f) => [f.target, f.runs, f.why]), [['deadfeed', 10, 'everything it found was filtered out']]);
  assert.equal(r.top[0].target, 'goodfeed'); assert.equal(r.top[0].added, 36);
  assert.ok(r.totals.failing >= 1 && r.totals.dead === 1);
  void broken; void resting;
});

/* ---------------------------------------------------------- ingest queue */

test('the ingest queue runs new feeds first, then the most overdue, weighting followed creators double', () => {
  repo.db.prepare('UPDATE feeds SET enabled = 0').run();
  const c = repo.creators.create({ handle: 'qcreator' });
  const mk = (target, o) => {
    const f = repo.feeds.upsert({ platform: 'x', kind: o.kind || 'search', target, creatorId: o.creator || null, origin: 'admin' }).feed;
    repo.db.prepare('UPDATE feeds SET enabled = 1, next_run_at = ?, consecutive_failures = ? WHERE id = ?').run(o.next, o.fails || 0, f.id);
  };
  mk('open-late-1h', { next: iso(HOUR) });
  mk('creator-late-40m', { kind: 'user', creator: c.id, next: iso(40 * 60000) });
  mk('open-late-3h', { next: iso(3 * HOUR) });
  mk('failing-late-5h', { next: iso(5 * HOUR), fails: 2 });
  mk('brand-new', { next: null });
  mk('not-due', { next: new Date(Date.now() + HOUR).toISOString() });
  assert.deepEqual(repo.feeds.due(10).map((f) => f.target), ['brand-new', 'open-late-3h', 'failing-late-5h', 'creator-late-40m', 'open-late-1h']);
});

/* ------------------------------------------------- thumbnails and tints (v10) */

test('thumbnails: a large picture gets a small stored WebP and its tint; a small one only a tint; a missing one is marked', async () => {
  const thumbs = require('../src/engine/thumbs');
  const store = require('../src/lib/objectstore');
  assert.equal(repo.db.pragma('user_version', { simple: true }), 10);
  repo.db.prepare("UPDATE media SET tint = '' WHERE tint IS NULL").run(); // earlier tests' rows are not part of this one
  const ins = repo.db.prepare(`INSERT INTO media (id, platform, media_type, media_url, preview_url, hash, title) VALUES (?, 'reddit', ?, ?, ?, ?, 'x')`);
  const add = (id, type, url, preview = null) => ins.run(id, type, url, preview, crypto.createHash('md5').update(id).digest('hex'));
  add('thumbbig01', 'image', `${mock.url}/big.jpg`);
  add('thumbsml01', 'image', `${mock.url}/small.jpg`);
  add('thumbvid01', 'video', `${mock.url}/clip.mp4`, `${mock.url}/big.jpg`);
  add('thumbgone1', 'image', `${mock.url}/gone.jpg`);
  const r = await thumbs.sweep({ limit: 10 });
  assert.equal(r.checked, 4);
  const row = (id) => repo.db.prepare('SELECT tint, thumb_url FROM media WHERE id = ?').get(id);
  const big = row('thumbbig01');
  assert.match(big.tint, /^#[0-9a-f]{6}$/);
  const [rr, gg, bb] = [1, 3, 5].map((i) => parseInt(big.tint.slice(i, i + 2), 16));
  assert.ok(rr > 150 && gg < 80 && bb < 90, big.tint);
  assert.ok(store.isStoreUrl(big.thumb_url));
  const meta = await require('sharp')((await require('../src/lib/net').fetchBuffer(big.thumb_url)).buffer).metadata();
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, 360);
  assert.equal(row('thumbsml01').thumb_url, null); assert.match(row('thumbsml01').tint, /^#/);
  assert.ok(row('thumbvid01').thumb_url, 'a video gets its poster as thumbnail');
  assert.deepEqual(row('thumbgone1'), { tint: '', thumb_url: null });
  assert.equal(thumbs.progress().remaining, 0);
});
