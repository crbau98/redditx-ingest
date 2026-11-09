'use strict';
/**
 * Phase 0: nothing in PRISM attributes content, pages or accounts to a creator because a picture LOOKS like his.
 *  - image match (engine/imagematch.js) keeps only the same-picture (pHash) check, and registers a page as his only if the
 *    page also names him; a look-alike (high visual similarity, far hash) attributes nothing and never even reads a vector;
 *  - "More like this" and "Guys with a similar look" (engine/visual.js) stay, as read-only recommendations: nothing there
 *    writes to a creator, feed or media row, and nothing that attributes imports it;
 *  - the schema migration retracts what the look-alike path had attributed (feeds disabled, items hidden, one audit entry);
 *  - Reddit is switched off by default in tests (setting redditEnabled) and a switched-off Reddit feed is skipped, never a failure.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv, start } = require('./helpers/mock');

let mock; let discovery; let lookup; let repo; let registry; let engine; let breaker; let settingsStore; let imagematch; let brave; let imagefilter; let web; let schema;
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const REF = 'ffffffffffffffffffffffffffffffff';
const NEAR = 'fffffffffffffffffffffffffffffffe'; // 1 bit from REF: the very same picture
const FAR = '00000000000000000000000000000000';  // 128 bits from REF: a different picture, however similar it looks
const state = { hits: [], phash: FAR, embedCalls: 0, analyzed: 0 };
const orig = {};

before(async () => {
  // One counting mock answers as every Reddit host (www, old, OAuth, archive): whatever reaches it is a request Reddit would have got.
  mock = await start({});
  prepareEnv({ REDDIT_BASE_URL: mock.url, REDDIT_OAUTH_URL: mock.url, REDDIT_ARCHIVE_URL: mock.url, REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret' });
  repo = require('../src/db/repo');
  registry = require('../src/sources');
  engine = require('../src/engine/engine');
  breaker = require('../src/engine/breaker');
  settingsStore = require('../src/settings');
  imagematch = require('../src/engine/imagematch');
  brave = require('../src/lib/brave');
  imagefilter = require('../src/lib/imagefilter');
  web = require('../src/sources/web');
  schema = require('../src/db/schema');
  discovery = require('../src/engine/discovery');
  lookup = require('../src/engine/lookup');
  Object.assign(orig, { images: brave.images, analyze: imagefilter.analyze, embedUrl: imagefilter.embedUrl, robots: web.robotsAllows });
  brave.images = async () => state.hits;
  imagefilter.analyze = async () => { state.analyzed++; return { status: 'ok', phash: state.phash }; };
  // If anything still asks for a visual vector, this records it, and hands back a vector identical to his: the worst case.
  imagefilter.embedUrl = async () => { state.embedCalls++; return { status: 'ok', vec: Buffer.alloc(260, 1) }; };
  web.robotsAllows = async () => true;
});
after(() => { Object.assign(brave, { images: orig.images }); Object.assign(imagefilter, { analyze: orig.analyze, embedUrl: orig.embedUrl }); web.robotsAllows = orig.robots; engine.shutdown(); return mock.close(); });
beforeEach(() => { Object.assign(state, { hits: [], phash: FAR, embedCalls: 0, analyzed: 0 }); });

let n = 0;
function creatorWithPictures(handle, displayName) {
  const c = repo.creators.create({ handle, displayName, origin: 'admin' });
  for (let i = 0; i < 2; i++) {
    n++;
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: `p0-${n}`, source_key: `reddit:p0-${n}:0`, post_key: `reddit:p0-${n}`, media_type: 'image', media_url: `https://i.example.test/p0-${n}.jpg`, hash: `p0hash${n}`, phash: REF });
  }
  return repo.creators.get(c.id);
}
const hit = (page, title = '') => ({ pageUrl: page, imageUrl: `${page}/pic.jpg`, title, description: '' });
const imageMatchActions = (creatorId) => repo.db.prepare("SELECT reason FROM moderation_actions WHERE action = 'image-match' AND target_id = ?").all(creatorId);

describe('image match: the same picture, never a look-alike', () => {
  test('a look-alike alone (hash far, vector identical, page names him) attributes nothing and reads no vector', async () => {
    const c = creatorWithPictures('zed_lookalike', 'Zed Lookalike');
    state.phash = FAR;
    state.hits = [hit('https://gallery.example.test/zed-lookalike-pics', 'Zed Lookalike pictures')];
    const out = await imagematch.matchCreator(c, { budget: 40 });
    assert.equal(state.analyzed, 1, 'the picture was hashed');
    assert.equal(state.embedCalls, 0, 'no visual vector was ever requested');
    assert.deepEqual(out, { checked: 1, matched: 0, pages: 0, pictures: 0, cbir: 0 }); // cbir: reverse-image rows, all 0 here
    assert.ok(!repo.feeds.find('web', 'page', 'https://gallery.example.test/zed-lookalike-pics'), 'no feed was registered');
    assert.equal(imageMatchActions(c.id).length, 0, 'and nothing was logged as an attribution');
  });

  test('the same picture on a page that names him: the page is registered, the picture gets its "also posted on" source', async () => {
    const c = creatorWithPictures('zed_samepic', 'Zed Samepic');
    state.phash = NEAR;
    state.hits = [hit('https://gallery.example.test/zed-samepic-gallery', 'Zed Samepic on a gallery')];
    const out = await imagematch.matchCreator(c, { budget: 40 });
    assert.equal(out.pictures, 1);
    assert.equal(out.pages, 1);
    assert.equal(state.embedCalls, 0);
    const f = repo.feeds.find('web', 'page', 'https://gallery.example.test/zed-samepic-gallery');
    assert.ok(f && f.creator_id === c.id, 'registered as his');
    const acts = imageMatchActions(c.id);
    assert.equal(acts.length, 1);
    assert.match(acts[0].reason, /^same picture \(1 bits\), page names him/);
    assert.ok(!/look-alike/.test(acts[0].reason));
  });

  test('the same picture on a page that does NOT name him is noted on the picture but the page does not become his', async () => {
    const c = creatorWithPictures('zed_hosted', 'Zed Hosted');
    state.phash = NEAR;
    state.hits = [hit('https://aggregator.example.test/random-gallery', 'Hot pictures, all models')];
    const out = await imagematch.matchCreator(c, { budget: 40 });
    assert.equal(out.pictures, 1, 'the repost of his file is recorded');
    assert.equal(out.pages, 0);
    assert.ok(!repo.feeds.find('web', 'page', 'https://aggregator.example.test/random-gallery'), 'a gallery that hosts a copy of one of his files is not his');
  });

  test('a different picture on a page that names him is still not his', async () => {
    const c = creatorWithPictures('zed_named', 'Zed Named');
    state.phash = FAR;
    state.hits = [hit('https://gallery.example.test/zed-named-fanpage', 'Zed Named fan page')];
    const out = await imagematch.matchCreator(c, { budget: 40 });
    assert.deepEqual([out.matched, out.pages, out.pictures], [0, 0, 0]);
  });
});

describe('no code path attributes by visual similarity', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
  // (phash.js has a DCT cosine and web.js reads schema.org's embedUrl property: neither is a visual vector, so match calls and definitions, not words)
  const VISUAL = /\bembedUrl\s*(?:\(|=[^=])|embeddings'|media_embeddings|engine\/visual|require\('\.\/visual'\)/;
  const COSINE = /cosine|\bcos\(/;

  test('the only files that request or store visual vectors are the vector store, the image worker plumbing and the read-only display routes', () => {
    const users = walk(SRC).filter((f) => VISUAL.test(code(f))).map(rel).sort();
    // db/repo.js and db/schema.js only DELETE embeddings, to purge removed items (takedown, block, migration v22);
    // they never read a vector or write one. routes/admin.js only reads visual.status() — the row COUNTS for the
    // admin console, never a vector, never an attribution.
    assert.deepEqual(users, ['db/repo.js', 'db/schema.js', 'engine/visual.js', 'lib/imagefilter-core.js', 'lib/imagefilter.js', 'routes/admin.js', 'routes/public.js']);
  });

  test('every module that attributes or follows anything is free of visual-similarity code', () => {
    for (const f of ['engine/imagematch.js', 'engine/identity.js', 'engine/lookup.js', 'engine/discovery.js', 'engine/creators.js', 'engine/ai.js', 'services/targets.js', 'engine/engine.js', 'lib/links.js']) {
      assert.ok(!VISUAL.test(code(path.join(SRC, f))), `${f} does not use visual similarity`);
    }
    assert.ok(!/similarity/i.test(code(path.join(SRC, 'engine', 'imagematch.js'))), 'imagematch.js has no similarity threshold');
    assert.ok(!COSINE.test(code(path.join(SRC, 'engine', 'imagematch.js'))), 'and no cosine');
  });

  test('visual.js ("More like this") writes only its own vector table: no creator, feed or media row, no attribution', () => {
    const src = code(path.join(SRC, 'engine', 'visual.js'));
    const writes = [...src.matchAll(/\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)].map((m) => m[2]).filter((t) => t.toUpperCase() !== 'SET'); // "DO UPDATE SET" is part of an upsert
    assert.ok(writes.length > 0);
    assert.ok(writes.every((t) => t === 'media_embeddings'), `writes: ${writes.join(', ')}`);
    assert.ok(!/repo\.(feeds|creators|identity|candidates)\.\w+\(/.test(src.replace(/repo\.(feeds|creators)\.(get|list|find)\w*\(/g, '')), 'no repo mutation call');
  });

  test('the public routes only READ it: similar(), similarCreators() for display and the read-only index warm-up', () => {
    const uses = [...code(path.join(SRC, 'routes', 'public.js')).matchAll(/require\('\.\.\/engine\/visual'\)\.(\w+)/g)].map((m) => m[1]).sort();
    // warmIndex: the boot warm-up builds the same in-memory index once, read-only (no writes, no attribution)
    assert.deepEqual([...new Set(uses)], ['similar', 'similarCreators', 'warmIndex']);
  });

  test('the look-alike setting and its admin control are gone', () => {
    assert.ok(!('imageMatchSimilarity' in settingsStore.get()), 'not a setting any more');
    assert.ok(!/imageMatchSimilarity/.test(code(path.join(SRC, 'settings.js'))));
    assert.ok(!/imageMatchSimilarity/.test(fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'admin', 'discovery.js'), 'utf8')));
  });
});

describe('migration v18: what the look-alike path attributed is retracted, except what the creator names himself', () => {
  test('look-alike feeds are disabled and their items hidden; same-picture feeds are untouched; each gets an audit entry', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (let i = 0; i < 17; i++) schema.MIGRATIONS[i](db);
    db.pragma('user_version = 17');
    const creator = (id) => db.prepare("INSERT INTO creators (id, handle, display_name, scope, origin) VALUES (?, ?, ?, 'in', 'admin')").run(id, id, id);
    const feed = (id, platform, kind, target, origin, cid) => db.prepare('INSERT INTO feeds (id, platform, kind, target, label, creator_id, enabled, trusted, origin, interval_min, priority) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 180, 0)').run(id, platform, kind, target, target, cid, origin);
    const item = (id, feedId, cid, state = 'published') => db.prepare("INSERT INTO media (id, creator_id, feed_id, platform, source_id, source_key, post_key, position, media_type, media_url, hash, nsfw_level, scope, publish_state, posted_at) VALUES (?, ?, ?, 'web', ?, ?, ?, 0, 'image', ?, ?, 'explicit', 'in', ?, '2026-01-01T00:00:00.000Z')").run(id, cid, feedId, id, `web:${id}:0`, `web:${id}`, `https://x.test/${id}.jpg`, `h-${id}`, state);
    const act = (cid, reason) => db.prepare("INSERT INTO moderation_actions (target_type, target_id, action, reason, actor) VALUES ('creator', ?, 'image-match', ?, 'discovery')").run(cid, reason);
    creator('c1'); creator('c2');
    feed('f-web', 'web', 'page', 'https://gallery.example.test/look', 'discovered', 'c1');
    feed('f-bsky', 'bluesky', 'user', 'lookalike.bsky.social', 'discovered', 'c1');
    feed('f-same', 'web', 'page', 'https://gallery.example.test/same', 'discovered', 'c2');
    feed('f-admin', 'web', 'page', 'https://gallery.example.test/look2', 'admin', 'c2'); // named in a look-alike log line, but followed by an admin: not ours to touch
    item('i-web', 'f-web', 'c1'); item('i-web-review', 'f-web', 'c1', 'review'); item('i-bsky', 'f-bsky', 'c1'); item('i-same', 'f-same', 'c2'); item('i-admin', 'f-admin', 'c2');
    act('c1', 'look-alike (71%) → https://gallery.example.test/look');
    act('c1', 'look-alike (66%) → https://bsky.app/profile/lookalike.bsky.social');
    act('c2', 'same picture (2 bits) → https://gallery.example.test/same');
    act('c2', 'look-alike (64%) → https://gallery.example.test/look2');

    schema.MIGRATIONS[17](db);

    const en = (id) => db.prepare('SELECT enabled FROM feeds WHERE id = ?').get(id).enabled;
    const st = (id) => db.prepare('SELECT publish_state, review_reason FROM media WHERE id = ?').get(id);
    assert.equal(en('f-web'), 0); assert.equal(en('f-bsky'), 0);
    assert.equal(en('f-same'), 1, 'a same-picture feed stays'); assert.equal(en('f-admin'), 1, 'an admin\'s own feed stays');
    for (const id of ['i-web', 'i-web-review', 'i-bsky']) assert.deepEqual(st(id), { publish_state: 'hidden', review_reason: 'look-alike attribution retracted' }, id);
    assert.equal(st('i-same').publish_state, 'published'); assert.equal(st('i-admin').publish_state, 'published');
    const audit = db.prepare("SELECT target_id, reason, actor FROM moderation_actions WHERE action = 'imagematch-retract'").all();
    assert.equal(audit.length, 2);
    assert.ok(audit.every((a) => a.target_id === 'c1' && a.actor === 'migration' && /look-alike attribution removed/.test(a.reason)));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE publish_state = 'hidden'").get().n, 3, 'hidden, not deleted: an admin can restore them');
    db.close();
  });

  // A tiny database at schema 17 with one creator per case, a discovered feed, an item, and a look-alike log line.
  function fixture() {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (let i = 0; i < 17; i++) schema.MIGRATIONS[i](db);
    db.pragma('user_version = 17');
    let n = 0;
    return {
      db,
      /** a creator (bio / links / bio_source / alias / identity evidence as given) with ONE look-alike feed and ONE item */
      add({ platform, kind = 'user', target, url, bio = null, links = [], bioSource = null, alias = null, identity = null, enabled = 1 }) {
        n++; const cid = `c${n}`; const fid = `f${n}`;
        db.prepare("INSERT INTO creators (id, handle, display_name, scope, origin, bio, links, bio_source) VALUES (?, ?, ?, 'in', 'admin', ?, ?, ?)").run(cid, cid, cid, bio, JSON.stringify(links), bioSource);
        db.prepare("INSERT INTO feeds (id, platform, kind, target, label, creator_id, enabled, trusted, origin, interval_min, priority) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'discovered', 180, 0)").run(fid, platform, kind, target, target, cid, enabled);
        db.prepare("INSERT INTO media (id, creator_id, feed_id, platform, source_id, source_key, post_key, position, media_type, media_url, hash, nsfw_level, scope, publish_state, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'image', ?, ?, 'explicit', 'in', 'published', '2026-01-01T00:00:00.000Z')").run(`i${n}`, cid, fid, platform, `i${n}`, `${platform}:i${n}:0`, `${platform}:i${n}`, `https://x.test/i${n}.jpg`, `h${n}`);
        db.prepare("INSERT INTO moderation_actions (target_type, target_id, action, reason, actor) VALUES ('creator', ?, 'image-match', ?, 'discovery')").run(cid, `look-alike (70%) → ${url}`);
        if (alias) db.prepare("INSERT INTO creator_aliases (creator_id, norm, alias, kind, source) VALUES (?, ?, ?, 'handle', ?)").run(cid, require('../src/lib/alias').normAlias(target), target, alias);
        if (identity) {
          db.prepare("INSERT INTO creators (id, handle, display_name, scope, origin) VALUES (?, ?, ?, 'in', 'admin')").run(`o${n}`, `o${n}`, `o${n}`);
          const [a, b] = cid < `o${n}` ? [cid, `o${n}`] : [`o${n}`, cid];
          db.prepare('INSERT INTO identity_links (a_id, b_id, evidence, strength, status) VALUES (?, ?, ?, 2, ?)').run(a, b, JSON.stringify([{ type: 'bio-link', detail: `x:@${target}` }]), identity);
        }
        return { cid, fid, iid: `i${n}` };
      },
      state: (x) => ({ enabled: db.prepare('SELECT enabled FROM feeds WHERE id = ?').get(x.fid).enabled, item: db.prepare('SELECT publish_state FROM media WHERE id = ?').get(x.iid).publish_state }),
      audit: (x, action) => db.prepare('SELECT reason FROM moderation_actions WHERE target_id = ? AND action = ?').all(x.cid, action).map((r) => r.reason),
      run: () => schema.MIGRATIONS[17](db),
    };
  }

  test('a feed the creator names himself is KEPT, with an audit row: his links list, his bio, a bio-claimed alias, an identity link', () => {
    const F = fixture();
    const links = F.add({ platform: 'x', target: 'SamHolister', url: 'https://x.com/SamHolister', links: [{ url: 'https://twitter.com/SamHolister', label: 'X' }] });
    const sameHandle = F.add({ platform: 'x', target: 'SamHolister2', url: 'https://x.com/SamHolister2', links: [{ url: 'https://justfor.fans/samholister2' }] }); // his own JFF page has the same handle
    const bio = F.add({ platform: 'tumblr', target: 'yournewdadxxx', url: 'https://www.tumblr.com/yournewdadxxx', bio: 'Soft Dom top Daddy. Much more at http://justfor.fans/yournewdadxxx' });
    const alias = F.add({ platform: 'x', target: 'lowkeyboy_', url: 'https://x.com/lowkeyboy_', alias: 'bio' });
    const identity = F.add({ platform: 'x', target: 'Monsterbait', url: 'https://x.com/Monsterbait', identity: 'pending' });
    const stranger = F.add({ platform: 'x', target: 'RandomGuy', url: 'https://x.com/RandomGuy', bio: 'nothing about it', links: [{ url: 'https://instagram.com/someoneelse' }] });
    F.run();
    for (const [name, c, why] of [['links', links, 'links'], ['same handle on another platform in his links', sameHandle, 'links'], ['bio', bio, 'bio'], ['alias', alias, 'alias'], ['identity', identity, 'identity']]) {
      assert.deepEqual(F.state(c), { enabled: 1, item: 'published' }, `${name}: kept`);
      const kept = F.audit(c, 'imagematch-keep');
      assert.equal(kept.length, 1, name);
      assert.match(kept[0], new RegExp(`^kept: self-declared \\(${why}\\)`), name);
      assert.equal(F.audit(c, 'imagematch-retract').length, 0, name);
    }
    assert.deepEqual(F.state(stranger), { enabled: 0, item: 'hidden' }, 'nothing of his names it: retracted');
    assert.equal(F.audit(stranger, 'imagematch-retract').length, 1);
  });

  test('"different people" is not self-declared; a bio read from this feed\'s own platform is not either', () => {
    const F = fixture();
    const rejected = F.add({ platform: 'x', target: 'NotHim', url: 'https://x.com/NotHim', identity: 'rejected' });
    const circular = F.add({ platform: 'x', target: 'CircularGuy', url: 'https://x.com/CircularGuy', bio: 'find me: CircularGuy', bioSource: 'x' }); // the bio came from an X profile: possibly this very feed
    const other = F.add({ platform: 'x', target: 'OtherSource', url: 'https://x.com/OtherSource', bio: 'find me: OtherSource', bioSource: 'bluesky' }); // read from Bluesky: his own words
    F.run();
    assert.deepEqual(F.state(rejected), { enabled: 0, item: 'hidden' });
    assert.deepEqual(F.state(circular), { enabled: 0, item: 'hidden' }, 'not counted as self-declared');
    assert.deepEqual(F.state(other), { enabled: 1, item: 'published' });
  });

  test('re-running changes nothing: no new audit rows, and a feed an admin re-enabled is never disabled again', () => {
    const F = fixture();
    const gone = F.add({ platform: 'x', target: 'Gone1', url: 'https://x.com/Gone1' });
    const kept = F.add({ platform: 'x', target: 'Kept1', url: 'https://x.com/Kept1', links: [{ url: 'https://x.com/Kept1' }] });
    F.run();
    const total = () => F.db.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE action IN ('imagematch-retract', 'imagematch-keep')").get().n;
    assert.equal(total(), 2);
    // an admin restores the retracted feed and one of its items
    F.db.prepare('UPDATE feeds SET enabled = 1 WHERE id = ?').run(gone.fid);
    F.db.prepare("UPDATE media SET publish_state = 'published' WHERE id = ?").run(gone.iid);
    F.run(); F.run();
    assert.equal(total(), 2, 'no audit rows added');
    assert.deepEqual(F.state(gone), { enabled: 1, item: 'published' }, 'the admin\'s decision stands');
    assert.deepEqual(F.state(kept), { enabled: 1, item: 'published' });
  });

  test('a look-alike feed that was ALREADY disabled for another reason still has its items hidden', () => {
    const F = fixture();
    const off = F.add({ platform: 'x', target: 'AlreadyOff', url: 'https://x.com/AlreadyOff', enabled: 0 });
    F.run();
    assert.deepEqual(F.state(off), { enabled: 0, item: 'hidden' });
    assert.equal(F.audit(off, 'imagematch-retract').length, 1);
  });

  test('a database with no look-alike history migrates untouched', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (let i = 0; i < 18; i++) schema.MIGRATIONS[i](db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM moderation_actions WHERE action IN ('imagematch-retract', 'imagematch-keep')").get().n, 0);
    db.close();
  });
});

