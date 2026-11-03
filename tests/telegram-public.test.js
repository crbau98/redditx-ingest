'use strict';
/** Telegram beyond joined channels: public channels by username, media into the bucket, budgets, approved joins, and no AI on Telegram content. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');
const { s3Server, ACCESS, SECRET, BUCKET } = require('./helpers/s3');

let s3; let mt; let tg; let repo; let tp; let aiguard; let llm; let targets; let settingsStore; let store; let registry;
const photoMsg = (id, text) => ({ id, message: text, date: 1700000000 + id, views: 400, forwards: 2, media: { className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: [{ className: 'PhotoSize', w: 1280, h: 960 }] } } });
const chan = (id, username, title, extra = {}) => ({ className: 'Channel', id, username, title, broadcast: true, participantsCount: 500, ...extra });

function fakeClient({ joined = [], publicChannels = [], messages = {}, search = {}, posts = {} }) {
  const calls = { search: [], posts: [], join: [], sent: [] };
  const all = () => [...joined, ...publicChannels];
  return {
    calls,
    async connect() {}, async checkAuthorization() { return true; }, async disconnect() {},
    async getDialogs() { return joined.map((e) => ({ entity: e, title: e.title })); },
    async getEntity(ref) { const e = all().find((x) => x.username === ref || String(x.id) === String(ref)); if (!e) throw Object.assign(new Error('x'), { errorMessage: 'USERNAME_NOT_OCCUPIED' }); return e; },
    async getMessages(entity, o = {}) { let l = (messages[String(entity.id)] || []).slice(); if (o.minId) l = l.filter((m) => m.id > o.minId); if (o.offsetId) l = l.filter((m) => m.id < o.offsetId); l.sort((a, b) => (o.reverse ? a.id - b.id : b.id - a.id)); return l.slice(0, o.limit || 100); },
    async downloadMedia(msg, o = {}) { const d = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, msg.id % 200)]); if (o.outputFile) { fs.writeFileSync(o.outputFile, d); return o.outputFile; } return d; },
    async downloadProfilePhoto() { return Buffer.alloc(300, 4); },
    async invoke() { return { fullChat: { about: 'official page of Rex Carter, links https://example.com/rex', participantsCount: 900 } }; },
    async searchChannels(q) { calls.search.push(q); return search[q] || []; },
    async searchPosts(tag) { calls.posts.push(tag); return posts[tag] || []; },
    async joinChannel(u) { calls.join.push(u); const e = publicChannels.find((x) => x.username === u); if (e) joined.push(e); return { id: String(e && e.id), username: u, title: e && e.title }; },
  };
}

before(async () => {
  s3 = await s3Server();
  prepareEnv({ MEDIA_STORE_ENDPOINT: s3.url, MEDIA_STORE_BUCKET: BUCKET, MEDIA_STORE_ACCESS_KEY_ID: ACCESS, MEDIA_STORE_SECRET_ACCESS_KEY: SECRET, MEDIA_STORE_PREFIX: 'prism/', TELEGRAM_MAX_MB: '1' });
  mt = require('../src/lib/telegram-mtproto'); tg = require('../src/sources/telegram'); repo = require('../src/db/repo');
  tp = require('../src/services/telegram-public'); aiguard = require('../src/lib/aiguard'); llm = require('../src/lib/llm');
  targets = require('../src/services/targets'); settingsStore = require('../src/settings'); store = require('../src/lib/objectstore'); registry = require('../src/sources');
});
after(async () => { mt._setFactory(null); await s3.close(); });

describe('public channels by username', () => {
  let client;
  before(() => {
    client = fakeClient({ joined: [chan(1, 'joinedone', 'Joined One')], publicChannels: [chan(50, 'adultpublic', 'Adult Public')], messages: { 50: [photoMsg(1, 'gym set one'), photoMsg(2, 'gym set two')] } });
    mt._setFactory(async () => client);
  });

  test('a t.me link the web preview cannot read becomes an MTProto channel feed by username (no join); bots and unready setups are left alone', () => {
    assert.equal(tp.ready(), true);
    const spec = registry.parseInput('https://t.me/adultpublic');
    assert.equal(spec.platform, 'telegram'); assert.equal(spec.kind, 'user');
    assert.deepEqual([tp.upgradeSpec(spec).kind, tp.upgradeSpec(spec).target], ['channel', 'adultpublic']);
    assert.equal(tp.upgradeSpec({ platform: 'telegram', kind: 'user', target: 'some_bot' }).kind, 'user', 'bots stay as they are');
    settingsStore.update({ telegramPublic: false });
    assert.equal(tp.upgradeSpec(spec).kind, 'user', 'switched off');
    settingsStore.update({ telegramPublic: true });
    const r = targets.addSpec(spec, { origin: 'admin' });
    assert.equal(r.status, 'created');
    assert.equal(r.feed.kind, 'channel'); assert.equal(r.feed.platform, 'telegram');
  });

  test('its media is copied into the object store (bucket) under the configured prefix, after the text gates accepted it', async () => {
    const feed = repo.feeds.find('telegram', 'channel', 'adultpublic');
    const got = await tg.fetch(feed, { limit: 40, cursor: {}, force: true, aborted: () => false });
    assert.equal(got.items.length, 2);
    assert.ok(![...s3.objects.keys()].some((k) => /\/tg\/50\/\d+\./.test(k)), 'no post media is stored until the pipeline asks (the channel avatar is)');
    for (const it of got.items) { await it.stage?.(it); await it.materialize(it); }
    const keys = [...s3.objects.keys()].sort();
    assert.ok(keys.some((k) => k === `/${BUCKET}/prism/tg/50/1.jpg`) && keys.some((k) => k === `/${BUCKET}/prism/tg/50/2.jpg`), keys.join(', '));
    console.log('bucket object keys:', keys.join(' '));
    assert.ok(got.items.every((i) => i.mediaUrl.includes('/tg/50/')));
  });

  test('searches are budgeted and an exact username needs a second sign before it is followed; leads are not followed', async () => {
    const c = repo.creators.create({ handle: 'rexcarter', displayName: 'Rex Carter', origin: 'admin' });
    client = fakeClient({ publicChannels: [chan(70, 'rexcarter', 'Rex Carter Official'), chan(71, 'rexcarter2', 'Other')], search: { rexcarter: [{ id: '70', username: 'rexcarter', title: 'Rex Carter Official', members: 900, kind: 'channel' }] },
      posts: { rexcarter: [{ id: '71', username: 'rexcarter2', title: 'Other', hits: 3 }] } });
    mt._setFactory(async () => client);
    settingsStore.update({ telegramSearchesPerDay: 3 });
    const r = await tp.lookupHandles(c.id, { force: true });
    assert.deepEqual(r.followed, ['rexcarter'], 'exact username, and the description names him');
    assert.ok(r.leads.some((l) => l.username === 'rexcarter2'), 'hashtag hit is only a lead');
    assert.ok(!repo.feeds.find('telegram', 'channel', 'rexcarter2'));
    assert.equal(repo.feeds.find('telegram', 'channel', 'rexcarter').creator_id, c.id);
    // budget: 3 per day in total (2 spent above)
    const again = await tp.lookupHandles(c.id, { force: true });
    assert.equal(again.searched, 1, 'only one search left today');
    const third = await tp.lookupHandles(c.id, { force: true });
    assert.equal(third.searched, 0); assert.match(String(third.skipped), /budget/);
    assert.equal(client.calls.search.length + client.calls.posts.length, 3, 'never more than the daily cap');
  });

  test('joins only from the approved list, one at a time, within the daily cap and spacing', async () => {
    client = fakeClient({ joined: [], publicChannels: [chan(80, 'approvedone', 'Approved One'), chan(81, 'notapproved', 'Not Approved')] });
    mt._setFactory(async () => client);
    repo.settings.set('tg_budget', JSON.stringify({ day: new Date().toISOString().slice(0, 10), searches: 0, joins: 0, lastJoinAt: 0 }));
    assert.equal((await tp.joinApproved()).joined, null, 'empty list joins nothing');
    settingsStore.update({ telegramApprovedJoins: '@approvedone\nhttps://t.me/approvedtwo', telegramJoinsPerDay: 2 });
    client.joined = client.joined || [];
    const first = await tp.joinApproved();
    assert.equal(first.joined, 'approvedone'); assert.deepEqual(client.calls.join, ['approvedone']);
    const second = await tp.joinApproved();
    assert.equal(second.joined, null); assert.match(second.reason, /2 h/);
    assert.ok(!client.calls.join.includes('notapproved'));
  });
});

describe('no AI on Telegram content (Telegram API Terms §1.5)', () => {
  test('text read from Telegram is dropped from AI requests, or the request is refused', async () => {
    const msg = { id: 5, text: 'Rex shares his workout schedule every single morning', media: [{ type: 'image', url: 'u', preview: 'u' }], date: null, views: 0, link: 'https://t.me/x/5' };
    tg.toItems(msg, 'gymchan', { displayName: 'Gym Channel Official', bio: 'the best gym channel in the world' });
    const input = { accounts: [{ id: 1, bio: 'Rex shares his workout schedule every single morning' }, { id: 2, bio: 'a bluesky bio that is unrelated' }, { id: 3, displayName: 'Gym Channel Official' }] };
    const out = aiguard.scrub(input, 'triage');
    assert.deepEqual(out.accounts.map((a) => a.id), [2], 'only the non-Telegram account is sent');
    assert.throws(() => aiguard.scrub({ accounts: [{ platform: 'telegram', bio: 'x' }] }, 'triage'), (e) => e.aiGuard && e.refusal);
    assert.throws(() => aiguard.scrub({ q: 'see https://t.me/somechan/123 for more' }, 'search'), (e) => e.aiGuard);
    await assert.rejects(llm.json('profiles', { system: 's', input: { creators: [{ bio: 'the best gym channel in the world' }] }, schema: {}, effort: 'low' }), (e) => e.aiGuard);
    await assert.rejects(require('../src/lib/claude').webSearch('the best gym channel in the world'), (e) => e.aiGuard);
  });

  test('the Telegram modules never import a model client, never send or post, and never touch media APIs of a hosted model', () => {
    for (const f of ['src/sources/telegram.js', 'src/lib/telegram-mtproto.js', 'src/lib/telegram-bot.js', 'src/services/telegram-sync.js', 'src/services/telegram-public.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!/require\(['"][./]*(?:lib\/)?(?:llm|claude|openai|ai)['"]\)/.test(code), `${f} imports a model client`);
      assert.ok(!/sendMessage|sendFile|SendMessage|SendMedia|EditMessage|forwardMessages|ForwardMessages|DeleteMessages|sendMessage/.test(code), `${f} sends or edits something`);
    }
    for (const f of ['src/lib/openai.js', 'src/lib/claude.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      assert.ok(!/image_url|input_image|"type":\s*"image"|type:\s*'image'/.test(code), `${f} sends images to a hosted model`);
    }
  });
});

/* ------------------------------------------------------------------ review fixes */
describe('follow rule: ownership, not a mention', () => {
  const names = ['rexcarter', 'rex carter'];
  test('only an ownership phrase next to his name counts; negations, fan pages and bare mentions do not', () => {
    for (const ok of ['official page of Rex Carter', "I'm @rexcarter, follow me", 'this is the official channel of rexcarter']) assert.equal(tp.claimsOwnership('', ok, names), true, ok);
    for (const bad of ['not affiliated with @rexcarter', 'fake @rexcarter channel', 'Rex Carter fan page. official updates', 'unofficial rexcarter archive', 'posts about @rexcarter and others', 'my channel. rexcarter is great']) assert.equal(tp.claimsOwnership('', bad, names), false, bad);
  });
  test('an exact-username channel that says "not affiliated with @handle" becomes a lead, not a feed', async () => {
    const c = repo.creators.create({ handle: 'maxfit', displayName: 'Max Fit', origin: 'admin' });
    const cl = fakeClient({ publicChannels: [chan(90, 'maxfit', 'Max Fit Archive')], search: { maxfit: [{ id: '90', username: 'maxfit', title: 'Max Fit Archive', members: 100, kind: 'channel' }] } });
    cl.invoke = async () => ({ fullChat: { about: 'not affiliated with @maxfit, just a fan page', participantsCount: 10 } });
    mt._setFactory(async () => cl);
    repo.settings.set('tg_budget', JSON.stringify({ day: new Date().toISOString().slice(0, 10), searches: 0, joins: 0, lastJoinAt: 0 }));
    settingsStore.update({ telegramSearchesPerDay: 12 });
    const r = await tp.lookupHandles(c.id, { force: true });
    assert.deepEqual(r.followed, []);
    assert.ok(r.leads.some((l) => l.username === 'maxfit'));
    assert.ok(!repo.feeds.find('telegram', 'channel', 'maxfit'));
  });
});

