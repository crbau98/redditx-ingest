'use strict';
/**
 * Bright Data Discover API (https://docs.brightdata.com): web search ranked by AI relevance to an INTENT, not by keywords.
 * It is used as one more search provider (lib/websearch.js), so discovery and creator lookup find public creator pages,
 * galleries and link hubs the other engines rank poorly.
 *
 *   POST /discover  { query, intent, mode, num_results }   ->  { task_id }
 *   GET  /discover?task_id=...   until status === "done"   ->  { results: [{ link, title, description, relevance_score }] }
 *
 * Each search costs credit, so it counts against the same daily budget as Brave and Keenable. The token is read from
 * BRIGHTDATA_API_TOKEN (or BRIGHTDATA_API_KEY) and is sent only as a Bearer header.
 *
 * Web Unlocker (opt-in, paid, see unlock()): a public page that refused PRISM's own request is fetched through Bright Data's
 * unblocking network instead. It is off by default (setting brightdataUnlocker) and only ever called for a page that
 * REFUSED us - never for a paywalled or leak host, a takedown, a private address or a robots.txt disallow.
 */
const config = require('../config');
const http = require('../sources/http').forPlatform('brightdata', 400);
const repo = require('../db/repo');
const leaks = require('./leaks');
const { isPaywalledHost } = require('./brave');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const configured = () => !!config.creds.brightdataKey;
const auth = () => ({ authorization: `Bearer ${config.creds.brightdataKey}`, 'content-type': 'application/json', accept: 'application/json' });

function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('brightdata.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}
function record() {
  const u = usage();
  repo.settings.set('brightdata.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}

/** Rows -> {url, title, description, relevance}, best first. Leak sites and paywalled hosts never come out of here. */
function parseResults(rows, { minRelevance = 0 } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const url = String((r && (r.link || r.url)) || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    if (leaks.isLeakUrl(url) || isPaywalledHost(url)) continue;
    const relevance = Number(r.relevance_score);
    if (Number.isFinite(relevance) && relevance < minRelevance) continue;
    seen.add(url);
    out.push({ url, title: String(r.title || '').trim(), description: String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 500), relevance: Number.isFinite(relevance) ? relevance : null });
  }
  return out.sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1));
}

const failure = (e, what) => {
  if (e.status === 401 || e.status === 403) return Object.assign(new Error(`Bright Data rejected the token (HTTP ${e.status}) during ${what}; check BRIGHTDATA_API_TOKEN and that Discover is enabled on the account`), { skip: true, status: e.status });
  if (e.status === 402 || e.status === 429) return Object.assign(new Error(`Bright Data quota or rate limit hit (HTTP ${e.status})`), { budget: true, status: e.status });
  return e;
};

/**
 * @param {string} q
 * @param {{count?: number, budget?: number, intent?: string}} opts `intent` overrides BRIGHTDATA_DISCOVER_INTENT for this query
 */
async function search(q, { count = 20, budget = 40, intent } = {}) {
  if (!configured()) throw Object.assign(new Error('BRIGHTDATA_API_TOKEN is not set'), { skip: true });
  if (usage().count >= budget) throw Object.assign(new Error(`Bright Data daily budget reached (${budget}/day; raise the budget or add another search provider)`), { budget: true });
  const base = config.baseUrls.brightdata;
  let task;
  try {
    task = await http.json(`${base}/discover`, { method: 'POST', retries: 1, headers: auth(), body: JSON.stringify({ query: String(q).slice(0, 1500), intent: (intent || config.brightdata.intent).slice(0, 3000), mode: 'standard', num_results: Math.min(Math.max(count, 1), 20), remove_duplicates: true }) });
  } catch (e) { throw failure(e, 'the search request'); }
  if (!task || !task.task_id) throw Object.assign(new Error(`Bright Data did not start the search${task && task.error ? `: ${String(task.error).slice(0, 120)}` : ''}`), { status: 502 });
  record(); // the request reached the API and was accepted: it costs credit whatever happens next

  const deadline = Date.now() + config.brightdata.timeoutMs;
  for (;;) {
    let r;
    try { r = await http.json(`${base}/discover?task_id=${encodeURIComponent(task.task_id)}`, { headers: auth(), retries: 1 }); } catch (e) { throw failure(e, 'polling'); }
    if (r && r.status === 'done') return parseResults(r.results, config.brightdata).slice(0, count);
    if (r && (r.status === 'failed' || r.status === 'error')) throw Object.assign(new Error(`Bright Data search failed: ${String(r.error || r.message || r.status).slice(0, 160)}`), { status: 502 });
    if (Date.now() + config.brightdata.pollMs > deadline) throw Object.assign(new Error(`Bright Data search did not finish within ${Math.round(config.brightdata.timeoutMs / 1000)}s`), { status: 504 });
    await sleep(config.brightdata.pollMs);
  }
}

