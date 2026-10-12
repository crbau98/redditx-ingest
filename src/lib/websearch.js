'use strict';
/**
 * Web search for discovery and creator lookup, with more than one backend so a single outage, quota or missing
 * key does not switch the whole feature off:
 *
 *   keenable Keenable, a search engine built for AI agents (KEENABLE_API_KEY), daily budget enforced by lib/keenable
 *   brave    Brave Search API (BRAVE_API_KEY), daily budget enforced by lib/brave
 *   searxng  a SearXNG instance's JSON API (SEARXNG_URL), free and self-hostable, no per-query budget
 *
 * `search(q)` tries the configured providers in order (SEARCH_PROVIDERS, default "keenable,brave,searxng"), falls
 * through on errors / empty answers / exhausted budgets, and caches answers for ten minutes so a lookup that
 * repeats a query (or a retry) costs nothing. Results are always `{url, title, description}`.
 */
const config = require('../config');
const brave = require('./brave');
const keenable = require('./keenable');
const http = require('../sources/http').forPlatform('searxng', 800);

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();

const searxngUrl = () => String(config.searxngUrl || '').replace(/\/+$/, '');

const PROVIDERS = {
  keenable: {
    configured: () => keenable.configured(),
    search: (q, o) => keenable.search(q, o),
  },
  brave: {
    configured: () => brave.configured(),
    search: (q, o) => brave.search(q, o),
  },
  searxng: {
    configured: () => !!searxngUrl(),
    async search(q, { count = 20 } = {}) {
      const json = await http.json(`${searxngUrl()}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0&language=all`, { allowInternal: true, timeout: /\.onion(?::|\/|$)/i.test(searxngUrl()) ? 70000 : 20000 }); // the only caller allowed to reach INTERNAL_HOSTS
      return (json.results || []).slice(0, count).map((r) => ({ url: r.url, title: strip(r.title), description: strip(r.content) })).filter((r) => r.url);
    },
  },
};

const order = () => (config.searchProviders || ['keenable', 'brave', 'searxng']).filter((p) => PROVIDERS[p]);
const configured = () => order().some((p) => PROVIDERS[p].configured());

function status() {
  return {
    configured: configured(),
    providers: order().map((p) => ({ name: p, configured: PROVIDERS[p].configured() })),
    brave: { configured: brave.configured(), usage: brave.usage() },
    keenable: { configured: keenable.configured(), usage: keenable.usage() },
  };
}

/**
 * @param {string} q
 * @param {{count?: number, budget?: number, fresh?: boolean, site?: string}} opts `budget` = metered calls per day (Brave, Keenable); `site` restricts results to one domain
 * @returns {Promise<Array<{url,title,description}> & {provider?: string}>}
 */
async function search(q, { count = 20, budget = 40, fresh = false, site } = {}) {
  const key = `${count}|${site || ''}|${q}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  const providers = order().filter((p) => PROVIDERS[p].configured());
  if (!providers.length) throw Object.assign(new Error('No web search configured: set BRAVE_API_KEY or SEARXNG_URL'), { skip: true });
  let lastErr;
  for (const name of providers) {
    try {
      // Keenable filters by site natively; the others get a site: operator in the query.
      const results = await PROVIDERS[name].search(site && name !== 'keenable' ? `${q} site:${site}` : q, { count, budget, site });
      if (!results.length && providers.length > 1 && name !== providers[providers.length - 1]) { lastErr = lastErr || new Error(`${name}: no results`); continue; }
      Object.defineProperty(results, 'provider', { value: name, enumerable: false });
      cache.set(key, { at: Date.now(), results });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return results;
    } catch (e) { lastErr = e; } // budget spent / key rejected / outage: next provider
  }
  throw lastErr || new Error('web search failed');
}

function _clear() { cache.clear(); }

module.exports = { search, configured, status, PROVIDERS, _clear };
