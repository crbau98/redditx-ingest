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
  const json = await http.json(url, { headers: { accept: 'application/json', 'x-subscription-token': config.creds.braveKey }, retries: 1 });
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, '');
  return ((json.web && json.web.results) || []).map((r) => ({ url: r.url, title: strip(r.title), description: strip(r.description) })).filter((r) => r.url);
}

module.exports = { search, usage, configured };
