'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// ddgEnabled reads DDG_BASE_URL under test (tests must not reach the live web): set it before
// config loads so the DuckDuckGo providers are 'configured' and their cooldown clocks are observable.
process.env.DDG_BASE_URL = process.env.DDG_BASE_URL || 'http://127.0.0.1:1';
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
