'use strict';
/** v5 Following: the follow endpoints (POST, device-held follow lists) and the front-end wiring. */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine;
const AGE = { cookie: 'prism_age=1' };

const call = async (p, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
};
const post = (p, body) => call(p, { method: 'POST', headers: AGE, body });

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

let n = 0;
function addMedia(creator, { posted, ingested, type = 'image', state } = {}) {
  n++;
  const id = repo.media.insert({ creator_id: creator.id, platform: 'reddit', source_id: `fw${n}`, source_key: `reddit:fw${n}:0`, post_key: `reddit:fw${n}`, community: 'fwtest', author: creator.handle, title: `Follow item ${n}`, media_type: type, media_url: `https://example.com/${n}.jpg`, hash: `fwh${n}`, source_url: 'https://example.com/p', posted_at: posted });
  if (ingested) repo.db.prepare('UPDATE media SET ingested_at = ? WHERE id = ?').run(ingested, id);
  if (state) repo.media.setState(id, state);
  repo.creators.refreshStats(creator.id);
  return id;
}

describe('follow endpoints', () => {
  let a; let b; let hidden; const T0 = '2026-10-01T00:00:00.000Z'; const T1 = '2026-10-10T00:00:00.000Z';
  before(() => {
    a = repo.creators.create({ handle: 'fw_alpha', displayName: 'Alpha' });
    b = repo.creators.create({ handle: 'fw_beta', displayName: 'Beta' });
    hidden = repo.creators.create({ handle: 'fw_gone', displayName: 'Gone' });
    addMedia(a, { posted: '2026-09-20T00:00:00.000Z', ingested: '2026-09-20T00:00:00.000Z' });
    addMedia(a, { posted: '2026-10-05T00:00:00.000Z', ingested: '2026-10-05T00:00:00.000Z' });
    addMedia(a, { posted: '2026-10-12T00:00:00.000Z', ingested: '2026-10-12T00:00:00.000Z', type: 'video' });
    addMedia(a, { posted: '2026-10-13T00:00:00.000Z', ingested: '2026-10-13T00:00:00.000Z', state: 'review' }); // not public
    addMedia(b, { posted: '2026-10-11T00:00:00.000Z', ingested: '2026-10-11T00:00:00.000Z' });
    addMedia(hidden, { posted: '2026-10-11T00:00:00.000Z', ingested: '2026-10-11T00:00:00.000Z' });
    repo.creators.update(hidden.id, { status: 'hidden' });
  });

  test('both endpoints sit behind the age gate', async () => {
    assert.equal((await call('/api/follow/summary', { method: 'POST', body: { follows: [] } })).status, 403);
    assert.equal((await call('/api/follow/feed', { method: 'POST', body: { follows: [] } })).status, 403);
  });

  test('summary counts what is new per creator since its own seen time and reports creators gone', async () => {
    const r = await post('/api/follow/summary', { follows: [{ id: a.id, seen: T0 }, { id: b.id, seen: T1 }, { id: hidden.id, seen: T0 }, { id: 'nope' }] });
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.json.creators.map((c) => [c.id, c]));
    assert.equal(byId[a.id].new_count, 2, 'two public posts arrived after T0; the one in review does not count');
    assert.equal(byId[b.id].new_count, 1);
    assert.ok(!byId[hidden.id], 'hidden creators are not shown');
    assert.deepEqual(r.json.gone, [hidden.id]);
    assert.equal(r.json.total_new, 3);
    assert.equal(r.json.creators[0].id, a.id, 'most to catch up on first');
    for (const k of ['status', 'scope', 'origin']) assert.ok(!(k in byId[a.id]), `does not leak ${k}`);
  });

  test('summary can return full creator cards', async () => {
    const r = await post('/api/follow/summary', { follows: [{ id: a.id, seen: T0 }], cards: true });
    const c = r.json.creators[0];
    assert.ok(Array.isArray(c.previews) && Array.isArray(c.platforms));
    assert.equal(c.new_count, 2);
    assert.ok(!('status' in c));
  });

  test('feed: newest first, split at each creator’s own cut-off, filtered by type', async () => {
    const follows = [{ id: a.id, since: T0 }, { id: b.id, since: T1 }, { id: hidden.id, since: T0 }];
    const all = await post('/api/follow/feed', { follows, part: 'all' });
    assert.equal(all.json.total, 4, 'public posts of active creators only');
    const dates = all.json.items.map((m) => m.posted_at);
    assert.deepEqual(dates, [...dates].sort().reverse());
    const fresh = await post('/api/follow/feed', { follows, part: 'new' });
    assert.equal(fresh.json.total, 3);
    const earlier = await post('/api/follow/feed', { follows, part: 'earlier' });
    assert.equal(earlier.json.total, 1);
    assert.equal(new Set([...fresh.json.items, ...earlier.json.items].map((m) => m.id)).size, 4, 'the two parts never overlap');
    const vids = await post('/api/follow/feed', { follows, part: 'all', type: 'video' });
    assert.equal(vids.json.total, 1);
    const item = all.json.items[0];
    assert.ok(item.creator_handle && !('hash' in item) && !('publish_state' in item));
  });

  test('opted-out creators drop out of the feed, and a big backlog reads as more than 99', async () => {
    const out = repo.creators.create({ handle: 'fw_optout', displayName: 'Opted out' });
    addMedia(out, { posted: '2026-10-11T00:00:00.000Z', ingested: '2026-10-11T00:00:00.000Z' });
    repo.db.prepare("UPDATE creators SET scope = 'excluded' WHERE id = ?").run(out.id);
    assert.equal((await post('/api/follow/feed', { follows: [{ id: out.id }], part: 'all' })).json.total, 0);
    const busy = repo.creators.create({ handle: 'fw_busy', displayName: 'Busy' });
    for (let i = 0; i < 101; i++) addMedia(busy, { posted: '2026-10-11T00:00:00.000Z', ingested: '2026-10-11T00:00:00.000Z' });
    const r = await post('/api/follow/summary', { follows: [{ id: busy.id, seen: T0 }] });
    assert.equal(r.json.creators[0].new_count, 100, 'capped one past 99 so the badge can show 99+');
  });

  test('feed paging and input limits', async () => {
    const follows = [{ id: a.id }];
    const p0 = await post('/api/follow/feed', { follows, limit: 2, page: 0 });
    const p1 = await post('/api/follow/feed', { follows, limit: 2, page: 1, nocount: true });
    assert.equal(p0.json.items.length, 2); assert.equal(p1.json.items.length, 1);
    assert.equal(p1.json.total, null);
    assert.equal((await post('/api/follow/feed', { follows: 'x' })).json.total, 0);
    assert.equal((await post('/api/follow/feed', { follows: [{ id: "x' OR 1=1 --" }] })).json.total, 0);
    const many = Array.from({ length: 900 }, (_, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` }));
    assert.equal((await post('/api/follow/feed', { follows: [...many, { id: a.id }] })).status, 200, 'long lists are capped, not rejected');
  });
});

describe('front end wiring', () => {
  const pub = path.join(__dirname, '..', 'public');
  const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');

  test('the Following page is routed, in the desktop nav, the phone menu and the palette', () => {
    const main = read('js', 'main.js');
    assert.match(main, /pattern: '\/following', view: following/);
    assert.match(main, /\['following', '\/following', 'Following', 'rss', true\]/);
    assert.match(read('js', 'components', 'menu.js'), /href\('\/following'\)/);
    assert.match(read('js', 'components', 'palette.js'), /go\('\/following'\)/);
  });

  test('follow lists travel in POST bodies, never in URLs, and reads do not clear the API cache', () => {
    const api = read('js', 'api.js');
    assert.match(api, /export function query\(path, body, opts\)/);
    const view = read('js', 'views', 'following.js');
    assert.match(view, /postQuery\('\/api\/follow\/feed'/);
    assert.doesNotMatch(view, /creators: .*join\(','\)/);
  });

  test('Reels from Following keeps every followed creator, and badge counts track the current follow list', () => {
    assert.match(read('js', 'views', 'reels.js'), /postQuery\('\/api\/follow\/feed'/);
    const f = read('js', 'following.js');
    assert.match(f, /inflight\.key === key/);
    assert.match(f, /n !== asked/);
    assert.match(f, /follows\.prune\(data\.gone\)/);
  });

  test('viewer shows more from the creator and where else he posts', () => {
    const lb = read('js', 'components', 'lightbox.js');
    assert.match(lb, /function creatorStrip/);
    assert.match(lb, /openElsewhere\(/);
    assert.match(read('css', 'ux.css'), /\.lb-more-strip/);
  });

  test('recent searches are offered on an empty box and cleared with history', () => {
    assert.match(read('js', 'components', 'suggest.js'), /function renderRecent/);
    assert.match(read('js', 'smart.js'), /recentSearches\.add\(text\)/);
    assert.match(read('js', 'views', 'saved.js'), /recentSearches\.clear\(\)/);
  });
});