describe('the AI guard survives a restart', () => {
  test('text read from Telegram in one process is still refused by a brand-new process on the same database', () => {
    const { spawnSync } = require('child_process');
    const env = { ...process.env, DB_PATH: process.env.DB_PATH };
    const root = path.join(__dirname, '..');
    const bio = 'Channel for hairy gym guys and their daily workouts';
    // process 1: Telegram text is read (marked), and a creator bio is stored with its source
    const a = spawnSync(process.execPath, ['-e', `
      const g = require('./src/lib/aiguard'); const repo = require('./src/db/repo');
      g.mark(${JSON.stringify(bio)});
      const c = repo.creators.create({ handle: 'tgperson', displayName: 'TG Person', origin: 'admin' });
      repo.creators.enrich(c.id, { bio: 'bio read from a telegram channel, kept for later' });
      repo.db.prepare("UPDATE creators SET bio_source = 'telegram' WHERE id = ?").run(c.id);
    `], { cwd: root, env, encoding: 'utf8' });
    assert.equal(a.status, 0, a.stderr);
    // process 2: nothing registered in memory; the guard must still refuse
    const b = spawnSync(process.execPath, ['-e', `
      const g = require('./src/lib/aiguard');
      const out = {};
      out.direct = g.tainted(${JSON.stringify(bio)});
      out.embedded = g.tainted({ creators: [{ text: 'before ' + ${JSON.stringify(bio)} + ' after' }] });
      out.storedBio = g.tainted({ creators: [{ text: 'x bio read from a telegram channel, kept for later' }] });
      out.clean = g.tainted({ creators: [{ text: 'a bluesky bio with nothing from telegram in it' }] });
      process.stdout.write(JSON.stringify(out));
    `], { cwd: root, env, encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(JSON.parse(b.stdout.trim().split('\n').pop()), { direct: true, embedded: true, storedBio: true, clean: false });
  });
});
