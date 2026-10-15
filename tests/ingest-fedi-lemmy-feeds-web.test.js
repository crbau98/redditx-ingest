'use strict';
/**
 * Lemmy (v3 + v4), RSS/Atom/JSON Feed (conditional GET, autodiscovery, encodings), web pages (robots.txt),
 * link-in-bio hubs, the Brave client and the Telegram Bot client - all against mock servers.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let lemmy3; let lemmy4; let site; let brave; let tg; let repo; let engine;
const state = { lemmy3Pages: [], lemmy4Cursors: [], braveCalls: [], brave429: 0, rssEtagHits: [], tgCalls: 0 };
const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';

const pv = (id, extra = {}, post = {}) => ({
  post: { id, name: 'Gay gym selfie', url: `https://lemmynsfw.com/pictrs/image/${id}.jpg`, url_content_type: 'image/jpeg', thumbnail_url: `https://lemmynsfw.com/pictrs/image/${id}.jpg?thumbnail=512`, published: '2026-10-04T10:00:00Z', ap_id: `https://lemmynsfw.com/post/${id}`, nsfw: true, ...post },
  creator: { name: 'zed', actor_id: 'https://lemmynsfw.com/u/zed' }, community: { name: 'gaynsfw', actor_id: 'https://lemmynsfw.com/c/gaynsfw', nsfw: true }, counts: { score: 12 }, ...extra,
});

const feedXml = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Zed</title>${items}</channel></rss>`;
const rssItem = (n, date) => `<item><title>Gay gym ${n}</title><link>https://site.example/p/${n}</link><guid>g${n}</guid><pubDate>${date}</pubDate><enclosure url="https://site.example/img/${n}.jpg" type="image/jpeg"/></item>`;

before(async () => {
  lemmy3 = await start({
    '/api/v3/post/list': (req, res, url) => {
      state.lemmy3Pages.push(url.search);
      if (url.searchParams.get('community_name') === 'missing') return { status: 400, json: { error: 'couldnt_find_community' } };
      const page = Number(url.searchParams.get('page'));
      if (page === 1) return { json: { posts: [
        pv(1), pv(2, {}, { url: 'https://www.redgifs.com/watch/bluepony', url_content_type: 'text/html', thumbnail_url: 'https://lemmynsfw.com/pictrs/image/t.jpg' }),
        pv(3, {}, { url: 'https://news.example/article', url_content_type: 'text/html', thumbnail_url: null }), pv(4, {}, { removed: true }),
        pv(5, {}, { published: '2026-10-04T09:00:00.123456' /* no zone */ }),
      ] } };
      return { json: { posts: [] } };
    },
  });
  lemmy4 = await start({
    // v3 is gone on Lemmy 1.0 servers
    '/api/v4/post/list': (req, res, url) => {
      state.lemmy4Cursors.push(url.searchParams.get('page_cursor'));
      if (!url.searchParams.get('page_cursor')) {
        return { json: { next_page: 'CUR2', posts: [{ post: { id: 11, name: 'Gay muscle', url: 'https://lemmy.example/pictrs/image/a.webp', url_content_type: 'image/webp', thumbnail_url: '/pictrs/image/a-thumb.webp', published_at: '2026-10-05T10:00:00Z', ap_id: 'https://lemmy.example/post/11', nsfw: false, score: 40 }, creator: { name: 'zed', actor_id: 'https://lemmy.example/u/zed' }, community: { name: 'gaymuscle', actor_id: 'https://lemmy.example/c/gaymuscle' } }] } };
      }
      return { json: { posts: [{ post: { id: 10, name: 'Gay muscle 2', url: 'https://lemmy.example/pictrs/image/b.webp', url_content_type: 'image/webp', published_at: '2026-10-04T10:00:00Z', ap_id: 'https://lemmy.example/post/10', score: 3 }, creator: { name: 'zed', actor_id: 'https://lemmy.example/u/zed' }, community: { name: 'gaymuscle', actor_id: 'https://lemmy.example/c/gaymuscle' } }] } };
    },
  });
  const latin1 = Buffer.from(feedXml(rssItem(1, 'Fri, 03 Oct 2026 10:00:00 GMT')).replace('UTF-8', 'ISO-8859-1').replace('<title>Zed</title>', '<title>Zéd café</title>'), 'latin1');
  site = await start({
    '/robots.txt': () => ({ body: 'User-agent: Googlebot\nUser-agent: *\nDisallow: /private\nDisallow: /*.json$\nAllow: /private/ok\n' }),
    '/private/page': () => ({ body: '<html></html>' }), '/private/ok': () => ({ headers: { 'content-type': 'text/html' }, body: '<html><body><img src="/a.jpg" width="900"></body></html>' }),
    '/zed.xml': (req) => {
      state.rssEtagHits.push(req.headers['if-none-match'] || null);
      if (req.headers['if-none-match'] === '"v1"') return { status: 304 };
      return { headers: { 'content-type': 'application/rss+xml', etag: '"v1"' }, body: feedXml(rssItem(1, 'Fri, 03 Oct 2026 10:00:00 GMT') + rssItem(2, 'Sat, 04 Oct 2026 10:00:00 GMT')) };
    },
    '/latin1.xml': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: latin1 }),
    '/oldest-first.xml': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: feedXml([1, 2, 3, 4, 5].map((n) => rssItem(n, `Mon, 0${n} Sep 2026 10:00:00 GMT`)).join('')) }),
    '/home': () => ({ headers: { 'content-type': 'text/html' }, body: '<html><head><title>Zed</title><link rel="alternate" type="application/atom+xml" href="/atom-feed"><link rel="alternate" type="application/rss+xml" title="Comments" href="/comments.xml"></head><body>hi</body></html>' }),
    '/atom-feed': () => ({ headers: { 'content-type': 'application/atom+xml' }, body: '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Zed</title><entry><id>1</id><title>One</title><link href="/p/1"/><updated>2026-10-04T10:00:00Z</updated><published>2026-10-01T10:00:00Z</published><link rel="enclosure" type="image/jpeg" href="/img/1.jpg"/></entry></feed>' }),
    '/plain-page': () => ({ headers: { 'content-type': 'text/html' }, body: '<html><body>no feeds here</body></html>' }),
    '/hub/zed': () => ({ headers: { 'content-type': 'text/html' }, body: `<html><head><title>Zed | Linktree</title></head><body>
      <a href="${site.url}/out?url=https%3A%2F%2Ft.me%2Fzedchannel">Telegram</a>
      <script id="__NEXT_DATA__">{"links":[{"url":"https:\\u002F\\u002Fx.com\\u002Fzedfit"},{"url":"https:\\/\\/www.redgifs.com\\/users\\/zedgifs?a=1\\u0026b=2"}]}</script></body></html>` }),
    '/lazy': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: feedXml('<item><title>Lazy</title><link>https://site.example/lazy</link><guid>z</guid><pubDate>Fri, 03 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<a href="https://site.example/full.jpg"><img src="https://site.example/thumb.jpg" width="300" height="300"></a><img src="data:image/gif;base64,R0lGOD" data-src="https://site.example/lazy1.jpg" width="800"><img srcset="https://site.example/s-400.jpg 400w, https://site.example/s-1600.jpg 1600w" src="https://site.example/s-400.jpg">]]></description></item>') }),
  });
  brave = await start({
    '/res/v1/web/search': (req, res, url) => {
      state.braveCalls.push({ token: req.headers['x-subscription-token'], accept: req.headers.accept, q: url.searchParams.get('q') });
      if (url.searchParams.get('q') === 'badkey') return { status: 401, json: { error: 'SUBSCRIPTION_TOKEN_INVALID' } };
      if (url.searchParams.get('q') === 'quota') return { status: 429, headers: { 'x-ratelimit-remaining': '1, 0', 'x-ratelimit-reset': '1, 99999' }, json: {} };
      if (state.brave429-- > 0) return { status: 429, headers: { 'x-ratelimit-remaining': '0, 900', 'x-ratelimit-reset': '1, 99999' }, json: {} };
      return { json: { web: { results: [{ url: 'https://bsky.app/profile/zed.bsky.social', title: 'Zed <strong>bsky</strong>', description: 'x' }, { title: 'no url' }] } } };
    },
  });
  tg = await start({
    [`/bot${TG_TOKEN}/getChat`]: () => { state.tgCalls++; return { status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 17', parameters: { retry_after: 17 } } }; },
  });
  prepareEnv({
    MASTODON_INSTANCES: 'x.invalid', LEMMY_INSTANCES: 'x.invalid',
    BRAVE_BASE_URL: brave.url, BRAVE_API_KEY: 'brave-key', TELEGRAM_BOT_BASE_URL: tg.url, TELEGRAM_API_KEY: TG_TOKEN,
  });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
});
after(async () => { engine.shutdown(); for (const m of [lemmy3, lemmy4, site, brave, tg]) await m.close(); });

