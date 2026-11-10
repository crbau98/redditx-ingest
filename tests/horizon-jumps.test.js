'use strict';
/**
 * Jump-back from device history: palette rows, the History continue rail, and Home's split errors.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('recent jumps keep history order and cap videos and creators at six', async () => {
  const mod = await import(pathToFileURL(path.join(root, 'public/js/recent-jumps.js')).href);
  const ids = ['b', 'a', 'c'];
  const ordered = mod.orderByIds([{ id: 'a' }, { id: 'c' }, { id: 'b' }], ids);
  assert.deepEqual(ordered.map((m) => m.id), ['b', 'a', 'c']);

  const items = [];
  for (let i = 0; i < 8; i++) {
    items.push({
      id: `v${i}`, media_type: 'video', title: `Clip ${i}`, creator_id: `c${i}`,
      creator_name: `Name ${i}`, creator_handle: `h${i}`, creator_avatar: null,
    });
  }
  items.push({ id: 'img', media_type: 'image', title: 'Still', creator_id: 'c0', creator_name: 'Name 0' });
  const jumps = mod.recentJumps(items, [{ id: 'v1', t: 42 }]);
  assert.equal(jumps.videos.length, 6);
  assert.equal(jumps.creators.length, 6);
  assert.equal(jumps.videos[0].id, 'v0');
  assert.equal(jumps.videos[1].leftOff, 42);
  assert.equal(jumps.videos[0].leftOff, null);
  assert.equal(jumps.videos[0].still, null);
  const withStill = mod.recentJumps([{
    id: 'v', media_type: 'video', title: 'Clip', thumb_url: 'https://cdn/t.webp', preview_url: 'https://cdn/p.jpg',
    creator_id: 'c', creator_handle: 'h',
  }]);
  assert.equal(withStill.videos[0].still, 'https://cdn/t.webp');
  assert.equal(withStill.videos[0].stillFall, 'https://cdn/p.jpg');
  assert.equal(jumps.creators[0].id, 'c0');
  assert.equal(jumps.creators[0].handle, 'h0');
  assert.equal(mod.recentJumps([{ id: 'img', media_type: 'image', creator_id: 'c9', creator_handle: 'solo' }]).videos.length, 0);
  assert.equal(mod.recentJumps([{ id: 'img', media_type: 'image', creator_id: 'c9', creator_handle: 'solo' }]).creators[0].display_name, 'solo');
  assert.equal(mod.jumpCacheFresh({ key: 'a', at: 1_000 }, 'a', 1_000 + mod.JUMP_CACHE_MS - 1), true);
  assert.equal(mod.jumpCacheFresh({ key: 'a', at: 1_000 }, 'a', 1_000 + mod.JUMP_CACHE_MS), false);
  assert.equal(mod.jumpCacheFresh({ key: 'a', at: 1_000 }, 'b', 1_500), false);
});

test('the palette and History read device history instead of waiting on a search', () => {
  const palette = read('public/js/components/palette.js');
  const saved = read('public/js/views/saved.js');
  assert.match(palette, /jumpCacheFresh/);
  assert.match(palette, /history\.list\(\)\.slice\(0, 24\)/);
  assert.match(palette, /Recent creators/);
  assert.match(palette, /Recent videos/);
  assert.match(palette, /class: 'palette-still'/);
  assert.match(palette, /dataset\.fell/);
  assert.match(palette, /prefs\.historyOff/);
  assert.match(saved, /continue-watching/);
  assert.match(saved, /playback\.list\(\)\.slice\(0, 12\)/);
  assert.match(saved, /Where videos left off on this device/);
  assert.match(saved, /mediaCard\(it, \{ open, eager: i < 4 \}\)/);
  assert.match(saved, /creatorCard\(c, \{ eager: i < 4 \}\)/);
  assert.match(saved, /if \(i < 4\) ask\(\)/);
  assert.match(saved, /requestIdleCallback\(ask, \{ timeout: 1500 \}\)/);
  assert.match(saved, /if \(!badge\.isConnected\) return/);
  const following = read('public/js/views/following.js');
  assert.match(following, /creatorCard\(c, \{ mini: true, eager: i < 2 \}\)/);
  const home = read('public/js/views/home.js');
  assert.match(home, /mediaCard\(it, \{ open: open\(continueItems\), eager: false \}\)/);
});

test('history asks once for the first page and any resume point past it', async () => {
  const mod = await import(pathToFileURL(path.join(root, 'public/js/history-page.js')).href);
  const historyIds = Array.from({ length: 40 }, (_, i) => `h${i}`);
  const inside = mod.historyPageIds(historyIds, ['h1', 'h2'], 36);
  assert.deepEqual(inside.extra, []);
  assert.equal(inside.asked.length, 36);
  const outside = mod.historyPageIds(historyIds, ['h1', 'h39', 'h39'], 36);
  assert.deepEqual(outside.extra, ['h39']);
  assert.equal(outside.asked[0], 'h0');
  assert.equal(outside.asked[outside.asked.length - 1], 'h39');
  const saved = read('public/js/views/saved.js');
  const feed = read('public/js/components/feed.js');
  const hist = saved.slice(saved.indexOf("tab === 'history'"));
  assert.match(hist, /historyPageIds/);
  assert.match(hist, /alsoIds: extra/);
  assert.match(hist, /showProgress: true/);
  assert.doesNotMatch(hist, /ids: resumeSaved\.map/);
  assert.match(feed, /alsoIds\.filter/);
  assert.match(feed, /resumeFrac/);
  const fav = saved.slice(saved.indexOf("tab === 'saved'"), saved.indexOf("tab === 'collections'"));
  const coll = saved.slice(saved.indexOf("tab === 'collections'"), saved.indexOf("tab === 'following'"));
  assert.match(fav, /showProgress: true/);
  assert.match(coll, /showProgress: true/);
});

test('a smart feed count asks for one item newer than the last visit', async () => {
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.localStorage = store;
  const mod = await import(pathToFileURL(path.join(root, 'public/js/store.js')).href);
  const q = mod.smartFeedQuery({ query: { tag: 'gym', sort: 'relevance', following: '1' }, seen: '2026-01-01T00:00:00.000Z' });
  assert.equal(q.tag, 'gym');
  assert.equal(q.sort, undefined);
  assert.equal(q.following, undefined);
  assert.equal(q.after, '2026-01-01T00:00:00.000Z');
  assert.equal(q.limit, 1);
  assert.equal(q.creators, '00000000-0000-0000-0000-000000000000');
});

test('Home keeps the early grid when Discover fails, and says so when the grid fails', () => {
  const home = read('public/js/views/home.js');
  const feed = read('public/js/components/feed.js');
  const catchAt = home.indexOf("await get('/api/discover')");
  const afterCatch = home.indexOf('const s = data.stats');
  const catchBody = home.slice(catchAt, afterCatch);
  assert.match(catchBody, /holder\.replaceWith/);
  assert.match(catchBody, /failedFeeds\.paint\(\)/);
  const retry = catchBody.slice(catchBody.indexOf('onclick'), catchBody.indexOf('Try again'));
  assert.ok(retry.indexOf('home(root)') < retry.indexOf('dying.destroy()'), 'the new grid is created before the old one is destroyed');
  assert.ok(retry.indexOf('const next = home(root)') < retry.indexOf('extra = () => { next(); }') && retry.indexOf('extra = () => { next(); }') < retry.indexOf('dying.destroy()'), 'the cleanup the router holds calls the replacement before the old grid is destroyed');
  const stopBody = home.slice(home.indexOf('const stop = () => {'), home.indexOf('void fill()'));
  assert.ok(stopBody.indexOf('extra()') < stopBody.indexOf('if (feed) feed.destroy()'), 'leaving runs the replacement cleanup, which drops that grid');
  assert.match(catchBody, /if \(left\) return/);
  assert.doesNotMatch(catchBody, /feed\.destroy/);
  assert.doesNotMatch(catchBody, /root\.replaceChildren\(emptyState/);
  assert.match(home, /Latest uploads are still on this page/);
  assert.match(home, /Latest uploads didn’t load\. The rest of Home is still here\./);
  assert.match(home, /Discover still loaded/);
  assert.match(home, /searches\.list\(\)\.slice\(0, 2\)/);
  assert.match(home, /class: 'section home-feeds'/);
  assert.match(home, /const emptyFeeds = homeFeeds\(\)/);
  assert.ok(home.indexOf('emptyFeeds.paint()') > home.indexOf('root.replaceChildren(...[hero, emptyState'), 'empty-library counts start after that message is on screen');
  assert.match(home, /initPullToRefresh\(root, async \(\) => \{ emptyFeeds\.paint\(\); \}\)/);
  assert.ok(home.indexOf('feeds.paint()') > home.indexOf('root.replaceChildren(...parts, feedSection)'), 'the new-item counts start after Discover has painted');
  assert.ok(home.indexOf("get('/api/media', smartFeedQuery(fresh))") > home.indexOf("await get('/api/discover')"));
  const saved = read('public/js/views/saved.js');
  assert.match(saved, /get\('\/api\/media', smartFeedQuery\(s\)\)/);
  const store = read('public/js/store.js');
  assert.match(store, /export function smartFeedQuery/);
  assert.match(store, /after: s && s\.seen, limit: 1/);
  assert.match(home, /popular\.map\(\(c, i\) => creatorCard\(c, \{ mini: true, eager: i < 2/);
  assert.match(home, /people\.map\(\(c, i\) => creatorCard\(c, \{ mini: true, badge: c\.reason, eager: i < 2 \}\)/);
  const creators = read('public/js/views/creators.js');
  assert.match(creators, /const firstPage = page === 0/);
  assert.match(creators, /creatorCard\(c, \{ eager: firstPage && i < 4 \}\)/);
  assert.match(creators, /if \(!done\) prefetch\('\/api\/creators', creatorQuery\(page\)\)/);
  assert.match(feed, /failText \|\| e\.message/);
});
