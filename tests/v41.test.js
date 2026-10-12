'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let backup; let portability; let telegram;
const AGE = { cookie: 'prism_age=1' };
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, json, text };
};
const pub = (p, o = {}) => call(p, { ...o, headers: { ...AGE, ...(o.headers || {}) } });
const adm = (p, o = {}) => call(`/api/admin${p}`, { ...o, headers: { ...ADMIN, ...(o.headers || {}) } });

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  portability = require('../src/services/portability'); telegram = require('../src/sources/telegram');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });

let n = 0;
const post = (cr, tags, extra = {}) => {
  n++;
  const id = repo.media.insert({ creator_id: cr.id, platform: 'reddit', source_id: `v${n}`, source_key: `reddit:v${n}:0`, post_key: `reddit:v${n}`, community: 'v41sub', author: cr.handle, title: `v41 item ${n}`, media_type: 'image', media_url: `https://i.redd.it/v${n}.jpg`, hash: `v41h${n}`, ...extra }, tags);
  repo.creators.refreshStats(cr.id); return id;
};

describe('Telegram adapter', () => {
  const html = `<html><body><div class="tgme_channel_info"><div class="tgme_channel_info_header"><div class="tgme_channel_info_header_title"><span>Zed Channel</span></div></div><div class="tgme_channel_info_description">Model. <a href="https://x.com/zedtg">x</a> <a href="https://onlyfans.com/zedtg">of</a></div></div>
  <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="zedchan/101"><div class="tgme_widget_message_bubble">
    <a class="tgme_widget_message_photo_wrap" href="https://t.me/zedchan/101" style="width:453px;background-image:url('https://cdn4.telesco.pe/file/photo101.jpg')"></a>
    <div class="tgme_widget_message_text">Gym day</div>
    <div class="tgme_widget_message_footer"><span class="tgme_widget_message_views">1.2K</span><a class="tgme_widget_message_date" href="https://t.me/zedchan/101"><time datetime="2026-10-05T10:00:00+00:00">10:00</time></a></div></div></div></div>
  <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="zedchan/102"><div class="tgme_widget_message_bubble">
    <a class="tgme_widget_message_video_player" href="https://t.me/zedchan/102"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn4.telesco.pe/file/thumb102.jpg')"></i><video src="https://cdn4.telesco.pe/file/clip102.mp4"></video><time class="message_video_duration">1:05</time></a>
    <div class="tgme_widget_message_footer"><span class="tgme_widget_message_views">3M</span><a class="tgme_widget_message_date" href="https://t.me/zedchan/102"><time datetime="2026-10-06T10:00:00+00:00">10:00</time></a></div></div></div></div>
  <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="zedchan/103"><div class="tgme_widget_message_text">text only</div></div></div></body></html>`;
  test('parses photos, videos, captions, views, dates and the channel profile', () => {
    const r = telegram.parsePage(html, 'zedchan');
    assert.equal(r.messages.length, 2, 'text-only posts are skipped');
    const [p, v] = r.messages;
    assert.equal(p.media[0].url, 'https://cdn4.telesco.pe/file/photo101.jpg'); assert.equal(p.text, 'Gym day'); assert.equal(p.views, 1200); assert.equal(p.date, '2026-10-05T10:00:00.000Z');
    assert.equal(v.media[0].type, 'video'); assert.equal(v.media[0].duration, 65); assert.equal(v.media[0].preview, 'https://cdn4.telesco.pe/file/thumb102.jpg'); assert.equal(v.views, 3000000);
    assert.equal(r.profile.displayName, 'Zed Channel');
    assert.deepEqual(r.profile.links.map((l) => l.platform).sort(), ['external', 'x']);
    assert.equal(r.minId, 101);
    const items = telegram.toItems(v, 'zedchan');
    assert.equal(items[0].sourceId, 'zedchan/102'); assert.equal(items[0].author, 'zedchan'); assert.equal(items[0].trusted, true);
  });
  test('a page with no channel markup is reported as unavailable, not as an empty feed', () => {
    assert.equal(telegram.parsePage('<html><body>Redirected</body></html>', 'x').hasChannel, false);
    assert.equal(telegram.parseCount('2.5K'), 2500); assert.equal(telegram.parseCount('abc'), 0);
  });
});

