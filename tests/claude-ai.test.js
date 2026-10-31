'use strict';
/**
 * Claude integration (lib/claude.js, engine/ai.js) against a mock of the Anthropic Messages API, through the official SDK:
 * the request it sends (model, structured output, effort, prompt caching, refusal fallback), cost control (answer cache,
 * daily budget), refusals and rejected keys, and what PRISM does with the answers: search reading, discovery query
 * planning, candidate triage and web search. Nothing here reaches the real API.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let api; let server; let base; let repo; let engine; let claude; let ai; let settingsStore; let websearch;
const AGE = { cookie: 'prism_age=1' };
const pub = async (p) => { const res = await fetch(`${base}${p}`, { headers: AGE }); return { status: res.status, json: await res.json() }; };
const admin = async (p, body) => { const res = await fetch(`${base}${p}`, { method: body ? 'POST' : 'GET', headers: { 'x-admin-key': 'test-key', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, json: await res.json() }; };

// What the mock answers, by purpose (read from the system prompt). Each is a function of the request body.
const state = { requests: [], headers: [], status: 200, stop: 'end_turn', answers: {} };
const purposeOf = (body) => {
  const sys = (body.system || []).map((b) => b.text).join('\n');
  if (sys.includes('search box')) return 'search';
  if (sys.includes('plan web searches')) return 'queries';
  if (sys.includes('You review accounts')) return 'triage';
  if (sys.includes('web-search step')) return 'websearch';
  return 'other';
};
const message = (content, extra = {}) => ({ id: `msg_${state.requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: state.stop, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...extra });

before(async () => {
  api = await start({
    '/v1/messages': (req) => {
      const body = JSON.parse(req.bodyText);
      state.requests.push(body); state.headers.push(req.headers);
      if (state.status !== 200) return { status: state.status, json: { type: 'error', error: { type: state.status === 401 ? 'authentication_error' : 'rate_limit_error', message: 'nope' } } };
      const p = purposeOf(body);
      if (state.stop === 'refusal') return { json: message([], { stop_details: { type: 'refusal', category: 'general_harms', explanation: 'x' } }) };
      if (p === 'websearch') return { json: state.answers.websearch(body) };
      const answer = state.answers[p] ? state.answers[p](body) : {};
      return { json: message([{ type: 'text', text: JSON.stringify(answer) }]) };
    },
  });
  prepareEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: api.url, SEARCH_PROVIDERS: 'claude' });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  claude = require('../src/lib/claude');
  ai = require('../src/engine/ai');
  settingsStore = require('../src/settings');
  websearch = require('../src/lib/websearch');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); await api.close(); });
beforeEach(() => {
  state.requests.length = 0; state.headers.length = 0; state.status = 200; state.stop = 'end_turn';
  claude._reset(); websearch._clear();
  repo.settings.set('ai.usage', '{}');
  settingsStore.update({ aiSearch: true, aiDiscovery: true, aiDailyBudget: 300 });
});

let n = 0;
const post = (creator, tags, extra = {}) => {
  n++;
  const id = repo.media.insert({ creator_id: creator.id, platform: 'x', source_id: `ai${n}`, source_key: `x:ai${n}:0`, post_key: `x:ai${n}`, author: creator.handle,
    title: `post ${n}`, media_type: 'image', media_url: `https://pbs.twimg.com/ai${n}.jpg`, hash: `aih${n}`, ...extra }, tags);
  repo.creators.refreshStats(creator.id);
  return id;
};

describe('lib/claude: the request and its cost', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

  test('one structured request: model, JSON schema output, effort, cached system prompt, refusal fallback', async () => {
    state.answers.other = () => ({ ok: true });
    const r = await claude.json('probe', { system: 'You are a probe.', input: 'hello', schema, effort: 'low', maxTokens: 500 });
    assert.deepEqual(r, { ok: true });
    const body = state.requests[0];
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.max_tokens, 500);
    assert.deepEqual(body.output_config, { effort: 'low', format: { type: 'json_schema', schema } });
    assert.deepEqual(body.system, [{ type: 'text', text: 'You are a probe.', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.thinking, undefined, 'thinking is left to the model (adaptive); effort controls it');
    assert.match(String(state.headers[0]['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.ok(state.headers[0]['x-api-key'] === 'sk-ant-test' || state.headers[0].authorization === 'Bearer sk-ant-test', 'the key is sent as a credential header');
    assert.equal(claude.usage().calls, 1);
    assert.equal(claude.usage().input, 120);
  });

  test('the same question twice costs one request', async () => {
    state.answers.other = () => ({ ok: true });
    await claude.json('probe', { system: 'S', input: 'same', schema });
    await claude.json('probe', { system: 'S', input: 'same', schema });
    assert.equal(state.requests.length, 1);
  });

  test('the daily budget is a hard stop', async () => {
    state.answers.other = () => ({ ok: true });
    settingsStore.update({ aiDailyBudget: 1 });
    await claude.json('probe', { system: 'S', input: 'one', schema });
    await assert.rejects(claude.json('probe', { system: 'S', input: 'two', schema }), (e) => e.budget === true);
    assert.equal(state.requests.length, 1);
  });

  test('a refusal is an error the caller sees as "no answer", counted, never retried', async () => {
    state.stop = 'refusal';
    await assert.rejects(claude.json('probe', { system: 'S', input: 'x', schema }), (e) => e.refusal === true && /declined/.test(e.message));
    assert.equal(state.requests.length, 1);
    assert.equal(claude.usage().refusals, 1);
  });

  test('a rejected key is a quiet skip; the key never appears in the error', async () => {
    state.status = 401;
    await assert.rejects(claude.json('probe', { system: 'S', input: 'y', schema }), (e) => e.skip === true && /ANTHROPIC_API_KEY/.test(e.message) && !/sk-ant-test/.test(e.message));
  });

  test('admin status shows configuration and usage, never the key', async () => {
    const r = await admin('/api/admin/ai');
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true);
    assert.equal(r.json.model, 'claude-opus-5-5');
    assert.ok(!JSON.stringify(r.json).includes('sk-ant-test'));
  });
});

describe('AI search: words the rules cannot place', () => {
  const w = {};
  before(() => {
    w.a = repo.creators.create({ handle: 'trailrunner', displayName: 'Trail Runner' });
    w.b = repo.creators.create({ handle: 'deskguy', displayName: 'Desk Guy' });
    w.p1 = post(w.a, ['beard', 'outdoors'], { media_type: 'video' });
    w.p2 = post(w.a, ['beard', 'gym']);
    w.p3 = post(w.b, ['office', 'suit']);
  });

  test('Claude maps slang onto the library\'s tags; tags the library does not have are dropped', async () => {
    state.answers.search = () => ({ tags: ['beard', 'outdoors', 'lumberjack-core'], type: 'video', sort: '', since: '', platform: '', paid: '', athletic: false, creator: '', text: '', note: 'Bearded men outside, videos' });
    const r = await pub(`/api/understand/ai?q=${encodeURIComponent('rugged scruffy mountain dudes clips')}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ai.rewritten, '#beard #outdoors videos');
    assert.equal(r.json.ai.note, 'Bearded men outside, videos');
    assert.deepEqual(r.json.query.tags.split(','), ['beard', 'outdoors']);
    assert.equal(r.json.query.type, 'video');
    // the tag list it chose from is the library's own (in the cached system prompt), and the words went as the user turn
    const body = state.requests[0];
    assert.match(body.system[0].text, /TAG LIST:\n.*\bbeard\b/s);
    assert.equal(body.messages[0].content, 'rugged scruffy mountain dudes clips');
  });

  test('a search the rules fully understand never asks Claude', async () => {
    const r = await pub(`/api/understand/ai?q=${encodeURIComponent('beard gym')}`);
    assert.equal(r.json.ai, null);
    assert.deepEqual(r.json.query.tags.split(','), ['beard', 'gym']);
    assert.equal(state.requests.length, 0);
  });

  test('/api/search?ai=1 answers with Claude\'s reading when it finds something, and says so', async () => {
    state.answers.search = () => ({ tags: ['beard'], type: '', sort: '', since: '', platform: '', paid: '', athletic: false, creator: '', text: '', note: 'Bearded' });
    const r = await pub(`/api/search?ai=1&q=${encodeURIComponent('scruffy chin fuzz')}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ai.rewritten, '#beard');
    const ids = r.json.posts.items.map((x) => x.id).sort();
    assert.deepEqual(ids, [w.p1, w.p2].sort());
  });

  test('...and keeps the plain result when Claude\'s reading finds nothing', async () => {
    state.answers.search = () => ({ tags: [], type: '', sort: '', since: '', platform: '', paid: '', athletic: false, creator: '', text: 'zzzunknown', note: 'n/a' });
    const r = await pub(`/api/search?ai=1&q=${encodeURIComponent('qqqq wwww')}`);
    assert.equal(r.json.ai, null);
  });

  test('without ai=1, /api/search never calls Claude', async () => {
    await pub(`/api/search?q=${encodeURIComponent('scruffy chin fuzz')}`);
    assert.equal(state.requests.length, 0);
  });

  test('switched off, or out of budget: the rules answer alone', async () => {
    settingsStore.update({ aiSearch: false });
    let r = await pub(`/api/understand/ai?q=${encodeURIComponent('scruffy chin fuzz')}`);
    assert.equal(r.json.ai, null);
    settingsStore.update({ aiSearch: true, aiDailyBudget: 0 });
    r = await pub(`/api/understand/ai?q=${encodeURIComponent('scruffy chin fuzz')}`);
    assert.equal(r.json.ai, null);
    assert.equal(state.requests.length, 0);
    const meta = await pub('/api/meta');
    assert.equal(meta.json.ai.search, true);
  });

  test('rewrite() emits only syntax lib/query reads back as the same filters', () => {
    const vocab = require('../src/lib/query').buildVocabulary({ tags: [{ name: 'beard', count: 3 }, { name: 'locker-room', count: 2 }], creators: [], communities: [] });
    const s = ai.rewrite({ tags: ['locker-room', 'nope'], type: 'image', sort: 'top', since: 'week', platform: 'x', paid: 'fansly', athletic: true, creator: '', text: 'sweaty "towel"' }, vocab);
    assert.equal(s, '#locker-room photos best past week twitter on fansly athletic sweaty towel');
    const u = require('../src/lib/query').understand(s, vocab);
    assert.deepEqual([u.tags, u.type, u.sort, u.since, u.platform, u.paid, u.build, u.text], [['locker-room'], 'image', 'top', 'week', 'x', 'fansly', 'fit', 'sweaty towel']);
  });
});

describe('AI discovery: planned queries and triage', () => {
  test('plans new queries once a day, without repeating the admin\'s; discovery rotates through them', async () => {
    settingsStore.update({ discoveryQueries: 'gay muscle creator linktree' });
    state.answers.queries = () => ({ queries: ['gay muscle creator linktree', 'hairy bear creator bluesky', 'x', 'otter fitness allmylinks', 'hairy bear creator bluesky'] });
    const r = await ai.planQueries({ force: true });
    assert.equal(r.planned, 2);
    assert.deepEqual(ai.plannedQueries(), ['hairy bear creator bluesky', 'otter fitness allmylinks']);
    const again = await ai.planQueries();
    assert.equal(again.planned, 0, 'not re-planned within the day');
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].output_config.effort, 'medium');
    const input = JSON.parse(state.requests[0].messages[0].content);
    assert.deepEqual(input.existing_queries, ['gay muscle creator linktree']);
    const st = await admin('/api/admin/ai');
    assert.deepEqual(st.json.plannedQueries, ['hairy bear creator bluesky', 'otter fitness allmylinks']);
  });

  test('triage boosts adult male creators, rejects possible minors, holds the rest; each account is judged once', async () => {
    const mk = (target, bio) => repo.candidates.insert({ platform: 'bluesky', kind: 'user', target, display_name: target, bio, score: 3, signals: { search: ['q'] } });
    const good = mk('musclejock.bsky.social', '18+ | gym | my OF link below');
    const minor = mk('kid.bsky.social', 'sophomore, 16');
    const brand = mk('shoes.bsky.social', 'We sell running shoes');
    state.answers.triage = (body) => {
      const { accounts } = JSON.parse(body.messages[0].content);
      return { verdicts: accounts.map((a) => (
        a.handle.startsWith('musclejock') ? { n: a.n, adult_creator: true, male: true, possible_minor: false, confidence: 0.92, reason: 'adult creator' }
          : a.handle.startsWith('kid') ? { n: a.n, adult_creator: false, male: true, possible_minor: true, confidence: 0.9, reason: 'states age 16' }
            : { n: a.n, adult_creator: false, male: false, possible_minor: false, confidence: 0.95, reason: 'a shoe brand' })) };
    };
    const r = await admin('/api/admin/ai/triage', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { judged: 3, boosted: 1, held: 1, rejected: 1 });
    const g = repo.candidates.get(good.id); const m = repo.candidates.get(minor.id); const b = repo.candidates.get(brand.id);
    assert.ok(g.score > 3, `boosted: ${g.score}`);
    assert.deepEqual(g.signals.ai, ['triage 0.92']);
    assert.equal(g.status, 'pending');
    assert.equal(m.status, 'rejected');
    assert.match(m.reason, /possible minor/);
    assert.equal(b.status, 'pending');
    assert.match(b.reason, /^needs review: AI triage says not a man/);
    assert.ok(!repo.candidates.promotable(0, 50).some((c) => c.id === b.id), 'held accounts are never auto-followed');
    // the bios were sent as data in the user turn, not in the system prompt
    assert.match(state.requests[0].messages[0].content, /sophomore, 16/);
    assert.doesNotMatch(state.requests[0].system[0].text, /sophomore/);
    const again = await ai.triage();
    assert.equal(again.judged, 0);
    assert.equal(state.requests.length, 1);
  });

  test('without a key, AI discovery is a no-op', async () => {
    const config = require('../src/config');
    const key = config.creds.anthropicKey;
    config.creds.anthropicKey = '';
    try {
      assert.equal(await ai.planQueries({ force: true }), null);
      assert.equal(await ai.triage(), null);
      assert.equal(await ai.readSearch('anything here', { tags: [], tagMap: new Map() }), null);
      assert.equal((await admin('/api/admin/ai/plan', {})).status, 409);
    } finally { config.creds.anthropicKey = key; }
    assert.equal(state.requests.length, 0);
  });
});

describe('Claude as a web search provider', () => {
  test('only URLs the search tool returned come back (paid / mirror hosts included now)', async () => {
    state.answers.websearch = () => message([
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'hairy bear creator' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
        { type: 'web_search_result', url: 'https://linktr.ee/bearguy', title: 'Bear Guy | Linktree', encrypted_content: 'x', page_age: null },
        { type: 'web_search_result', url: 'https://bsky.app/profile/bearguy.bsky.social', title: 'Bear Guy on Bluesky', encrypted_content: 'x', page_age: null },
        { type: 'web_search_result', url: 'https://coomer.su/onlyfans/user/bearguy', title: 'leak', encrypted_content: 'x', page_age: null },
        { type: 'web_search_result', url: 'https://onlyfans.com/bearguy', title: 'paid', encrypted_content: 'x', page_age: null },
      ] },
      { type: 'text', text: 'https://bsky.app/profile/bearguy.bsky.social | His Bluesky, posts photos\nhttps://made-up.example/never-returned | invented\nhttps://coomer.su/onlyfans/user/bearguy | leak' },
    ]);
    const results = await websearch.search('hairy bear creator', { count: 10 });
    assert.equal(results.provider, 'claude');
    assert.deepEqual(results.map((r) => r.url), ['https://bsky.app/profile/bearguy.bsky.social', 'https://coomer.su/onlyfans/user/bearguy', 'https://linktr.ee/bearguy', 'https://onlyfans.com/bearguy']);
    assert.equal(results[0].description, 'His Bluesky, posts photos');
    assert.equal(results[2].title, 'Bear Guy | Linktree');
    const body = state.requests[0];
    assert.deepEqual(body.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
  });

  test('a paused server-tool turn is continued, a bounded number of times', async () => {
    let turn = 0;
    state.answers.websearch = () => {
      turn++;
      if (turn === 1) return message([{ type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://linktr.ee/a', title: 'A', encrypted_content: 'x' }] }], { stop_reason: 'pause_turn' });
      return message([{ type: 'text', text: 'https://linktr.ee/a | A' }]);
    };
    const r = await claude.webSearch('paused query');
    assert.deepEqual(r.map((x) => x.url), ['https://linktr.ee/a']);
    assert.equal(state.requests.length, 2);
    assert.equal(state.requests[1].messages[1].role, 'assistant');
  });
});
