'use strict';
/**
 * Claude (Anthropic API) for the jobs rules do badly: reading what someone meant by a search, planning new discovery
 * searches from what the library already likes, judging whether a discovered account is an adult male creator, and (as
 * the last search provider) searching the web.
 *
 * Text only: public handles, names, bios, search words and tag names are sent; pictures and videos never are.
 *
 *   json(purpose, {system, input, schema})   one structured call: the answer is JSON that matches `schema`
 *                                            (structured outputs), parsed and returned. Identical calls are cached.
 *   webSearch(q)                             Claude's web search tool; only URLs the tool actually returned come back.
 *
 * Cost control: every call counts against the daily budget (setting aiDailyBudget); the answer cache means a repeated
 * question costs nothing; the system prompt is marked for prompt caching. A declined request (stop_reason "refusal")
 * is an error the caller treats like "no answer" - it is never retried in another wording. Inert without ANTHROPIC_API_KEY.
 */
const crypto = require('crypto');
const config = require('../config');
const repo = require('../db/repo');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); Anthropic = Anthropic.default || Anthropic; } catch { Anthropic = null; }

const today = () => new Date().toISOString().slice(0, 10);
const configured = () => !!(config.creds.anthropicKey && Anthropic);

// Server-side refusal fallback (beta): when a safety classifier declines, the API re-runs the request on a fallback
// model inside the same call. Accepted for these models on the Claude API.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;
let clientKey = '';
function getClient() {
  const key = `${config.creds.anthropicKey}|${config.baseUrls.anthropic}|${config.anthropic.timeoutMs}`;
  if (!client || key !== clientKey) {
    client = new Anthropic({ apiKey: config.creds.anthropicKey, baseURL: config.baseUrls.anthropic, timeout: config.anthropic.timeoutMs, maxRetries: 2 });
    clientKey = key;
  }
  return client;
}

/* ------------------------------------------------------------------ budget */
function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('ai.usage') || '{}'); } catch { u = {}; }
  const t = u.total || { calls: 0, input: 0, output: 0 };
  return u.day === today()
    ? { day: u.day, calls: u.calls || 0, input: u.input || 0, output: u.output || 0, refusals: u.refusals || 0, total: t }
    : { day: today(), calls: 0, input: 0, output: 0, refusals: 0, total: t };
}
function record(res, { refusal = false } = {}) {
  const u = usage();
  const inTok = (res && res.usage && (res.usage.input_tokens || 0) + (res.usage.cache_read_input_tokens || 0) + (res.usage.cache_creation_input_tokens || 0)) || 0;
  const outTok = (res && res.usage && res.usage.output_tokens) || 0;
  repo.settings.set('ai.usage', JSON.stringify({
    day: u.day, calls: u.calls + 1, input: u.input + inTok, output: u.output + outTok, refusals: u.refusals + (refusal ? 1 : 0),
    total: { calls: u.total.calls + 1, input: u.total.input + inTok, output: u.total.output + outTok },
  }));
}
function budgetLeft() {
  const s = require('../settings').get();
  return Math.max(0, s.aiDailyBudget - usage().calls);
}

/* ------------------------------------------------------------------- cache */
const cache = new Map(); // key -> {at, value}
const CACHE_MAX = 500;
const keyOf = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function cached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit;
  if (hit) cache.delete(key);
  return null;
}
function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/* ------------------------------------------------------------------ errors */
const skipErr = (msg, extra = {}) => Object.assign(new Error(msg), { skip: true, ...extra });
function failure(e) {
  if (!Anthropic || !(e instanceof Anthropic.APIError)) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return skipErr(`Anthropic rejected the API key (HTTP ${e.status}); check ANTHROPIC_API_KEY`, { status: e.status });
  if (e instanceof Anthropic.RateLimitError) return Object.assign(new Error('Anthropic rate limit hit (HTTP 429)'), { budget: true, status: 429 });
  if (e instanceof Anthropic.BadRequestError) return Object.assign(new Error(`Anthropic refused the request (HTTP 400): ${String(e.message).slice(0, 200)}`), { status: 400 });
  return Object.assign(new Error(`Anthropic API error${e.status ? ` (HTTP ${e.status})` : ''}: ${String(e.message).slice(0, 200)}`), { status: e.status || 502 });
}

