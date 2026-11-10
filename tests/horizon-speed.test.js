'use strict';
/**
 * Speed and resume rules shipped with the long-horizon pass:
 * list payloads drop captions, API responses carry Server-Timing, and resume math is exact.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();

function loadPolicy() {
  const file = path.join(__dirname, '../public/js/playback-policy.js');
  const src = fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(`${src}\nmodule.exports = { RATES, clampRate, stepRate, resumeAt, keepProgress, mergeResume };`, file);
  return m.exports;
}

const policy = loadPolicy();

test('playback speed steps stay inside the five rates and do not wrap', () => {
  assert.deepEqual(policy.RATES, [0.75, 1, 1.25, 1.5, 2]);
  assert.equal(policy.clampRate('nope'), 1);
  assert.equal(policy.stepRate(1, 1), 1.25);
  assert.equal(policy.stepRate(2, 1), 2);
  assert.equal(policy.stepRate(0.75, -1), 0.75);
  assert.equal(policy.stepRate(1.25, -1), 1);
});

test('home paints the latest grid before it waits on the discover snapshot', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/home.js'), 'utf8');
  const feedAt = src.indexOf('createFeed(');
  const waitAt = src.indexOf("await get('/api/discover')");
  const back = src.indexOf('return stop;');
  assert.ok(feedAt > 0 && waitAt > feedAt, 'the grid is created before discover is awaited');
  assert.ok(back > feedAt && back < waitAt, 'cleanup is returned before Discover is awaited');
  assert.ok(src.indexOf('if (left) return') < src.indexOf('holder.replaceWith'), 'a late failure does not replace the skeleton after you leave');
  assert.ok(src.indexOf('if (left) return') < src.indexOf('root.replaceChildren(...parts, feedSection)'), 'a late snapshot does not replace a page you have left');
  assert.match(src, /Continue watching/);
});

test('Saved → Following hands back cleanup before the follow summary returns', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/saved.js'), 'utf8');
  const bones = src.indexOf("class: 'creator-grid'");
  const asked = src.indexOf("postQuery('/api/follow/summary'");
  const back = src.indexOf('return () => { left = true; cleanup(); }');
  assert.ok(bones > 0 && bones < asked && asked < back, 'the skeletons are up, and cleanup is returned, before the summary is awaited');
  assert.equal(src.includes("await postQuery('/api/follow/summary'"), false);
  const paint = src.indexOf('grid.replaceChildren(...d.creators.map((c, i) => creatorCard(c, { eager: i < 4 })))');
  assert.ok(src.indexOf('if (left) return') > asked && src.indexOf('if (left) return') < paint, 'a late summary does not replace the skeletons after you leave');
  assert.ok(src.includes('if (left) return; grid.replaceChildren(h(\'p\', { class: \'muted\' }, e.message))'), 'a late failure does not paint an error you will not see');
});

test('an empty Following page hands back cleanup before popular creators return', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/following.js'), 'utf8');
  const empty = src.slice(src.indexOf('function emptyFollowing'), src.indexOf('export async function following'));
  const painted = empty.indexOf("title: 'You’re not following anyone yet'");
  const asked = empty.indexOf("get('/api/creators', { sort: 'score', limit: 12 })");
  const back = empty.indexOf('return () => { left = true; }');
  assert.ok(painted > 0 && painted < asked && asked < back, 'the empty state is up, and cleanup is returned, before popular creators are awaited');
  assert.equal(empty.includes('await get('), false);
  const fill = empty.indexOf('people.replaceChildren(...r.items.map((c, i) => creatorCard(c, { mini: true, eager: i < 2 })))');
  assert.ok(empty.indexOf('if (left) return') > asked && empty.indexOf('if (left) return') < fill, 'a late list does not replace a page you have left');
  assert.ok(empty.includes('if (left) return; people.remove()'), 'a late failure does not drop the rail after you leave');
});

test('Explore drops late platform, creator, and tag chip fills after you leave', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/explore.js'), 'utf8');
  const painted = src.indexOf("aria-label': 'Explore filters'");
  const plats = src.indexOf("get('/api/platforms')");
  const creators = src.indexOf("get('/api/creators', { sort: 'media'");
  const tags = src.indexOf("get('/api/tags', { limit: 30 })");
  const back = src.indexOf('return () => {\n    left = true;');
  assert.ok(painted > 0 && painted < plats && plats < creators && creators < tags && tags < back, 'the filter bar is up, and cleanup marks left, before chip fills resolve');
  assert.equal(src.includes('await get(\'/api/platforms\')'), false);
  assert.equal(src.includes('await get(\'/api/creators\''), false);
  assert.equal(src.includes('await get(\'/api/tags\''), false);
  const platFill = src.indexOf('platSel.replaceChildren(');
  const creatorFill = src.indexOf('creatorRail.replaceChildren(\n      h(\'button\'');
  const tagFill = src.indexOf('tagRail.replaceChildren(...tags.map');
  assert.ok(src.lastIndexOf('if (left) return', platFill) > plats && src.lastIndexOf('if (left) return', platFill) < platFill, 'a late platform list does not rewrite the source select');
  assert.ok(src.lastIndexOf('if (left) return', creatorFill) > creators && src.lastIndexOf('if (left) return', creatorFill) < creatorFill, 'a late creator list does not rewrite the Creator rail');
  assert.ok(src.lastIndexOf('if (left) return', tagFill) > tags && src.lastIndexOf('if (left) return', tagFill) < tagFill, 'a late tag list does not rewrite the Tags rail');
  assert.ok(src.includes('if (left) return; creatorRail.replaceChildren()'), 'a late creator failure does not clear the rail after you leave');
});

test('Explore drops late creator-name and spelling fills after you leave', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/explore.js'), 'utf8');
  const leftAt = src.indexOf('let left = false;');
  const nameAsk = src.indexOf('get(`/api/creators/${f.creator}`)');
  const nameFill = src.indexOf('creatorChip.textContent = `by ${creatorName}`');
  const spellingAsk = src.indexOf('understand(f.raw)');
  const spellingFill = src.indexOf("fixes.replaceChildren(icon('check', 'sm'), 'Spelling fixed:");
  const back = src.indexOf('return () => {\n    left = true;');
  assert.ok(leftAt > 0 && leftAt < nameAsk && nameAsk < nameFill, 'left is marked before the creator-name request');
  assert.ok(src.lastIndexOf('if (left) return', nameFill) > nameAsk && src.lastIndexOf('if (left) return', nameFill) < nameFill, 'a late creator name does not rewrite the chip or document title');
  assert.ok(spellingAsk > leftAt && spellingAsk < spellingFill && spellingFill < back, 'Understood as is up before spelling resolves');
  assert.ok(src.lastIndexOf('if (left) return', spellingFill) > spellingAsk && src.lastIndexOf('if (left) return', spellingFill) < spellingFill, 'a late spelling note does not rewrite Understood as');
  assert.equal(src.includes('await get(`/api/creators/${f.creator}`)'), false);
  assert.equal(src.includes('await understand(f.raw)'), false);
});

test('Explore drops a late Narrow-with relatedRail fill after you leave', () => {
  const explore = fs.readFileSync(path.join(__dirname, '../public/js/views/explore.js'), 'utf8');
  const smart = fs.readFileSync(path.join(__dirname, '../public/js/smart.js'), 'utf8');
  const leftAt = explore.indexOf('let left = false;');
  const rail = explore.indexOf("relatedRail(focusTags, { onPick: addTag, title: 'Narrow with'");
  const alive = explore.indexOf('alive: () => !left', rail);
  const back = explore.indexOf('return () => {\n    left = true;');
  assert.ok(leftAt > 0 && leftAt < rail && rail < alive && alive < back, 'Narrow with passes alive from Explore’s left flag');
  const ask = smart.indexOf("get('/api/tags/related'");
  const guard = smart.indexOf('if (!alive()) return;', ask);
  const fill = smart.indexOf('el.replaceChildren(h(\'span\', { class: \'rr-label\' }', ask);
  assert.ok(ask > 0 && guard > ask && guard < fill, 'a late related list does not paint Narrow with after you leave');
  assert.equal(smart.includes('await get(\'/api/tags/related\''), false);
});

test('Explore drops a late findRelaxation navigate or empty prompt after you leave', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/explore.js'), 'utf8');
  const leftAt = src.indexOf('let left = false;');
  const onEmpty = src.indexOf('async function onEmpty()');
  const ask = src.indexOf('await findRelaxation(f, toApi, { creatorName })', onEmpty);
  const guard = src.indexOf('if (left || !r) return;', ask);
  const nav = src.indexOf("navigate('/explore', { ...f, ...r.patch, relaxed: r.label, from }", ask);
  const btn = src.indexOf('emptyHost.append(h(\'button\'', ask);
  const back = src.indexOf('return () => {\n    left = true;');
  assert.ok(leftAt > 0 && leftAt < onEmpty && onEmpty < ask, 'left is marked before relaxation probes');
  assert.ok(ask > 0 && guard > ask && guard < nav && nav < btn && btn < back, 'a late relaxation does not navigate or append after you leave');
  assert.equal(src.includes('if (!r || !root.isConnected) return;'), false);
});

test('a creator profile hands back cleanup before the profile returns', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/creator.js'), 'utf8');
  const bone = src.indexOf("style: { height: '220px' }");
  const back = src.indexOf('return stop;');
  const waitAt = src.indexOf('await profileP');
  const painted = src.indexOf('root.replaceChildren(stage,');
  assert.ok(bone > 0 && bone < back && back < waitAt, 'the header skeleton is up, and cleanup is returned, before the profile is awaited');
  assert.ok(src.indexOf('if (left) return') < painted, 'a late profile does not replace a page you have left');
  assert.match(src, /const art = \(c\.previews && c\.previews\[0\]\) \|\| c\.banner_url/);
});

test('browse paints sources, communities, and tags before topics and paid counts', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/browse.js'), 'utf8');
  const started = src.indexOf('const topicsP = topicCards({ limit: 12 }).catch(() => null)');
  const waited = src.indexOf('await Promise.all([tagsP, communitiesP, platformsP])');
  const painted = src.indexOf("h('h2', null, icon('tag'), 'Tags')");
  const paid = src.indexOf('Promise.all([ofCreatorsP, ofPostsP, fanslyP])');
  const topics = src.indexOf('topicsP.then(');
  assert.ok(started > 0 && waited > started, 'topics start before the catalog is awaited');
  assert.ok(src.indexOf("get('/api/creators', { onlyfans: '1', limit: 1 })") < waited);
  assert.ok(painted > waited, 'the tag cloud is built after the catalog returns, not after topics');
  assert.ok(paid > painted && topics > painted, 'paid tiles and topics fill in after the shell is painted');
  assert.ok(src.includes('if (!paidHold.isConnected) return'));
  assert.ok(src.includes('if (!topicHold.isConnected) return'));
  const fail = src.indexOf("title: 'Couldn’t load'");
  assert.ok(fail > waited && fail < painted, 'a catalog failure replaces the page; a later topic or count failure does not');
  const back = src.indexOf('return stop;');
  assert.ok(src.indexOf("style: { height: '320px' }") < back && back < waited, 'cleanup is returned before the catalog is awaited');
  assert.ok(src.indexOf('if (left) return') < fail, 'a late failure does not replace the skeleton after you leave');
  const empty = src.indexOf("title: 'Nothing ingested yet'");
  assert.ok(src.lastIndexOf('if (left) return', empty) > waited && src.lastIndexOf('if (left) return', empty) < empty, 'an empty library does not replace a page you have left');
  assert.ok(src.lastIndexOf('if (left) return', painted) < painted, 'a late catalog does not replace a page you have left');
});

test('the creators grid shows skeletons until the first page replaces them', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/creators.js'), 'utf8');
  const bones = src.indexOf("class: 'creator-grid', 'aria-busy': 'true'");
  const waited = src.indexOf("await get('/api/creators', params)");
  const swapped = src.indexOf('if (firstPage) { grid.replaceChildren(...cards); grid.removeAttribute(\'aria-busy\'); }');
  assert.ok(bones > 0 && bones < waited, 'skeletons are in the grid before the first page is awaited');
  assert.ok(swapped > waited, 'the first page replaces the skeletons');
  assert.ok(src.includes('if (page === 0) { grid.replaceChildren(); grid.removeAttribute(\'aria-busy\'); }'));
  const guard = src.indexOf('if (destroyed) return;');
  const stop = src.indexOf('const stop = () => { destroyed = true; io.disconnect();');
  const started = src.indexOf('load().then(');
  const back = src.indexOf('return stop;');
  assert.ok(guard > waited && guard < swapped, 'a late page does not replace the grid after you leave');
  assert.ok(src.includes('if (destroyed) return;\n      if (page === 0)'), 'a late failure does not clear the skeletons after you leave');
  assert.ok(stop > waited && stop < started && started < back, 'cleanup is returned before the first page is awaited');
  assert.equal(src.includes('await load()'), false);
});

test('reels shows one skeleton slide until the first real slide arrives', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/reels.js'), 'utf8');
  const made = src.indexOf("const reelBone = () => h('section', { class: 'reel skeleton reel-bone', 'aria-hidden': 'true' })");
  const painted = src.indexOf('root.replaceChildren(shell)');
  const started = src.indexOf('load().then(');
  const dropped = src.indexOf('if (bone) { bone.remove(); bone = null; }');
  const slideAt = src.indexOf('const s = slide(it, slides.length)');
  assert.ok(made > 0 && made < painted && painted < started, 'the skeleton is in the track before the first page starts');
  const guard = src.indexOf('if (destroyed) return;');
  const stop = src.indexOf('const stop = () => {');
  const back = src.indexOf('return stop;');
  assert.ok(guard > 0 && guard < dropped, 'a late page does not replace the skeleton after you leave');
  assert.ok(src.includes('if (destroyed) return;\n      if (!slides.length)'), 'a late failure leaves the skeleton instead of painting an error you will not see');
  assert.ok(stop > painted && stop < started && started < back, 'cleanup, including the key handler, is returned before the first page is awaited');
  assert.equal(src.includes('await load()'), false);
  assert.ok(!src.slice(made, made + 120).includes('video'), 'the skeleton does not request a video');
  assert.ok(dropped > slideAt && dropped < src.indexOf('track.appendChild(s.el)'), 'the skeleton leaves as the first real slide is appended');
  const fail = src.indexOf("title: 'Couldn’t load reels'");
  assert.ok(fail > dropped, 'a failed first page still shows the existing error');
  assert.ok(src.includes('bone = reelBone(); track.replaceChildren(bone); load();'), 'try again puts the skeleton back before loading');
  assert.match(src, /track\.replaceChildren\(bone\); track\.scrollTop = 0/);
});

test('a deep-linked viewer shows the item before related returns', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/components/lightbox.js'), 'utf8');
  const started = src.indexOf('const relatedP = get(`/api/media/${id}/related`, { limit: 24 }).catch(() => [])');
  const item = src.indexOf('const item = await get(`/api/media/${id}`)');
  const shown = src.indexOf('show(0);');
  const waited = src.indexOf('const related = await relatedP');
  assert.ok(started > 0 && started < item && item < shown && shown < waited, 'related starts first, and the item is shown before that list is awaited');
  assert.ok(src.includes('S.openSeq !== seq'), 'a newer open does not take the late related list');
  const share = src.indexOf('relWait.set(id, relatedP)');
  const stripWait = src.indexOf('else if (relWait.has(it.id))');
  const second = src.indexOf('get(`/api/media/${it.id}/related`, { limit: 9 })');
  assert.ok(share > started && share < shown, 'the strip can see the sequence request before the item is shown');
  assert.ok(stripWait > 0 && stripWait < second, 'a waiting sequence list is used before a second related request');
  assert.ok(src.includes('if (relCache.has(it.id)) return'));
  assert.ok(src.includes('.slice(0, 9)'));
});

test('the viewer asks once for a creator’s recent posts', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/components/lightbox.js'), 'utf8');
  const gets = src.match(/get\(`\/api\/creators\/\$\{[^}]+}\/media`/g) || [];
  assert.deepEqual(gets, ['get(`/api/creators/${id}/media`']);
  assert.ok(src.includes('if (hit && hit.pending) return hit.pending'));
  assert.ok(src.includes('creatorPosts(it.creator_id)'));
  assert.equal((src.match(/creatorPosts\(it\.creator_id\)/g) || []).length, 2);
});

test('resume ignores a clip that just started, already finished, or is too short', () => {
  assert.equal(policy.resumeAt(1, 40), 0);
  assert.equal(policy.resumeAt(38, 40), 0);
  assert.equal(policy.resumeAt(12, 5), 0);
  assert.equal(policy.resumeAt(12, 40), 12);
  assert.equal(policy.keepProgress(12, 40), true);
  assert.equal(policy.keepProgress(1, 40), false);
});

test('import keeps the newer resume point and drops one older than 21 days', () => {
  const now = Date.now();
  const merged = policy.mergeResume(
    [{ id: 'a', t: 10, d: 40, at: now - 1000 }, { id: 'c', t: 9, d: 40, at: now - 2000 }],
    [{ id: 'a', t: 20, d: 40, at: now }, { id: 'b', t: 8, d: 30, at: now - 22 * 86400000 }, { id: 'bad', t: 'x' }],
    now,
  );
  assert.equal(merged.find((p) => p.id === 'a').t, 20);
  assert.equal(merged.some((p) => p.id === 'b' || p.id === 'bad'), false);
  assert.equal(policy.mergeResume([{ id: 'a', t: 15, d: 40, at: now }], [{ id: 'a', t: 5, d: 40, at: now - 5000 }], now)[0].t, 15);
  const store = fs.readFileSync(path.join(__dirname, '../public/js/store.js'), 'utf8');
  assert.match(store, /playback: playback\.list\(\)/);
  assert.match(store, /mergeResume\(plays, data\.playback\)/);
});

test('the review queue pages a mixed backlog instead of stopping at the newest 60', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/admin/moderation.js'), 'utf8');
  assert.match(src, /adminGet\('\/moderation\/queue', filterQuery\(\)\)/);
  assert.match(src, /pager\(\{ page: r\.page, limit: r\.limit \|\| PAGE, total: r\.total/);
  assert.ok(src.includes('if (!r.items.length && page > 0 && (r.total || 0) > 0)'), 'an empty later page steps back after a clear');
});

test('the review queue can filter by hold kind or one named reason', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/admin/moderation.js'), 'utf8');
  assert.ok(src.includes("q.reason = reason"), 'named reason is sent to the queue');
  assert.ok(src.includes('q.kind = kind'), 'hold kind is sent to the queue');
  assert.match(src, /Filter by named hold reason/);
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
  assert.match(route, /reviewReason: reason/);
  assert.match(route, /reviewKind: kind/);
});

test('find drops a late lookup and does not open a profile after you leave', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/find.js'), 'utf8');
  const paint = src.indexOf('function paint()');
  const lookup = src.indexOf("await post('/api/lookup'");
  const follow = src.indexOf("await post('/api/lookup/follow'");
  const nav = src.indexOf('if (!left) navigate(`/creator/${r.creator.id}`)');
  const back = src.indexOf('return stop;');
  assert.ok(paint > 0 && src.slice(paint, paint + 40).includes('if (left) return'), 'paint does nothing once you have left');
  assert.ok(lookup > 0 && src.indexOf('if (left) return', lookup) > lookup && src.indexOf('if (left) return', lookup) < follow, 'a late lookup does not paint');
  assert.ok(follow > 0 && nav > follow, 'a follow that finishes after you leave does not navigate');
  assert.ok(src.includes('if (openTimer) clearTimeout(openTimer)'), 'leaving cancels the profile open');
  assert.ok(back > nav && !src.includes('return () => {}'), 'the router receives a stop, not an empty cleanup');
});

test('a grid item omits the caption; the single-item shape keeps it', () => {
  const { publicMedia } = require('../src/routes/public');
  const row = {
    id: 'm', title: 't', description: 'a long caption that grids do not need', media_type: 'image',
    media_url: 'https://a/b.jpg', preview_url: null, thumbnail_url: null, hls_url: null, has_audio: false,
    width: 10, height: 10, duration: null, platform: 'reddit', community: null, author: 'a', source_url: 'https://a',
    score: 1, likes: 0, views: 0, nsfw_level: null, posted_at: '2026-01-01', creator_id: null,
    creator_handle: null, creator_name: null, creator_avatar: null, tags: [], position: 0, post_key: 'k',
  };
  const brief = publicMedia(row, { brief: true });
  assert.equal('description' in brief, false);
  assert.equal(publicMedia(row).description, row.description);
  assert.equal(brief.title, 't');
  assert.equal(brief.media_url, row.media_url);
});

describe('Server-Timing', () => {
  let server; let base;
  before(async () => {
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { if (server) await new Promise((r) => server.close(r)); });

  test('an API response names how long the server spent', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('server-timing') || '', /^app;dur=\d+(\.\d+)?$/);
  });
});
