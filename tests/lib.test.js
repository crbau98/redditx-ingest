'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/mock').prepareEnv();

const { checkText } = require('../src/lib/safety');
const { classify } = require('../src/lib/scope');
const { parseProfile, extractLinks, profileUrl } = require('../src/lib/links');
const { isPrivateIp, isPrivateHost } = require('../src/lib/net');
const { canonicalUrl, normalizeImgur, hostBlocked, hostOf } = require('../src/lib/mediaurl');
const { ftsQuery } = require('../src/db/repo');
const breaker = require('../src/engine/breaker');
const { computeNextRun } = require('../src/engine/engine');

describe('safety gate', () => {
  const level = (t) => checkText(t).level;
  test('blocks explicit minor terms', () => {
    for (const t of ['underage', 'under 18 only', 'jailbait', 'lolicon', 'shotacon', 'pedo stuff', 'pre-teen', 'my kid brother', 'child', 'toddler', 'school boy', 'minor', 'middle school']) {
      assert.equal(level(t), 'block', t);
    }
  });
  test('blocks stated ages under 18 in every common spelling', () => {
    for (const t of ["i'm 16", 'im 15', 'age: 17', 'aged 12', '14yo', '15 y/o', '13 years old', '16-year-old', '[M17] selfie', '(16m)', "i'm sixteen", 'fifteen years old', 'thirteen yo']) {
      assert.equal(level(t), 'block', t);
    }
  });
  test('does not block adults, heights or measurements', () => {
    for (const t of ['18yo gym bro', '21 years old', "I'm 6'2 and 190lbs", 'im 8 inches', 'age: 25', 'part (2) of my series', 'm4m', 'twink', 'daddy', 'college jock 21', '4k video', '[M25]', 'm4a']) {
      assert.equal(level(t), null, t);
    }
  });
  test('routes borderline wording to review, not publish', () => {
    for (const t of ['teen vibes', 'high school jock', 'barely legal', 'just turned 18']) assert.equal(level(t), 'review', t);
  });
  test('sees through case, unicode tricks and zero-width characters', () => {
    assert.equal(level('UNDERAGE'), 'block');
    assert.equal(level('un​der​age'), 'block');
    assert.equal(level('ＵＮＤＥＲＡＧＥ'), 'block');
  });
  test('checks across all parts and arrays', () => {
    assert.equal(checkText('fine', ['also fine', 'but underage'], null).level, 'block');
    assert.equal(checkText().level, null);
  });
});

describe('scope classifier', () => {
  test('trusted feeds only exclude clear female-only posts', () => {
    assert.equal(classify('sunset beach', { trusted: true }).scope, 'in');
    assert.equal(classify('[F] new here', { trusted: true }).scope, 'excluded');
    assert.equal(classify('busty milf', { trusted: true }).scope, 'excluded');
    assert.equal(classify('f4m but also gay', { trusted: true }).scope, 'in');
  });
  test('untrusted feeds need a positive male signal', () => {
    assert.equal(classify('hung gay stud').scope, 'in');
    assert.equal(classify('sunset beach').scope, 'uncertain');
    assert.equal(classify('f4m but also gay').scope, 'uncertain');
    assert.equal(classify(['lesbian couple']).scope, 'excluded');
  });
});

