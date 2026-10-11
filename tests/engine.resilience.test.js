'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv, JPEG, PNG_TINY } = require('./helpers/mock');

let mock; let repo; let engine; let breaker; let events;
const state = { rssStatus: 403, newEntry: false };

const rssFor = (base, entries) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Zed Gallery</title>${entries.map((e) => `<item><title>${e.title}</title><link>${base}/p/${e.id}</link><guid>${e.id}</guid><pubDate>${e.date}</pubDate>${e.media.map((m) => `<enclosure url="${m}" type="image/jpeg"/>`).join('')}</item>`).join('')}</channel></rss>`;

before(async () => {
  mock = await start({
    '/flaky.xml': () => ({ status: state.rssStatus, body: 'nope' }),
    '/gone.xml': () => ({ status: 404, body: 'gone' }),
    '/img/ok.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }),
    '/img/ok2.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }),
    '/img/tiny.png': () => ({ headers: { 'content-type': 'image/png' }, body: PNG_TINY }),
    '/img/page.jpg': () => ({ headers: { 'content-type': 'text/html' }, body: '<html>not an image</html>' }),
    '/img/missing.jpg': () => ({ status: 404, body: 'x' }),
    '/gallery.xml': () => {
      const base = mock.url;
      const entries = [
        { id: 'e1', title: 'Good photo', date: 'Fri, 03 Oct 2026 10:00:00 GMT', media: [`${base}/img/ok.jpg`] },
        { id: 'e2', title: 'Tiny placeholder', date: 'Fri, 03 Oct 2026 11:00:00 GMT', media: [`${base}/img/tiny.png`] },
        { id: 'e3', title: 'HTML pretending', date: 'Fri, 03 Oct 2026 12:00:00 GMT', media: [`${base}/img/page.jpg`] },
        { id: 'e4', title: 'Dead link', date: 'Fri, 03 Oct 2026 13:00:00 GMT', media: [`${base}/img/missing.jpg`] },
        { id: 'e5', title: 'Stock', date: 'Fri, 03 Oct 2026 14:00:00 GMT', media: ['https://images.unsplash.com/photo-1.jpg'] },
        { id: 'e6', title: 'im 15 lol', date: 'Fri, 03 Oct 2026 15:00:00 GMT', media: [`${base}/img/ok2.jpg`] },
      ];
      if (state.newEntry) entries.push({ id: 'e7', title: 'Brand new', date: 'Sat, 04 Oct 2026 10:00:00 GMT', media: [`${base}/img/ok2.jpg?v=2`] });
      return { headers: { 'content-type': 'application/rss+xml' }, body: rssFor(base, entries) };
    },
    '/bio-ok': () => ({ headers: { 'content-type': 'text/html' }, body: '<html><head><title>Zed | Links</title><meta property="og:description" content="Coach and model"></head><body><a href="https://x.com/zedfit">x</a><a href="https://bsky.app/profile/zed.bsky.social">b</a><a href="https://onlyfans.com/zed">of</a><a href="https://www.reddit.com/user/redditzed">r</a><a href="https://reddit.com/r/somecommunity">community-not-a-person</a></body></html>' }),
    '/bio-minor': () => ({ headers: { 'content-type': 'text/html' }, body: '<html><head><title>Kid | Links</title><meta property="og:description" content="im 16 and new here"></head><body><a href="https://x.com/kidacct">x</a></body></html>' }),
  });
  prepareEnv();
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  breaker = require('../src/engine/breaker');
  events = require('../src/engine/events');
});
after(async () => { engine.shutdown(); await mock.close(); });

const feed = (o) => repo.feeds.upsert({ origin: 'admin', ...o }).feed;

describe('failure handling', () => {
  test('a failing feed records the error, backs off exponentially, and never throws', async () => {
    breaker.reset();
    const f = feed({ platform: 'rss', kind: 'feed', target: `${mock.url}/flaky.xml`, intervalMin: 60 });
    const r1 = await engine.runFeed(f, 'manual');
    assert.equal(r1.status, 'error');
    let row = repo.feeds.get(f.id);
    assert.equal(row.consecutive_failures, 1); assert.equal(row.last_status, 'error'); assert.match(row.last_error, /403/);
    const d1 = new Date(row.next_run_at) - Date.now();
    await engine.runFeed(repo.feeds.get(f.id), 'manual');
    row = repo.feeds.get(f.id);
    assert.equal(row.consecutive_failures, 2);
    assert.ok(new Date(row.next_run_at) - Date.now() > d1 * 1.5, 'second failure waits longer');
  });
  test('recovery resets the failure counter and clears the error', async () => {
    state.rssStatus = 200;
    const f = repo.feeds.find('rss', 'feed', `${mock.url}/flaky.xml`);
    // body is not a feed, but a 200 with no entries is a *healthy* empty run
    const r = await engine.runFeed(repo.feeds.get(f.id), 'manual');
    assert.equal(r.status, 'empty');
    const row = repo.feeds.get(f.id);
    assert.equal(row.consecutive_failures, 0); assert.equal(row.last_error, null);
  });
  test('a platform that keeps failing trips its breaker, and the scheduler then leaves it alone', async () => {
    breaker.reset(); state.rssStatus = 403;
    const feeds = [1, 2, 3, 4, 5].map((i) => feed({ platform: 'rss', kind: 'feed', target: `${mock.url}/flaky.xml?i=${i}`, intervalMin: 60 }));
    for (const f of feeds.slice(0, 4)) await engine.runFeed(repo.feeds.get(f.id), 'schedule');
    assert.equal(breaker.snapshot().rss.state, 'open');
    repo.feeds.update(feeds[4].id, { runNow: true });
    const before = repo.runs.recent({ feedId: feeds[4].id }).length;
    repo.settings.set('schedulerEnabled', 'true');
    await engine.tick();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(repo.runs.recent({ feedId: feeds[4].id }).length, before, 'no request is sent to an open platform');
    breaker.reset();
  });
  test('"not configured" is skipped, not failed: no failure count, no breaker damage', async () => {
    breaker.reset();
    const f = feed({ platform: 'x', kind: 'search', target: 'gay muscle' });
    const r = await engine.runFeed(f, 'schedule');
    assert.equal(r.status, 'skipped');
    const row = repo.feeds.get(f.id);
    assert.equal(row.consecutive_failures, 0); assert.equal(row.last_status, 'skipped'); assert.match(row.last_error, /X_BEARER_TOKEN/);
    assert.equal((breaker.snapshot().x || { failures: 0 }).failures, 0);
  });
  test('a target that no longer exists is disabled after three 404s', async () => {
    breaker.reset();
    const f = feed({ platform: 'rss', kind: 'feed', target: `${mock.url}/gone.xml` });
    for (let i = 0; i < 3; i++) await engine.runFeed(repo.feeds.get(f.id), 'manual');
    const row = repo.feeds.get(f.id);
    assert.equal(row.enabled, 0); assert.match(row.last_error, /Not found/);
    assert.notEqual((breaker.snapshot().rss || {}).state, 'open', '404s never trip the platform breaker');
  });
  test('an unknown adapter/kind combination is skipped cleanly', async () => {
    const f = feed({ platform: 'nonesuch', kind: 'user', target: 'x' });
    assert.equal((await engine.runFeed(f, 'manual')).status, 'skipped');
  });
});

describe('media validation for unknown hosts', () => {
  test('only genuine media is published; placeholders, HTML, dead links, stock and unsafe items are filtered', async () => {
    breaker.reset();
    const f = feed({ platform: 'rss', kind: 'feed', target: `${mock.url}/gallery.xml`, label: 'Zed Gallery' });
    const r = await engine.runFeed(f, 'manual');
    assert.equal(r.added, 1, JSON.stringify(r));
    assert.equal(r.blocked, 1, 'underage-signal title blocked');
    const rows = repo.media.list({ limit: 50, state: 'any', admin: true, platform: 'rss' }).items;
    assert.deepEqual(rows.map((m) => m.title), ['Good photo']);
    assert.equal(r.skipped, 3, 'tiny placeholder, HTML page and dead link rejected by the probe');
    assert.equal(r.fetched, 5, 'the stock-photo host was already dropped by the adapter');
  });
  test('the feed owns a creator, created automatically from the site', () => {
    const f = repo.feeds.find('rss', 'feed', `${mock.url}/gallery.xml`);
    assert.ok(f.creator_id);
    const c = repo.creators.get(f.creator_id);
    assert.equal(c.handle, 'Zed Gallery'); assert.equal(c.media_count, 1);
  });
  test('re-running finds nothing new; a new entry is picked up via the cursor', async () => {
    const f = () => repo.feeds.find('rss', 'feed', `${mock.url}/gallery.xml`);
    const again = await engine.runFeed(f(), 'manual');
    assert.equal(again.added, 0);
    state.newEntry = true;
    const next = await engine.runFeed(f(), 'manual');
    assert.equal(next.added, 1, JSON.stringify(next));
    assert.equal(repo.media.list({ q: 'brand new' }).total, 1);
  });
  test('items from a blocked creator are refused even if the feed keeps running', async () => {
    const f = repo.feeds.find('rss', 'feed', `${mock.url}/gallery.xml`);
    repo.creators.block(f.creator_id, 'test');
    state.newEntry = false;
    const before = repo.media.list({ admin: true, state: 'any', platform: 'rss' }).total;
    await engine.runFeed(repo.feeds.get(f.id), 'manual', { force: true });
    assert.equal(repo.media.list({ admin: true, state: 'any', platform: 'rss' }).total, before);
  });
});

describe('creator profiles and cross-platform linking', () => {
  test('a link-in-bio page adds the creator’s other public accounts and keeps paywalled links display-only', async () => {
    const c = repo.creators.create({ handle: 'zedcreator', origin: 'admin' });
    const f = feed({ platform: 'linkinbio', kind: 'page', target: `${mock.url}/bio-ok`, creatorId: c.id });
    const r = await engine.runFeed(f, 'manual');
    assert.equal(r.status, 'empty');
    const names = repo.feeds.list({ creatorId: c.id, limit: 50 }).items.map((x) => `${x.platform}:${x.kind}:${x.target}`).sort();
    assert.ok(names.includes('x:user:zedfit') && names.includes('bluesky:user:zed.bsky.social') && names.includes('reddit:user:redditzed'), names.join());
    assert.ok(!names.some((n) => n.includes('somecommunity')), 'a community link in a bio is not a creator account');
    const full = repo.creators.get(c.id);
    assert.ok(full.links.some((l) => l.service === 'OnlyFans' && l.url.includes('onlyfans.com/zed')));
    assert.ok(!repo.feeds.list({ platform: 'external', limit: 5 }).total, 'paywalled platforms never become feeds');
    assert.equal(full.display_name === 'zedcreator' || full.display_name === 'Zed', true);
  });
  test('a profile that says the person is a minor blocks the creator immediately', async () => {
    const c = repo.creators.create({ handle: 'kidcreator', origin: 'admin' });
    const f = feed({ platform: 'linkinbio', kind: 'page', target: `${mock.url}/bio-minor`, creatorId: c.id });
    await engine.runFeed(f, 'manual');
    assert.equal(repo.creators.get(c.id).status, 'blocked');
    assert.equal(repo.feeds.find('x', 'user', 'kidacct'), null, 'their other accounts are never followed');
    assert.ok(repo.blocklist.has('creator', c.id));
  });
});

describe('manual controls', () => {
  test('manual work runs even with the scheduler off; stop clears the queue; run history is kept', async () => {
    repo.settings.set('schedulerEnabled', 'false');
    breaker.reset();
    const f = feed({ platform: 'rss', kind: 'feed', target: `${mock.url}/gallery.xml?manual=1` });
    assert.equal(engine.enqueue([f.id], { force: true }), 1);
    assert.equal(engine.enqueue([f.id], { force: true }), 0, 'no duplicate queueing');
    for (let i = 0; i < 40 && repo.runs.recent({ feedId: f.id }).filter((r) => r.finished_at).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(repo.runs.recent({ feedId: f.id }).some((r) => r.finished_at), 'queued run executed');
    const g = feed({ platform: 'rss', kind: 'feed', target: `${mock.url}/gallery.xml?manual=2` });
    engine.stopAll();
    assert.equal(engine.status().queued, 0);
    assert.ok(events.getLogs(50).some((l) => /Stop requested/.test(l.msg)));
    assert.ok(g);
  });
  test('seeding is idempotent and only happens once per version', () => {
    const first = engine.seedDefaults(); const second = engine.seedDefaults();
    assert.ok(first > 0); assert.equal(second, 0);
    repo.feeds.remove(repo.feeds.find('reddit', 'community', 'gaymuscle').id);
    assert.equal(engine.seedDefaults(), 0, 'a feed the admin deleted does not come back');
  });
});
