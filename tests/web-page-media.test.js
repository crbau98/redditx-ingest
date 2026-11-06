'use strict';
// Page extraction: a page's declared image and its thumbnails are media. A real studio video post puts
// its poster in og:image and a 300x168 thumb on `data-main-thumb`, and its DOM otherwise only carries
// the site logo; before this the page yielded that logo (or nothing) and every item was rejected
// downstream.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let web;

before(() => {
  prepareEnv({});
  web = require('../src/sources/web');
});

after(() => require('../src/lib/render').close());

const extract = (html) => web.extractPage(html, 'https://studio.example/scene/1/');
const urls = (page) => page.media.map((m) => m.url);

test('og:image is an item even when the DOM only carries the site logo', () => {
  const page = extract(`<html><head><meta property="og:image" content="https://studio.example/up/2026/10/poster.webp" /></head>
    <body><img src="https://studio.example/up/2024/02/try1gay.png" alt="site" /></body></html>`);
  assert.equal(page.media[0].url, 'https://studio.example/up/2026/10/poster.webp', urls(page).join());
  assert.equal(page.media[0].type, 'image');
});

test('an og:image that is itself junk (a logo or avatar) is still refused', () => {
  const page = extract(`<html><head><meta property="og:image" content="https://studio.example/assets/logo.png" /></head><body></body></html>`);
  assert.equal(page.media.length, 0, urls(page).join());
});

test('data-main-thumb is read as the image source', () => {
  const page = extract(`<html><body><div data-main-thumb="https://studio.example/up/2026/10/thumb.webp"><img width="300" height="168" data-main-thumb="https://studio.example/up/2026/10/thumb.webp" alt="scene" /></div></body></html>`);
  const hit = page.media.find((m) => m.url.endsWith('/thumb.webp'));
  assert.ok(hit, urls(page).join());
  assert.equal(hit.width, 300);
  assert.equal(hit.height, 168);
});

test('a 300x168 poster passes the size floor, a 150px avatar does not', () => {
  const page = extract(`<html><body>
    <img src="https://studio.example/up/poster.webp" width="300" height="168" alt="poster" />
    <img src="https://studio.example/up/avatar.webp" width="150" height="150" alt="avatar" />
    <img src="https://studio.example/up/tiny.webp" width="50" height="50" alt="tiny" />
  </body></html>`);
  assert.ok(urls(page).some((u) => u.endsWith('/poster.webp')), urls(page).join());
  assert.ok(!urls(page).some((u) => /avatar|tiny/.test(u)), urls(page).join());
});

test('the og:image is pushed once even when the DOM repeats it', () => {
  const page = extract(`<html><head><meta property="og:image" content="https://studio.example/up/poster.webp" /></head>
    <body><img src="https://studio.example/up/poster.webp" width="800" height="1000" /></body></html>`);
  assert.equal(urls(page).filter((u) => u.endsWith('/poster.webp')).length, 1, urls(page).join());
});