describe('profile / link parsing', () => {
  const p = (x, hint) => { const r = parseProfile(x, hint); return r && `${r.platform}|${r.kind}|${r.target}`; };
  test('recognises accounts on every supported platform', () => {
    assert.equal(p('https://x.com/foo'), 'x|user|foo');
    assert.equal(p('https://twitter.com/foo/status/123'), 'x|user|foo');
    assert.equal(p('r/GayBros'), 'reddit|community|gaybros');
    assert.equal(p('u/someone'), 'reddit|user|someone');
    assert.equal(p('https://www.reddit.com/user/someone/submitted'), 'reddit|user|someone');
    assert.equal(p('https://bsky.app/profile/foo.bsky.social'), 'bluesky|user|foo.bsky.social');
    assert.equal(p('foo.bsky.social'), 'bluesky|user|foo.bsky.social');
    assert.equal(p('@zed@mastodon.social'), 'mastodon|user|zed@mastodon.social');
    assert.equal(p('https://mastodon.social/@zed'), 'mastodon|user|zed@mastodon.social');
    assert.equal(p('https://www.redgifs.com/users/Bar'), 'redgifs|user|bar');
    assert.equal(p('https://lemmynsfw.com/c/gaynsfw'), 'lemmy|community|gaynsfw@lemmynsfw.com');
    assert.equal(p('https://foo.tumblr.com'), 'rss|feed|https://foo.tumblr.com/rss');
    assert.equal(p('https://example.com/feed.xml'), 'rss|feed|https://example.com/feed.xml');
    assert.equal(p('https://linktr.ee/zed'), 'linkinbio|page|https://linktr.ee/zed');
    assert.equal(p('https://example.com/gallery'), 'web|page|https://example.com/gallery');
  });
  test('bare @handles need a platform hint', () => {
    assert.equal(p('@foo'), null);
    assert.equal(p('@foo', { platform: 'x' }), 'x|user|foo');
  });
  test('rejects non-profile pages and junk', () => {
    assert.equal(p('https://twitter.com/intent/tweet'), null);
    assert.equal(p('https://x.com/home'), null);
    assert.equal(p('not a url'), null);
    assert.equal(p('javascript:alert(1)'), null);
    assert.equal(p(''), null);
  });
  test('paywalled platforms are display-only, never ingestable', () => {
    for (const u of ['https://onlyfans.com/zed', 'https://fansly.com/zed', 'https://patreon.com/zed', 'https://www.instagram.com/zed']) {
      const r = parseProfile(u);
      assert.equal(r.external, true, u);
      assert.equal(r.ingestable, false, u);
    }
  });
  test('does not mistake other sites’ @paths for Mastodon', () => {
    assert.notEqual(parseProfile('https://medium.com/@zed').platform, 'mastodon');
    assert.equal(parseProfile('https://www.youtube.com/@zed').external, true);
  });
  test('extractLinks pulls a deduplicated set out of free text', () => {
    const links = extractLinks('Find me: https://x.com/zed, https://x.com/zed again, https://bsky.app/profile/zed.bsky.social and https://onlyfans.com/zed');
    assert.deepEqual(links.map((l) => l.platform).sort(), ['bluesky', 'external', 'x']);
  });
  test('profileUrl round-trips', () => {
    assert.equal(profileUrl('reddit', 'user', 'zed'), 'https://www.reddit.com/user/zed');
    assert.equal(profileUrl('mastodon', 'user', 'zed@mastodon.social'), 'https://mastodon.social/@zed');
    assert.equal(profileUrl('lemmy', 'community', 'gay@lemmy.world'), 'https://lemmy.world/c/gay');
  });
});

describe('SSRF guard', () => {
  test('private and reserved addresses are rejected', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });
  test('public addresses pass', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '172.32.0.1']) assert.equal(isPrivateIp(ip), false, ip);
  });
});

describe('url helpers', () => {
  test('canonicalUrl ignores signing / cache-busting params but keeps identity', () => {
    assert.equal(canonicalUrl('https://i.redd.it/a.jpg?s=abc&width=640'), canonicalUrl('https://i.redd.it/a.jpg?s=zzz&width=1080'));
    assert.notEqual(canonicalUrl('https://i.redd.it/a.jpg'), canonicalUrl('https://i.redd.it/b.jpg'));
    assert.equal(canonicalUrl('https://I.REDD.IT/a.jpg#frag'), canonicalUrl('https://i.redd.it/a.jpg'));
  });
  test('imgur normalisation', () => {
    assert.equal(normalizeImgur('https://imgur.com/abc123'), 'https://i.imgur.com/abc123.jpg');
    assert.equal(normalizeImgur('https://i.imgur.com/abc123.gifv'), 'https://i.imgur.com/abc123.mp4');
    assert.equal(normalizeImgur('https://imgur.com/a/xyz'), null);
    assert.equal(normalizeImgur('https://example.com/x.jpg'), 'https://example.com/x.jpg');
  });
  test('stock hosts are blocked, empty hosts too', () => {
    assert.equal(hostBlocked(hostOf('https://images.unsplash.com/x.jpg')), true);
    assert.equal(hostBlocked(hostOf('https://i.redd.it/x.jpg')), false);
    assert.equal(hostBlocked(''), true);
  });
});

