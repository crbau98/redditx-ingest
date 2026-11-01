'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// ddgEnabled reads DDG_BASE_URL under test (tests must not reach the live web): set it before
// config loads so the DuckDuckGo providers are 'configured' and their cooldown clocks are observable.
process.env.DDG_BASE_URL = process.env.DDG_BASE_URL || 'http://127.0.0.1:1';
process.env.BRAVE_API_KEY = process.env.BRAVE_API_KEY || 'test-key'; // no network: the tier test stubs both searches
const { parseDdg } = require('../src/lib/websearch');

test('ddg parser unwraps redirect links and keeps title and snippet', () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/p')}&rut=x">Hello</a><a class="result__snippet">snip</a></div>`;
  const r = parseDdg(html);
  assert.equal(r[0].url, 'https://example.com/p');
  assert.equal(r[0].title, 'Hello');
  assert.equal(r[0].description, 'snip');
});

test('ddg parser reports a CAPTCHA page', () => {
  assert.throws(() => parseDdg('<form id="challenge-form"></form>'), /CAPTCHA/);
});

const { coherent } = require('../src/lib/websearch');

test('coherence: decoy results that ignore the query are rejected', () => {
  const query = 'top gay onlyfans creators list';
  const decoys = [
    { url: 'https://example.com/a', title: 'Top Hat | Interactive Learning', description: '' },
    { url: 'https://example.com/b', title: 'TOP | English meaning', description: '' },
    { url: 'https://example.com/c', title: 'Tops and Bottoms Sneakers', description: '' },
  ];
  assert.equal(coherent(decoys, query), false, 'wordplay on one stopword is not an answer');
  const good = [
    { url: 'https://onlyfans.com/directory', title: 'OnlyFans creators list', description: 'top gay onlyfans creators' },
    { url: 'https://example.com/x', title: 'Gay OnlyFans Directory', description: 'creator list' },
    { url: 'https://example.com/y', title: 'Another listicle', description: 'gay creators to follow' },
    { url: 'https://example.com/z', title: 'Unrelated but harmless', description: '' },
  ];
  assert.equal(coherent(good, query), true, 'a list with real hits passes');
});

test('coherence: short queries and empty results behave sensibly', () => {
  assert.equal(coherent([], 'anything'), false, 'no results is never coherent');
  assert.equal(coherent([{ url: 'https://a.com', title: 'x', description: '' }], 'gay'), true, 'all-stopword query is not held against the provider');
});

test('cooldowns are per endpoint: one walled DDG door leaves the others open', () => {
  const ws = require('../src/lib/websearch');
  ws._clear();
  assert.equal(ws.PROVIDERS.ddg.configured(), true, 'html endpoint starts available');
  assert.equal(ws.PROVIDERS['ddg-lite'].configured(), true, 'lite endpoint starts available');
  ws._setCooldown(60000); // cools only the /html/ endpoint, as its CAPTCHA/timeout would
  assert.equal(ws.PROVIDERS.ddg.configured(), false, 'html endpoint cooled down');
  assert.equal(ws.PROVIDERS['ddg-lite'].configured(), true, 'lite endpoint unaffected by the html cooldown');
  const cd = ws._cooldown();
  assert.ok(cd.until && !cd.lite, 'the html cooldown is reported on its own clock');
  ws._clear();
  assert.equal(ws.PROVIDERS.ddg.configured(), true, 'cleared again');
});

test('Bing: a challenge page is a wall, an empty result set is not', () => {
  const ws = require('../src/lib/websearch');
  const captcha = '<form id="captchaform"></form><div class="b_no">No results</div>';
  assert.throws(() => ws.parseBing(captcha), /CAPTCHA/, 'a challenge must surface as a wall (cooldown path)');
  const honestEmpty = '<div class="b_no">There are no results for your query</div>';
  assert.deepEqual(ws.parseBing(honestEmpty), [], 'Bing\'s own no-results block is an honest empty, not a wall');
});

test('preferKeyless puts the free tier ahead of the paid one (one shared daily budget)', async () => {
  const ws = require('../src/lib/websearch');
  ws._clear();
  const order = [];
  const { brave, ddg, bing } = ws.PROVIDERS;
  const oBrave = brave.search; const oDdg = ddg.search; const oBing = bing.search;
  brave.search = async () => { order.push('brave'); return [{ url: 'https://example.com/brave', title: 'tier order paid first answer', description: 'tier order paid first' }]; };
  bing.search = async () => { order.push('bing'); return [{ url: 'https://example.com/bing', title: 'tier order free first answer', description: 'tier order free first' }]; };
  ddg.search = async () => { order.push('ddg'); return [{ url: 'https://example.com/ddg', title: 'tier order free first answer', description: 'tier order free first' }]; };
  try {
    const paid = await ws.search('tier order paid first', {});
    assert.equal(order[0], 'brave', 'by default the paid tier runs first');
    assert.equal(paid.provider, 'brave');
    order.length = 0;
    const free = await ws.search('tier order free first', { preferKeyless: true });
    assert.ok(!order.includes('brave'), 'preferKeyless never touches the paid provider');
    assert.ok(free.provider.includes('ddg'), `the free tier answers: ${free.provider}`);
    // DuckDuckGo leads the merge: it is the door that answers creator names exactly, while Bing
    // intermittently answers with bot-mitigation decoys.
    assert.equal(free.provider, 'ddg+bing', 'the keyless tier merges every door that answered, DDG first');
  } finally {
    brave.search = oBrave; bing.search = oBing; ddg.search = oDdg; ws._clear();
  }
});

test('the last open keyless door never cools down (no-search is worse than a slow search)', () => {
  const ws = require('../src/lib/websearch');
  ws._clear();
  // With other doors open, a wall on this one may cool it down.
  assert.equal(ws._anotherDoorOpen('ddg'), true, 'other doors are open');
  // Cool every OTHER door: this one is now the last, so the rule must flip.
  ws._setCooldown(60000, 'bing');
  ws._setCooldown(60000, 'lite');
  assert.equal(ws._anotherDoorOpen('ddg'), false, 'no other door remains — this one must stay live');
  assert.equal(ws.PROVIDERS['ddg-lite'].configured(), false, 'lite cooled by the test');
  assert.equal(ws.PROVIDERS.bing.configured(), false, 'bing cooled by the test');
  // The live door must remain configured: cooling it would leave search with NOTHING configured
  // once Brave's daily budget is spent (the exact failure this rule fixes).
  assert.equal(ws.PROVIDERS.ddg.configured(), true, 'last door stays configured');
  assert.equal(ws.configured(), true, 'search as a whole is still possible');
  ws._clear();
});
