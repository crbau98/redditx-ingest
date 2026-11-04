'use strict';
/**
 * Scrapfly Scrape API (https://scrapfly.io/docs/scrape-api): a paid unblock/render tier, used only as a FALLBACK for a
 * public page that already REFUSED PRISM (see sources/web.js unlockedRead). Direct download and the local browser still
 * come first, and Bright Data's unlocker is tried before this.
 *
 *   GET {SCRAPFLY_BASE_URL}?url=<page>&key=<key>&unblocker=true&render_js=...&cost_budget=...
 *   -> { result: { content, status_code, headers, format }, config: {...} }
 *
 * Hard rules, enforced here so no caller can skip them:
 *   - the URL goes through lib/browser4.assertAllowed() first: takedowns, private/loopback hosts, non-http(s) URLs and URLs
 *     with embedded credentials are refused, and nothing is sent to Scrapfly;
 *   - the key is only ever sent as the `key` query parameter. It is redacted from every error message and is never logged;
 *   - daily caps on requests (setting scrapflyBudget) and credits (setting scrapflyCreditBudget) stop the call before it is made;
 *   - a host where Scrapfly keeps finding nothing backs off (12 h, 24 h, 48 h, 72 h), tracked here in repo.settings.
 */
const config = require('../config');
const repo = require('../db/repo');
const settingsStore = require('../settings');
const http = require('../sources/http').forPlatform('scrapfly', 1000);
const { looksBlocked } = require('./brightdata');

const HOUR = 3600 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const configured = () => !!config.creds.scrapflyKey;

/** Test seam: replaces the HTTP call. Receives (url, opts) and resolves to { status, headers, body: Buffer }. */
let requester = null;
function setRequester(fn) { requester = fn; }

/** Daily and monthly counters. The account is on a monthly plan, so the month is capped too (scrapflyMonthlyBudget). */
function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('scrapfly.usage') || '{}'); } catch { u = {}; }
  const day = u.day === today() ? u : { day: today(), count: 0, credits: 0 };
  const month = u.month === thisMonth() ? u.monthCount || 0 : 0;
  const monthCredits = u.month === thisMonth() ? u.monthCredits || 0 : 0;
  return { day: day.day, count: day.count || 0, credits: day.credits || 0, month: thisMonth(), monthCount: month, monthCredits, total: u.total || 0, totalCredits: u.totalCredits || 0 };
}
/** Count one request that was sent, with the credits the API reported for it (from x-scrapfly-api-cost). */
function record(credits) {
  const u = usage();
  const c = Number(credits) || 0;
  repo.settings.set('scrapfly.usage', JSON.stringify({
    day: u.day, count: u.count + 1, credits: u.credits + c,
    month: u.month, monthCount: u.monthCount + 1, monthCredits: u.monthCredits + c,
    total: u.total + 1, totalCredits: u.totalCredits + c,
  }));
}

