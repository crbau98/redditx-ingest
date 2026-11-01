'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