const ctx = (extra = {}) => ({ cursor: {}, aborted: () => false, needProfile: false, ...extra });
const hostOf = (m) => m.url.replace('http://', '');

describe('Lemmy', () => {
  const lemmy = () => require('../src/sources/lemmy');

  test('v3 community feed: pages until empty; images, RedGIFs link posts and zone-less dates are handled', async () => {
    const out = await lemmy().fetch({ kind: 'community', target: `gaynsfw@${hostOf(lemmy3)}` }, ctx());
    assert.match(state.lemmy3Pages[0], /community_name=gaynsfw/); assert.match(state.lemmy3Pages[0], /sort=New/); assert.match(state.lemmy3Pages[1], /page=2/);
    const bySource = Object.fromEntries(out.items.map((i) => [i.sourceId.split('/').pop(), i]));
    assert.deepEqual(Object.keys(bySource).sort(), ['1', '2', '5']);
    assert.equal(bySource[2].mediaUrl, 'https://www.redgifs.com/watch/bluepony', 'RedGIFs page kept for the pipeline to resolve');
    assert.equal(bySource[2].mediaType, 'video');
    assert.equal(bySource[5].postedAt, '2026-10-04T09:00:00.123Z', 'timestamps without a zone are UTC');
    assert.equal(bySource[1].author, 'zed@lemmynsfw.com');
  });

  test('"couldnt_find_community" (HTTP 400) is reported as gone', async () => {
    await assert.rejects(() => lemmy().fetch({ kind: 'community', target: `missing@${hostOf(lemmy3)}` }, ctx()), (e) => e.status === 404 && /couldnt_find_community/.test(e.message));
  });

  test('Lemmy 1.0 (v4 only): falls back, follows page_cursor, reads score/published_at, absolutises thumbnails', async () => {
    const out = await lemmy().fetch({ kind: 'community', target: `gaymuscle@${hostOf(lemmy4)}` }, ctx());
    assert.deepEqual(state.lemmy4Cursors, [null, 'CUR2']);
    assert.equal(out.items.length, 2);
    const first = out.items.find((i) => /post\/11/.test(i.sourceId));
    assert.equal(first.score, 40); assert.equal(first.postedAt, '2026-10-05T10:00:00.000Z'); assert.equal(first.nsfw, 'suggestive');
    assert.equal(first.previewUrl, `http://${hostOf(lemmy4)}/pictrs/image/a-thumb.webp`);
    // the second call remembers v4 and does not probe v3 again
    state.lemmy4Cursors.length = 0;
    await lemmy().fetch({ kind: 'community', target: `gaymuscle@${hostOf(lemmy4)}` }, ctx({ cursor: { newestAt: '2026-10-05T10:00:00.000Z' } }));
    assert.ok(!lemmy4.hits.slice(-2).some((h) => h.includes('/api/v3/')));
  });
});

