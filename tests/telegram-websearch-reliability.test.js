'use strict';
/**
 * Backend reliability track: Telegram ingestion + web search failure surfacing.
 * Covers each fix without touching lawful scope gates.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let websearch; let brave; let keenable; let tg; let mt; let repo;
const hits = { brave: 0, searx: 0, keen: 0 };
const mode = { brave: 'ok', searx: 'ok', keen: 'ok' };

before(async () => {
  mock = await start({
    '/res/v1/web/search': (req) => {
      hits.brave++;
      if (mode.brave === 'rejected') return { status: 403, json: {} };
      if (mode.brave === 'invalid') return { status: 422, json: {} };
      if (mode.brave === 'empty') return { json: { web: { results: [] } } };
      return { json: { web: { results: [{ url: 'https://x.com/a', title: 'A', description: 'brave' }] } } };
    },
    '/search': () => {
      hits.searx++;
      if (mode.searx === 'empty') return { json: { results: [] } };
      if (mode.searx === 'down') return { status: 500, body: 'down' };
      return { json: { results: [{ url: 'https://bsky.app/profile/a.bsky.social', title: 'A', content: 'searx' }] } };
    },
    '/mcp': (req) => {
      hits.keen++;
      if (mode.keen === 'unauthorized') return { status: 401, json: { error: 'bad' } };
      if (mode.keen === 'empty') return { json: { result: { content: [{ type: 'text', text: 'Title: nothing\nSnippets:\nnothing' }] } } };
      return { json: { result: { content: [{ type: 'text', text: 'Title: T\nURL: https://example.com/x\nAcquired: 2026-01-01\nSnippets:\nhello world\n\n---\n\nTitle: T2\nURL: https://example.com/y\nSnippets:\nsecond' }] } } };
    },
  });
  prepareEnv({
    BRAVE_BASE_URL: mock.url, BRAVE_API_KEY: 'k', SEARXNG_URL: mock.url,
    KEENABLE_BASE_URL: `${mock.url}/mcp`, KEENABLE_API_KEY: 'kk',
    SEARCH_PROVIDERS: 'keenable,brave,searxng',
  });
  websearch = require('../src/lib/websearch');
  brave = require('../src/lib/brave');
  keenable = require('../src/lib/keenable');
  tg = require('../src/sources/telegram');
  mt = require('../src/lib/telegram-mtproto');
  repo = require('../src/db/repo');
});
after(async () => { mt._setFactory(null); await mock.close(); });

describe('telegram preview parsing', () => {
  test('parseCount handles grouped thousands', () => {
    assert.equal(tg.parseCount('1,234'), 1234);
    assert.equal(tg.parseCount('12 345'), 12345);
    assert.equal(tg.parseCount('1.2K'), 1200);
    assert.equal(tg.parseCount('3M'), 3000000);
    assert.equal(tg.parseCount('abc'), 0);
  });

  test('document thumbnails and lazy video sources are collected', () => {
    const html = `<div class="tgme_widget_message" data-post="c/1">
      <div class="tgme_widget_message_document_wrap"><img src="https://cdn.example.com/doc-thumb.jpg"></div>
      <a class="tgme_widget_message_date" href="https://t.me/c/1"><time datetime="2026-10-12T10:00:00+00:00"></time></a></div>
      <div class="tgme_widget_message" data-post="c/2">
      <a class="tgme_widget_message_video_player"><video data-src="https://cdn.example.com/lazy.mp4"></video></a>
      <a class="tgme_widget_message_date" href="https://t.me/c/2"><time datetime="2026-10-12T11:00:00+00:00"></time></a></div>`;
    const r = tg.parsePage(html, 'c');
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0].media[0].url, 'https://cdn.example.com/doc-thumb.jpg');
    assert.equal(r.messages[1].media[0].url, 'https://cdn.example.com/lazy.mp4');
  });
});

describe('telegram mtproto cursor/notes/materialization', () => {
  test('skip reasons surface as feed notes (not a silent empty success)', async () => {
    const big = { id: 9, message: 'big clip', date: 1700000009, views: 10, media: { className: 'MessageMediaDocument', document: { className: 'Document', mimeType: 'video/mp4', size: 500 * 1024 * 1024, thumbs: [], attributes: [{ className: 'DocumentAttributeVideo', w: 10, h: 10 }] } } };
    const client = {
      async getEntity() { return { id: 77, username: 'chanx', title: 'Chan X' }; },
      async getMessages() { return [big]; },
      async downloadMedia() { return Buffer.alloc(10); },
      async invoke() { return { fullChat: {} }; },
      async downloadProfilePhoto() { return null; },
    };
    mt._setFactory(async () => client);
    const feed = { target: 'chanx', label: 'Chan X', trusted: 1 };
    const r = await tg.fetchChannel(feed, { limit: 40, cursor: {}, aborted: () => false });
    assert.equal(r.items.length, 0);
    assert.ok(r.notes.some((n) => /skipped 1 video larger than/i.test(n)), JSON.stringify(r.notes));
    assert.ok(r.skipped && Object.keys(r.skipped).length === 1);
    mt._setFactory(null);
  });

  test('a failed video thumbnail stage is retried during materialize', async () => {
    const calls = [];
    const msg = { id: 42, message: 'clip', date: 1700000042, views: 5, media: { className: 'MessageMediaDocument', document: { className: 'Document', mimeType: 'video/mp4', size: 100, thumbs: [{ className: 'PhotoSize', w: 10, h: 10 }], attributes: [{ className: 'DocumentAttributeVideo', w: 10, h: 10 }] } } };
    const fakeMt = require('../src/lib/telegram-mtproto');
    const d = fakeMt.describeMedia(msg);
    assert.equal(d.type, 'video');
    let thumbTries = 0;
    const origFactory = null;
    const client = {
      async downloadMedia(m, o = {}) {
        calls.push(o);
        if ('thumb' in o) { thumbTries++; if (thumbTries === 1) throw new Error('transient'); return Buffer.alloc(50, 7); }
        if (o.outputFile) { require('fs').writeFileSync(o.outputFile, Buffer.alloc(100, 8)); return o.outputFile; }
        return Buffer.alloc(100, 8);
      },
    };
    fakeMt._setFactory(async () => client);
    const store = require('../src/lib/objectstore');
    const ch = { id: '999', username: 'retrychan', title: 'Retry', target: 'retrychan', trusted: true };
    const item = tg.messageToItem(msg, d, ch);
    const it = {};
    await item.stage(it); // thumb fails transiently: must not permanently drop the poster
    const hasPosterKey = `tg/999/42-t.jpg`;
    try { await store.remove(`tg/999/42.mp4`); await store.remove(hasPosterKey); } catch { /* clean */ }
    await item.materialize(it);
    assert.equal(thumbTries, 2, 'materialize retried the thumbnail');
    assert.ok(it.previewUrl && it.previewUrl.includes('42-t.jpg'));
    await item.discard();
    fakeMt._setFactory(origFactory);
  });

  test('private-channel targets resolve as numeric peers', async () => {
    let seen = null;
    const client = {
      async getDialogs() { return []; },
      async getEntity(ref) { seen = ref; return { id: 200, username: null, title: 'Secret' }; },
    };
    mt._setFactory(async () => client);
    await mt.entityOf('id:200');
    assert.equal(seen, 200, 'numeric id passed as a number');
    mt._setFactory(null);
  });
});