/** One Messages API request, with budget, refusal fallback and usage accounting. */
async function call(params, { timeoutMs } = {}) {
  if (!configured()) throw skipErr('Claude is not configured: set ANTHROPIC_API_KEY');
  if (budgetLeft() <= 0) throw Object.assign(new Error('Claude daily budget reached (setting aiDailyBudget)'), { budget: true });
  const model = config.anthropic.model;
  const body = { model, ...params };
  if (config.anthropic.fallbacks && FALLBACK_MODELS.has(model)) { body.betas = [FALLBACK_BETA]; body.fallbacks = 'default'; }
  let res;
  try { res = await getClient().beta.messages.create(body, timeoutMs ? { timeout: timeoutMs, maxRetries: 0 } : undefined); } catch (e) { throw failure(e); }
  if (res.stop_reason === 'refusal') {
    record(res, { refusal: true });
    const cat = res.stop_details && res.stop_details.category;
    throw Object.assign(new Error(`Claude declined this request${cat ? ` (${cat})` : ''}`), { refusal: true, skip: true });
  }
  record(res);
  return res;
}

const textOf = (res) => (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

/**
 * A structured answer: JSON matching `schema`.
 * @param {string} purpose label for logs and the cache key
 * @param {{system: string, input: string|object, schema: object, effort?: string, maxTokens?: number, ttlMs?: number, timeoutMs?: number}} o
 *   timeoutMs: give up sooner than ANTHROPIC_TIMEOUT_MS, without retries (for requests someone is waiting on)
 */
async function json(purpose, { system, input, schema, effort = 'low', maxTokens = 8000, ttlMs = 24 * 3600 * 1000, timeoutMs }) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const key = keyOf(purpose, config.anthropic.model, system, text, schema);
  const hit = cached(key, ttlMs);
  if (hit) return hit.value;
  const res = await call({
    max_tokens: maxTokens,
    // The system prompt is the same for every call of a purpose: cache it (no effect below the minimum cacheable size).
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: text }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  }, { timeoutMs });
  if (res.stop_reason === 'max_tokens') throw new Error(`Claude ran out of room answering (${purpose}); raise maxTokens`);
  let value;
  try { value = JSON.parse(textOf(res)); } catch { throw new Error(`Claude returned unreadable JSON (${purpose})`); }
  remember(key, value);
  return value;
}

const SEARCH_SYSTEM = [
  'You are the web-search step of a media discovery tool for an adult (18+) site about men.',
  'Run web searches for the query and report the most relevant results: public creator profiles, galleries, social accounts and link-in-bio pages.',
  'Only report URLs that appeared in your web search results, and never anything involving minors.',
  'Answer with one result per line, exactly: URL | one-sentence description of what is on it. No other text.',
].join('\n');

/**
 * Web search through Claude's server-side web search tool. Returns {url,title,description}[]: URLs come only from the
 * tool's own result blocks (a URL the model wrote but the tool never returned is dropped).
 */
async function webSearch(q, { count = 10, site } = {}) {
  const query = site ? `${q} site:${site}` : q;
  const key = keyOf('websearch', config.anthropic.model, query, count);
  const hit = cached(key, 10 * 60 * 1000);
  if (hit) return hit.value;
  const tool = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };
  if (site) tool.allowed_domains = [site];
  const messages = [{ role: 'user', content: `Search query: ${query}\nReport up to ${count} results.` }];
  const seen = new Map(); // url -> title, as the tool returned them
  let res;
  for (let turn = 0; turn < 3; turn++) { // a server-tool turn can pause; continue it (pause_turn) a bounded number of times
    res = await call({
      max_tokens: 8000,
      system: [{ type: 'text', text: SEARCH_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [tool],
      messages,
      output_config: { effort: 'low' },
    });
    for (const b of res.content || []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r && r.url) seen.set(r.url, r.title || '');
    }
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  // Claude's ranked lines first ("URL | description"), then any other result the tool returned, in its order.
  const described = new Map();
  for (const line of textOf(res).split('\n')) {
    const m = line.match(/(https?:\/\/\S+?)[)\].,]*\s*(?:\||\s[-–—]\s)\s*(.*)$/) || line.match(/(https?:\/\/\S+?)[)\].,]*\s*$/);
    if (m && !described.has(m[1])) described.set(m[1], (m[2] || '').trim());
  }
  const out = [];
  for (const url of [...described.keys(), ...seen.keys()]) {
    if (!seen.has(url) || out.some((r) => r.url === url)) continue;
    out.push({ url, title: String(seen.get(url) || '').trim(), description: String(described.get(url) || '').replace(/\s+/g, ' ').trim().slice(0, 500) });
    if (out.length >= count) break;
  }
  remember(key, out);
  return out;
}

function status() {
  const s = require('../settings').get();
  return { configured: configured(), sdk: !!Anthropic, model: config.anthropic.model, budget: s.aiDailyBudget, usage: usage(), cached: cache.size };
}

function _reset() { cache.clear(); client = null; clientKey = ''; }

module.exports = { configured, json, webSearch, usage, budgetLeft, status, _reset, FALLBACK_MODELS };
