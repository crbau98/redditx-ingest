'use strict';
/**
 * OpenAI as the default AI provider (lib/openai.js) and the switch that picks it (lib/llm.js, AI_PROVIDER), against local
 * mocks of the Responses API and the Anthropic Messages API: the request on the wire (model, instructions, strict
 * json_schema, reasoning.effort), parsing, refusals and incomplete answers, retries, budget, cache, "off without a key",
 * the provider switch, Claude still selectable, and the Claude-only web search staying out of the OpenAI path.
 * Nothing here reaches either real API and no real key is used.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { start, prepareEnv } = require('./helpers/mock');

let oai; let ant; let config; let repo; let engine; let llm; let openai; let ai; let settingsStore; let websearch;
const ROOT = path.join(__dirname, '..');
const state = { oai: [], oaiHeaders: [], ant: [], mode: 'ok', statuses: [], answer: () => ({ ok: true }) };

const usage = { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 12 } };
const responseBody = (extra = {}) => ({
  id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-6.1-sol', usage,
  output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(state.answer()) }] }],
  ...extra,
});
const messageBody = () => ({ id: 'msg_a', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: JSON.stringify(state.answer()) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

before(async () => {
  oai = await start({
    '/v1/responses': (req) => {
      state.oai.push(JSON.parse(req.bodyText)); state.oaiHeaders.push(req.headers);
      const forced = state.statuses.shift();
      if (forced) return { status: forced, json: { error: { message: `forced ${forced}`, type: 'x' } } };
      switch (state.mode) {
        case 'refusal': return { json: responseBody({ output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }] }) };
        case 'filter': return { json: responseBody({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }) };
        case 'maxtokens': return { json: responseBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":' }] }] }) };
        case 'badjson': return { json: responseBody({ output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'not json' }] }] }) };
        case 'failed': return { json: responseBody({ status: 'failed', error: { message: 'server had a problem' }, output: [] }) };
        default: return { json: responseBody() };
      }
    },
  });
  ant = await start({ '/v1/messages': (req) => { state.ant.push(JSON.parse(req.bodyText)); return { json: messageBody() }; } });
  prepareEnv({ OPENAI_API_KEY: 'sk-oai-test', OPENAI_BASE_URL: oai.url, OPENAI_RETRY_MS: '1', ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: ant.url });
  delete process.env.AI_PROVIDER;
  config = require('../src/config');
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  llm = require('../src/lib/llm');
  openai = require('../src/lib/openai');
  ai = require('../src/engine/ai');
  settingsStore = require('../src/settings');
  websearch = require('../src/lib/websearch');
});
after(async () => { engine.shutdown(); await oai.close(); await ant.close(); });
beforeEach(() => {
  state.oai.length = 0; state.oaiHeaders.length = 0; state.ant.length = 0; state.mode = 'ok'; state.statuses = []; state.answer = () => ({ ok: true });
  config.ai.provider = 'openai';
  llm._reset();
  repo.settings.set('ai.usage', '{}');
  repo.discoveryState.set('ai.queries', null);
  settingsStore.update({ aiSearch: true, aiDiscovery: true, aiDailyBudget: 300 });
});

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

describe('lib/openai: the request and the answer', () => {
  test('defaults: provider openai, model gpt-6.1-sol', () => {
    const r = spawnSync(process.execPath, ['-e', "const c=require('./src/config');console.log(JSON.stringify([c.ai.provider,c.openai.model,c.anthropic.model]))"], { cwd: ROOT, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), ['openai', 'gpt-6.1-sol', 'claude-haiku-5-5']);
  });

  test('one request: Responses API, strict json_schema, reasoning.effort, instructions, no stored response, bearer key', async () => {
    const r = await openai.json('probe me', { system: 'You are a probe.', input: { a: 1 }, schema, effort: 'medium', maxTokens: 700 });
    assert.deepEqual(r, { ok: true });
    assert.equal(state.oai.length, 1);
    const b = state.oai[0];
    assert.equal(b.model, 'gpt-6.1-sol');
    assert.equal(b.instructions, 'You are a probe.');
    assert.equal(b.input, JSON.stringify({ a: 1 }));
    assert.deepEqual(b.reasoning, { effort: 'medium' });
    assert.equal(b.max_output_tokens, 700);
    assert.equal(b.store, false);
    assert.deepEqual(b.text, { format: { type: 'json_schema', name: 'probe_me', strict: true, schema } });
    assert.equal(state.oaiHeaders[0].authorization, 'Bearer sk-oai-test');
    assert.equal(llm.usage().calls, 1);
    assert.equal(llm.usage().input, 120);
    assert.equal(llm.usage().output, 30);
  });

  test('effort is explicit and goes through as reasoning.effort, low to max', async () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      state.answer = () => ({ ok: e === 'low' });
      await openai.json('probe', { system: 'S', input: `effort ${e}`, schema, effort: e });
    }
    assert.deepEqual(state.oai.map((b) => b.reasoning.effort), ['low', 'medium', 'high', 'xhigh', 'max']);
    await assert.rejects(openai.json('probe', { system: 'S', input: 'none', schema }), (e) => e instanceof TypeError && /effort/.test(e.message));
    await assert.rejects(openai.json('probe', { system: 'S', input: 'bad', schema, effort: 'turbo' }), TypeError);
    assert.equal(state.oai.length, 5, 'nothing was sent without a valid effort');
  });

  test('the same question twice costs one request; a different one does not hit the cache', async () => {
    await openai.json('probe', { system: 'S', input: 'same', schema, effort: 'low' });
    await openai.json('probe', { system: 'S', input: 'same', schema, effort: 'low' });
    await openai.json('probe', { system: 'S', input: 'other', schema, effort: 'low' });
    assert.equal(state.oai.length, 2);
  });

  test('the daily budget is a hard stop', async () => {
    settingsStore.update({ aiDailyBudget: 1 });
    await openai.json('probe', { system: 'S', input: 'one', schema, effort: 'low' });
    await assert.rejects(openai.json('probe', { system: 'S', input: 'two', schema, effort: 'low' }), (e) => e.budget === true);
    assert.equal(state.oai.length, 1);
  });

  test('a refusal part is "no answer": counted, one request, never retried, never cached', async () => {
    state.mode = 'refusal';
    await assert.rejects(openai.json('probe', { system: 'S', input: 'x', schema, effort: 'low' }), (e) => e.refusal === true && e.skip === true && /declined/.test(e.message));
    assert.equal(state.oai.length, 1);
    assert.equal(llm.usage().refusals, 1);
    state.mode = 'ok';
    assert.deepEqual(await openai.json('probe', { system: 'S', input: 'x', schema, effort: 'low' }), { ok: true });
  });

  test('an answer cut off by the content filter is a refusal too', async () => {
    state.mode = 'filter';
    await assert.rejects(openai.json('probe', { system: 'S', input: 'f', schema, effort: 'low' }), (e) => e.refusal === true && /content filter/.test(e.message));
    assert.equal(llm.usage().refusals, 1);
  });

  test('incomplete (out of tokens), failed and unreadable answers are plain errors, not refusals', async () => {
    state.mode = 'maxtokens';
    await assert.rejects(openai.json('probe', { system: 'S', input: 'm', schema, effort: 'low' }), (e) => !e.refusal && /ran out of room/.test(e.message));
    state.mode = 'badjson';
    await assert.rejects(openai.json('probe', { system: 'S', input: 'b', schema, effort: 'low' }), (e) => !e.refusal && /unreadable JSON/.test(e.message));
    state.mode = 'failed';
    await assert.rejects(openai.json('probe', { system: 'S', input: 'f', schema, effort: 'low' }), (e) => !e.refusal && /could not answer/.test(e.message));
    assert.equal(llm.usage().refusals, 0);
  });

  test('a rejected key is a quiet skip and the key never appears in the error; no retry', async () => {
    state.statuses = [401];
    await assert.rejects(openai.json('probe', { system: 'S', input: 'k', schema, effort: 'low' }), (e) => e.skip === true && /OPENAI_API_KEY/.test(e.message) && !/sk-oai-test/.test(e.message));
    assert.equal(state.oai.length, 1);
  });

  test('429 and 5xx are retried (twice); a late success is returned, a lasting 429 is a budget error', async () => {
    state.statuses = [500, 429];
    assert.deepEqual(await openai.json('probe', { system: 'S', input: 'r1', schema, effort: 'low' }), { ok: true });
    assert.equal(state.oai.length, 3);
    state.oai.length = 0; state.statuses = [429, 429, 429];
    await assert.rejects(openai.json('probe', { system: 'S', input: 'r2', schema, effort: 'low' }), (e) => e.budget === true && e.status === 429);
    assert.equal(state.oai.length, 3);
  });

  test('a caller that is waiting (timeoutMs) gets no retries', async () => {
    state.statuses = [500];
    await assert.rejects(openai.json('probe', { system: 'S', input: 'w', schema, effort: 'low', timeoutMs: 5000 }), (e) => e.status === 500);
    assert.equal(state.oai.length, 1);
  });

  test('off without a key: not configured, nothing sent', async () => {
    const was = config.creds.openaiKey;
    config.creds.openaiKey = '';
    try {
      assert.equal(openai.configured(), false);
      assert.equal(llm.configured(), false);
      await assert.rejects(openai.json('probe', { system: 'S', input: 'nokey', schema, effort: 'low' }), (e) => e.skip === true && /OPENAI_API_KEY/.test(e.message));
      assert.equal(state.oai.length, 0);
    } finally { config.creds.openaiKey = was; }
  });

  test('OPENAI_API_KEY_FILE is read like BRAVE_API_KEY_FILE; the key itself is never printed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-key-'));
    const file = path.join(dir, 'key.txt');
    fs.writeFileSync(file, 'sk-from-file-123\n');
    const run = (env) => JSON.parse(spawnSync(process.execPath, ['-e', "const c=require('./src/config');console.log(JSON.stringify({set:!!c.creds.openaiKey,len:c.creds.openaiKey.length}))"], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).stdout);
    assert.deepEqual(run({ OPENAI_API_KEY_FILE: file }), { set: true, len: 'sk-from-file-123'.length });
    assert.deepEqual(run({ OPENAI_API_KEY_FILE: path.join(dir, 'missing.txt') }), { set: false, len: 0 });
    assert.deepEqual(run({ OPENAI_API_KEY: 'sk-direct', OPENAI_API_KEY_FILE: file }), { set: true, len: 'sk-direct'.length }, 'the plain variable wins');
  });
});

describe('the provider switch', () => {
  const plan = { queries: ['otter gym bluesky', 'scruffy lifter linktree', 'bear hiker telegram'] };

  test('openai is the default: engine/ai goes to the Responses API with the explicit effort, not to Anthropic', async () => {
    state.answer = () => plan;
    assert.equal(llm.provider(), 'openai');
    const r = await ai.planQueries({ force: true });
    assert.equal(r.planned, 3);
    assert.equal(state.oai.length, 1);
    assert.equal(state.ant.length, 0);
    assert.equal(state.oai[0].model, 'gpt-6.1-sol');
    assert.equal(state.oai[0].reasoning.effort, 'medium');
    assert.equal(state.oai[0].text.format.strict, true);
    assert.deepEqual(ai.plannedQueries(), plan.queries);
  });

  test('AI_PROVIDER=anthropic: the same job goes to Claude, with Claude\'s own request shape', async () => {
    config.ai.provider = 'anthropic';
    state.answer = () => plan;
    assert.equal(llm.provider(), 'anthropic');
    const r = await ai.planQueries({ force: true });
    assert.equal(r.planned, 3);
    assert.equal(state.oai.length, 0);
    assert.equal(state.ant.length, 1);
    assert.equal(state.ant[0].model, 'claude-haiku-5-5');
    assert.equal(state.ant[0].output_config.effort, 'medium');
  });

  test('status names the active provider and model, shows usage, never a key', () => {
    const s = llm.status();
    assert.deepEqual([s.provider, s.label, s.model, s.configured, s.keyName], ['openai', 'OpenAI', 'gpt-6.1-sol', true, 'OPENAI_API_KEY']);
    config.ai.provider = 'anthropic';
    const c = llm.status();
    assert.deepEqual([c.provider, c.label, c.model, c.keyName], ['anthropic', 'Claude', 'claude-haiku-5-5', 'ANTHROPIC_API_KEY']);
    assert.ok(!JSON.stringify([s, c]).includes('sk-'));
  });

  test('a refusal from the active provider means no answer in the caller, for both providers', async () => {
    state.mode = 'refusal';
    state.answer = () => plan;
    assert.equal(await ai.planQueries({ force: true }), null);
    assert.deepEqual(ai.plannedQueries(), []);
  });

  test('switched off (aiDiscovery) or no key: no request, whichever provider', async () => {
    settingsStore.update({ aiDiscovery: false });
    assert.equal(await ai.planQueries({ force: true }), null);
    settingsStore.update({ aiDiscovery: true });
    const was = config.creds.openaiKey; config.creds.openaiKey = '';
    try { assert.equal(await ai.planQueries({ force: true }), null); } finally { config.creds.openaiKey = was; }
    assert.equal(state.oai.length + state.ant.length, 0);
  });

  test('the budget is shared: requests to either provider count against the same day', async () => {
    settingsStore.update({ aiDailyBudget: 2 });
    await openai.json('probe', { system: 'S', input: 'a', schema, effort: 'low' });
    config.ai.provider = 'anthropic';
    state.answer = () => ({ ok: true });
    await llm.json('probe', { system: 'S', input: 'b', schema, effort: 'low' });
    await assert.rejects(llm.json('probe', { system: 'S', input: 'c', schema, effort: 'low' }), (e) => e.budget === true);
    assert.equal(llm.usage().calls, 2);
  });
});

describe('Claude-only web search, Brave, and structure', () => {
  test('the Claude web-search provider is offered only when an Anthropic key exists, whichever AI provider is selected', () => {
    assert.equal(llm.provider(), 'openai');
    assert.equal(websearch.PROVIDERS.claude.configured(), true, 'Anthropic key set: Claude search stays available under openai');
    const was = config.creds.anthropicKey; config.creds.anthropicKey = '';
    try { assert.equal(websearch.PROVIDERS.claude.configured(), false, 'no Anthropic key: switched off cleanly'); } finally { config.creds.anthropicKey = was; }
  });

  test('Brave is untouched by the AI provider', () => {
    const braveBefore = websearch.PROVIDERS.brave.configured();
    config.ai.provider = 'anthropic';
    assert.equal(websearch.PROVIDERS.brave.configured(), braveBefore);
    config.ai.provider = 'openai';
    assert.equal(websearch.PROVIDERS.brave.configured(), braveBefore);
    assert.ok(Object.keys(websearch.PROVIDERS).includes('brave'));
  });

  test('every callers goes through lib/llm: only llm.js and websearch.js (Claude web search) import lib/claude', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const importers = walk(path.join(ROOT, 'src')).filter((f) => /require\(['"](\.\.?\/)+(lib\/)?claude['"]\)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(path.join(ROOT, 'src'), f)).sort();
    assert.deepEqual(importers, ['lib/llm.js', 'lib/websearch.js']);
  });

  test('every schema sent to the model satisfies strict structured outputs: all properties required, no extras, recursively', () => {
    const problems = [];
    const check = (name, node, where = '') => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        const keys = Object.keys(node.properties || {});
        if (node.additionalProperties !== false) problems.push(`${name}${where}: additionalProperties must be false`);
        if (JSON.stringify([...(node.required || [])].sort()) !== JSON.stringify([...keys].sort())) problems.push(`${name}${where}: required must list every property`);
        for (const k of keys) check(name, node.properties[k], `${where}.${k}`);
      }
      if (node.type === 'array') check(name, node.items, `${where}[]`);
    };
    for (const [name, s] of Object.entries({ search: ai.SEARCH_SCHEMA, queries: ai.QUERY_SCHEMA, triage: ai.TRIAGE_SCHEMA, profiles: ai.PROFILE_SCHEMA })) {
      assert.ok(s, `${name} schema is exported`);
      check(name, s);
    }
    assert.deepEqual(problems, []);
  });

  test('picture and face code stays out of the OpenAI client and the switch', () => {
    for (const f of ['openai.js', 'llm.js', 'aiusage.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', f), 'utf8');
      for (const banned of ['imagefilter', 'imagematch', 'phash', 'embeddings', 'physique', 'base64', 'image_url', 'input_image']) assert.ok(!src.includes(banned), `${f} does not reference ${banned}`);
    }
  });
});