describe('RSS / Atom / JSON Feed', () => {
  const rss = () => require('../src/sources/rss');

  test('conditional GET: ETag stored in the cursor, unchanged feed answers 304 and yields nothing', async () => {
    const feed = { kind: 'feed', target: `${site.url}/zed.xml` };
    const first = await rss().fetch(feed, ctx());
    assert.equal(first.items.length, 2); assert.equal(first.cursor.etag, '"v1"'); assert.equal(first.cursor.newestAt, '2026-10-04T10:00:00.000Z');
    const second = await rss().fetch(feed, ctx({ cursor: first.cursor }));
    assert.equal(second.via, 'feed-304'); assert.equal(second.items.length, 0);
    assert.equal(state.rssEtagHits[1], '"v1"');
    const forced = await rss().fetch(feed, ctx({ cursor: { ...first.cursor, newestAt: null }, force: true }));
    assert.equal(forced.items.length, 2, 'a forced run ignores validators');
  });

  test('ISO-8859-1 feeds are decoded with their declared charset', async () => {
    const out = await rss().fetch({ kind: 'feed', target: `${site.url}/latin1.xml` }, ctx());
    assert.equal(out.profile.displayName, 'Zéd café');
  });

  test('oldest-first feeds still yield the NEWEST entries when capped', async () => {
    const out = await rss().fetch({ kind: 'feed', target: `${site.url}/oldest-first.xml` }, ctx({ limit: 2 }));
    assert.deepEqual(out.items.map((i) => i.sourceId).sort(), ['g4', 'g5']);
  });

  test('a site URL instead of a feed URL is autodiscovered via <link rel=alternate> (published beats updated)', async () => {
    const out = await rss().fetch({ kind: 'feed', target: `${site.url}/home` }, ctx());
    assert.equal(out.via, 'feed-discovered');
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].mediaUrl, `${site.url}/img/1.jpg`, 'relative enclosure resolved against the feed URL');
    assert.equal(out.items[0].postedAt, '2026-10-01T10:00:00.000Z');
  });

  test('a page with no feed is a clear error instead of a silent empty run', async () => {
    await assert.rejects(() => rss().fetch({ kind: 'feed', target: `${site.url}/plain-page` }, ctx()), (e) => e.status === 422 && /not a feed/.test(e.message));
  });

  test('inline HTML: linked full-size image is not duplicated by its thumbnail; lazy-loaded and srcset images are found', async () => {
    const out = await rss().fetch({ kind: 'feed', target: `${site.url}/lazy` }, ctx());
    assert.deepEqual(out.items.map((i) => i.mediaUrl).sort(), ['https://site.example/full.jpg', 'https://site.example/lazy1.jpg', 'https://site.example/s-1600.jpg']);
  });
});