describe('search query builder', () => {
  test('quotes tokens, prefixes the last, and neutralises FTS syntax', () => {
    assert.equal(ftsQuery('hung gay'), '"hung"* "gay"*');
    assert.equal(ftsQuery('a" OR (b'), '"a"* "OR"* "b"*');
    assert.equal(ftsQuery('   '), null);
    assert.equal(ftsQuery('***'), null);
    assert.equal(ftsQuery('#tag @user'), '"tag"* "user"*');
  });
});

describe('circuit breaker', () => {
  test('opens after repeated systemic failures, ignores 404s, recovers', () => {
    breaker.reset();
    const now = Date.now();
    for (let i = 0; i < 3; i++) breaker.failure('x', Object.assign(new Error('boom'), { status: 500 }), now);
    assert.equal(breaker.canRun('x', now), true, 'below threshold');
    breaker.failure('x', Object.assign(new Error('boom'), { status: 429, retryAfter: 0 }), now);
    assert.equal(breaker.canRun('x', now + 1000), false, 'open');
    assert.equal(breaker.snapshot(now + 1000).x.state, 'open');
    const later = now + 4 * 60 * 1000;
    assert.equal(breaker.canRun('x', later), true, 'half-open lets one probe through');
    assert.equal(breaker.canRun('x', later), false, 'but only one');
    breaker.success('x');
    assert.equal(breaker.snapshot().x.state, 'closed');

    breaker.reset();
    for (let i = 0; i < 10; i++) breaker.failure('y', Object.assign(new Error('gone'), { status: 404 }), now);
    assert.equal(breaker.canRun('y', now), true, '404s are about one target, not the platform');
  });
  test('cool-down grows on repeated trips and honours Retry-After', () => {
    breaker.reset();
    const now = Date.now();
    for (let i = 0; i < 4; i++) breaker.failure('z', Object.assign(new Error('e'), { status: 500 }), now);
    const first = breaker.openUntil('z') - now;
    breaker.canRun('z', now + first + 1); // half-open probe...
    breaker.failure('z', Object.assign(new Error('e'), { status: 500 }), now + first + 1); // ...fails
    const second = breaker.openUntil('z') - (now + first + 1);
    assert.ok(second >= first * 2 - 10, `${second} should be ~2x ${first}`);
    breaker.reset();
    breaker.failure('r', Object.assign(new Error('e'), { status: 429, retryAfter: 600000 }), now);
    for (let i = 0; i < 3; i++) breaker.failure('r', Object.assign(new Error('e'), { status: 429, retryAfter: 600000 }), now);
    assert.ok(breaker.openUntil('r') - now >= 600000);
  });
});

describe('feed scheduling', () => {
  test('success -> jittered interval; failures -> exponential backoff capped at a day', () => {
    const feed = { interval_min: 60 };
    const ms = (iso) => new Date(iso).getTime() - Date.now();
    const ok = ms(computeNextRun(feed, 0));
    assert.ok(ok > 0.85 * 3600000 && ok < 1.15 * 3600000, String(ok));
    const f1 = ms(computeNextRun(feed, 1)); const f3 = ms(computeNextRun(feed, 3));
    assert.ok(f3 > f1 * 3, 'grows');
    assert.ok(ms(computeNextRun(feed, 30)) <= 24 * 3600000 * 1.15, 'capped');
    assert.ok(ms(computeNextRun(feed, 1, 5 * 3600000)) >= 5 * 3600000 - 1000, 'honours Retry-After');
  });
});
