'use strict';
/** Wave 14 (Halyard): Reddit full-size fallback and user history; link health does not call a picture gone while a rendition loads. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const http = require('../src/sources/http');
const calls = [];
let route = () => { throw new Error('no route'); };
http.forPlatform = () => ({ json: async (url, opts) => { calls.push(url); return route(url, opts); }, text: async (url) => { calls.push(url); return route(url); } });
const settings = require('../src/settings');
settings.update({ redditEnabled: true });
const reddit = require('../src/sources/reddit');
const repo = require('../src/db/repo');
const health = require('../src/engine/health');

const post = (id, t, extra = {}) => ({ id, created_utc: t, author: 'someuser', subreddit: 'gaybrosgonewild', title: `post ${id}`, permalink: `/r/gaybrosgonewild/comments/${id}/t/`, over_18: true, url: `https://i.redd.it/${id}.jpg`, ...extra });

test('an image post keeps the unsigned original as mediaUrl and the unescaped full-resolution source as the fallback', () => {
  const p = post('2vgdgczkx72i1', 1700000000, {
    preview: { images: [{ source: { url: 'https://preview.redd.it/2vgdgczkx72i1.jpg?auto=webp&amp;s=abc123', width: 3024, height: 4032 },
      resolutions: [{ url: 'https://preview.redd.it/2vgdgczkx72i1.jpg?width=640&amp;crop=smart&amp;s=def', width: 640, height: 853 }] }] },
  });
  const [item] = reddit.parsePost(p);
  assert.equal(item.mediaUrl, 'https://i.redd.it/2vgdgczkx72i1.jpg');
  assert.equal(item.fallbackUrl, 'https://preview.redd.it/2vgdgczkx72i1.jpg?auto=webp&s=abc123', 'HTML-unescaped, full resolution');
  assert.match(item.previewUrl, /width=640/, 'the card preview stays the 640 px rendition');
  assert.equal(item.width, 3024);
});

test('a gallery still carries its signed full-size URL as the fallback; a gallery video does not', () => {
  const p = { id: 'gal1', created_utc: 1700000001, author: 'u', subreddit: 's', title: 'g', permalink: '/r/s/comments/gal1/g/', over_18: true, is_gallery: true,
    gallery_data: { items: [{ media_id: 'aaa', id: 1 }, { media_id: 'bbb', id: 2 }] },
    media_metadata: {
      aaa: { status: 'valid', e: 'Image', m: 'image/jpg', s: { u: 'https://preview.redd.it/aaa.jpg?width=2000&amp;s=sig1', x: 2000, y: 3000 }, p: [{ u: 'https://preview.redd.it/aaa.jpg?width=640&amp;s=s640', x: 640, y: 960 }] },
      bbb: { status: 'valid', e: 'AnimatedImage', m: 'image/gif', s: { mp4: 'https://i.redd.it/bbb.mp4', x: 480, y: 480 }, p: [] },
    } };
  const items = reddit.parsePost(p);
  assert.equal(items.length, 2);
  assert.equal(items[0].mediaUrl, 'https://i.redd.it/aaa.jpg');
  assert.equal(items[0].fallbackUrl, 'https://preview.redd.it/aaa.jpg?width=2000&s=sig1');
  assert.equal(items[1].mediaType, 'video'); assert.equal(items[1].fallbackUrl, undefined);
});

test('the fallback is stored in media.fallback_url (migration v39) and served with the item', () => {
  const cols = repo.db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  assert.ok(cols.includes('fallback_url'));
  const id = repo.media.insert({ platform: 'reddit', source_id: 'fb1', source_key: 'reddit:fb1:0', hash: 'fbh1', media_type: 'image', media_url: 'https://i.redd.it/fb1.jpg', preview_url: 'https://preview.redd.it/fb1.jpg?width=640', fallback_url: 'https://preview.redd.it/fb1.jpg?auto=webp&s=x', title: 't' });
  assert.equal(repo.media.get(id).fallback_url, 'https://preview.redd.it/fb1.jpg?auto=webp&s=x');
  const id2 = repo.media.insert({ platform: 'reddit', source_id: 'fb2', source_key: 'reddit:fb2:0', hash: 'fbh2', media_type: 'image', media_url: 'https://i.redd.it/fb2.jpg', title: 't' });
  assert.equal(repo.media.get(id2).fallback_url, null);
});

/* ------------------------------------------------------------------ link health */
const mk = (n, extra) => repo.media.insert({ platform: 'reddit', source_id: `h${n}`, source_key: `reddit:h${n}:0`, hash: `hh${n}`, media_type: 'image', media_url: `https://i.redd.it/h${n}.jpg`, title: 't', ...extra });
const probeBy = (okUrls) => async (url) => (okUrls.includes(url) ? { ok: true } : { ok: false, reason: 'http 404' });
const age = (id) => repo.db.prepare("UPDATE media_health SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours') WHERE media_id = ?").run(id);

test('link health: an original that answers 404 while its fallback loads is NOT gone, and is never hidden', async () => {
  const id = mk(1, { fallback_url: 'https://preview.redd.it/h1.jpg?s=full' });
  const probe = probeBy(['https://preview.redd.it/h1.jpg?s=full']);
  for (let i = 0; i < 3; i++) { const r = await health.check(id, { probe }); assert.equal(r.verdict, 'ok'); age(id); }
  assert.equal(repo.media.get(id).publish_state, 'published');
});

