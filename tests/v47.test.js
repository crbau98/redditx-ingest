'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine; let backup;
const AGE = { cookie: 'prism_age=1' };
const call = async (p, headers = AGE) => { const res = await fetch(`${base}${p}`, { headers }); return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }; };

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); await new Promise((r) => server.close(r)); });

describe('query performance guards (large library)', () => {
  let creators;
  before(() => {
    const tags = ['muscle', 'gym', 'beach', 'bear', 'twink', 'jock', 'beard', 'swim'];
    creators = Array.from({ length: 40 }, (_, i) => repo.creators.create({ handle: `perf_${i}` }));
    const ins = repo.db.transaction(() => {
      for (let i = 0; i < 6000; i++) {
        const c = creators[i % creators.length];
        repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: `p${i}`, source_key: `reddit:p${i}:0`, post_key: `reddit:p${i}`, title: `post ${tags[i % 8]} ${tags[(i * 3) % 8]}`,
          media_type: i % 3 ? 'image' : 'video', media_url: `https://i.redd.it/p${i}.jpg`, preview_url: `https://i.redd.it/p${i}p.jpg`, hash: `v47p${i}`, score: i % 997, community: `sub${i % 20}`,
          posted_at: new Date(Date.now() - i * 60000).toISOString() }, [tags[i % 8], tags[(i * 3) % 8]]);
      }
    });
    ins();
    for (const c of creators) repo.creators.refreshStats(c.id);
  });
  const timed = (fn) => { const t = Date.now(); const r = fn(); return { r, ms: Date.now() - t }; };
  test('full-text search with a total stays fast (no per-row MATCH)', () => {
    // The FTS join used to drive the COUNT from media and re-run MATCH per row: ~10 s at this size.
    const { r, ms } = timed(() => repo.media.list({ q: 'post muscle', limit: 36 }));
    assert.ok(r.total > 0 && r.items.length > 0);
    assert.ok(ms < 300, `search took ${ms} ms (the per-row MATCH plan takes ~1.4 s here)`);
    const { ms: ms2 } = timed(() => repo.media.list({ q: 'muscle', tag: 'gym', limit: 36 }));
    assert.ok(ms2 < 300, `search + tag took ${ms2} ms`);
  });
  test('listings return the same rows whichever index is used', () => {
    const recent = repo.media.list({ sort: 'recent', limit: 20 }).items.map((m) => m.posted_at);
    assert.deepEqual(recent, [...recent].sort().reverse(), 'newest first');
    const top = repo.media.list({ sort: 'top', limit: 20 }).items.map((m) => m.score);
    assert.deepEqual(top, [...top].sort((a, b) => b - a), 'highest score first');
    const tagged = repo.media.list({ tag: 'muscle', sort: 'recent', limit: 50 }).items;
    assert.ok(tagged.length === 50 && tagged.every((m) => /muscle/.test(m.title)));
    const oldest = repo.media.list({ sort: 'oldest', limit: 5 }).items.map((m) => m.posted_at);
    assert.deepEqual(oldest, [...oldest].sort(), 'oldest first');
  });
  test('totals refresh immediately after new content arrives', () => {
    const before = repo.media.list({ tag: 'swim', limit: 1 }).total;
    repo.media.insert({ creator_id: creators[0].id, platform: 'reddit', source_id: 'fresh', source_key: 'reddit:fresh:0', post_key: 'reddit:fresh', title: 'fresh swim', media_type: 'image', media_url: 'https://i.redd.it/fresh.jpg', hash: 'v47fresh' }, ['swim']);
    assert.equal(repo.media.list({ tag: 'swim', limit: 1 }).total, before + 1);
  });
  test('creator cards never preview off-topic (excluded) posts', () => {
    const c = repo.creators.create({ handle: 'card_scope' });
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: 'cs1', source_key: 'reddit:cs1:0', post_key: 'reddit:cs1', title: 't', media_type: 'image', media_url: 'https://i.redd.it/ok.jpg', preview_url: 'https://i.redd.it/okp.jpg', hash: 'v47cs1', score: 1 }, []);
    repo.media.insert({ creator_id: c.id, platform: 'reddit', source_id: 'cs2', source_key: 'reddit:cs2:0', post_key: 'reddit:cs2', title: 't', media_type: 'image', media_url: 'https://i.redd.it/hidden.jpg', preview_url: 'https://i.redd.it/hiddenp.jpg', hash: 'v47cs2', score: 999, scope: 'excluded' }, []);
    repo.creators.refreshStats(c.id);
    const card = repo.creators.list({ q: 'card_scope', limit: 5 }).items.find((x) => x.id === c.id);
    assert.ok(card);
    assert.ok(!JSON.stringify(card.previews).includes('hidden'), JSON.stringify(card.previews));
  });
  test('related tags, similar creators and autocomplete agree with the data', async () => {
    const sim = repo.creators.similar(creators[0].id);
    assert.ok(sim.length > 0 && !sim.some((x) => x.id === creators[0].id));
    const sug = await call('/api/suggest?q=mus');
    assert.deepEqual(sug.json.tags.map((t) => t.name), ['muscle']);
    assert.equal(sug.json.tags[0].count, 750); // every 8th post
  });
});