describe('discovery endpoints', () => {
  test('following filter returns only the requested creators and is validated', async () => {
    const a = repo.creators.create({ handle: 'fol_a' }); const b = repo.creators.create({ handle: 'fol_b' });
    const ia = post(a, ['beach']); post(b, ['beach']);
    const r = await pub(`/api/media?creators=${a.id},not-a-uuid`);
    assert.equal(r.json.total, 1); assert.equal(r.json.items[0].id, ia);
    assert.equal((await pub('/api/media?creators=garbage')).json.total, 0, 'a list with no valid ids matches nothing rather than everything');
  });
  test('similar creators rank by shared rare tags, exclude the creator, and hide non-public ones', async () => {
    const me = repo.creators.create({ handle: 'sim_me' }); const twin = repo.creators.create({ handle: 'sim_twin' }); const other = repo.creators.create({ handle: 'sim_other' }); const hidden = repo.creators.create({ handle: 'sim_hidden' });
    post(me, ['zebra-stripes', 'common-tag']); post(twin, ['zebra-stripes', 'common-tag']); post(other, ['common-tag']); post(hidden, ['zebra-stripes']);
    repo.creators.update(hidden.id, { status: 'hidden' });
    const r = await pub(`/api/creators/${me.id}/similar`);
    assert.equal(r.status, 200);
    const handles = r.json.map((c) => c.handle);
    assert.equal(handles[0], 'sim_twin'); assert.ok(!handles.includes('sim_me') && !handles.includes('sim_hidden'));
    assert.ok(!('status' in r.json[0]), 'public shape');
    assert.equal((await pub('/api/creators/00000000-0000-0000-0000-000000000000/similar')).status, 404);
  });
  test('suggest returns creators, tags and communities and survives hostile input', async () => {
    const c = repo.creators.create({ handle: 'suggestme', display_name: 'Suggest Me' }); post(c, ['suggest-tag']);
    const r = (await pub('/api/suggest?q=sugg')).json;
    assert.ok(r.creators.some((x) => x.handle === 'suggestme')); assert.ok(r.tags.some((t) => t.name === 'suggest-tag'));
    assert.ok((await pub('/api/suggest?q=v41')).json.communities.some((x) => x.name === 'v41sub'));
    for (const q of ['%', '_', '\\', "'; DROP TABLE media;--", '"', '']) assert.equal((await pub(`/api/suggest?q=${encodeURIComponent(q)}`)).status, 200, q);
    assert.deepEqual((await pub('/api/suggest?q=%25')).json.creators, [], 'a % is literal, not a wildcard');
    assert.equal((await call('/api/suggest?q=x')).status, 403, 'age gated');
  });
});

describe('tag lists', () => {
  test('platform names are never offered as tags (the source filter already covers them)', async () => {
    const c = repo.creators.create({ handle: 'tagfilter' }); post(c, ['reddit', 'redgifs', 'real-style-tag']);
    const names = (await pub('/api/tags?limit=200')).json.map((t) => t.name);
    assert.ok(names.includes('real-style-tag')); assert.ok(!names.includes('reddit') && !names.includes('redgifs'));
    assert.ok(!(await pub('/api/suggest?q=red')).json.tags.some((t) => t.name === 'reddit'));
    assert.ok(!(await pub('/api/discover')).json.tags.some((t) => t.name === 'reddit'));
    assert.equal(repo.media.list({ tag: 'reddit' }).total > 0, true, 'but the tag still works as a filter for existing links');
  });
});

describe('backups', () => {
  test('writes a consistent copy that opens as a valid database, and prunes old ones', () => {
    for (const f of backup.list()) fs.unlinkSync(`${backup.dir()}/${f.name}`);
    const Database = require('better-sqlite3');
    const first = backup.run();
    assert.ok(first.size > 0);
    const copy = new Database(`${backup.dir()}/${first.name}`, { readonly: true });
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(copy.prepare('SELECT COUNT(*) n FROM creators').get().n >= 1);
    copy.close();
    repo.settings.set('backupKeep', '2');
    for (let i = 0; i < 3; i++) {
      fs.copyFileSync(`${backup.dir()}/${first.name}`, `${backup.dir()}/prism-20200101-00000${i}.db`);
    }
    backup.run();
    assert.equal(backup.list().length, 2, 'keeps only the newest N');
    assert.ok(!backup.list().some((b) => b.name.includes('2020')) || backup.list()[0].name > 'prism-2021', 'newest first');
  });
  test('admin API lists and creates backups', async () => {
    const before = (await adm('/backups')).json;
    assert.ok(Array.isArray(before.items));
    assert.equal((await adm('/backups', { method: 'POST' })).status, 201);
    assert.equal((await call('/api/admin/backups')).status, 401);
  });
});