test('link health: with no fallback, a working preview also keeps an image alive; a video poster does not', async () => {
  const id = mk(2, { preview_url: 'https://preview.redd.it/h2.jpg?width=640' });
  assert.equal((await health.check(id, { probe: probeBy(['https://preview.redd.it/h2.jpg?width=640']) })).verdict, 'ok');
  const vid = repo.media.insert({ platform: 'reddit', source_id: 'h3', source_key: 'reddit:h3:0', hash: 'hh3', media_type: 'video', media_url: 'https://v.redd.it/h3/DASH_720.mp4', preview_url: 'https://preview.redd.it/h3.jpg', title: 't' });
  const probe = probeBy(['https://preview.redd.it/h3.jpg']);
  await health.check(vid, { probe }); age(vid);
  const r = await health.check(vid, { probe });
  assert.equal(r.verdict, 'gone'); assert.equal(r.hidden, true, 'a live poster says nothing about a dead video');
});

test('link health: original, fallback and preview all dead is still gone and is hidden after the confirmed second verdict', async () => {
  const id = mk(4, { fallback_url: 'https://preview.redd.it/h4.jpg?s=full', preview_url: 'https://preview.redd.it/h4.jpg?width=640' });
  const probe = probeBy([]);
  assert.equal((await health.check(id, { probe })).verdict, 'gone'); age(id);
  const r = await health.check(id, { probe });
  assert.equal(r.hidden, true); assert.equal(repo.media.get(id).publish_state, 'hidden');
});

/* ------------------------------------------------------------------ user history */
/** An archive of `total` posts by one author, newest first; honours limit and before like Arctic Shift. */
function archive(total, newest = 1_700_000_000) {
  const rows = Array.from({ length: total }, (_, i) => post(`p${i}`, newest - i * 600));
  return (url) => {
    const u = new URL(url);
    if (!u.pathname.endsWith('/api/posts/search')) return null;
    const limit = Number(u.searchParams.get('limit') || 100); const before = Number(u.searchParams.get('before') || Infinity); const after = u.searchParams.get('after');
    if (after) return { data: [] };
    return { data: rows.filter((r) => r.created_utc < before).slice(0, limit) };
  };
}

test('a Reddit user feed (1,200 posts) walks into his whole history, two archive pages a run, and closes when the archive runs out', async () => {
  route = archive(1200);
  const feed = { id: 'rhist', platform: 'reddit', kind: 'user', target: 'someuser', trusted: 1 };
  let cursor = {}; const ids = new Set(); const states = [];
  for (let run = 0; run < 10; run++) {
    const res = await reddit.fetch(feed, { cursor, limit: 100, aborted: () => false });
    for (const it of res.items) ids.add(it.sourceId);
    cursor = { ...cursor, ...(res.cursor || {}) }; if (res.cursor && !res.cursor.bfBefore) delete cursor.bfBefore;
    states.push({ pending: res.backfillPending, bfBefore: cursor.bfBefore || null, done: !!cursor.bfDone });
    if (!res.backfillPending) break;
  }
  assert.equal(ids.size, 1200, `all 1200 posts read (${ids.size}); runs: ${JSON.stringify(states)}`);
  assert.equal(cursor.bfDone, true); assert.equal(states[states.length - 1].pending, false);
  assert.ok(states.length >= 3 && states.length <= 7, `a few bounded runs (${states.length})`);
  assert.ok(states.slice(0, -1).every((s) => s.pending === true), 'pending until the last slice');
});

test('history is skipped for probes, communities and short limits; a finished history is not re-read', async () => {
  route = archive(300);
  const user = { id: 'r2', platform: 'reddit', kind: 'user', target: 'someuser', trusted: 1 };
  calls.length = 0;
  const probe = await reddit.fetch(user, { cursor: {}, limit: 8, probe: true, aborted: () => false });
  assert.equal(probe.backfillPending, false);
  calls.length = 0;
  const done = await reddit.fetch(user, { cursor: { newestAt: new Date(1_700_000_000 * 1000).toISOString(), bfDone: true }, limit: 100, aborted: () => false });
  assert.ok(!calls.some((u) => /before=/.test(u)), 'no history request once bfDone');
  assert.equal(done.backfillPending, false);
  const community = await reddit.fetch({ id: 'r3', platform: 'reddit', kind: 'community', target: 'gaybrosgonewild', trusted: 1 }, { cursor: {}, limit: 100, aborted: () => false });
  assert.equal(community.backfillPending, false);
});

test('an archive rate limit during history keeps the slice already read and the resume point', async () => {
  let n = 0; const rows = archive(300);
  route = (url) => { n++; if (n >= 3) throw Object.assign(new Error('Reddit archive is rate limiting'), { status: 429, retryAfter: 60000 }); return rows(url); };
  const res = await reddit.fetch({ id: 'r4', platform: 'reddit', kind: 'user', target: 'someuser', trusted: 1 }, { cursor: {}, limit: 100, aborted: () => false });
  assert.ok(res.items.length >= 100);
  assert.equal(res.backfillPending, true);
  assert.ok(res.cursor.bfBefore, 'resumes from where it stopped');
  assert.ok(res.notes.some((x) => /history paused/.test(x)));
});