describe('app shell: versioned immutable assets + modulepreload', () => {
  test('the shell points at /v/<hash>/ and preloads the whole static module graph', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const m = html.match(/src="\/v\/([0-9a-f]{10})\/js\/main\.js"/);
    assert.ok(m, 'main.js is versioned');
    const ver = m[1];
    // the stylesheets arrive as one minified, immutable bundle
    assert.match(html, new RegExp(`href="/v/${ver}/css/bundle\\.css"`));
    assert.doesNotMatch(html, /href="[^"]*\/css\/(app|ux|v6)\.css"/);
    const css = await fetch(`${base}/v/${ver}/css/bundle.css`);
    assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/); assert.match(css.headers.get('cache-control'), /immutable/);
    const cssText = await css.text();
    assert.ok(!cssText.includes('/*') && cssText.includes('.appbar') && cssText.includes('.nav-ind'), 'minified, and carries all three sheets');
    const preloads = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((x) => x[1]);
    for (const mod of ['/js/main.js', '/js/dom.js', '/js/api.js', '/js/views/home.js', '/js/components/card.js']) assert.ok(preloads.includes(`/v/${ver}${mod}`), mod);
    assert.ok(!preloads.some((p) => p.includes('/views/admin/')), 'the admin console is not preloaded (dynamic import)');
    // deep links get the same shell
    assert.equal(await (await fetch(`${base}/creators`)).text(), html);
    // versioned assets are immutable; a module's relative imports resolve under the same prefix
    const js = await fetch(`${base}/v/${ver}/js/main.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control'), /immutable/);
    assert.match(await js.text(), /from '\.\/dom\.js'/);
    // an old version (tab open across a deploy) still loads, but revalidates
    const old = await fetch(`${base}/v/0000000000/js/dom.js`);
    assert.equal(old.status, 200); assert.equal(old.headers.get('cache-control'), 'no-cache');
    // unversioned paths keep working
    assert.equal((await fetch(`${base}/js/main.js`)).status, 200);
  });
  test('the version changes when a front-end file changes', () => {
    const assets = require('../src/lib/assets');
    const path = require('path'); const fs = require('fs'); const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-assets-'));
    fs.mkdirSync(path.join(dir, 'js')); fs.mkdirSync(path.join(dir, 'css'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<head><script type="module" src="/js/main.js"></script></head>');
    fs.writeFileSync(path.join(dir, 'js', 'main.js'), "import { a } from './a.js';\n");
    fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'css', 'app.css'), 'body{}');
    const one = assets.build(dir);
    assert.deepEqual(one.modules.sort(), ['/js/a.js', '/js/main.js']);
    fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'export const a = 2;\n');
    assert.notEqual(assets.build(dir).version, one.version);
  });
});

describe('CSS minifier', () => {
  const { minifyCss } = require('../src/lib/assets');
  test('drops comments and whitespace but never touches strings, url() or calc() operators', () => {
    const src = `/* top */\n.a ,\n .b  {\n  content: 'a, b  /* not a comment */';\n  width: calc(100% - 32px);\n  background: url('/x y.png') ;\n}\n@media (max-width: 600px) { .c { color: red; } }`;
    assert.equal(minifyCss(src), `.a,.b{content: 'a, b  /* not a comment */';width: calc(100% - 32px);background: url('/x y.png')}@media (max-width: 600px){.c{color: red}}`);
  });
});
