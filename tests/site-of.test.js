'use strict';
/** "Same site" for refreshed profile pictures: the registrable domain, so unrelated sites below a shared suffix are never conflated. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registrableDomain, siteOf } = require('../src/lib/site');

test('subdomains of one site share it; the last two labels are not used blindly', () => {
  assert.equal(siteOf('https://cdn.bsky.app/img/a.jpg'), 'bsky.app');
  assert.equal(siteOf('https://img.coomer.st/banners/x'), 'coomer.st');
  assert.equal(siteOf('https://a.b.static.example.com/x'), 'example.com');
  assert.equal(siteOf('https://files.mastodon.social/x.png'), 'mastodon.social');
});

test('unrelated sites below a multi-label suffix are different sites (the cited example)', () => {
  assert.equal(siteOf('https://images.foo.co.uk/a.jpg'), 'foo.co.uk');
  assert.equal(siteOf('https://cdn.bar.co.uk/a.jpg'), 'bar.co.uk');
  assert.notEqual(siteOf('https://images.foo.co.uk/a.jpg'), siteOf('https://cdn.bar.co.uk/a.jpg'));
  assert.equal(siteOf('https://x.foo.com.au/'), 'foo.com.au');
  assert.equal(siteOf('https://static.foo.co.jp/'), 'foo.co.jp');
});

test('shared hosting and CDN suffixes: every customer is its own site', () => {
  assert.notEqual(siteOf('https://alice.github.io/a.png'), siteOf('https://bob.github.io/a.png'));
  assert.notEqual(siteOf('https://d1abc.cloudfront.net/a.png'), siteOf('https://d2xyz.cloudfront.net/a.png'));
  assert.notEqual(siteOf('https://a.blogspot.com/x'), siteOf('https://b.blogspot.com/x'));
  assert.equal(siteOf('https://cdn.alice.github.io/a.png'), 'alice.github.io');
});

test('a country code with a short second label is a suffix even when it is not in the list', () => {
  assert.equal(registrableDomain('img.shop.co.zz'), 'shop.co.zz');
  assert.equal(registrableDomain('shop.co.zz'), 'shop.co.zz');
  assert.notEqual(registrableDomain('a.one.com.zz'), registrableDomain('a.two.com.zz'));
});

test('no usable site for an address, a bare name or a bad URL; a trailing dot and case do not matter', () => {
  assert.equal(siteOf('http://10.1.2.3/a.jpg'), null);
  assert.equal(siteOf('http://[::1]/a.jpg'), null);
  assert.equal(siteOf('http://localhost/a.jpg'), null);
  assert.equal(siteOf('not a url'), null);
  assert.equal(siteOf(undefined), null);
  assert.equal(registrableDomain('CDN.Example.COM.'), 'example.com');
});

test('enrich: a refreshed avatar from another site below a shared suffix does not replace the stored one', () => {
  const { prepareEnv } = require('./helpers/mock');
  prepareEnv();
  const repo = require('../src/db/repo');
  const c = repo.creators.create({ handle: 'sitecheck', origin: 'admin' });
  repo.creators.update(c.id, { avatarUrl: 'https://images.foo.co.uk/old.jpg' });
  repo.creators.enrich(c.id, { avatarUrl: 'https://cdn.bar.co.uk/other-site.jpg' });
  assert.equal(repo.creators.get(c.id).avatar_url, 'https://images.foo.co.uk/old.jpg', 'a different site never takes the avatar');
  repo.creators.enrich(c.id, { avatarUrl: 'https://static.foo.co.uk/new.jpg' });
  assert.equal(repo.creators.get(c.id).avatar_url, 'https://static.foo.co.uk/new.jpg', 'the same site does');
});
