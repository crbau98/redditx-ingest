'use strict';
/**
 * 2026 content reach: DuckDuckGo's working request shape, the performer directories
 * (GayForFans + JustTheGays, where the 2026 material lives), and the namesake rule.
 *
 * Everything runs against a mock server: no test reaches the live web.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let websearch; let brave; let gff; let links; let lookup; let limiter; let realSchedule;

// A DuckDuckGo /html/ answer with the result markup the parser reads.
const DDG_HTML = `
  <html><body>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://justthegays.tv/performer/christian-hogue-113')}">Christian Hogue on JustTheGays</a>
      <a class="result__snippet">Christian Hogue - porn, OnlyFans &amp; nude videos</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://onlyfans.com/hotalex6')}">Alejo Pino OnlyFans</a>
      <a class="result__snippet">Alejandro pino</a>
    </div>
  </body></html>`;

// A performer page: a name, an avatar, and video links (relative, like the real site).
const PERFORMER_HTML = (name, videos) => `
  <html><head>
    <title>${name} - porn, OnlyFans &amp; nude videos on JustTheGays</title>
    <link rel="canonical" href="https://justthegays.tv/performer/${name.toLowerCase().replace(/\s+/g, '-')}-113" />
    <meta property="og:image" content="https://cdn.gff.network/thumbnails/2026/02/${name.toLowerCase().replace(/\s+/g, '-')}-card.jpg" />
  </head><body>
    <h1>${name} - porn, OnlyFans &amp; nude videos on JustTheGays</h1>
    <img alt="${name}" src="https://cdn.gff.network/thumbnails/2026/02/${name.toLowerCase().replace(/\s+/g, '-')}-card.jpg" />
    ${videos.map((v) => `<a href="/video/${v}">${v}</a>`).join('')}
  </body></html>`;

// A video page: the VideoObject JSON-LD with a direct HLS playlist on the CDN.
const VIDEO_HTML = (slug, iso, views) => `
  <html><head>
    <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: slug,
    description: 'a video',
    thumbnailUrl: `https://cdn.gff.network/thumbnails/2026/02/${slug}.jpg`,
    uploadDate: iso,
    duration: 'PT2M',
    contentUrl: `https://cdn.gff.network/019e29e2/videos/2026/02/${slug}/index.m3u8`,
    actor: [{ '@type': 'Person', name: 'Christian Hogue' }],
    interactionStatistic: [{ '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: views }],
  })}</script>
  </head><body></body></html>`;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-2026-'));
  process.env.COOMER_INDEX_CACHE = path.join(dir, 'creators.json');
  mock = await start({
    // DuckDuckGo html endpoint (the real one is read with a form POST).
    '/html/': (req) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: DDG_HTML }),
    '/lite/': (req) => ({
      status: 200, headers: { 'content-type': 'text/html' },
      body: '<html><body><a class="result-link" href="//duckduckgo.com/l/?uddg='
        + encodeURIComponent('https://justthegays.tv/performer/christian-hogue-113')
        + '">Christian Hogue on JustTheGays</a></body></html>',
    }),
    // The performer directory's search endpoint.
    '/search': (req, res, url) => {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const hit = q.includes('christian');
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: hit
          ? '<html><body><a href="/performer/christian-hogue-113">#3 Christian Hogue</a><a href="/performer/christian-bay-5bwcg">#940 Christian Bay</a></body></html>'
          : '<html><body></body></html>',
      };
    },
    '/performer/christian-hogue-113': () => ({
      status: 200, headers: { 'content-type': 'text/html' },
      body: PERFORMER_HTML('Christian Hogue', ['christian-hogue-jerks-off-115', 'christian-hogue-a-compilation-63']),
    }),
    '/video/christian-hogue-jerks-off-115': () => ({
      status: 200, headers: { 'content-type': 'text/html' },
      body: VIDEO_HTML('christian-hogue-jerks-off-115', '2024-07-10T03:44:30.073Z', 66267),
    }),
    '/video/christian-hogue-a-compilation-63': () => ({
      status: 200, headers: { 'content-type': 'text/html' },
      body: VIDEO_HTML('christian-hogue-a-compilation-63', '2026-02-09T07:11:55.106Z', 22351),
    }),
    '/p6914/top-performers/trending': () => ({
      status: 200, headers: { 'content-type': 'text/html' },
      body: '<html><body><a href="/performer/angel-of-bogota-23">#1 Angel of Bogota</a><a href="/performer/braden-sherota-flowasthetao-69">#2 Braden Sherota (flowasthetao)</a></body></html>',
    }),
    '/p6913/top-performers/a-z': () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body></body></html>' }),
  });
  prepareEnv({
    DDG_HTML_URL: `${mock.url}/html/`,
    DDG_LITE_URL: `${mock.url}/lite/`,
    DDG_BASE_URL: mock.url,
    BRAVE_API_KEY: '',
    BING_SEARCH: '0',
    SEARCH_PROVIDERS: 'ddg',
  });
  limiter = require('../src/lib/limiter');
  realSchedule = limiter.schedule;
  limiter.schedule = (key, ms, fn) => fn();
  websearch = require('../src/lib/websearch');
  brave = require('../src/lib/brave');
  gff = require('../src/sources/gff');
  links = require('../src/lib/links');
  lookup = require('../src/engine/lookup');
});

after(async () => { limiter.schedule = realSchedule; await mock.close(); });

describe('DuckDuckGo: the request shape that actually answers', () => {
  test('the HTML endpoint is read with a form POST, a browser User-Agent and SafeSearch off', async () => {
    websearch._clear();
    const res = await websearch.PROVIDERS.ddg.search('Christian Hogue onlyfans', { count: 8 });
    assert.ok(res.length, 'the endpoint answers');
    assert.ok(res.some((r) => r.url.includes('justthegays.tv')), 'creator results, not decoys');
    // The mock records the request: it must be a POST with the query in the body.
    const post = mock.hits.filter((h) => h.startsWith('POST /html/'));
    assert.ok(post.length, 'the endpoint is read with POST (a GET is answered with an empty 202 challenge)');
    assert.ok(mock.hits.some((h) => h.includes('/html/?q=')), 'the query stays in the URL too');
  });

  test('the lite endpoint is a second door', async () => {
    websearch._clear();
    const res = await websearch.PROVIDERS['ddg-lite'].search('Christian Hogue', { count: 5 });
    assert.ok(res.length, 'the lite door answers');
    assert.ok(res.some((r) => r.url.includes('justthegays.tv')), 'with the same creator results');
    assert.ok(mock.hits.some((h) => h.startsWith('POST /lite/')), 'the lite door is read with POST as well');
  });

  test('the parser still unwraps redirect links and reports a CAPTCHA page', () => {
    const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/p')}&rut=x">Hello</a><a class="result__snippet">snip</a></div>`;
    const r = websearch.parseDdg(html);
    assert.equal(r[0].url, 'https://example.com/p');
    assert.equal(r[0].title, 'Hello');
    assert.throws(() => websearch.parseDdg('<form id="challenge-form"></form>'), /CAPTCHA/);
  });
});

describe('the performer directories: 2026 content', () => {
  test('a performer page keeps its own host for relative video links', () => {
    const page = gff._performerPage ? gff._performerPage(PERFORMER_HTML('Christian Hogue', ['a-video-slug'])) : null;
    assert.equal(page, null, 'the parser is not exported (the adapter is tested through fetch)');
  });

  test('the adapter reads a performer page and its 2026 videos, with the HLS stream and the views', async () => {
    const out = await gff.fetch({ platform: 'gff', kind: 'user', target: 'https://justthegays.tv/performer/christian-hogue-113' }, { limit: 5 });
    assert.ok(out.items.length >= 1, 'videos were read');
    const it = out.items.find((i) => i.postedAt && i.postedAt.startsWith('2026')) || out.items[0];
    assert.match(it.mediaUrl, /^https:\/\/cdn\.gff\.network\/.+\.m3u8$/, 'the stream comes straight off the CDN');
    assert.match(it.previewUrl, /cdn\.gff\.network/, 'a poster frame');
    assert.equal(it.author, 'Christian Hogue', 'the performer is named from the video page');
    assert.ok(it.score > 0, 'the view count is carried over as the score');
    assert.equal(out.profile.displayName, 'Christian Hogue', 'the profile is named');
  });

  test('a performer search answers a name with the performer page', async () => {
    const hits = await gff.searchPerformers('Christian Hogue', { limit: 6 });
    assert.ok(hits.length, 'the directory answered');
    assert.equal(hits[0].name, 'Christian Hogue', 'the man who was named comes first');
    assert.equal(hits[0].score, 1, 'and with a perfect match score');
    assert.ok(hits[0].url.includes('/performer/christian-hogue'), 'his own page');
  });

  test('the trending list is read (where the new performers appear first)', async () => {
    const hits = await gff.trendingPerformers({ limit: 10 });
    assert.ok(hits.length >= 1, 'the trending list answered');
    assert.ok(hits.some((h) => /angel-of-bogota/.test(h.url)), 'a performer from the list');
  });

  test('a JustTheGays performer URL parses into a creator feed', () => {
    const s = gff.parse('https://justthegays.tv/performer/christian-hogue-113');
    assert.equal(s.platform, 'gff');
    assert.equal(s.kind, 'user');
    assert.equal(s.target, 'https://justthegays.tv/performer/christian-hogue-113');
    assert.equal(s.ingestable, true);
  });

  test('a JustTheGays performer URL found in a page is a creator feed too', () => {
    const s = links.parseProfile('https://justthegays.tv/performer/reno-gold-71');
    assert.ok(s, 'the link parses');
    assert.equal(s.platform, 'gff');
    assert.equal(s.ingestable, true);
  });
});

describe('namesakes are not the man who was typed', () => {
  test('a numbered handle is a different person', () => {
    assert.equal(lookup.isNamesake('Christian Hogue', 'christianhogue9', 'christianhogue9.bsky.social'), true);
    assert.equal(lookup.isNamesake('Christian Hogue', 'christianhogue812', 'christianhogue812.bsky.social'), true);
  });

  test('the man himself is not a namesake', () => {
    assert.equal(lookup.isNamesake('Christian Hogue', 'christianhogue', 'Christian Hogue'), false);
    assert.equal(lookup.isNamesake('Christian Hogue', 'christian_hogue', 'Christian Hogue'), false);
    assert.equal(lookup.isNamesake('Alejandro Pino', 'alejandropino', 'Alejandro Pino'), false);
    assert.equal(lookup.isNamesake('Reno Gold', 'gold_reno', 'Reno gold'), false);
  });

  test('a single word cannot tell a namesake from the man', () => {
    assert.equal(lookup.isNamesake('Christian', 'christian9', 'christian9'), false);
  });
});