describe('config export / import', () => {
  test('round-trips creators, feeds and the blocklist; import is idempotent and additive', async () => {
    const c = (await adm('/creators', { method: 'POST', body: { name: 'Portable', inputs: 'https://x.com/portablex u/portablered https://onlyfans.com/portable' } })).json.creator;
    repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'portablesub', origin: 'admin' });
    repo.blocklist.add('creator', 'reddit:exportedblock', 'test');
    const exp = await adm('/export');
    assert.equal(exp.status, 200); assert.match(exp.headers.get('content-disposition'), /prism-config-.*\.json/);
    assert.equal(exp.json.format, 'prism-config');
    const ours = exp.json.creators.find((x) => x.handle === 'Portable');
    assert.ok(ours.links.some((l) => l.service === 'OnlyFans'));
    assert.ok(exp.json.feeds.some((f) => f.target === 'portablesub')); assert.ok(exp.json.blocklist.some((b) => b.value === 'reddit:exportedblock'));
    assert.ok(!JSON.stringify(exp.json).includes('test-key'), 'no secrets');

    // wipe, then import into the "new host"
    repo.creators.merge(c.id, c.id); // no-op guard
    repo.db.prepare('DELETE FROM feeds').run(); repo.db.prepare("DELETE FROM blocklist WHERE value = 'reddit:exportedblock'").run(); repo.db.prepare('DELETE FROM creators WHERE handle = ?').run('Portable');
    const imp = await adm('/import', { method: 'POST', body: exp.json });
    assert.equal(imp.status, 200); assert.ok(imp.json.creators.created >= 1); assert.ok(imp.json.feeds.created >= 3); assert.equal(imp.json.blocklist.added, 1);
    const restored = repo.creators.byAccount('x', 'portablex');
    assert.equal(restored.handle, 'Portable'); assert.ok(restored.links.some((l) => l.service === 'OnlyFans'));
    assert.equal(repo.feeds.find('reddit', 'community', 'portablesub').origin, 'import');
    assert.equal(repo.feeds.find('reddit', 'user', 'portablered').creator_id, restored.id, 'accounts re-attached to the same creator');
    const again = (await adm('/import', { method: 'POST', body: exp.json })).json;
    assert.equal(again.creators.created, 0); assert.equal(again.feeds.created, 0); assert.equal(again.blocklist.added, 0);
  });
  test('rejects foreign files, skips unknown platforms, refuses unsafe creators and blocklisted accounts', async () => {
    assert.equal((await adm('/import', { method: 'POST', body: { hello: 'world' } })).status, 400);
    const r = (await adm('/import', { method: 'POST', body: { format: 'prism-config', version: 1,
      creators: [{ ref: 'a', handle: 'safe_person' }, { ref: 'b', handle: 'im_16_lol_underage' }],
      feeds: [{ platform: 'nonesuch', kind: 'user', target: 'x' }, { platform: 'reddit', kind: 'user', target: 'safe_person', creatorRef: 'a' }, { platform: 'reddit', kind: 'user', target: 'exportedblock' }], blocklist: [{ type: 'nope', value: 'x' }] } })).json;
    assert.equal(r.creators.rejected, 1); assert.equal(r.feeds.skipped, 2); assert.equal(r.feeds.created, 1); assert.equal(r.blocklist.added, 0);
    assert.equal(repo.creators.byAccount('reddit', 'safe_person').handle, 'safe_person');
  });
  test('large config bodies are accepted on import only', async () => {
    const feeds = Array.from({ length: 12000 }, (_, i) => ({ platform: 'reddit', kind: 'community', target: `bulkimport${i}` }));
    assert.equal((await adm('/import', { method: 'POST', body: { format: 'prism-config', feeds } })).status, 200);
    const res = await fetch(`${base}/api/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(1.5 * 1024 * 1024) }) });
    assert.equal(res.status, 413, 'other endpoints keep the 1mb cap');
  });
});

describe('audit log and duplicates', () => {
  test('moderation actions are listed newest first with human-readable targets', async () => {
    const c = repo.creators.create({ handle: 'audited' }); const id = post(c, ['audit']);
    await adm(`/media/${id}/moderate`, { method: 'POST', body: { action: 'hide', reason: 'because' } });
    const r = (await adm('/audit?limit=5')).json;
    assert.equal(r.items[0].action, 'hide'); assert.equal(r.items[0].reason, 'because'); assert.equal(r.items[0].target_label, `v41 item ${n}`);
    assert.ok((await adm('/audit?type=creator')).json.items.every((x) => x.target_type === 'creator'));
  });
  test('probable duplicate creators are grouped across handle variants', async () => {
    repo.creators.create({ handle: 'Dup_Person' }); repo.creators.create({ handle: 'dup-person' }); repo.creators.create({ handle: 'dupperson_xo' });
    const groups = (await adm('/creators-duplicates')).json;
    const g = groups.find((x) => x.some((c) => c.handle === 'Dup_Person'));
    assert.ok(g && g.length === 3, JSON.stringify(groups.map((x) => x.map((c) => c.handle))));
    assert.ok(!groups.some((x) => x.some((c) => c.handle === 'sim_me')));
  });
});

describe('settings', () => {
  test('new backup settings are validated', async () => {
    const r = (await adm('/settings', { method: 'PUT', body: { backupKeep: 999, backupEnabled: 'yes' } })).json.values;
    assert.equal(r.backupKeep, 30); assert.equal(r.backupEnabled, true);
  });
});