/* ------------------------------------------------------------ Web Unlocker */
const unlockerConfigured = () => !!(config.creds.brightdataKey && config.brightdata.unlockerZone);
const browserConfigured = () => !!config.brightdata.browserWss;

function unlockUsage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('brightdata.unlock.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}
function recordUnlock() {
  const u = unlockUsage();
  repo.settings.set('brightdata.unlock.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}

/** Spend one unit of the daily unlock budget up front (the remote Browser API bills per use, not per HTML answer). */
function reserveUnlock(budget) {
  if (unlockUsage().count >= budget) throw Object.assign(new Error(`Bright Data unlock budget reached (${budget}/day)`), { budget: true });
  recordUnlock();
}

// What an unlocker answer looks like when it did not get through (the same signatures Bright Data's own guidance checks for).
const BLOCK_PAGE = /captcha|just a moment|access denied|cf-browser-verification|attention required|unusual traffic|are you a robot|verify you are human/i;
/** Is this HTML a block page rather than the page? Only short, text-poor documents are judged: a real page may mention "captcha". */
const looksBlocked = (html) => { const t = String(html || ''); return t.length < 6000 && BLOCK_PAGE.test(t); };

/** Take credentials out of anything that may be logged or stored. */
const redact = (msg) => String(msg || '').replace(/wss?:\/\/[^@\s]+@/gi, 'wss://***@').replace(/Bearer\s+\S+/gi, 'Bearer ***');

/**
 * Fetch one public page through the Web Unlocker. Every precondition that keeps PRISM's content policy intact is checked HERE,
 * inside the only function that sends a URL to Bright Data, so no caller can forget it: the URL must be a public http(s) page
 * (an internal address is never handed to a third party) and not a leak site, a paywalled host or a takedown.
 * @returns {Promise<{html: string, status: number}>}
 */
async function unlock(url, { budget = 100, country } = {}) {
  if (!unlockerConfigured()) throw Object.assign(new Error('BRIGHTDATA_API_TOKEN and BRIGHTDATA_UNLOCKER_ZONE must both be set'), { skip: true });
  await require('./browser4').assertAllowed(url);
  if (unlockUsage().count >= budget) throw Object.assign(new Error(`Bright Data unlock budget reached (${budget}/day)`), { budget: true });
  let res;
  try {
    res = await http.raw(`${config.baseUrls.brightdata}/request`, {
      method: 'POST', retries: 0, timeout: 90000, maxBytes: 3_500_000, headers: auth(),
      body: JSON.stringify({ zone: config.brightdata.unlockerZone, url, format: 'raw', ...(country ? { country } : {}) }),
    });
  } catch (e) { throw failure(e, 'the unlock request'); }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Bright Data rejected the token or zone (HTTP ${res.status}); check BRIGHTDATA_API_TOKEN and BRIGHTDATA_UNLOCKER_ZONE`), { skip: true, status: res.status });
  if (res.status === 402 || res.status === 429) throw Object.assign(new Error(`Bright Data quota or rate limit hit (HTTP ${res.status})`), { budget: true, status: res.status });
  recordUnlock(); // the request reached the service: count it, whatever it brought back
  const html = res.body.toString('utf8');
  if (res.status >= 400) throw Object.assign(new Error(`Bright Data could not fetch the page (HTTP ${res.status}${res.headers['x-brd-err-msg'] ? `: ${String(res.headers['x-brd-err-msg']).slice(0, 120)}` : ''})`), { status: res.status });
  if (looksBlocked(html)) throw Object.assign(new Error('Bright Data returned a block page, not the page'), { status: 502 });
  return { html, status: res.status };
}

module.exports = { search, configured, usage, parseResults, unlock, unlockerConfigured, browserConfigured, unlockUsage, reserveUnlock, redact, looksBlocked };