describe('schema: v17 is the Telegram migration, v18 is the look-alike retraction', () => {
  test('v17 (telegram_text, creators.bio_source) is idempotent and v18 builds on it', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    for (let i = 0; i < 16; i++) schema.MIGRATIONS[i](db);
    schema.MIGRATIONS[16](db); schema.MIGRATIONS[16](db); // twice: idempotent
    assert.ok(db.prepare('PRAGMA table_info(creators)').all().some((c) => c.name === 'bio_source'));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'telegram_text'").get());
    assert.ok(schema.MIGRATIONS.length >= 23, 'v17 and v18 sit at indexes 16 and 17; later migrations are appended');
    db.close();
  });
});

describe('Reddit: switched off by default, reversible, never a failure', () => {
  const reddit = () => registry.get('reddit');
  after(() => settingsStore.update({ redditEnabled: false }));

  test('the setting exists, is off by default, and a switched-off Reddit reports "not configured" with the reason', () => {
    assert.equal(settingsStore.get().redditEnabled, false);
    for (const kind of ['user', 'community']) {
      const c = reddit().isConfigured(kind);
      assert.equal(c.ok, false);
      assert.match(c.note, /switched off.*redditEnabled/);
    }
  });

  test('a Reddit feed is skipped by the engine: no failure count, no breaker damage, no request', async () => {
    breaker.reset();
    const f = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'phase0_user', origin: 'admin', runNow: false }).feed;
    const r = await engine.runFeed(f, 'schedule');
    assert.equal(r.status, 'skipped');
    const row = repo.feeds.get(f.id);
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.last_status, 'skipped');
    assert.match(row.last_error, /redditEnabled/);
    assert.equal(row.enabled, 1, 'nothing is deleted or disabled: the feed just waits');
    assert.equal((breaker.snapshot().reddit || { failures: 0 }).failures, 0);
  });

  test('OFF means ZERO requests on every path: feed runs, profile reads, discovery searches, mention search, Find lookups, even the OAuth token', async () => {
    settingsStore.update({ redditEnabled: false });
    breaker.reset();
    const start0 = mock.hits.length;
    const reddit = registry.get('reddit');
    const community = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'phase0_sub', origin: 'admin', runNow: false }).feed;
    const user = repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'phase0_user2', origin: 'admin', runNow: false }).feed;
    for (let i = 0; i < 3; i++) { await engine.runFeed(community, 'schedule'); await engine.runFeed(user, 'manual'); }
    for (const feed of [community, user]) {
      for (const cursor of [{}, { newestAt: '2026-01-01T00:00:00.000Z' }]) {
        await assert.rejects(reddit.fetch(feed, { cursor, limit: 25, force: true, needProfile: true, aborted: () => false }), (e) => e.skip === true && /switched off/.test(e.message));
      }
    }
    assert.deepEqual(await reddit.searchSubreddits('gay fitness', 25), []);
    assert.deepEqual(await reddit.searchPosts('"someone" OR "x"', 15), []);
    // discovery's community search and a Find lookup, with every OTHER network call stubbed so only Reddit is being counted
    const restore = [];
    const stub = (obj, key, fn) => { restore.push([obj, key, obj[key]]); obj[key] = fn; };
    try {
      stub(registry.get('bluesky'), 'searchFeeds', async () => []);
      stub(registry.get('bluesky'), 'searchActors', async () => []);
      stub(registry.get('redgifs'), 'searchCreators', async () => []);
      stub(require('../src/lib/websearch'), 'search', async () => { const r = []; Object.defineProperty(r, 'provider', { value: 'fake' }); return r; });
      stub(require('../src/lib/websearch'), 'configured', () => true);
      for (const a of registry.list()) if (a.platform !== 'reddit') stub(a, 'fetch', async () => { throw Object.assign(new Error('not found'), { status: 404 }); });
      await discovery.communityDiscovery({ keywords: 2 });
      const found = await lookup.lookup('u/phase0_probe');
      assert.ok(found, 'a Find lookup still answers');
    } finally { for (const [obj, key, fn] of restore.reverse()) obj[key] = fn; }
    assert.equal(mock.hits.length - start0, 0, `requests that reached Reddit while off: ${JSON.stringify(mock.hits.slice(start0, start0 + 5))}`);
    const row = repo.feeds.get(community.id);
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.last_status, 'skipped');
  });

  test('discovery reaches Reddit only through the two guarded functions (the mention search at discovery.js:1136 and the community search)', () => {
    const src = fs.readFileSync(path.join(SRC, 'engine', 'discovery.js'), 'utf8');
    const calls = [...src.matchAll(/\breddit\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(calls.length >= 2);
    // parsePost is a pure row mapper: it turns an already-fetched row into media items and never touches the network
    // (asserted below). The archive fetch in redditPosters() is a third-party archive, gated on the Reddit switch.
    assert.ok(calls.every((c) => c === 'searchSubreddits' || c === 'searchPosts' || c === 'parsePost'), `discovery calls reddit.${[...new Set(calls)].join(', reddit.')}`);
    assert.ok(!/reddit\.com\/(?:r|user|search)/.test(src.replace(/'site:reddit\.com'/g, '')), 'and builds no Reddit URL of its own');
    const reddit = fs.readFileSync(path.join(SRC, 'sources', 'reddit.js'), 'utf8');
    for (const fn of ['searchSubreddits', 'searchPosts']) assert.match(reddit, new RegExp(`async function ${fn}\\([^)]*\\) \\{\\n  if \\(!enabled\\(\\)\\) return`), `${fn} checks the switch first`);
    const parseBody = reddit.slice(reddit.indexOf('function parsePost('), reddit.indexOf('function fromRssEntry('));
    assert.ok(!/\b(await|fetch|viaOauth|viaJson|viaRss|viaArchive)\b/.test(parseBody), 'parsePost never reaches the network');
  });

  test('the same calls DO reach Reddit once it is switched on (so the zero above is the switch, not a dead mock)', async () => {
    settingsStore.update({ redditEnabled: true });
    try {
      const before = mock.hits.length;
      await registry.get('reddit').searchSubreddits('gay fitness', 25).catch(() => {});
      await registry.get('reddit').searchPosts('"someone"', 15).catch(() => {});
      assert.ok(mock.hits.length > before, 'requests were made');
    } finally { settingsStore.update({ redditEnabled: false }); }
  });

  test('turning the setting on brings it back, and off again switches it off', () => {
    settingsStore.update({ redditEnabled: true });
    assert.equal(reddit().isConfigured('user').ok, true);
    settingsStore.update({ redditEnabled: false });
    assert.equal(reddit().isConfigured('user').ok, false);
  });
});
