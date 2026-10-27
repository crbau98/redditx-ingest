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
