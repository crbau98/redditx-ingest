'use strict';
/**
 * Oxylabs Web API (https://developers.oxylabs.io/products/web-api/for-agents.md), built from that page:
 *
 *   POST {base}/v1/search  { query (1-2048 chars), max_results (1-20), location? }  -> { results: [{ title, outline, url }], metadata: { request_id } }
 *   POST {base}/v1/scrape  { url, output: ["html"], run_js?, location? }             -> { results: [{ html, url }], metadata: { request_id } }
 *
 * Used for two things only: reading a public page that REFUSED PRISM (403 / bot check) with output "html", so the existing
 * HTML and JSON-LD parsing still runs on it, and the keyless X search (lib/websearch.js, provider "oxylabs").
 *
 * Rules, enforced here so no caller can skip them:
 *   - the key comes from OXYLABS_WEB_API_KEY, goes out only as `Authorization: Bearer`, and is never logged or put in an error;
 *     without a key nothing is sent (no unauthenticated fallback);
 *   - a URL goes through lib/browser4.assertAllowed() first: takedowns, private hosts and non-http(s) URLs never leave PRISM.
 *     robots.txt is checked by the caller, as for a direct read, and the page then runs through the same pipeline gates;
 *   - success is any 2xx; retries (max 3 attempts, exponential backoff with jitter) only on a transport timeout and on
 *     408 / 429 / 5xx; 400 and 401 are surfaced at once with the field or a clear message; the request_id is logged on failures;
 *   - a daily request cap (setting oxylabsDailyBudget, 0 = never used): every attempt, retries included, is counted
 *     before it is sent, so the day never ends over the cap;
 *   - one URL is read at most once per 10 minutes (the answer is cached), and a page that comes back empty or as a block page
 *     is retried once with run_js, as the doc says.
 */
const config = require('../config');
const repo = require('../db/repo');
const net = require('./net');

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS = 3;
const TIMEOUT_MS = 150_000;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

const today = () => new Date().toISOString().slice(0, 10);
const key = () => String(config.creds.oxylabsKey || '').trim();
const configured = () => !!key();

/** Test seams: the HTTP call ((url, opts) -> {status, headers, body}) and the backoff sleep. */
let requester = null;
let sleeper = (ms) => new Promise((r) => setTimeout(r, ms));
function setRequester(fn) { requester = fn; }
function setSleep(fn) { sleeper = fn || ((ms) => new Promise((r) => setTimeout(r, ms))); }