/** Remove the key from anything that may be logged or thrown: the key itself, and any key= query parameter. */
function redact(msg) {
  let s = String(msg || '');
  const k = config.creds.scrapflyKey;
  if (k) s = s.split(k).join('***');
  return s.replace(/([?&]key=)[^&\s'"]+/gi, '$1***');
}

/** Credits one call may cost (worst case): the unblocker burns up to costBudget, a JS render adds 5. */
function reserveFor({ unblocker, renderJs, costBudget }) {
  return (unblocker ? costBudget : 1) + (renderJs ? 5 : 0);
}

/**
 * The query string for one call. Only the parameters we use are set; optional ones only when configured.
 * Exported for tests (the key is included here, so never log the result).
 */
function buildParams(url, { unblocker = true, renderJs = false, costBudget = 30, country, proxyPool = 'public_datacenter_pool', renderWaitMs = 3000 } = {}, key = config.creds.scrapflyKey) {
  const p = new URLSearchParams({ url, key });
  if (unblocker) {
    p.set('unblocker', 'true');
    p.set('cost_budget', String(costBudget));
    p.set('proxy_pool', proxyPool); // datacenter first: Scrapfly escalates on its own when a page needs more
  }
  if (renderJs) {
    p.set('render_js', 'true');
    p.set('rendering_wait', String(renderWaitMs));
  }
  if (country) p.set('country', country);
  return p;
}

/** Map a Scrapfly HTTP status to the error kinds the callers already understand (skip / budget / status). */
function apiError(status, rejectCode) {
  if (status === 401) return Object.assign(new Error('Scrapfly rejected the key (HTTP 401); check SCRAPFLY_API_KEY'), { skip: true, status });
  if (status === 403) return Object.assign(new Error('Scrapfly refused this request (HTTP 403: no permission for this account or option)'), { skip: true, status });
  if (status === 402) return Object.assign(new Error('Scrapfly account has no credit left (HTTP 402)'), { budget: true, status });
  if (status === 429) return Object.assign(new Error('Scrapfly quota or concurrency limit hit (HTTP 429)'), { budget: true, status });
  if (status === 422) return Object.assign(new Error(`Scrapfly could not fetch the page (HTTP 422${rejectCode ? `: ${rejectCode}` : ''})`), { status, target: true });
  return Object.assign(new Error(`Scrapfly is unavailable (HTTP ${status})`), { status, transient: true });
}

/**
 * Fetch one public page through Scrapfly.
 * @returns {Promise<{status: number, html: string, headers: object, cost: number, remaining: number|null, blocked: boolean}>}
 *   `status` is the status of the TARGET page; `blocked` is true when the answer is a block page or a refusal (not content).
 */
async function scrape(url, opts = {}) {
  if (!configured()) throw Object.assign(new Error('SCRAPFLY_API_KEY (or SCRAPFLY_API_KEY_FILE) is not set'), { skip: true });
  // The local content gate comes first: a takedown, a private host or a non-public URL is never sent to a third party.
  await require('./browser4').assertAllowed(url);
  const cfg = settingsStore.get();
  const sc = config.scrapfly;
  const costBudget = opts.costBudget || sc.costBudget;
  const unblocker = opts.unblocker !== false;
  const renderJs = !!opts.renderJs;
  const u0 = usage();
  if (u0.count >= cfg.scrapflyBudget) throw Object.assign(new Error(`Scrapfly daily request budget reached (${cfg.scrapflyBudget}/day)`), { budget: true });
  if (u0.monthCount >= cfg.scrapflyMonthlyBudget) throw Object.assign(new Error(`Scrapfly monthly request budget reached (${cfg.scrapflyMonthlyBudget}/month)`), { budget: true });
  const reserve = reserveFor({ unblocker, renderJs, costBudget });
  if (u0.credits + reserve > cfg.scrapflyCreditBudget) {
    throw Object.assign(new Error(`Scrapfly daily credit budget reached (${u0.credits} of ${cfg.scrapflyCreditBudget} used; this call may cost up to ${reserve})`), { budget: true });
  }
  const params = buildParams(url, { unblocker, renderJs, costBudget, country: sc.country, proxyPool: sc.proxyPool || undefined, renderWaitMs: sc.renderWaitMs });
  const endpoint = `${sc.baseUrl}?${params.toString()}`;
  let res;
  try {
    res = requester
      ? await requester(endpoint, { timeoutMs: sc.timeoutMs })
      : await http.raw(endpoint, { timeout: sc.timeoutMs, maxBytes: 8_000_000, retries: 0 });
  } catch (e) {
    // A network or timeout error: the request may have been billed, so it counts as an attempt; the message never carries the key.
    record(0);
    const err = new Error(redact(e && e.message));
    err.status = e && e.status; err.transient = true;
    throw err;
  }
  const headers = res.headers || {};
  const cost = Number(headers['x-scrapfly-api-cost']) || 0;
  const remaining = headers['x-scrapfly-remaining-api-credit'] != null ? Number(headers['x-scrapfly-remaining-api-credit']) : null;
  if (res.status !== 200) {
    const reject = String(headers['x-scrapfly-reject-code'] || '').slice(0, 80);
    if (res.status === 422) record(cost);
    else if (res.status < 400) record(cost);
    else record(0);
    throw apiError(res.status, reject);
  }
  record(cost);
  let body;
  try { body = JSON.parse(res.body.toString('utf8')); } catch { throw Object.assign(new Error('Scrapfly returned an answer that is not JSON'), { status: 502, transient: true }); }
  const r = (body && body.result) || {};
  const html = String(r.content || '');
  const status = Number(r.status_code) || 0;
  const blocked = status >= 400 || !html || looksBlocked(html);
  return { status, html, headers: r.headers || {}, cost, remaining, blocked };
}

/* ------------------------------------------------------- per-host back-off */
const hostKey = (host) => `scrapfly.host.${host}`;
function hostState(host) {
  try { return JSON.parse(repo.settings.get(hostKey(host)) || '{}'); } catch { return {}; }
}

/** Should Scrapfly be tried for this host right now? */
function decide(host) {
  const s = hostState(host);
  if (s.after && Date.parse(s.after) > Date.now()) return { ok: false, why: `Scrapfly found nothing on ${host} ${s.streak}x in a row; next try after ${s.after.slice(0, 16).replace('T', ' ')} UTC` };
  return { ok: true, why: 'Scrapfly fallback' };
}

/** Remember the outcome for a host: `found` = media or links in what came back. */
function recordHost(host, { found }) {
  if (!host) return;
  const s = hostState(host);
  const streak = found > 0 ? 0 : (s.streak || 0) + 1;
  const after = found > 0 ? null : new Date(Date.now() + Math.min(72, 12 * 2 ** (streak - 1)) * HOUR).toISOString();
  repo.settings.set(hostKey(host), JSON.stringify({ runs: (s.runs || 0) + 1, wins: (s.wins || 0) + (found > 0 ? 1 : 0), streak, after }));
}

module.exports = { configured, scrape, usage, buildParams, reserveFor, redact, decide, recordHost, hostState, setRequester, apiError };
