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
 *   - daily caps on requests (scrapflyBudget) and credits (scrapflyCreditBudget), and monthly caps on requests
 *     (scrapflyMonthlyBudget) and credits (scrapflyMonthlyCreditBudget), stop a call before it is made. Each attempt is checked
 *     against the cost_budget it actually sends. A COST_BUDGET_LIMIT answer is retried once at the escalated ceiling (80);
 *     that retry is only made when the caps can cover it;
 *   - a host where Scrapfly keeps finding nothing backs off (12 h, 24 h, 48 h, 72 h), tracked here in repo.settings.
 */
const config = require('../config');
const repo = require('../db/repo');
const settingsStore = require('../settings');
const http = require('../sources/http').forPlatform('scrapfly', 1000);
const { looksBlocked } = require('./brightdata');

const HOUR = 3600 * 1000;

/**
 * The allowlist (setting scrapflyAllowlist, one creator id or handle per line or comma-separated). The Scrapfly tier may spend
 * credits ONLY on a feed that belongs to one of these creators. Empty list = the tier never runs.
 */
function allowlist() {
  let raw = '';
  try { raw = settingsStore.get().scrapflyAllowlist || ''; } catch { raw = ''; }
  return new Set(String(raw).split(/[\n,]+/).map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean));
}

/** Does this feed belong to an allowlisted creator? Matches the creator id, the creator's handle, or a user feed's own handle. */
function allowedFor(feed) {
  const list = allowlist();
  if (!list.size || !feed) return false;
  if (feed.creator_id && list.has(String(feed.creator_id).toLowerCase())) return true;
  try {
    const c = feed.creator_id ? repo.creators.get(feed.creator_id) : null;
    if (c && c.handle && list.has(String(c.handle).toLowerCase())) return true;
  } catch { /* no creator row */ }
  if (feed.kind === 'user' && feed.target) {
    const handle = String(feed.target).split('@')[0].replace(/^@/, '').toLowerCase();
    if (handle && list.has(handle)) return true;
  }
  // A page feed (no creator row yet): an allowlisted handle of at least 6 characters in the URL's PATH. The host alone never
  // matches, and a short token such as 'logan' can never match, so a creator's own page is covered without a creator row.
  if (feed.target && /^https?:\/\//i.test(String(feed.target))) {
    let path = '';
    try { path = new URL(String(feed.target)).pathname.toLowerCase(); } catch { path = ''; }
    // Whole path segments only: the entry must be a segment, or start a segment and be followed by '-', '_' or '.'.
    // A substring anywhere in the path ('twinks' inside 'twinksandpics') must not spend credits on someone else's page.
    const segments = path.split('/').filter(Boolean);
    for (const entry of list) {
      if (entry.length < 6) continue;
      for (const seg of segments) {
        if (seg === entry || (seg.startsWith(entry) && /^[-_.]/.test(seg.slice(entry.length)))) return true;
      }
    }
  }
  return false;
}
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
  if (status === 401) return Object.assign(new Error('Scrapfly rejected the key (HTTP 401); check SCRAPFLY_API_KEY'), { skip: true, ours: true, status });
  if (status === 403) return Object.assign(new Error('Scrapfly refused this request (HTTP 403: no permission for this account or option)'), { skip: true, ours: true, status });
  if (status === 402) return Object.assign(new Error('Scrapfly account has no credit left (HTTP 402)'), { budget: true, ours: true, status });
  if (status === 429) return Object.assign(new Error('Scrapfly quota or concurrency limit hit (HTTP 429)'), { budget: true, ours: true, status });
  if (status === 422 && /COST_BUDGET_LIMIT/.test(String(rejectCode || ''))) return Object.assign(new Error(`Scrapfly stopped at the cost ceiling (HTTP 422: ${rejectCode})`), { status, costLimit: true, ours: true });
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
  const sc = config.scrapfly;
  const first = opts.costBudget || sc.costBudget;
  try {
    return await attempt(url, { ...opts, costBudget: first });
  } catch (e) {
    // The ONLY escalation rule: our ceiling refused the page, the caller allows it, and the caps can cover the 80-credit ceiling
    // (attempt() checks the caps against the budget it sends). The refused attempt's cost is carried over, once.
    if (!(opts.escalate && e.costLimit && sc.escalateCostBudget > first)) throw e;
    const refused = e.cost || 0;
    // Say WHY the escalation did not run, in words an admin can act on: our cap, not the site.
    const u = usage(); const cfg = settingsStore.get(); const esc = sc.escalateCostBudget;
    if (u.credits + esc > cfg.scrapflyCreditBudget) {
      throw Object.assign(new Error(`escalation refused: the daily credit cap is ${cfg.scrapflyCreditBudget}, the escalated ceiling needs ${esc} (used today: ${u.credits})`), { budget: true, escalationRefused: true, cost: refused });
    }
    if (u.monthCredits + esc > cfg.scrapflyMonthlyCreditBudget) {
      throw Object.assign(new Error(`escalation refused: the monthly credit cap is ${cfg.scrapflyMonthlyCreditBudget}, the escalated ceiling needs ${esc} (used this month: ${u.monthCredits})`), { budget: true, escalationRefused: true, cost: refused });
    }
    try {
      const r = await attempt(url, { ...opts, costBudget: esc });
      r.cost += refused;
      return r;
    } catch (e2) {
      e2.cost = refused + (e2.cost || 0);
      throw e2;
    }
  }
}