function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('oxylabs.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}
function record() {
  const u = usage();
  repo.settings.set('oxylabs.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}
function dailyBudget() {
  try { return Number(require('../settings').get().oxylabsDailyBudget) || 0; } catch { return 0; }
}
function remaining(budget = dailyBudget()) { return Math.max(0, budget - usage().count); }

/** Take the key out of anything that may be logged or thrown. */
function redact(msg) {
  let s = String(msg || '');
  const k = key();
  if (k) s = s.split(k).join('***');
  return s.replace(/Bearer\s+\S+/gi, 'Bearer ***');
}

const fail = (message, extra = {}) => Object.assign(new Error(redact(message)), { ours: true, ...extra });
const isTimeout = (e) => /time(d)?\s?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(`${e && e.message} ${e && e.code}`);

function warn(path, status, requestId, detail) {
  console.warn(redact(`[oxylabs] ${path} -> ${status}${requestId ? ` (request_id ${requestId})` : ''}${detail ? `: ${detail}` : ''}`));
}

async function post(path, payload) {
  if (!configured()) throw fail('OXYLABS_WEB_API_KEY is not set', { skip: true });
  const budget = dailyBudget();
  if (!budget) throw fail('Oxylabs is off (setting oxylabsDailyBudget is 0)', { skip: true });
  const url = `${config.baseUrls.oxylabs}${path}`;
  const opts = {
    method: 'POST', body: JSON.stringify(payload), timeout: TIMEOUT_MS, retries: 0, maxBytes: 8_000_000,
    headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/json', accept: 'application/json' },
  };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Reserve the request BEFORE it is sent, in the same synchronous step as the check: concurrent callers (or a retry)
    // used to pass the check together while the count still said 99, and the day ended at 101 of 100.
    if (remaining(budget) <= 0) throw fail(`Oxylabs daily budget reached (${budget}/day)`, { budget: true });
    record();
    let res;
    try {
      res = requester ? await requester(url, opts) : await net.request(url, opts);
    } catch (e) {
      if (!isTimeout(e)) throw fail(`${path} -> ${e.message}`, { status: e.status || 0 });
      warn(path, 'timeout', null, `attempt ${attempt}/${ATTEMPTS}`);
      if (attempt === ATTEMPTS) throw fail(`${path} -> timed out after ${ATTEMPTS} attempts`, { status: 504, transient: true });
      await sleeper(2 ** attempt * 1000 + Math.random() * 1000);
      continue;
    }
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    const requestId = json && json.metadata && json.metadata.request_id;
    if (res.status >= 200 && res.status < 300) {
      if (!json) throw fail(`${path} -> ${res.status}: the answer was not JSON`, { status: 502, requestId });
      return json;
    }
    if (res.status === 401) {
      warn(path, 401, requestId, 'the API key was rejected');
      throw fail('Oxylabs rejected the API key (HTTP 401); check OXYLABS_WEB_API_KEY (a key for another Oxylabs product also 401s)', { status: 401, skip: true, requestId });
    }
    const title = json && json.title;
    const fields = json && Array.isArray(json.errors) ? json.errors.map((er) => `${er.pointer || '?'}: ${er.detail || ''}`).join('; ') : '';
    const detail = title ? `${title}${fields ? ` (${fields})` : json.detail ? ` (${json.detail})` : ''}` : text.slice(0, 300);
    if (!RETRYABLE.has(res.status) || attempt === ATTEMPTS) {
      warn(path, res.status, requestId, detail);
      throw fail(`${path} -> ${res.status}: ${detail}`, { status: res.status, requestId, budget: res.status === 429, transient: res.status >= 500 || res.status === 408 });
    }
    warn(path, res.status, requestId, `attempt ${attempt}/${ATTEMPTS}, retrying`);
    await sleeper(2 ** attempt * 1000 + Math.random() * 1000); // jitter: no lockstep retries
  }
  throw fail('unreachable');
}

/**
 * Web search. Results as {url, title, description}; `description` is the outline, which only locates a page.
 * @param {string} query
 * @param {{count?: number, location?: string}} opts
 */
async function search(query, { count = 10, location } = {}) {
  const q = String(query || '').trim().slice(0, 2048);
  if (!q) throw fail('empty query', { skip: true });
  const payload = { query: q, max_results: Math.min(Math.max(Number(count) || 10, 1), 20) };
  if (location && /^[A-Z]{2}$/.test(location)) payload.location = location;
  const json = await post('/v1/search', payload);
  return (Array.isArray(json.results) ? json.results : [])
    .filter((r) => r && /^https?:\/\//i.test(String(r.url || '')))
    .map((r) => ({ url: String(r.url), title: String(r.title || '').trim(), description: (Array.isArray(r.outline) ? r.outline.join(' ') : String(r.outline || '')).replace(/\s+/g, ' ').trim().slice(0, 500) }));
}

// A short, text-poor block page ("Just a moment...") is not the page.
const BLOCK_PAGE = /captcha|just a moment|access denied|cf-browser-verification|attention required|verify you are human/i;
const looksBlocked = (html) => { const t = String(html || ''); return !t.trim() || (t.length < 6000 && BLOCK_PAGE.test(t)); };

/**
 * Read one public page as HTML. Empty or block-page answers are retried once with run_js.
 * @returns {Promise<{html: string, url: string, blocked: boolean, requests: number}>}
 */
async function scrape(pageUrl, { location } = {}) {
  await require('./browser4').assertAllowed(pageUrl); // takedowns / private hosts never leave PRISM
  const hit = cache.get(pageUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };
  let requests = 0;
  const once = async (runJs) => {
    const payload = { url: pageUrl, output: ['html'] };
    if (runJs) payload.run_js = true;
    if (location && /^[A-Z]{2}$/.test(location)) payload.location = location;
    requests++;
    const json = await post('/v1/scrape', payload);
    const first = Array.isArray(json.results) ? json.results[0] : null;
    return { html: first && typeof first.html === 'string' ? first.html : '', url: (first && first.url) || pageUrl };
  };
  let out = await once(false);
  if (looksBlocked(out.html)) {
    try { out = await once(true); } catch { /* keep the first answer; it is reported as blocked */ }
  }
  const value = { ...out, blocked: looksBlocked(out.html), requests };
  if (!value.blocked) {
    cache.set(pageUrl, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return value;
}

module.exports = { configured, search, scrape, usage, remaining, dailyBudget, redact, looksBlocked, setRequester, setSleep, _clear: () => { cache.clear(); repo.settings.set('oxylabs.usage', '{}'); } };
