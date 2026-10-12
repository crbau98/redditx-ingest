'use strict';
/**
 * Brave Search API client (https://api.search.brave.com). Used by discovery to
 * find creators' profiles across platforms. Every call counts against a daily
 * budget (Admin → Settings) so a plan's monthly quota is never blown by a loop.
 */
const config = require('../config');
const http = require('../sources/http').forPlatform('brave', 1100); // free plan: 1 request / second
const repo = require('../db/repo');

const today = () => new Date().toISOString().slice(0, 10);

function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('brave.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}

function record() {
  const u = usage();
  repo.settings.set('brave.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}

const configured = () => !!config.creds.braveKey;

/** "1, 18000" style X-RateLimit-* headers: [per-second, per-month] values. */
const pair = (h) => String(h || '').split(',').map((x) => Number(x.trim()));

/**
 * @param {string} q
 * @param {{count?: number, budget?: number}} opts budget = max calls per day
 * @returns {Promise<Array<{url: string, title: string, description: string}>>}
 */
async function search(q, { count = 20, budget = 40 } = {}) {
  if (!configured()) throw Object.assign(new Error('BRAVE_API_KEY is not set'), { skip: true });
  if (usage().count >= budget) throw Object.assign(new Error(`Brave daily budget reached (${budget})`), { budget: true });
  record();
  const url = `${config.baseUrls.brave}/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(20, count)}&safesearch=off&spellcheck=0&text_decorations=0`;
  const headers = { accept: 'application/json', 'x-subscription-token': config.creds.braveKey };
  // Raw so the rate-limit headers are readable: Brave's free plan allows 1 request/second and a monthly quota, and a
  // 429 means different things for each (wait a second vs. stop until next month).
  let res = await http.raw(url, { headers, retries: 0 });
  if (res.status === 429) {
    if (pair(res.headers['x-ratelimit-remaining'])[1] === 0) throw Object.assign(new Error('Brave monthly quota is used up'), { status: 429, budget: true });
    const wait = Math.min(Math.max((pair(res.headers['x-ratelimit-reset'])[0] || 1) * 1000, 1100), 5000);
    await new Promise((r) => setTimeout(r, wait));
    res = await http.raw(url, { headers, retries: 0 });
    if (res.status === 429) throw Object.assign(new Error('Brave rate limit hit (HTTP 429); will retry on the next discovery run'), { status: 429, retryAfter: wait * 4 });
  }
  if (res.status === 401 || res.status === 403 || res.status === 422) {
    // Key rejected / plan lacks web search: a configuration problem, not an outage.
    throw Object.assign(new Error(`Brave rejected the API key (HTTP ${res.status}); check BRAVE_API_KEY and that the plan includes Web Search`), { skip: true, status: res.status });
  }
  if (res.status >= 400) throw Object.assign(new Error(`Brave search failed (HTTP ${res.status})`), { status: res.status });
  let json;
  try { json = JSON.parse(res.body.toString('utf8')); } catch { throw Object.assign(new Error('Brave returned a non-JSON response'), { status: res.status }); }
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, '');
  return ((json.web && json.web.results) || []).map((r) => ({ url: r.url, title: strip(r.title), description: strip(r.description) })).filter((r) => r.url);
}

module.exports = { search, usage, configured };