describe('web pages and link-in-bio', () => {
  const web = () => require('../src/sources/web');

  test('robots.txt: groups with several User-agent lines, Allow overrides, wildcard + $ patterns', async () => {
    assert.equal(await web().robotsAllows(`${site.url}/private/page`), false);
    assert.equal(await web().robotsAllows(`${site.url}/private/ok`), true, 'longer Allow wins');
    assert.equal(await web().robotsAllows(`${site.url}/data/x.json`), false);
    assert.equal(await web().robotsAllows(`${site.url}/data/x.json?y=1`), true, '$ anchors the pattern');
    assert.equal(await web().robotsAllows(`${site.url}/gallery`), true);
  });

  test('robots.txt that is 404, 5xx, HTML or unreachable never blocks the site', async () => {
    for (const [name, handler] of [['404', () => ({ status: 404, body: 'nope' })], ['500', () => ({ status: 500, body: 'oops' })], ['html', () => ({ headers: { 'content-type': 'text/html' }, body: '<html><body>Disallow: /</body></html>' })], ['spa', () => ({ body: '<!doctype html><html>Disallow: /</html>' })]]) {
      const m = await start({ '/robots.txt': handler });
      try { assert.equal(await web().robotsAllows(`${m.url}/anything`), true, name); } finally { await m.close(); }
    }
    const dead = await start({}); const url = dead.url; await dead.close();
    assert.equal(await web().robotsAllows(`${url}/anything`), true, 'connection refused');
  });

  test('parseRobots: the PRISM group overrides *; "Disallow:" (empty) allows everything', () => {
    const rules = web().parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: PRISM\nDisallow: /admin\n');
    assert.equal(web().pathAllowed(rules, '/gallery'), true); assert.equal(web().pathAllowed(rules, '/admin/x'), false);
    assert.equal(web().pathAllowed(web().parseRobots('User-agent: *\nDisallow:\n'), '/x'), true);
  });

  test('link-in-bio: URLs hidden in \\u002F-escaped hydration JSON and ?url= click wrappers are recovered', async () => {
    const out = await web().linkInBioAdapter.fetch({ kind: 'page', target: `${site.url}/hub/zed` });
    const got = out.profile.links.map((l) => `${l.platform}:${l.target}`);
    assert.ok(got.includes('x:zedfit'), got.join());
    assert.ok(got.includes('redgifs:zedgifs'), got.join());
    assert.ok(got.includes('telegram:zedchannel'), got.join());
    assert.equal(out.items.length, 0);
  });
});

describe('Brave Search client', () => {
  const braveLib = () => require('../src/lib/brave');

  test('sends X-Subscription-Token + Accept: application/json and reads web.results[]', async () => {
    const r = await braveLib().search('gay muscle bluesky');
    assert.deepEqual(r, [{ url: 'https://bsky.app/profile/zed.bsky.social', title: 'Zed bsky', description: 'x' }]);
    assert.equal(state.braveCalls[0].token, 'brave-key'); assert.equal(state.braveCalls[0].accept, 'application/json');
  });

  test('a per-second 429 is retried once after the reset; a spent monthly quota stops with a budget error', async () => {
    state.brave429 = 1;
    const r = await braveLib().search('retry me');
    assert.equal(r.length, 1);
    await assert.rejects(() => braveLib().search('quota'), (e) => e.budget === true && /monthly/.test(e.message));
  });

  test('a rejected key is a configuration problem (skip), not an outage', async () => {
    await assert.rejects(() => braveLib().search('badkey'), (e) => e.skip === true && /BRAVE_API_KEY/.test(e.message));
  });
});

describe('Telegram Bot client', () => {
  test('flood control (429 + parameters.retry_after) surfaces the wait, and the token never leaks', async () => {
    const bot = require('../src/lib/telegram-bot');
    await assert.rejects(() => bot.channelInfo('somechannel'), (e) => e.retryAfter === 17000 && e.status === 429 && !e.message.includes(TG_TOKEN) && /Too Many Requests/.test(e.message));
  });
});
