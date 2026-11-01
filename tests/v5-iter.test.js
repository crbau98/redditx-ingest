'use strict';
/**
 * v5 Horizon iteration run: sequenced concrete upgrades, one section per item.
 * Lawful bounds hold throughout: paid hosts are parsed as strings, never fetched
 * (see item 1); no new scrapers, no face-match, no whole-web enumeration.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------- item 1: paid parsing parity */
test('iter1: paid.js parses Fansly/JFF handles and finds every paid page a text names', () => {
  const paid = require('../src/lib/paid');
  assert.equal(paid.fanslyHandle('https://fansly.com/JakeFit/posts'), 'jakefit');
  assert.equal(paid.fanslyHandle('fansly.com/login'), null); // site page, not a person
  assert.equal(paid.jffHandle('https://justfor.fans/Jake_Fit'), 'jake_fit');
  assert.equal(paid.jffHandle('https://justfor.fans/search'), null);
  assert.equal(paid.serviceOf('https://manyvids.com/Profile/123/x'), 'ManyVids');
  assert.equal(paid.serviceOf('https://fansly.com/x'), 'Fansly');
  assert.equal(paid.serviceOf('https://bsky.app/profile/x'), null);
  const found = paid.findPaidHandles('My OnlyFans: @jakefit onlyfans.com/jakefit · Fansly: @jakefit2 fansly.com/jakefit2 · jff: justfor.fans/jakefit3');
  assert.deepEqual(found.map((f) => `${f.service}:${f.handle}`), ['OnlyFans:jakefit', 'Fansly:jakefit2', 'JustFor.Fans:jakefit3']);
  assert.equal(paid.paidLink('Fansly', 'jakefit2').url, 'https://fansly.com/jakefit2');
  assert.equal(paid.paidLink('Fansly', 'jakefit2', { free: true }).free, true);
});

test('a URL path or file name that merely starts with "onlyfans-" is not a username', () => {
  const paid = require('../src/lib/paid');
  // One harvested listicle produced 37 junk leads: the prose separator matches the middle of
  // somebody else's path ('vicesnob.com/onlyfans-creator-debanking-2026/') and of file names.
  const junk = [
    'https://www.vicesnob.com/onlyfans-creator-debanking-2026/',
    'https://www.vicesnob.com/wp-content/uploads/2026/09/onlyfans-debanking-featured.jpg',
    'https://www.vicesnob.com/onlyfans-taxes-creator-owes-irs-1-1-million/',
    'https://vicesnob.com/onlyfans-ceo-keily-blair-will-speak-at-fortunes-mo/',
    'share this: onlyfans-alternatives-for-creators',
  ];
  for (const t of junk) assert.deepEqual(paid.findPaidHandles(t), [], t);
  // ...while every real prose and URL form still resolves.
  const good = [
    'My OnlyFans: @jakefit',
    'my onlyfans is musclejock88',
    'Fansly - hotty_dude',
    'https://onlyfans.com/joeymillsxxx',
    'follow onlyfans.com/william_seedvip today',
  ];
  for (const t of good) assert.equal(paid.findPaidHandles(t).length, 1, t);
  // a subdomain of the real host still counts (the guard is a word boundary, not "any dot")
  assert.equal(paid.findPaidHandles('see m.onlyfans.com/jakefit now').length, 1, 'subdomain host');
});

test('iter1: extractLinks catches bare paid URLs for every paid host', () => {
  const { extractLinks } = require('../src/lib/links');
  for (const [bare, service] of [['manyvids.com/Profile/1/x', 'ManyVids'], ['loyalfans.com/jake', 'LoyalFans'], ['fanvue.com/jake', 'Fanvue']]) {
    const got = extractLinks(`see my page ${bare} ok`).filter((p) => p.external);
    assert.ok(got.some((p) => p.service === service), `${bare} parses as ${service}`);
  }
});

/* ------------------------------------------------- item 7: paid link accuracy */
test('iter7: parsed paid pages carry canonical handles', () => {
  const { parseProfile } = require('../src/lib/links');
  assert.equal(parseProfile('https://fansly.com/JakeFit/posts').handle, 'jakefit');
  assert.equal(parseProfile('https://justfor.fans/Jake_Fit').handle, 'jake_fit');
  assert.equal(parseProfile('https://manyvids.com/Profile/1/x').handle, undefined, 'non-traced services keep no handle claim');
});
/* ------------------------------------------------- item 5: dotted bio handles */
test('iter5: bio alias lines catch Bluesky-style dotted and dashed handles', () => {
  const identity = require('../src/engine/identity');
  assert.deepEqual(identity.bioAliases('backup: @jake-fit | new acc @Jake.Lifts-'), ['jake-fit', 'Jake.Lifts']);
  assert.deepEqual(identity.bioAliases('formerly @jake_old-.'), ['jake_old']);
  assert.deepEqual(identity.bioAliases('go follow my bf @tomlifts and @gymbuddy'), [], 'shout-outs stay out');
});
/* ------------------------------------------------- item 4: alias affix keys */
test('iter4: filler affixes collapse so one man’s accounts share an alias key', () => {
  const { normAlias, usableAlias } = require('../src/lib/alias');
  for (const s of ['the_real_jake', '@RealJake', 'Jake.Official', 'iamjake', 'imrealjake', 'itsjake_backup', 'mrjakealt']) assert.equal(normAlias(s), 'jake', s);
  assert.equal(normAlias('@Jake.Fit'), 'jakefit', 'real stems survive');
  assert.equal(normAlias('Image'), 'image', 'a man actually called Image never collapses');
  assert.equal(normAlias('Theo'), 'theo', 'short names are left alone');
  assert.equal(normAlias('Theodore'), 'theodore', 'given names with filler-like prefixes survive');
  assert.equal(usableAlias('jake'), true);
  for (const g of ['official', 'fanpage', 'instagram', 'backupacc']) assert.equal(usableAlias(g), false, g);
});
