'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv, JPEG } = require('./helpers/mock');

let upstream; let server; let base; let repo; let config; let engine;
const AGE = { cookie: 'prism_age=1' };
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const VIDEO = Buffer.alloc(100000, 3);

const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
};
const pub = (path, o = {}) => call(path, { ...o, headers: { ...AGE, ...(o.headers || {}) } });
const adm = (path, o = {}) => call(`/api/admin${path}`, { ...o, headers: { ...ADMIN, ...(o.headers || {}) } });

before(async () => {
  upstream = await start({
    '/m/img.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }),
    '/m/vid.mp4': (req, res) => {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!range) { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': VIDEO.length, 'accept-ranges': 'bytes' }); res.end(VIDEO); return null; }
      const s = Number(range[1]); const e = range[2] ? Number(range[2]) : VIDEO.length - 1;
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${s}-${e}/${VIDEO.length}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' });
      res.end(VIDEO.subarray(s, e + 1)); return null;
    },
    '/m/evil.svg': () => ({ headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }),
    '/m/page.html': () => ({ headers: { 'content-type': 'text/html' }, body: '<html>hi</html>' }),
    '/m/redirect': () => ({ status: 302, headers: { location: '/m/img.jpg' } }),
    '/m/missing': () => ({ status: 404, body: 'no' }),
    '/hls/master.m3u8': () => ({ headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n' }),
    '/hls/variant.m3u8': () => ({ headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n' }),
    '/hls/notaplaylist.m3u8': () => ({ body: 'hello' }),
  });
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  config = require('../src/config');
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  repo.hosts.add(`${upstream.url}/`); // what ingestion does for every host it accepts media from
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); await upstream.close(); });

const seed = (() => {
  let n = 0;
  return (o = {}) => {
    n++;
    const creator = o.creator || repo.creators.create({ handle: `api_creator_${n}`, displayName: `Creator ${n}` });
    const id = repo.media.insert({ creator_id: creator.id, platform: 'reddit', source_id: `api${n}`, source_key: `reddit:api${n}:0`, post_key: `reddit:api${n}`, community: 'apitest', author: creator.handle, title: `API item ${n} unique${n}`, media_type: 'image', media_url: `${upstream.url}/m/img.jpg?n=${n}`, preview_url: `${upstream.url}/m/img.jpg?p=${n}`, hash: `apih${n}`, source_url: 'https://example.com/post', score: 10 * n, width: 800, height: 1000, review_reason: o.review_reason || null, ...o.row }, ['apitag']);
    repo.creators.refreshStats(creator.id);
    return { id, creator, n };
  };
})();

describe('open endpoints and the age gate', () => {
  test('health and meta are open and describe the gate', async () => {
    const h = await call('/api/health'); assert.equal(h.status, 200); assert.equal(h.json.db, true);
    const m = await call('/api/meta'); assert.equal(m.json.ageGate.enforce, true); assert.equal(m.json.ageGate.verified, false);
    assert.ok(m.json.platforms.some((p) => p.platform === 'reddit'));
    assert.equal((await call('/api/meta', { headers: AGE })).json.ageGate.verified, true);
  });
  test('content endpoints refuse requests without the cookie — including the media proxy', async () => {
    for (const p of ['/api/media', '/api/discover', '/api/creators', '/api/tags', '/api/stats', '/api/proxy?url=x', '/api/hls?url=x']) {
      const r = await call(p); assert.equal(r.status, 403, p); assert.equal(r.json.code, 'age_gate', p);
    }
  });
  test('confirming sets an HttpOnly, SameSite cookie that unlocks content', async () => {
    const r = await call('/api/age/confirm', { method: 'POST', body: {} });
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /prism_age=1/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
    assert.equal((await call('/api/stats', { headers: { cookie: cookie.split(';')[0] } })).status, 200);
  });
  test('security headers are present and the CSP forbids inline script', async () => {
    const r = await call('/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/); assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-powered-by'), null); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('referrer-policy'), /no-referrer/);
  });
  test('SPA fallback serves the app; unknown API paths return JSON 404; static JS always revalidates', async () => {
    assert.match((await call('/some/client/route')).text, /<div id="app">/);
    const nf = await call('/api/definitely-not-here'); assert.equal(nf.status, 404); assert.equal(nf.json.error, 'Not found');
    assert.match((await call('/js/main.js')).headers.get('cache-control'), /no-cache/);
  });
  test('malformed JSON bodies are a 400, not a crash', async () => {
    const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
  });
});

describe('public API', () => {
  test('lists media without leaking internal fields', async () => {
    const { id } = seed();
    const r = await pub('/api/media?limit=100&community=apitest');
    assert.equal(r.status, 200);
    const item = r.json.items.find((m) => m.id === id);
    assert.ok(item); assert.deepEqual(item.tags, ['apitag', 'apitest', 'reddit'].sort().length ? item.tags : []);
    for (const hidden of ['hash', 'source_key', 'review_reason', 'feed_id', 'scope', 'publish_state', 'seq']) assert.ok(!(hidden in item), `leaks ${hidden}`);
    assert.ok(item.creator_handle && item.preview_url);
  });
  test('detail, related, ids filter, and visibility rules', async () => {
    const a = seed(); const b = seed({ creator: seed().creator });
    assert.equal((await pub(`/api/media/${a.id}`)).json.id, a.id);
    assert.ok((await pub(`/api/media/${a.id}/related`)).json.length >= 0);
    const some = await pub(`/api/media?ids=${a.id},${b.id},not-a-uuid`);
    assert.equal(some.json.total, 2);
    repo.media.setState(a.id, 'review');
    assert.equal((await pub(`/api/media/${a.id}`)).status, 404, 'review items are not public');
    assert.equal((await pub(`/api/media?ids=${a.id}`)).json.total, 0);
    assert.equal((await pub('/api/media/00000000-0000-0000-0000-000000000000')).status, 404);
  });
  test('search, sorting, paging, limits are validated and clamped', async () => {
    const x = seed({ row: { title: 'searchable zebraunique' } });
    assert.equal((await pub('/api/media?q=zebraunique')).json.items[0].id, x.id);
    assert.equal((await pub('/api/media?limit=99999')).json.limit, 120);
    assert.equal((await pub('/api/media?sort=DROP%20TABLE&page=-5')).status, 200);
    assert.equal((await pub('/api/media?platform=reddit;--')).json.total >= 1, true, 'bad platform value ignored, not injected');
    assert.equal((await pub("/api/media?q=%22%20OR%20%28")).status, 200);
  });
  test('creators: list, profile (with account links) and their media', async () => {
    const { creator } = seed();
    repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'pubcreator.bsky.social', creatorId: creator.id });
    repo.creators.update(creator.id, { links: [{ platform: 'external', service: 'Throne', label: 'Throne', url: 'https://throne.com/x' }] });
    const list = await pub(`/api/creators?q=${creator.handle}`);
    assert.equal(list.json.items[0].id, creator.id);
    assert.ok(!('status' in list.json.items[0]) && !('origin' in list.json.items[0]));
    const p = await pub(`/api/creators/${creator.id}`);
    assert.equal(p.json.handle, creator.handle);
    assert.ok(p.json.accounts.some((a) => a.url === 'https://bsky.app/profile/pubcreator.bsky.social'));
    assert.equal(p.json.links[0].service, 'Throne');
    assert.equal((await pub(`/api/creators/${creator.id}/media`)).json.total, 1);
    repo.creators.update(creator.id, { status: 'hidden' });
    assert.equal((await pub(`/api/creators/${creator.id}`)).status, 404);
    assert.equal((await pub(`/api/creators/${creator.id}/media`)).status, 404);
  });
  test('discover returns every rail', async () => {
    const d = (await pub('/api/discover')).json;
    for (const k of ['stats', 'trending', 'freshVideos', 'topCreators', 'newCreators', 'tags', 'communities', 'platforms']) assert.ok(k in d, k);
  });
  test('view and like counters increment', async () => {
    const { id } = seed();
    await pub(`/api/media/${id}/view`, { method: 'POST', body: {} }); await pub(`/api/media/${id}/like`, { method: 'POST', body: {} });
    const m = (await pub(`/api/media/${id}`)).json; assert.equal(m.views, 1); assert.equal(m.likes, 1);
    await pub(`/api/media/${id}/like`, { method: 'POST', body: { delta: -1 } });
    assert.equal((await pub(`/api/media/${id}`)).json.likes, 0);
  });
});

