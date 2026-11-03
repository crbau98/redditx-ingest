'use strict';
/**
 * OpenAI (Responses API) over plain fetch, for the same structured jobs as lib/claude.js: reading a search, planning
 * discovery queries, triaging accounts, reading creators' own profile text. Text only; no dependency.
 *
 *   json(purpose, {system, input, schema, effort})   one structured call: text.format json_schema (strict), the answer
 *                                                    parsed and returned. Identical calls are cached.
 *
 * Same rules as Claude: every call counts against the daily budget (aiDailyBudget); `effort` must be given and becomes
 * reasoning.effort; a refusal (a refusal part, or an incomplete response cut off by the content filter) is an error the
 * caller treats as "no answer" and is never retried; inert without OPENAI_API_KEY / OPENAI_API_KEY_FILE.
 * Requests set store:false, so nothing is kept in the account's response history.
 */
const config = require('../config');
const store = require('./aiusage');
const net = require('./net');
const redact = require('./redact');

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const configured = () => !!config.creds.openaiKey;
const PROVIDER = 'openai';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(status, body, retryAfterMs = 0) {
  const detail = redact(String((body && body.error && body.error.message) || '')).slice(0, 200);
  if (status === 401 || status === 403) return store.skipErr(`OpenAI rejected the API key (HTTP ${status}); check OPENAI_API_KEY`, { status });
  if (status === 429) return store.budgetErr('OpenAI rate limit hit (HTTP 429)', { status, retryAfterMs });
  if (status === 400) return Object.assign(new Error(`OpenAI refused the request (HTTP 400): ${detail}`), { status });
  return Object.assign(new Error(`OpenAI API error (HTTP ${status})${detail ? `: ${detail}` : ''}`), { status });
}

/**
 * POST /v1/responses with retries on 429 / 5xx / network errors (none when someone is waiting: timeoutMs given).
 * A 429's Retry-After is waited for when it is within retryAfterCapMs; a longer one is not retried into (it would only fail
 * again): the provider cools down for the cap, calls inside that window send nothing, and one "AI rate-limited" event is logged.
 */
async function post(body, { timeoutMs } = {}) {
  const retries = timeoutMs ? 0 : 2;
  const cap = config.openai.retryAfterCapMs;
  let last; let wait = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(wait || config.openai.retryMs * attempt);
    wait = 0;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs || config.openai.timeoutMs);
    try {
      const res = await fetch(`${config.baseUrls.openai}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.creds.openaiKey}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      if (res.ok) return json || {};
      if (res.status === 429) {
        const asked = net.parseRetryAfter(res.headers.get('retry-after'));
        const hold = Math.min(asked, cap);
        last = httpError(429, json, hold);
        if (asked > cap) { store.coolDown(PROVIDER, hold); break; } // asked to wait longer than we will: stop here
        wait = asked; // 0 = no header: the usual backoff
        if (asked) store.coolDown(PROVIDER, asked);
        continue;
      }
      last = httpError(res.status, json);
      if (res.status < 500) throw last;
    } catch (e) {
      if (e && (e.skip || (e.status && e.status < 500 && e.status !== 429))) throw e;
      if (!last || (e && !e.status)) last = Object.assign(new Error(`OpenAI request failed: ${ac.signal.aborted ? 'timed out' : redact(String(e && e.message)).slice(0, 120)}`), { status: 502 });
    } finally { clearTimeout(timer); }
  }
  if (last && last.status === 429) store.noteRateLimited('OpenAI', last.retryAfterMs);
  throw last;
}

/** What a Responses API answer holds: the text, or why there is none. */
function readOutput(res) {
  let text = ''; let refusal = '';
  for (const item of res.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'output_text') text += part.text || '';
      else if (part.type === 'refusal') refusal += part.refusal || '';
    }
  }
  return { text, refusal };
}

async function json(purpose, { system, input, schema, effort, maxTokens = 8000, ttlMs = 24 * 3600 * 1000, timeoutMs }) {
  if (!EFFORTS.has(effort)) throw new TypeError(`openai.json(${purpose}): effort must be set explicitly (${[...EFFORTS].join('|')})`);
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const key = store.keyOf('openai', purpose, config.openai.model, system, text, schema);
  const hit = store.cached(key, ttlMs);
  if (hit) return hit.value;
  if (!configured()) throw store.skipErr('OpenAI is not configured: set OPENAI_API_KEY');
  const cooling = store.coolRemaining(PROVIDER);
  if (cooling > 0) throw store.budgetErr(`OpenAI is rate-limited; cooling down for ${Math.ceil(cooling / 1000)}s`, { status: 429, retryAfterMs: cooling });
  const release = store.reserve(); // in-flight calls count against the budget from here until they finish
  try {
    const res = await post({
      model: config.openai.model,
      instructions: system,
      input: text,
      reasoning: { effort },
      max_output_tokens: maxTokens,
      store: false,
      text: { format: { type: 'json_schema', name: String(purpose).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'answer', strict: true, schema } },
    }, { timeoutMs });
    const inTok = (res.usage && res.usage.input_tokens) || 0;
    const outTok = (res.usage && res.usage.output_tokens) || 0;
    const { text: out, refusal } = readOutput(res);
    const filtered = res.status === 'incomplete' && res.incomplete_details && res.incomplete_details.reason === 'content_filter';
    if (refusal || filtered) {
      store.record(inTok, outTok, { refusal: true });
      throw Object.assign(new Error(`OpenAI declined this request${filtered ? ' (content filter)' : ''}`), { refusal: true, skip: true });
    }
    store.record(inTok, outTok);
    if (res.status === 'failed') throw Object.assign(new Error(`OpenAI could not answer (${purpose}): ${redact(String((res.error && res.error.message) || 'failed')).slice(0, 160)}`), { status: 502 });
    if (res.status === 'incomplete') throw new Error(`OpenAI ran out of room answering (${purpose}); raise maxTokens`);
    let value;
    try { value = JSON.parse(out); } catch { throw new Error(`OpenAI returned unreadable JSON (${purpose})`); }
    store.remember(key, value);
    return value;
  } finally { release(); }
}

function status() {
  const s = require('../settings').get();
  return { configured: configured(), model: config.openai.model, budget: s.aiDailyBudget, usage: store.usage(), cached: store.cacheSize() };
}

module.exports = { configured, json, status, usage: store.usage, budgetLeft: store.budgetLeft, _reset: store.reset };