/** One request to Scrapfly. The caps are checked against the cost_budget this attempt will actually send, before it is sent. */
async function attempt(url, opts) {
  const cfg = settingsStore.get();
  const sc = config.scrapfly;
  const costBudget = opts.costBudget;
  const unblocker = opts.unblocker !== false;
  const renderJs = !!opts.renderJs;
  const u0 = usage();
  if (u0.count >= cfg.scrapflyBudget) throw Object.assign(new Error(`Scrapfly daily request budget reached (${cfg.scrapflyBudget}/day)`), { budget: true });
  if (u0.monthCount >= cfg.scrapflyMonthlyBudget) throw Object.assign(new Error(`Scrapfly monthly request budget reached (${cfg.scrapflyMonthlyBudget}/month)`), { budget: true });
  const reserve = reserveFor({ unblocker, renderJs, costBudget });
  if (u0.credits + reserve > cfg.scrapflyCreditBudget) {
    throw Object.assign(new Error(`Scrapfly daily credit budget reached (${u0.credits} of ${cfg.scrapflyCreditBudget} used; this call may cost up to ${reserve})`), { budget: true });
  }
  if (u0.monthCredits + reserve > cfg.scrapflyMonthlyCreditBudget) {
    throw Object.assign(new Error(`Scrapfly monthly credit budget reached (${u0.monthCredits} of ${cfg.scrapflyMonthlyCreditBudget} used; this call may cost up to ${reserve})`), { budget: true });
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
    const bodyText = res.body ? res.body.toString('utf8', 0, 600) : '';
    const reject = String(headers['x-scrapfly-reject-code'] || (/COST_BUDGET_LIMIT/.test(bodyText) ? 'ERR::SCRAPE::COST_BUDGET_LIMIT' : '')).slice(0, 80);
    // A 422 was processed by Scrapfly (counts as a request); the account errors 401/402/403/429 are not billed scrapes.
    record(res.status === 422 || res.status < 400 ? cost : 0);
    const err = apiError(res.status, reject);
    err.cost = cost;
    throw err;
  }
  record(cost);
  let body;
  try { body = JSON.parse(res.body.toString('utf8')); } catch { throw Object.assign(new Error('Scrapfly returned an answer that is not JSON'), { status: 502, transient: true }); }
  const r = (body && body.result) || {};
  const html = String(r.content || '');
  const status = Number(r.status_code) || 0;
  const blocked = status >= 400 || !html || looksBlocked(html);
  return { status, html, headers: r.headers || {}, cost, remaining, costBudget, blocked };
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

/**
 * The one fallback every caller uses (web pages as HTML, Mastodon-style APIs as JSON). Owns, in one place: the local gate
 * (inside scrape), the daily request, daily credit and monthly caps (inside scrape), the cost-capped unblocker call, the
 * block-page check, the per-host back-off, and the optional JavaScript-rendered retry.
 *
 * @param {string} url
 * @param {{json?: boolean, parse?: (html: string, headers: object) => any, count?: (value: any) => number, host?: string}} opts
 *   json: parse the answer as JSON. parse: custom parser for HTML (throw, or return null, to say "not the page").
 *   count: how many useful things the answer holds (drives the back-off and whether the JS-rendered retry runs).
 * @returns {Promise<{value: any, cost: number, rendered: boolean}>} throws skip / budget / status errors like scrape().
 */
async function read(url, { json = false, parse, count, host, allowed = false, escalate = true } = {}) {
  if (!allowed) throw Object.assign(new Error('this creator is not on the Scrapfly allowlist (setting scrapflyAllowlist)'), { skip: true });
  const h = host || hostOfUrl(url);
  const v = decide(h);
  if (!v.ok) throw Object.assign(new Error(v.why), { skip: true });
  const toValue = (r) => {
    if (r.blocked) return null;
    try {
      if (parse) return parse(r.html, r.headers);
      if (json) return JSON.parse(r.html);
      return r.html;
    } catch { return null; }
  };
  const n = (value) => (value == null || (value && value.optedOut) ? 0 : (count ? count(value) : 1));
  const cfgSc = config.scrapfly;
  let cost = 0; let rendered = false; let value = null;
  try {
    const first = await scrape(url, { unblocker: true, renderJs: false, escalate: !!escalate });
    cost += first.cost;
    value = toValue(first);
    if (value && value.optedOut) {
      // Our own opt-out (noindex / nopin / takedown) wins exactly as it does for the plain read: not content, not a refusal.
      return { value, cost, rendered, optedOut: true };
    }
    if (!json && n(value) === 0 && value != null) {
      // A JavaScript-built page: one rendered retry at the first ceiling (the scrape() budget checks run again).
      rendered = true;
      const second = await scrape(url, { unblocker: true, renderJs: true });
      cost += second.cost;
      const v2 = toValue(second);
      if (v2 != null && (v2.optedOut || n(v2) > n(value))) value = v2;
      if (value && value.optedOut) return { value, cost, rendered, optedOut: true };
    }
  } catch (e) {
    // A refusal or a failed answer counts toward the back-off. Our own limits (budget, ceiling, account) never do.
    if (!e.skip && !e.budget && !e.ours) recordHost(h, { found: 0 });
    e.cost = cost + (e.cost || 0); // cost of earlier successful phases + this failing phase (counted once)
    throw e;
  }
  if (value == null) {
    recordHost(h, { found: 0 });
    throw Object.assign(new Error('Scrapfly returned a block page or an unreadable answer, not the page'), { status: 502, cost });
  }
  recordHost(h, { found: n(value) });
  return { value, cost, rendered };
}

function hostOfUrl(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }

module.exports = { configured, scrape, read, attempt, allowlist, allowedFor, usage, buildParams, reserveFor, redact, decide, recordHost, hostState, setRequester, apiError };
