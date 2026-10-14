'use strict';
/** v5 platform switcher: the creator-page data it relies on, and the component's wiring. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine;
const get = async (p) => (await fetch(`${base}${p}`, { headers: { cookie: 'prism_age=1' } })).json();

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

describe('creator data behind the switcher', () => {
  let c;
  before(() => {
    c = repo.creators.create({ handle: 'ps_multi', displayName: 'Multi' });
    const add = (platform, i) => repo.media.insert({ creator_id: c.id, platform, source_id: `ps${platform}${i}`, source_key: `${platform}:ps${i}:0`, post_key: `${platform}:ps${i}`, author: 'ps_multi', title: `ps ${i}`, media_type: 'image', media_url: `https://example.com/ps${platform}${i}.jpg`, hash: `psh${platform}${i}`, source_url: 'https://example.com/p', posted_at: `2026-10-0${i + 1}T00:00:00.000Z` });
    for (let i = 0; i < 3; i++) add('redgifs', i);
    add('bluesky', 0);
    repo.creators.refreshStats(c.id);
  });

  test('activity lists every platform with a count, busiest first', async () => {
    const a = await get(`/api/creators/${c.id}/activity`);
    assert.deepEqual(a.platforms, [{ platform: 'redgifs', n: 3 }, { platform: 'bluesky', n: 1 }]);
  });

  test('his media filters by platform, and rejects junk platform values', async () => {
    assert.equal((await get(`/api/creators/${c.id}/media?platform=redgifs`)).total, 3);
    assert.equal((await get(`/api/creators/${c.id}/media?platform=bluesky`)).total, 1);
    assert.equal((await get(`/api/creators/${c.id}/media?platform=${encodeURIComponent("x' OR 1=1")}`)).total, 4, 'an invalid platform is ignored, not passed through');
  });
});

describe('front end', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'public', ...p), 'utf8');

  test('pills are a keyboard radiogroup, paid pages are link-outs only', () => {
    const ps = read('js', 'components', 'platform-switcher.js');
    assert.match(ps, /role: 'radiogroup'/);
    assert.match(ps, /role: 'radio', 'aria-checked'/);
    assert.match(ps, /ArrowRight/);
    assert.match(ps, /rel: 'noopener noreferrer nofollow'/);
    assert.match(ps, /\/api\/creators\/\$\{c\.id\}\/activity/);
    assert.match(read('js', 'components', 'elsewhere.js'), /export function paidPages\(c\)/);
    assert.match(read('css', 'ux.css'), /\.ps-pill\.on/);
  });

  test('no paid page is fetched or embedded: the switcher only links out', () => {
    const ps = read('js', 'components', 'platform-switcher.js');
    assert.doesNotMatch(ps, /onlyfans\.com|fansly\.com/i, 'no hard-coded paid site access');
    assert.doesNotMatch(ps, /<iframe|h\('iframe'|h\('img'/);
  });
});