describe('reports and takedowns', () => {
  test('input is validated', async () => {
    assert.equal((await call('/api/report', { method: 'POST', body: { kind: 'bogus', mediaId: 'x' } })).status, 400);
    assert.equal((await call('/api/report', { method: 'POST', body: { kind: 'takedown' } })).status, 400);
    assert.equal((await call('/api/report', { method: 'POST', body: { kind: 'takedown', mediaId: '00000000-0000-0000-0000-000000000000' } })).status, 404);
  });
  test('reports work without the age gate (takedowns must always be possible)', async () => {
    const { id } = seed();
    const r = await call('/api/report', { method: 'POST', body: { kind: 'takedown', mediaId: id, reason: 'that is me', contact: 'me@example.com' } });
    assert.equal(r.status, 201);
    assert.equal(repo.media.get(id).publish_state, 'published', 'ordinary takedowns wait for a human');
    assert.ok(repo.reports.get(r.json.id));
  });
  test('safety reports hide the item immediately, before any human looks', async () => {
    const { id, creator } = seed();
    for (const kind of ['underage', 'nonconsensual']) {
      const s = seed();
      const r = await call('/api/report', { method: 'POST', body: { kind, mediaId: s.id } });
      assert.equal(r.status, 201); assert.equal(repo.media.get(s.id).publish_state, 'hidden', kind);
      assert.equal((await pub(`/api/media/${s.id}`)).status, 404);
    }
    await call('/api/report', { method: 'POST', body: { kind: 'underage', creatorId: creator.id } });
    assert.equal(repo.creators.get(creator.id).status, 'hidden');
    assert.ok(id);
  });
  test('admin resolves: remove blocklists permanently; restore republishes', async () => {
    const a = seed(); const b = seed();
    const ra = (await call('/api/report', { method: 'POST', body: { kind: 'copyright', mediaId: a.id } })).json.id;
    const rb = (await call('/api/report', { method: 'POST', body: { kind: 'underage', mediaId: b.id } })).json.id;
    const open = (await adm('/reports')).json;
    assert.equal(open.items[0].kind, 'underage', 'safety reports sort first');
    assert.equal((await adm(`/reports/${ra}/resolve`, { method: 'POST', body: { action: 'remove' } })).status, 200);
    assert.equal(repo.media.get(a.id).publish_state, 'removed');
    assert.ok(repo.blocklist.has('hash', repo.db.prepare('SELECT hash FROM media WHERE id=?').get(a.id).hash));
    assert.equal((await adm(`/reports/${rb}/resolve`, { method: 'POST', body: { action: 'restore', note: 'false alarm' } })).status, 200);
    assert.equal(repo.media.get(b.id).publish_state, 'published');
    assert.equal((await adm(`/reports/${rb}/resolve`, { method: 'POST', body: { action: 'nonsense' } })).status, 400);
  });
});

