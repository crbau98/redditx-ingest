'use strict';
/**
 * Phase 2 remainder: every dropped post and failed profile read shows in the run notes, X reads a further API page only
 * while the last one was full (3 at most), a Telegram forward keeps the original channel's handle as a lead (never
 * "undefined"), and a GFF scene with a second performer credits him on the one stored row.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv, JPEG } = require('./helpers/mock');

let mock; let net; let limiter; let reddit; let x; let telegram; let engine; let pipeline; let repo;
const realFetchJSON = [];
before(async () => {
  mock = await start({ '/scene.jpg': () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG }) });
  prepareEnv({ REDDIT_BASE_URL: 'https://www.reddit.com', REDDIT_ARCHIVE_URL: 'https://arctic-shift.photon-reddit.com' });
  limiter = require('../src/lib/limiter');
  limiter.schedule = async (key, ms, fn) => fn();
  net = require('../src/lib/net');
  realFetchJSON.push(net.fetchJSON);
  require('../src/settings').update({ redditEnabled: true });
  reddit = require('../src/sources/reddit');
  x = require('../src/sources/x');
  telegram = require('../src/sources/telegram');
  engine = require('../src/engine/engine');
  pipeline = require('../src/engine/pipeline');
  repo = require('../src/db/repo');
});
after(async () => { net.fetchJSON = realFetchJSON[0]; engine.shutdown(); await mock.close(); });

const post = (o) => ({ id: o.id, title: o.title || 't', author: o.author || 'jock', subreddit: 'gaybros', score: 1, over_18: true, created_utc: 1793940000, permalink: `/r/gaybros/comments/${o.id}/x/`, ...o });

test('reddit: removed posts, imgur albums and unreadable links are counted in the notes; text posts are not', async () => {
  net.fetchJSON = async (url) => {
    if (/arctic-shift/.test(url)) {
      return { data: [
        post({ id: 'ok1', url: 'https://i.redd.it/ok1.jpg' }),
        post({ id: 'rm1', url: 'https://i.redd.it/rm1.jpg', removed_by_category: 'moderator' }),
        post({ id: 'al1', url: 'https://imgur.com/a/abcdef' }),
        post({ id: 'ln1', url: 'https://example.com/some-article' }),
        post({ id: 'tx1', url: 'https://www.reddit.com/r/gaybros/comments/tx1/x/', is_self: true, selftext: 'just words' }),
      ] };
    }
    throw Object.assign(new Error('blocked'), { status: 403 });
  };
  const out = await reddit.fetch({ platform: 'reddit', kind: 'community', target: 'gaybros' }, { cursor: {}, limit: 100, aborted: () => false });
  assert.deepEqual(out.items.map((i) => i.sourceId), ['ok1']);
  const note = out.notes.find((n) => /^dropped/.test(n));
  assert.ok(note, JSON.stringify(out.notes));
  assert.match(note, /dropped 3 post\(s\)/);
  assert.match(note, /removed or deleted ×1/);
  assert.match(note, /imgur album ×1/);
  assert.match(note, /unsupported link ×1/);
  assert.doesNotMatch(note, /text/);
});

test('reddit: a profile read that fails (500) still returns the posts, with a note', async () => {
  net.fetchJSON = async (url) => {
    if (/arctic-shift/.test(url)) return { data: [post({ id: 'u1', author: 'jock', url: 'https://i.redd.it/u1.jpg' })] };
    if (/\/about\.json/.test(url)) throw Object.assign(new Error('HTTP 500 for about.json'), { status: 500 });
    throw Object.assign(new Error('blocked'), { status: 403 });
  };
  const out = await reddit.fetch({ platform: 'reddit', kind: 'user', target: 'jock' }, { cursor: {}, limit: 100, needProfile: true, aborted: () => false });
  assert.deepEqual(out.items.map((i) => i.sourceId), ['u1']);
  assert.equal(out.profile, null);
  assert.ok(out.notes.some((n) => /profile not read: HTTP 500/.test(n)), JSON.stringify(out.notes));
});

const page = (n, next) => ({ data: Array.from({ length: n }, (_, i) => ({ id: String(i) })), meta: { result_count: n, newest_id: `n${n}`, ...(next ? { next_token: next } : {}) } });

test('x: a full page asks for one more; a partial page stops (both pages kept, no third request)', async () => {
  const asked = [];
  const r = await x._apiPages(async (next) => { asked.push(next); return asked.length === 1 ? page(100, 't2') : page(40, 't3'); }, 3);
  assert.deepEqual(asked, [null, 't2']);
  assert.equal(r.pages.length, 2);
  assert.equal(r.newestId, 'n100');
});

test('x: full pages stop at the hard cap of 3, and a budget stop on a later page keeps what was read', async () => {
  const asked = [];
  const r = await x._apiPages(async (next) => { asked.push(next); return page(100, `t${asked.length + 1}`); }, 3);
  assert.equal(asked.length, 3, 'never a fourth page');
  assert.equal(r.pages.length, 3);
  let n = 0;
  const cut = await x._apiPages(async () => { n++; if (n === 2) throw Object.assign(new Error('X API monthly read budget reached'), { budget: true }); return page(100, 'more'); }, 3);
  assert.equal(cut.pages.length, 1);
  await assert.rejects(x._apiPages(async () => { throw Object.assign(new Error('budget'), { budget: true }); }, 3), (e) => e.budget);
});

test('telegram: a forward keeps the original channel handle on repostOf; the author stays the channel', () => {
  const msg = { id: 1, text: 'fwd', date: '2026-11-01T00:00:00Z', views: 10, link: 'https://t.me/mine/1', media: [{ type: 'image', url: 'https://cdn.example/1.jpg' }], forwardFrom: { handle: 'origchan', name: 'Orig' } };
  const [it] = telegram.toItems(msg, 'mine', null);
  assert.equal(it.repostOf.handle, 'origchan');
  assert.equal(it.repostOf.via, 'mine');
  assert.equal(it.author, telegram.toItems({ ...msg, forwardFrom: null }, 'mine', null)[0].author, 'author unchanged by the forward');
  const [noHandle] = telegram.toItems({ ...msg, forwardFrom: { handle: null, name: 'Someone' } }, 'mine', null);
  assert.equal('handle' in noHandle.repostOf, false);
});

test('engine: a repost with no handle is never stored as an "undefined" lead', () => {
  const c = repo.creators.create({ handle: 'waysin_owner', displayName: 'Owner' });
  const w = { originals: new Set(), reposters: new Map(), hangouts: new Set(), forwards: new Set() };
  engine._waysIn.noteWaysIn({ repostOf: { platform: 'telegram', via: 'otherchan' } }, { creatorId: c.id }, { platform: 'telegram', kind: 'channel', target: 'mine' }, w);
  assert.equal(w.reposters.size, 0);
  engine._waysIn.noteWaysIn({ repostOf: { platform: 'telegram', via: 'otherchan', handle: 'origchan' } }, { creatorId: c.id }, { platform: 'telegram', kind: 'channel', target: 'mine' }, w);
  assert.deepEqual([...w.reposters.get('otherchan')], ['origchan']);
  for (const set of w.reposters.values()) assert.ok(![...set].includes('undefined'));
});

test('gff: the same scene from a second performer credits him on the one stored row; no second media row', async () => {
  const settings = { probeUnknownHosts: false, scopeMode: 'open' };
  const feedA = repo.feeds.upsert({ platform: 'gff', kind: 'user', target: 'https://justthegays.tv/performer/alpha-one-1', runNow: false }).feed;
  const feedB = repo.feeds.upsert({ platform: 'gff', kind: 'user', target: 'https://justthegays.tv/performer/beta-three-2', runNow: false }).feed;
  repo.hosts.add(`${mock.url}/`);
  const scene = (author, extra = {}) => ({ sourceId: 'gff-scene-abc123', position: 0, title: 'gym scene', author, mediaType: 'image', mediaUrl: `${mock.url}/scene.jpg`, permalink: 'https://justthegays.tv/video/scene-abc123', postedAt: '2026-11-01T00:00:00Z', trusted: true, nsfw: 'explicit', ...extra });
  const first = await pipeline.processItem(scene('Alpha One', { credits: ['Gamma Two'] }), feedA, null, settings);
  assert.ok(['added', 'review'].includes(first.outcome), JSON.stringify(first));
  const alts = () => repo.media.altSources(first.mediaId, 20).map((a) => a.author).sort();
  assert.deepEqual(alts(), ['Gamma Two'], 'the second actor in the JSON-LD is credited');
  const second = await pipeline.processItem(scene('Beta Three'), feedB, null, settings);
  assert.equal(second.outcome, 'dupe');
  assert.deepEqual(alts(), ['Beta Three', 'Gamma Two']);
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE source_key = 'gff:gff-scene-abc123:0'").get().n, 1);
  // the first performer re-read, and the second again: nothing new
  await pipeline.processItem(scene('Alpha One'), feedA, null, settings);
  await pipeline.processItem(scene('Beta Three'), feedB, null, settings);
  assert.equal(alts().length, 2);
  assert.equal(repo.media.get(first.mediaId).creator_id, first.creatorId, 'the creator is unchanged');
});