describe('websearch fallback/budgets/caching', () => {
  test('budget exhaustion is surfaced in provider health', async () => {
    websearch._clear();
    mode.brave = 'ok'; mode.searx = 'ok'; mode.keen = 'ok';
    repo.settings.set('brave.usage', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 99, total: 99 }));
    repo.settings.set('keenable.usage', JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 99, total: 99 }));
    const r = await websearch.search('budget surfacing q', { budget: 1 });
    assert.equal(r.provider, 'searxng');
    const st = websearch.status();
    const b = st.providers.find((p) => p.name === 'brave');
    const k = st.providers.find((p) => p.name === 'keenable');
    assert.match(b.lastError || '', /budget/i);
    assert.match(k.lastError || '', /budget/i);
    repo.settings.set('brave.usage', '{}'); repo.settings.set('keenable.usage', '{}');
  });

  test('an empty last provider throws instead of caching emptiness', async () => {
    websearch._clear();
    mode.keen = 'empty'; mode.brave = 'empty'; mode.searx = 'empty';
    await assert.rejects(() => websearch.search('all empty q', { fresh: true }), /no results/);
    mode.keen = 'ok'; mode.brave = 'ok'; mode.searx = 'ok';
    const r = await websearch.search('all empty q', { fresh: true });
    assert.ok(r.length > 0, 'recovery after empty is not stuck behind a cached empty answer');
  });

  test('onion SearXNG without TOR_PROXY explains itself', async () => {
    const config = require('../src/config');
    const savedUrl = config.searxngUrl; const savedTor = config.torProxy; const savedProviders = config.searchProviders;
    config.searxngUrl = 'http://example1234567890.onion'; config.torProxy = ''; config.searchProviders = ['searxng'];
    websearch._clear();
    await assert.rejects(() => websearch.search('onion q', { fresh: true }), /TOR_PROXY/);
    Object.assign(config, { searxngUrl: savedUrl, torProxy: savedTor, searchProviders: savedProviders });
  });
});

describe('brave + keenable accounting', () => {
  test('a rejected key does not burn the daily budget; success does', async () => {
    repo.settings.set('brave.usage', '{}');
    mode.brave = 'rejected';
    await assert.rejects(() => brave.search('q-rej'), (e) => e.skip === true);
    assert.equal(brave.usage().count, 0, '401/403 must not consume budget');
    mode.brave = 'ok';
    await brave.search('q-ok');
    assert.equal(brave.usage().count, 1);
    repo.settings.set('brave.usage', '{}');
  });

  test('HTTP 422 is a bad query, not a bad key', async () => {
    mode.brave = 'invalid';
    await assert.rejects(() => brave.search('q-422'), (e) => e.status === 422 && !e.skip && /invalid parameters/i.test(e.message));
    mode.brave = 'ok';
  });

  test('keenable rejects without spending budget; parses tolerant blocks', async () => {
    repo.settings.set('keenable.usage', '{}');
    mode.keen = 'unauthorized';
    await assert.rejects(() => keenable.search('q'), (e) => e.skip === true);
    assert.equal(keenable.usage().count, 0);
    mode.keen = 'ok';
    await keenable.search('q2');
    assert.equal(keenable.usage().count, 1);
    const out = keenable.parseResults('  Title: Spaced\n  URL: https://example.com/s\n  Snippets:\n  hi there');
    assert.equal(out[0].url, 'https://example.com/s');
    repo.settings.set('keenable.usage', '{}');
  });
});
