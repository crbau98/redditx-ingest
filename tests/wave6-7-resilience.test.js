'use strict';
/**
 * Waves 6-7 (v4.20.0): the scheduler heals itself after a hung run, feed retirement reads only the dead list,
 * BoyfriendTV returns before the 150 s run timeout, more wrong-platform hosts stay off, and SearXNG keeps the hits
 * that name the query when one of its engines is noisy.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

// Before anything under src/ loads (describe bodies run at load time): test mode, a temp DB, no live search doors.
prepareEnv({ SEARCH_PROVIDERS: 'searxng' });

let mock;
const searx = { results: [] };
let repo; let engine; let registry; let realGet; let settings;
before(async () => {
  mock = await start({ '/search': () => ({ json: { results: searx.results } }) });
  require('../src/config').searxngUrl = mock.url; // config is read at load; the mock port is known only now
  repo = require('../src/db/repo'); engine = require('../src/engine/engine');
  registry = require('../src/sources'); realGet = registry.get; settings = require('../src/settings');
});
after(async () => { registry.get = realGet; engine._state.timer = null; engine.shutdown(); await mock.close(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('1. engine: a hung run never keeps its slot', () => {
  test('the hard stop schedules a tick at once, so the freed slot is refilled', async () => {
    const hung = { platform: 'hang67', kinds: ['user'], isConfigured: () => ({ ok: true }), fetch: () => new Promise(() => {}) };
    registry.get = (p) => (p === 'hang67' ? hung : realGet(p));
    const feed = repo.feeds.upsert({ platform: 'hang67', kind: 'user', target: 'stuck', runNow: false }).feed;
    const realSweep = repo.runs.timeoutStale; let ticks = 0;
    repo.runs.timeoutStale = (...a) => { ticks++; return realSweep(...a); };
    engine._state.timer = { fake: true }; // "the engine is started": the hard stop only re-ticks a live engine
    try {
      engine.runFeed(feed, 'manual', { hardDeadlineMs: 80 });
      await wait(20);
      assert.ok(engine._state.running.get(feed.id).startedMs > 0, 'the entry carries its start time');
      assert.equal(typeof engine._state.running.get(feed.id).forceFinish, 'function');
      assert.equal(ticks, 0);
      await wait(150);
      assert.equal(engine._state.running.has(feed.id), false, 'the slot is free');
      assert.ok(ticks >= 1, 'tick() ran after the hard stop without waiting for the 30 s timer');
    } finally { repo.runs.timeoutStale = realSweep; engine._state.timer = null; }
  });

  test('tick() evicts an in-memory entry past the hard deadline plus grace, and closes it through its own finish', async () => {
    let closed = null;
    const old = { feedId: 'ghost', platform: 'ghost', startedMs: Date.now() - (15 * 60_000 + 20_000), forceFinish: (e) => { closed = e; } };
    const young = { feedId: 'young', platform: 'young', startedMs: Date.now() - 60_000, forceFinish: () => { throw new Error('must not be closed'); } };
    engine._state.running.set('ghost', old);
    engine._state.running.set('young', young);
    try {
      await engine.tick();
      assert.equal(engine._state.running.has('ghost'), false, 'the stuck entry is gone');
      assert.match(closed, /watchdog: evicted stuck in-memory run/);
      assert.equal(engine._state.running.has('young'), true, 'a run inside its deadline is left alone');
    } finally { engine._state.running.delete('ghost'); engine._state.running.delete('young'); }
  });
});

describe('2. sourcehealth: retiring dead feeds runs only the dead-list query', () => {
  test('retireDead() pauses the dead feed through deadFeeds() and never runs the other report() queries', () => {
    const sh = require('../src/engine/sourcehealth');
    settings.update({ keepRunHistoryDays: 30 });
    const feed = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'deadsub67', origin: 'discovered', runNow: false }).feed;
    const longAgo = new Date(Date.now() - 60 * 86400000).toISOString();
    repo.db.prepare('UPDATE feeds SET created_at = ? WHERE id = ?').run(longAgo, feed.id);
    const ins = repo.db.prepare("INSERT INTO feed_runs (id, feed_id, started_at, status, fetched, added) VALUES (?, ?, ?, 'empty', 0, 0)");
    for (let i = 0; i < 14; i++) ins.run(`dead67-${i}`, feed.id, new Date(Date.now() - (i + 1) * 86400000).toISOString());

    const viaHelper = sh.deadFeeds({ deadDays: 30, deadMinRuns: 12, limit: 1000, deadNeverWorked: true });
    assert.ok(viaHelper.some((f) => f.id === feed.id), 'deadFeeds() lists it');
    assert.deepEqual(sh.report({ deadDays: 30, deadMinRuns: 12, limit: 1000, deadNeverWorked: true }).dead.map((f) => f.id), viaHelper.map((f) => f.id), 'report() uses the same list');

    const seen = []; const orig = repo.db.prepare.bind(repo.db);
    repo.db.prepare = (sql) => { seen.push(sql); return orig(sql); };
    let r;
    try { r = sh.retireDead({ dryRun: true }); } finally { repo.db.prepare = orig; }
    assert.ok(r.paused.some((p) => p.id === feed.id), 'the dead feed would be paused');
    assert.ok(seen.some((s) => /HAVING runs >= @minRuns/.test(s)), 'the dead-list query ran');
    for (const other of [/consecutive_failures >= \?/, /last_success_at < \?/, /ORDER BY COALESCE\(last_success_at/]) {
      assert.ok(!seen.some((s) => other.test(s)), `retireDead() does not run ${other}`);
    }
  });
});

describe('3. BoyfriendTV stays inside the run timeout', () => {
  const net = require('../src/lib/net');
  const bftv = require('../src/sources/boyfriendtv');
  const video = (id) => `https://www.boyfriendtv.in/videos/${id}/demo/`;
  const embed = (id) => `https://www.boyfriendtv.in/embed/${id}/1/600/338/`;
  const INDEX = 'https://cdn77.boyfriendtv.in/sitemaps/boyfriendtv.in/sitemaps.xml';
  const CHILD = 'https://cdn77.boyfriendtv.in/sitemaps/boyfriendtv.in/sitemap_videos_1.xml';
  const page = (id) => `<html><head><title>Video ${id} | BoyFriendTV</title><meta property="og:title" content="Video ${id}" /></head><body><iframe src="${embed(id)}"></iframe></body></html>`;
  const player = (id) => `<script>player.setup({ sources: {"hlsAuto":"https:\\/\\/cdn.boyfriendtv.in\\/key=a\\/media=hls4A\\/multi=854x480:${id}\\/_TPL_.mp4"} });</script>`;

  test('18 pages a run by default (setting and adapter agree)', () => {
    assert.equal(bftv.DEFAULT_PER_RUN, 18);
    assert.equal(require('../src/settings').SCHEMA ? require('../src/settings').SCHEMA.boyfriendtvPagesPerRun.default : 18, 18);
  });

  test('past its soft deadline a run stops cleanly, returns what it read, and the cursor resumes at the first unread page', async () => {
    const ids = ['1', '2', '3', '4', '5', '6'];
    const pages = new Map([[INDEX, `<sitemapindex><sitemap><loc>${CHILD}</loc></sitemap></sitemapindex>`], [CHILD, `<urlset>${ids.map((i) => `<url><loc>${video(i)}</loc></url>`).join('')}</urlset>`],
      ['https://www.boyfriendtv.in/rss/videos.xml', '<rss><channel></channel></rss>']]);
    for (const i of ids) { pages.set(video(i), page(i)); pages.set(embed(i), player(i)); }
    const realReq = net.request; const realText = net.fetchText; const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    const answer = (url) => {
      if (/robots\.txt$/.test(url)) return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nAllow: /\n') };
      if (/\/videos\//.test(url)) clock += 10_000; // every video page costs 10 s of the run
      const b = pages.get(url);
      return b ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(b) } : { status: 404, headers: {}, body: Buffer.from('') };
    };
    net.request = async (url) => answer(url);
    net.fetchText = async (url) => { const r = answer(url); if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }); return r.body.toString('utf8'); };
    settings.update({ boyfriendtvPagesPerRun: 18, boyfriendtvDailyPages: 200 });
    try {
      const r = await bftv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: 'https://www.boyfriendtv.in/' }, { softTimeoutMs: 25_000 });
      assert.deepEqual(r.items.map((i) => i.sourceId), ['bftv-1', 'bftv-2', 'bftv-3'], 'the pages read before the deadline are returned');
      assert.equal(r.cursor.child, CHILD);
      assert.equal(r.cursor.offset, 3, 'the cursor points at the first page not read');
      assert.ok(r.notes.some((n) => /soft deadline/.test(n)));
      const next = await bftv.fetch({ platform: 'boyfriendtv', kind: 'catalog', target: 'https://www.boyfriendtv.in/' }, { cursor: r.cursor, softTimeoutMs: 1_000_000 });
      assert.deepEqual(next.items.map((i) => i.sourceId), ['bftv-4', 'bftv-5', 'bftv-6'], 'the next run continues where it stopped');
    } finally { net.request = realReq; net.fetchText = realText; Date.now = realNow; }
  });
});

describe('4. wrong-platform hosts', () => {
  test('mastodon on fanhub.com / theb.co and peertube on xxxerome.com / onlyfaphouse.com stay off', () => {
    const { deadReason } = require('../src/lib/deadhosts');
    assert.match(deadReason('mastodon', 'someone@fanhub.com'), /not a Mastodon server/);
    assert.match(deadReason('mastodon', 'someone@theb.co'), /not a Mastodon server/);
    assert.match(deadReason('peertube', 'https://xxxerome.com/c/x'), /not a PeerTube server/);
    assert.match(deadReason('peertube', 'onlyfaphouse.com'), /not a PeerTube server/);
    assert.equal(deadReason('mastodon', 'someone@mastodon.social'), null);
    assert.equal(deadReason('rss', 'https://fanhub.com/feed'), null, 'only the wrong platform is refused');
  });
});

describe('5. SearXNG coherence', () => {
  test('one noisy engine no longer sinks the coherent SearXNG hits', async () => {
    const websearch = require('../src/lib/websearch');
    searx.results = [
      { url: 'https://bsky.app/profile/zarkovian.bsky.social', title: 'Zarkovian on Bluesky', content: 'creator' },
      ...[1, 2, 3, 4, 5].map((i) => ({ url: `https://noise.example/${i}`, title: `Unrelated ${i}`, content: 'shopping' })),
    ];
    const r = await websearch.search('zarkovian', { fresh: true });
    assert.equal(r.provider, 'searxng');
    assert.deepEqual(r.map((x) => x.url), ['https://bsky.app/profile/zarkovian.bsky.social'], 'only the coherent hit is kept');
  });

  test('a SearXNG answer with no coherent hit at all is still dropped', async () => {
    const websearch = require('../src/lib/websearch');
    searx.results = [1, 2, 3].map((i) => ({ url: `https://noise.example/x${i}`, title: `Unrelated ${i}`, content: 'shopping' }));
    await assert.rejects(() => websearch.search('qwyntrell', { fresh: true }), /incoherent results from searxng/);
  });
});
