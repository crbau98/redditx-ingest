'use strict';
/**
 * Hardening of the AI layer after release review:
 *  - the daily budget holds under concurrency (in-flight calls count), for both providers;
 *  - a sustained 429 honours Retry-After within a cap, cools the provider down, and logs one throttled "AI rate-limited" event;
 *  - grounded() needs whole-word matches and an ownership phrase, so "my ex is jake_fit" does not ground jake_fit;
 *  - Bearer tokens and key-like strings never reach the event log through upstream error text.
 * Local mocks of both APIs; no real key or network.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let oai; let ant; let config; let repo; let engine; let llm; let openai; let claude; let ai; let events; let settingsStore; let redact;
const SECRET = 'sk-proj-AbCdEfGh1234567890XyZ';
const state = { oai: 0, ant: 0, delayMs: 0, mode: 'ok', retryAfter: null, antMode: 'ok', oaiTimes: [] };
const ok = (text = '{"ok":true}') => ({ id: 'r', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const antOk = () => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
const later = (res, ms, status, body, headers = {}) => setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); }, ms);

before(async () => {
  oai = await start({
    '/v1/responses': (req, res) => {
      state.oai++; state.oaiTimes.push(Date.now());
      if (state.mode === '429') { later(res, 0, 429, { error: { message: 'slow down' } }, state.retryAfter == null ? {} : { 'retry-after': String(state.retryAfter) }); return null; }
      if (state.mode === '429-once') { state.mode = 'ok'; later(res, 0, 429, { error: { message: 'slow down' } }, { 'retry-after': String(state.retryAfter) }); return null; }
      if (state.mode === 'leak') { later(res, 0, 400, { error: { message: `Incorrect API key provided: ${SECRET}. Authorization: Bearer ${SECRET}` } }); return null; }
      later(res, state.delayMs, 200, ok());
      return null;
    },
  });
  ant = await start({
    '/v1/messages': (req, res) => {
      state.ant++;
      if (state.antMode === 'leak') { later(res, 0, 400, { type: 'error', error: { type: 'invalid_request_error', message: `invalid x-api-key sk-ant-api03-ZZZZ1234567890abcdef and Bearer ${SECRET}` } }); return null; }
      later(res, state.delayMs, 200, antOk());
      return null;
    },
  });
  prepareEnv({ OPENAI_API_KEY: 'sk-oai-test-key-value', OPENAI_BASE_URL: oai.url, OPENAI_RETRY_MS: '1', OPENAI_RETRY_AFTER_CAP_MS: '300', ANTHROPIC_API_KEY: 'sk-ant-test-key-value', ANTHROPIC_BASE_URL: ant.url });
  delete process.env.AI_PROVIDER;
  config = require('../src/config');
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  llm = require('../src/lib/llm');
  openai = require('../src/lib/openai');
  claude = require('../src/lib/claude');
  ai = require('../src/engine/ai');
  events = require('../src/engine/events');
  settingsStore = require('../src/settings');
  redact = require('../src/lib/redact');
});
after(async () => { engine.shutdown(); await oai.close(); await ant.close(); });
beforeEach(() => {
  Object.assign(state, { oai: 0, ant: 0, delayMs: 0, mode: 'ok', retryAfter: null, antMode: 'ok', oaiTimes: [] });
  config.ai.provider = 'openai';
  llm._reset();
  events.clearLogs();
  repo.settings.set('ai.usage', '{}');
  repo.discoveryState.set('ai.queries', null);
  settingsStore.update({ aiSearch: true, aiDiscovery: true, aiDailyBudget: 300 });
});

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
let n = 0;
const askO = (extra = {}) => openai.json('t', { system: 's', input: `q${n++}`, schema, effort: 'low', ...extra });
const askC = (extra = {}) => claude.json('t', { system: 's', input: `q${n++}`, schema, effort: 'low', ...extra });
const rateLogs = () => events.getLogs(100).filter((l) => /AI rate-limited/.test(l.msg));

describe('the daily budget holds under concurrency', () => {
  test('12 parallel OpenAI calls with a budget of 3 send exactly 3 requests', async () => {
    settingsStore.update({ aiDailyBudget: 3 });
    state.delayMs = 120;
    const res = await Promise.allSettled(Array.from({ length: 12 }, () => askO()));
    assert.equal(state.oai, 3, 'upstream requests');
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 3);
    assert.ok(res.filter((r) => r.status === 'rejected').every((r) => r.reason.budget === true), 'the rest are budget errors');
    assert.equal(openai.usage().calls, 3);
    assert.equal(openai.budgetLeft(), 0);
  });

  test('12 parallel Claude calls with a budget of 3 send exactly 3 requests', async () => {
    settingsStore.update({ aiDailyBudget: 3 });
    state.delayMs = 120;
    const res = await Promise.allSettled(Array.from({ length: 12 }, () => askC()));
    assert.equal(state.ant, 3);
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(claude.usage().calls, 3);
  });

  test('a call that fails gives its slot back; the budget is not eaten by errors', async () => {
    settingsStore.update({ aiDailyBudget: 1 });
    state.mode = 'leak'; // HTTP 400, nothing recorded
    await assert.rejects(askO({ timeoutMs: 5000 }), (e) => e.status === 400);
    state.mode = 'ok';
    assert.deepEqual(await askO(), { ok: true });
    assert.equal(openai.usage().calls, 1);
  });

  test('a cached answer needs no budget at all', async () => {
    settingsStore.update({ aiDailyBudget: 1 });
    await askO({ input: 'same' });
    await askO({ input: 'same' });
    assert.equal(state.oai, 1);
  });
});

describe('a sustained 429', () => {
  test('Retry-After (within the cap) is waited for instead of the short default backoff', async () => {
    state.mode = '429-once'; state.retryAfter = 0.12; // 120 ms, under the 300 ms cap
    assert.deepEqual(await askO(), { ok: true });
    assert.equal(state.oai, 2);
    assert.ok(state.oaiTimes[1] - state.oaiTimes[0] >= 110, `waited ${state.oaiTimes[1] - state.oaiTimes[0]} ms`);
    assert.equal(rateLogs().length, 0, 'a 429 that recovered is not an event');
  });

  test('a Retry-After beyond the cap is not retried into: one request, a budget error that carries the wait', async () => {
    state.mode = '429'; state.retryAfter = 30;
    await assert.rejects(askO(), (e) => e.budget === true && e.status === 429 && e.retryAfterMs === 300);
    assert.equal(state.oai, 1);
  });

  test('then the provider cools down: calls inside the window send nothing, and resume after it', async () => {
    state.mode = '429'; state.retryAfter = 30;
    await assert.rejects(askO(), (e) => e.budget === true);
    state.oai = 0;
    await assert.rejects(askO(), (e) => e.budget === true && /rate-limited|cooling/i.test(e.message));
    assert.equal(state.oai, 0, 'nothing sent while cooling down');
    await new Promise((r) => setTimeout(r, 350));
    state.mode = 'ok';
    assert.deepEqual(await askO(), { ok: true });
  });

  test('one "AI rate-limited" event, however many calls are throttled', async () => {
    state.mode = '429'; state.retryAfter = 30;
    for (let i = 0; i < 4; i++) await assert.rejects(askO(), (e) => e.budget === true);
    const logs = rateLogs();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'WARN');
    assert.match(logs[0].msg, /OpenAI/);
  });

  test('without a Retry-After header the old backoff still applies: three requests, then one event', async () => {
    state.mode = '429'; state.retryAfter = null;
    await assert.rejects(askO(), (e) => e.budget === true);
    assert.equal(state.oai, 3);
    assert.equal(rateLogs().length, 1);
  });
});

describe('grounded(): whole words and an ownership phrase', () => {
  const g = (hay, quote, value) => ai.grounded(hay.toLowerCase().replace(/\s+/g, ' '), quote, value);
  test('"my ex is jake_fit" does not ground jake_fit', () => {
    assert.equal(g('my ex is jake_fit', 'my ex is jake_fit', 'jake_fit'), false);
    assert.equal(g('go follow my bf @tomlifts', 'go follow my bf @tomlifts', 'tomlifts'), false);
    assert.equal(g('shoutout to @jake_fit for the collab', 'shoutout to @jake_fit for the collab', 'jake_fit'), false);
  });
  test('first-person ownership grounds it', () => {
    for (const [text, value] of [
      ['my OnlyFans: jake_fit', 'jake_fit'], ["I'm Zed Calloway", 'Zed Calloway'], ['follow me at @jake_fit', 'jake_fit'],
      ['my other account: @rex_two', 'rex_two'], ['also on X: @moe_lifts_alt', 'moe_lifts_alt'], ['backup: @under-18-lifts', 'under-18-lifts'],
      ['I post on r/malefitness', 'malefitness'], ['my name is Abe Lincoln', 'Abe Lincoln'], ['@jake_fit - my insta', 'jake_fit'],
      ['Ivo Kessler official', 'Ivo Kessler'], ['find me on bluesky: zed.bsky.social', 'zed.bsky.social'],
    ]) assert.equal(g(text, text, value), true, text);
  });
  test('the value must be a whole word: a prefix, suffix or fragment does not ground it', () => {
    assert.equal(g('i love fred', 'i love fred', 'ed'), false);
    assert.equal(g('follow me at jake_fit2', 'follow me at jake_fit2', 'jake_fit'), false);
    assert.equal(g('follow me at xjake_fit', 'follow me at xjake_fit', 'jake_fit'), false);
    assert.equal(g('follow me at jake_fit.', 'follow me at jake_fit.', 'jake_fit'), true, 'a sentence period is not part of the handle');
    assert.equal(g('follow me at jake_fit.official', 'follow me at jake_fit.official', 'jake_fit'), false);
  });
  test('the phrase must sit next to the value, in the same sentence', () => {
    assert.equal(g('my onlyfans is great. also my ex is jake_fit', 'my onlyfans is great. also my ex is jake_fit', 'jake_fit'), false);
    assert.equal(g("i'm a runner and a lifter and a cook and also my ex is jake_fit", "i'm a runner and a lifter and a cook and also my ex is jake_fit", 'jake_fit'), false);
  });
  test('the quote must still be in his own text', () => {
    assert.equal(ai.grounded('lifting and tacos', "my onlyfans: jake_fit", 'jake_fit'), false);
  });
});

describe('secrets in upstream error text', () => {
  test('redact(): Bearer tokens, sk- keys, key=value pairs and the configured keys are masked; ordinary text is kept', () => {
    const out = redact(`bad key ${SECRET}; Authorization: Bearer abcdef0123456789.token_value; api_key="zzzzzzzzzzzz1234"; own ${config.creds.openaiKey}; req_0123abc failed at 12:00`);
    assert.ok(!out.includes(SECRET));
    assert.ok(!out.includes('abcdef0123456789'));
    assert.ok(!out.includes('zzzzzzzzzzzz1234'));
    assert.ok(!out.includes(config.creds.openaiKey));
    assert.match(out, /\[redacted\]/);
    assert.match(out, /req_0123abc failed at 12:00/);
    assert.equal(redact('HTTP 400: model not found'), 'HTTP 400: model not found');
    assert.equal(redact(null), '');
  });

  test('OpenAI: a 400 that echoes the key reaches the event log redacted', async () => {
    state.mode = 'leak';
    assert.equal(await ai.planQueries({ force: true }), null);
    const text = JSON.stringify(events.getLogs(100));
    assert.ok(/AI discovery queries/.test(text), 'the failure is still logged');
    assert.ok(!text.includes(SECRET), 'the key is not in the log');
    assert.ok(!/AbCdEfGh/.test(text));
  });

  test('Claude: the same, through the Anthropic error path', async () => {
    config.ai.provider = 'anthropic';
    state.antMode = 'leak';
    assert.equal(await ai.planQueries({ force: true }), null);
    const text = JSON.stringify(events.getLogs(100));
    assert.ok(/AI discovery queries/.test(text));
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes('sk-ant-api03-ZZZZ1234567890abcdef'));
  });

  test('the error object itself is redacted too, not only the log line', async () => {
    state.mode = 'leak';
    await assert.rejects(askO({ timeoutMs: 5000 }), (e) => !e.message.includes(SECRET) && /\[redacted\]/.test(e.message));
  });
});