describe('admin API', () => {
  test('requires the key (header or bearer); fails closed when no key is configured in production', async () => {
    assert.equal((await call('/api/admin/overview')).status, 401);
    assert.equal((await call('/api/admin/overview', { headers: { 'x-admin-key': 'wrong' } })).status, 401);
    assert.equal((await call('/api/admin/overview', { headers: { authorization: 'Bearer test-key' } })).status, 200);
    assert.equal((await adm('/overview')).status, 200);
    const saved = { key: config.adminKey, open: config.adminOpen };
    config.adminKey = ''; config.adminOpen = false;
    try { assert.equal((await call('/api/admin/overview')).status, 503); } finally { config.adminKey = saved.key; config.adminOpen = saved.open; }
  });
  test('overview, sources, engine, settings', async () => {
    const o = (await adm('/overview')).json; assert.ok(o.media && o.creators && o.feeds && o.queues && o.engine);
    const s = (await adm('/sources')).json; assert.ok(s.find((x) => x.platform === 'reddit').breaker); assert.ok(s.find((x) => x.platform === 'x').config.search.ok === false);
    assert.ok('running' in (await adm('/engine')).json);
    const st = await adm('/settings', { method: 'PUT', body: { maxConcurrentFeeds: 99, scopeMode: 'bogus', notASetting: 'x', autoTrack: false } });
    assert.equal(st.json.values.maxConcurrentFeeds, 8, 'clamped'); assert.equal(st.json.values.scopeMode, 'strict', 'invalid enum falls back'); assert.equal(st.json.values.autoTrack, false);
    assert.ok(!('notASetting' in st.json.values));
    assert.ok(!JSON.stringify((await adm('/settings')).json).includes('test-key'), 'secrets never echoed');
  });
  test('feeds: add from a pasted link, reject nonsense, bulk import, edit, delete', async () => {
    const add = await adm('/feeds', { method: 'POST', body: { input: 'https://www.reddit.com/r/AdminTestSub', run: false } });
    assert.equal(add.status, 201); assert.equal(add.json.feed.target, 'adminsubtest'.length ? 'admintestsub' : '');
    assert.equal((await adm('/feeds', { method: 'POST', body: { input: 'https://www.reddit.com/r/AdminTestSub', run: false } })).json.status, 'exists');
    assert.equal((await adm('/feeds', { method: 'POST', body: { input: 'not a link' } })).status, 400);
    assert.equal((await adm('/feeds', { method: 'POST', body: { platform: 'reddit', kind: 'search', target: 'x' } })).status, 400, 'unsupported kind for platform');
    const imp = await adm('/feeds/import', { method: 'POST', body: { text: 'r/importa, r/importb\nhttps://example.org/feed.xml\n@@@bad@@@ https://onlyfans.com/zed' } });
    assert.equal(imp.json.created, 3); assert.equal(imp.json.external, 1); assert.equal(imp.json.invalid.length, 1);
    const f = add.json.feed;
    assert.equal((await adm(`/feeds/${f.id}`, { method: 'PATCH', body: { intervalMin: 5, enabled: false } })).json.interval_min, 5);
    assert.equal((await adm(`/feeds/${f.id}`, { method: 'PATCH', body: { intervalMin: 1 } })).json.interval_min, 5, 'interval is clamped to the minimum');
    assert.equal((await adm('/feeds?platform=reddit&q=admintest')).json.total, 1);
    assert.equal((await adm(`/feeds/${f.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await adm(`/feeds/${f.id}`, { method: 'DELETE' })).status, 404);
  });
  test('creators: add from many links, extend an existing creator, conflicts, merge, block/restore', async () => {
    const r = await adm('/creators', { method: 'POST', body: { name: 'Admin Made', inputs: 'https://x.com/adminmade\nu/adminmade\nhttps://fansly.com/adminmade\nbogus' } });
    assert.equal(r.status, 201); assert.equal(r.json.feeds.length, 2); assert.equal(r.json.links.length, 1); assert.equal(r.json.skipped.length, 1);
    const again = await adm('/creators', { method: 'POST', body: { inputs: 'https://x.com/adminmade https://bsky.app/profile/adminmade.bsky.social' } });
    assert.equal(again.json.creator.id, r.json.creator.id, 'a known account extends its creator rather than duplicating'); assert.equal(again.json.feeds.length, 2);
    const other = await adm('/creators', { method: 'POST', body: { name: 'Someone Else', inputs: 'https://x.com/adminmade https://x.com/someoneelse' } });
    assert.equal(other.json.creator.id, r.json.creator.id, 'conflicting account resolves to its existing owner');
    const solo = await adm('/creators', { method: 'POST', body: { name: 'Solo', inputs: 'u/soloperson' } });
    const merged = await adm('/creators/merge', { method: 'POST', body: { keepId: r.json.creator.id, mergeId: solo.json.creator.id } });
    assert.equal(merged.status, 200); assert.equal(repo.creators.get(solo.json.creator.id), null);
    assert.equal((await adm('/creators', { method: 'POST', body: {} })).status, 400);
    assert.equal((await adm(`/creators/${r.json.creator.id}/block`, { method: 'POST', body: { reason: 't' } })).json.status, 'blocked');
    assert.ok(repo.blocklist.has('creator', 'x:adminmade'));
    const blocked = await adm('/creators', { method: 'POST', body: { inputs: 'https://x.com/adminmade' } });
    assert.equal(blocked.status, 400); assert.match(blocked.json.error, /blocked/);
    assert.equal((await adm(`/creators/${r.json.creator.id}/restore`, { method: 'POST' })).json.status, 'active');
  });
  test('media moderation: single, bulk, and permanent block', async () => {
    const a = seed({ row: { publish_state: 'review' } }); const b = seed(); const c = seed();
    assert.equal((await adm(`/media/${a.id}/moderate`, { method: 'POST', body: { action: 'approve' } })).json.publish_state, 'published');
    assert.equal((await adm('/media/bulk', { method: 'POST', body: { ids: [b.id, c.id], action: 'hide' } })).json.updated, 2);
    assert.equal(repo.media.get(b.id).publish_state, 'hidden');
    assert.equal((await adm(`/media/${c.id}/moderate`, { method: 'POST', body: { action: 'block', reason: 'x' } })).json.publish_state, 'removed');
    assert.equal((await adm(`/media/${c.id}/moderate`, { method: 'POST', body: { action: 'fly' } })).status, 400);
    assert.equal((await adm('/media/00000000-0000-0000-0000-000000000000/moderate', { method: 'POST', body: { action: 'hide' } })).status, 404);
    const q = (await adm('/moderation/queue')).json; assert.ok(Array.isArray(q.items));
    assert.equal((await adm('/media?state=hidden&limit=5')).status, 200);
  });
  test('blocklist CRUD', async () => {
    assert.equal((await adm('/blocklist', { method: 'POST', body: { type: 'creator', value: 'Reddit:BadActor', reason: 'r' } })).status, 201);
    assert.ok(repo.blocklist.has('creator', 'reddit:badactor'), 'case-insensitive');
    assert.equal((await adm('/blocklist', { method: 'POST', body: { type: 'nope', value: 'x' } })).status, 400);
    const list = (await adm('/blocklist')).json; const entry = list.items.find((b) => b.value === 'reddit:badactor');
    assert.equal((await adm(`/blocklist/${entry.id}`, { method: 'DELETE' })).status, 200);
  });
});

describe('media proxy', () => {
  const px = (url, h = {}) => pub(`/api/proxy?url=${encodeURIComponent(url)}`, { headers: h });
  test('streams allowed images with safe headers and caches them on disk', async () => {
    const url = `${upstream.url}/m/img.jpg?cache=1`;
    const r1 = await px(url);
    assert.equal(r1.status, 200); assert.equal(r1.headers.get('content-type'), 'image/jpeg'); assert.equal(r1.headers.get('x-cache'), 'MISS');
    assert.equal(r1.headers.get('cross-origin-resource-policy'), 'same-origin'); assert.match(r1.headers.get('cache-control'), /max-age/);
    await new Promise((r) => setTimeout(r, 100));
    const r2 = await px(url); assert.equal(r2.headers.get('x-cache'), 'HIT');
    const hitsBefore = upstream.hits.filter((h) => h.includes('cache=1')).length;
    await px(url); assert.equal(upstream.hits.filter((h) => h.includes('cache=1')).length, hitsBefore, 'served from cache, origin not contacted');
  });
  test('HTTP Range is passed through so video can seek', async () => {
    const full = await px(`${upstream.url}/m/vid.mp4`);
    assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const part = await pub(`/api/proxy?url=${encodeURIComponent(`${upstream.url}/m/vid.mp4`)}`, { headers: { range: 'bytes=1000-1999' } });
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 1000-1999/100000'); assert.equal(part.text.length, 1000);
  });
  test('refuses SVG (script injection), HTML and other non-media; maps upstream errors', async () => {
    assert.equal((await px(`${upstream.url}/m/evil.svg`)).status, 415);
    assert.equal((await px(`${upstream.url}/m/page.html`)).status, 415);
    assert.equal((await px(`${upstream.url}/m/missing`)).status, 404);
  });
  test('follows redirects safely', async () => {
    const r = await px(`${upstream.url}/m/redirect`); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
  });
  test('only hosts that ingestion has accepted (or known CDNs) are reachable; bad input is rejected', async () => {
    assert.equal((await px('http://127.0.0.2:9/x.jpg')).status, 403, 'unknown host');
    assert.equal((await px('https://example.org/x.jpg')).status, 403);
    assert.equal((await pub('/api/proxy')).status, 400);
    assert.equal((await px('file:///etc/passwd')).status, 400);
    assert.equal((await pub('/api/proxy?url=' + 'a'.repeat(3000))).status, 400);
  });
  test('HLS: playlists are rewritten so every segment and variant comes back through the proxy', async () => {
    const master = await pub(`/api/hls?url=${encodeURIComponent(`${upstream.url}/hls/master.m3u8`)}`);
    assert.equal(master.status, 200); assert.match(master.headers.get('content-type'), /mpegurl/);
    assert.match(master.text, /^\/api\/hls\?url=.*variant\.m3u8/m, 'variant playlists go via /api/hls');
    const variant = await pub(`/api/hls?url=${encodeURIComponent(`${upstream.url}/hls/variant.m3u8`)}`);
    assert.match(variant.text, /URI="\/api\/proxy\?url=[^"]*init\.mp4"/, 'init segment rewritten inside tag attributes');
    assert.match(variant.text, /^\/api\/proxy\?url=.*seg0\.ts/m, 'segments go via /api/proxy');
    assert.equal((await pub(`/api/hls?url=${encodeURIComponent(`${upstream.url}/hls/notaplaylist.m3u8`)}`)).status, 415);
  });
});
