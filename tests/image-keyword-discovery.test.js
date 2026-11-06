'use strict';
// Lane 2: keyword image discovery. The image feed and the picture bytes are stubbed; the hash index
// answers from a stub. The lane must queue profile pages only, and must skip a picture the library
// already has (same perceptual hash) before it queues the page it was found on.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let discovery; let settings; let dedupe; let phash;
let current = [];
let dupFor = new Set();
let n = 0;

const hit = (page, image, title = 'Gay muscle model 🔞', description = 'gay fitness creator, onlyfans below') => ({ pageUrl: page, imageUrl: `http://img.test/${image}`, title, description });

before(async () => {
  mock = await start({});
  prepareEnv({});
  repo = require('../src/db/repo');
  settings = require('../src/settings');
  discovery = require('../src/engine/discovery');
  dedupe = require('../src/services/dedupe');
  phash = require('../src/lib/phash');
  settings.update({ discoveryKeywords: 'gay muscle model', imageKeywordHits: 10, imageKeywordLeads: 5 });
  discovery._setImageProvider(async () => current);
  const net = require('../src/lib/net');
  net.request = async () => ({ status: 200, headers: {}, body: Buffer.from('img') });
  phash.hashBuffer = async () => `h${++n}`;
  dedupe.check = ({ phash: hex }) => (dupFor.has(hex) ? { dup: { id: 'x', p: 1, d: 0 }, blocked: null } : { dup: null, blocked: null });
});
after(async () => { await mock.close(); });

test('a page found through pictures is queued once, with the keyword that found it', async () => {
  current = [
    hit('https://linktr.ee/gaymuscleguy', 'a.jpg'),
    hit('https://example.org/blog/not-a-profile', 'c.jpg', 'Some blog post', ''),
    hit('https://linktr.ee/gaymuscleguy', 'a2.jpg'), // same page, second picture
  ];
  const out = await discovery.imageKeywordDiscovery({ hits: 10, leads: 5 });
  assert.equal(out.searched, 1);
  assert.equal(out.found, 1);
  const c = repo.candidates.find('linkinbio', 'page', 'https://linktr.ee/gaymuscleguy');
  assert.ok(c, 'the profile page is a lead');
  assert.equal(c.status, 'pending');
  assert.equal(c.scope, 'in');
  assert.equal(c.signals.imagesearch.length, 1, 'a second picture of the same page does not add a second signal');
  assert.equal(c.signals.imagesearch[0], 'image:gay muscle model', 'the keyword is the evidence');
  assert.ok(c.score >= 5);
  assert.equal(repo.candidates.find('web', 'page', 'https://example.org/blog/not-a-profile'), null, 'a page that is not a profile shape is ignored');
});

test('a picture the library already has skips its page before it is queued', async () => {
  dupFor = new Set([`h${n + 1}`]); // the next picture comes back as a stored copy
  current = [
    hit('https://linktr.ee/knowncopy', 'b.jpg', 'Gay jock creator', 'nsfw'),
    hit('https://linktr.ee/freshone', 'd.jpg', 'Gay otter creator', 'nsfw'),
  ];
  const out = await discovery.imageKeywordDiscovery({ hits: 10, leads: 5 });
  assert.equal(out.duplicates, 1);
  assert.equal(repo.candidates.find('linkinbio', 'page', 'https://linktr.ee/knowncopy'), null);
  assert.ok(repo.candidates.find('linkinbio', 'page', 'https://linktr.ee/freshone'), 'the new picture still queues its page');
});

test('a zeroed result cap does no work', async () => {
  let asked = 0;
  discovery._setImageProvider(async () => { asked++; return current; });
  const out = await discovery.imageKeywordDiscovery({ hits: 0, leads: 5 });
  assert.deepEqual(out, { searched: 0, hits: 0, fetched: 0, duplicates: 0, found: 0 });
  assert.equal(asked, 0);
});
