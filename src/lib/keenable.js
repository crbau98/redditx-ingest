'use strict';
/**
 * Keenable web search (https://keenable.ai): a search engine built for AI agents, spoken to over MCP's streamable HTTP
 * transport. The server is stateless, so one JSON-RPC `tools/call` POST per search is enough (no session handshake).
 *
 *   tool `search_web_pages`  { query, site?, ... }  ->  text blocks:  "Title: ..\nURL: ..\nAcquired: ..\nSnippets:\n..\n\n---\n\n"
 *
 * Every call counts against a daily budget (Admin → Settings), like Brave, because each search costs a credit.
 * The key is read from KEENABLE_API_KEY and is sent only in the X-API-Key header.
 */
const config = require('../config');
const http = require('../sources/http').forPlatform('keenable', 300);
const repo = require('../db/repo');

const today = () => new Date().toISOString().slice(0, 10);
const configured = () => !!config.creds.keenableKey;

function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('keenable.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}
function record() {
  const u = usage();
  repo.settings.set('keenable.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}

/** Split the text answer into {url, title, description}. */
function parseResults(text) {
  const out = [];
  for (const block of String(text || '').split(/\n-{3,}\n/)) {
    const url = (/^URL:\s*(\S+)/m.exec(block) || [])[1];
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = (/^Title:\s*(.*)$/m.exec(block) || [])[1] || '';
    const snip = block.split(/^Snippets:\s*$/m)[1] || '';
    out.push({ url, title: title.trim(), description: snip.replace(/\s+/g, ' ').trim().slice(0, 500) });
  }
  return out;
}

/**
 * @param {string} q
 * @param {{count?: number, budget?: number, site?: string}} opts
 */
async function search(q, { count = 20, budget = 200, site } = {}) {
  if (!configured()) throw Object.assign(new Error('KEENABLE_API_KEY is not set'), { skip: true });
  if (usage().count >= budget) throw Object.assign(new Error(`Keenable daily budget reached (${budget})`), { budget: true });
  record();
  const args = { query: q };
  if (site) args.site = site;
  let json;
  try {
    json = await http.json(config.baseUrls.keenable, {
      method: 'POST', retries: 1,
      headers: { 'x-api-key': config.creds.keenableKey, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_web_pages', arguments: args } }),
    });
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw Object.assign(new Error(`Keenable rejected the API key (HTTP ${e.status}); check KEENABLE_API_KEY`), { skip: true, status: e.status });
    if (e.status === 402 || e.status === 429) throw Object.assign(new Error(`Keenable quota or rate limit hit (HTTP ${e.status})`), { budget: true, status: e.status });
    throw e;
  }
  if (json && json.error) throw Object.assign(new Error(`Keenable: ${String(json.error.message || 'error').slice(0, 160)}`), { status: 502 });
  const text = ((json && json.result && json.result.content) || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n---\n');
  if (json && json.result && json.result.isError) throw Object.assign(new Error(`Keenable: ${text.slice(0, 160) || 'tool error'}`), { status: 502 });
  return parseResults(text).slice(0, count);
}

module.exports = { search, configured, usage, parseResults };
