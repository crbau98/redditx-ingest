'use strict';
/**
 * Web search for discovery and creator lookup, with more than one backend so a single outage, quota or missing
 * key does not switch the whole feature off:
 *
 *   keenable Keenable, a search engine built for AI agents (KEENABLE_API_KEY), daily budget enforced by lib/keenable
 *   brave    Brave Search API (BRAVE_API_KEY), daily budget enforced by lib/brave
 *   brightdata Bright Data Discover (BRIGHTDATA_API_TOKEN): intent-ranked results, daily budget enforced by lib/brightdata
 *   ddg      DuckDuckGo's HTML endpoint, keyless (DDG_SEARCH=1)
 *   searxng  a SearXNG instance's JSON API (SEARXNG_URL), free and self-hostable, no per-query budget.
 *            Set SEARXNG_ENGINES=duckduckgo,yandex,brave to pick the engines it queries (Yandex goes through here)
 *   claude   Claude's web search tool (ANTHROPIC_API_KEY), last resort; daily budget enforced by lib/claude
 *
 * `search(q)` tries the configured providers in order (SEARCH_PROVIDERS, default "keenable,brave,searxng"), falls
 * through on errors / empty answers / exhausted budgets, and caches answers for ten minutes so a lookup that
 * repeats a query (or a retry) costs nothing. Results are always `{url, title, description}`.
 */
const config = require('../config');
const brave = require('./brave');
const keenable = require('./keenable');
const brightdata = require('./brightdata');
const claude = require('./claude');
const http = require('../sources/http').forPlatform('searxng', 800);

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();

const cheerio = require('cheerio');
const ddgHttp = require('../sources/http').forPlatform('ddg', 1500);
// Bing has its own limiter key: sharing DDG's meant a DuckDuckGo 429 penalty (30 s+) delayed Bing
// too, and Bing's own spacing to be whatever DDG's was. Different hosts, different keys.
const bingHttp = require('../sources/http').forPlatform('bing', 900);

/** DuckDuckGo's two HTML endpoints, overridable so tests can point them at a local (or dead) server
 * instead of the live site: DDG_HTML_URL/DDG_LITE_URL set the exact base, DDG_BASE_URL sets both. */
const ddgHtmlUrl = (q) => {
  const b = String(process.env.DDG_HTML_URL || process.env.DDG_BASE_URL || 'https://html.duckduckgo.com').replace(/\/+$/, '');
  return `${b.endsWith('/html') ? b : `${b}/html`}/?q=${encodeURIComponent(q)}&kp=-2`;
};
const ddgLiteUrl = (q) => {
  const b = String(process.env.DDG_LITE_URL || process.env.DDG_BASE_URL || 'https://lite.duckduckgo.com').replace(/\/+$/, '');
  return `${b.endsWith('/lite') ? b : `${b}/lite`}/?q=${encodeURIComponent(q)}&kl=us-en&kp=-2`;
};
/**
 * DuckDuckGo's anti-bot layer answers a GET (or any request without a browser User-Agent) with an
 * empty HTTP 202 challenge page, so the HTML and lite endpoints must be read with a form POST:
 * a browser User-Agent, a matching Referer/Origin and `kp=-2` (SafeSearch off). The query stays
 * in the URL as well, so a test mock that reads `url.searchParams.get('q')` still sees it.
 */
const DDG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ddgPostHeaders = (origin) => ({
  'user-agent': DDG_UA,
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en-US,en;q=0.9',
  referer: `${origin}/`,
  origin,
  cookie: 'kp=-2',
});
/** The form body DuckDuckGo expects: the query, SafeSearch off and the region. */
const ddgPostBody = (q) => `q=${encodeURIComponent(q)}&kp=-2&kl=us-en&b=&df=`;
/** The origin a DDG endpoint belongs to (its Referer/Origin must match). */
const ddgOrigin = (url) => { try { return new URL(url).origin; } catch { return 'https://duckduckgo.com'; } };

const searxngUrl = () => String(config.searxngUrl || '').replace(/\/+$/, '');

/** DuckDuckGo walls some networks off (anomaly CAPTCHA, 429, plain timeouts). After a wall hit the
 * provider cools down for COOLDOWN_MS so every query is not stalled by a 6 s timeout; it is retried
 * automatically once the cooldown passes, and health shows the reason in the admin console. */
const COOLDOWN_MS = 10 * 60 * 1000;
/** Cooldowns are per ENDPOINT: a wall on html.duckduckgo.com says nothing about lite.duckduckgo.com
 * (they are answered differently), and one walled keyless door must not silence the others —
 * with the metered budget spent, a shared cooldown meant no search at all until the next day. */
let ddgCooldownUntil = 0;
let ddgLiteCooldownUntil = 0;
let bingCooldownUntil = 0;
let bingFails = 0;
const wall = (msg) => /CAPTCHA|anomaly|429|too many|timed?\s?out|ECONNRESET|EHOSTUNREACH|ENETUNREACH|getaddrinfo|HTTP 5\d\d/i.test(String(msg || ''));

/** The three keyless doors, so a wall on one can ask whether another is still open. */
function keylessDoors() { return { bing: PROVIDERS.bing, ddg: PROVIDERS.ddg, 'ddg-lite': PROVIDERS['ddg-lite'] }; }
/**
 * Is any keyless door besides `self` still answering? If not, this one must NOT cool down: burning a
 * 6 s timeout per query beats having no search at all (which is what a fully-cooled tier plus an
 * exhausted metered budget produces — discovery then reports "0 searches").
 */
function anotherDoorOpen(self) {
  return Object.entries(keylessDoors()).some(([name, p]) => name !== self && p && p.configured());
}

function parseDdg(html) {
  const $ = cheerio.load(html);
  if ($('form#challenge-form, .anomaly-modal__modal').length) throw new Error('DuckDuckGo asked for a CAPTCHA');
  const out = [];
  $('.result').each((_, el) => {
    const a = $(el).find('a.result__a').first();
    let href = a.attr('href') || '';
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    if (/^https?:\/\//.test(href)) out.push({ url: href, title: strip(a.text()), description: strip($(el).find('.result__snippet').text()) });
  });
  return out;
}

/** Bing's HTML endpoint (keyless). Result links come back as `/ck/a?...&u=a1<base64url>`. */
function parseBing(html) {
  const $ = cheerio.load(html);
  // A challenge page is a wall (the caller cools down); Bing's own "no results" block is an honest
  // empty answer (the caller falls through to the next tier) — they must not be confused, or one
  // empty query costs a 10-minute cooldown.
  if ($('#captchaform, #cf_challenge').length) throw new Error('Bing asked for a CAPTCHA');
  const out = [];
  $('.b_algo').each((_, el) => {
    const a = $(el).find('h2 a').first();
    let href = a.attr('href') || '';
    const m = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
    if (m) {
      try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        if (/^https?:\/\//.test(decoded)) href = decoded;
      } catch { /* keep the raw href */ }
    }
    if (!/^https?:\/\//.test(href)) return;
    const caption = $(el).find('.b_caption p').first();
    out.push({ url: href, title: strip(a.text()), description: strip(caption.text()) });
  });
  return out;
}

const QUERY_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'you', 'your', 'how', 'what', 'why', 'top', 'list', 'best', 'new', 'free', 'gay', 'male', 'men', 'man', 'site', 'official']);
const qTokens = (q) => String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !QUERY_STOP.has(w));
/**
 * Bot mitigation serves unrelated results while echoing the query perfectly. A result set whose
 * titles/snippets share nothing with the query would poison discovery, so it counts as a failure
 * (health shows it) instead of being returned.
 */
function coherent(results, q, { minShare = 0.25 } = {}) {
  const toks = qTokens(q);
  if (!results.length) return false;
  if (!toks.length) return true;
  let hits = 0;
  for (const r of results) {
    const hay = `${r.title || ''} ${r.description || ''} ${r.url || ''}`.toLowerCase();
    if (toks.some((t) => hay.includes(t))) hits++;
  }
  return hits / results.length >= minShare;
}

const PROVIDERS = {
  keenable: {
    configured: () => keenable.configured(),
    search: (q, o) => keenable.search(q, o),
  },
  // Keyless Bing HTML. This is the fallback that keeps discovery alive when no search API key is set:
  // DuckDuckGo times out from this network, so Bing answers the whole-web queries either way.
  // Inert under test unless a test sets its own DDG/Bing base (tests must not reach the live web).
  // Bot mitigation serves decoy results that echo the query perfectly: an incoherent answer counts
  // as a failure (visible in health) and cools the provider down instead of feeding junk to discovery.
  bing: {
    configured: () => config.bingEnabled !== false && Date.now() >= bingCooldownUntil,
    async search(q, { count = 20 } = {}) {
      const url = (extra = '') => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.min(Math.max(count, 10), 30)}&setlang=en&safeSearch=Off${extra}`;
      const headers = { 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml' };
      const fetchResults = async (extra) => parseBing(await bingHttp.text(url(extra), { timeout: 15000, headers })).slice(0, count);
      const cooled = (e) => { // a wall (CAPTCHA page, 429, timeout) is not a fluke: cool down, don't retry
        bingCooldownUntil = Date.now() + COOLDOWN_MS;
        throw Object.assign(new Error(`Bing is walled off from this network — cooling down ${COOLDOWN_MS / 60000} min (${String(e.message).slice(0, 80)})`), { skip: true });
      };

      let results;
      try { results = await fetchResults(''); } catch (e) { if (wall(e.message)) cooled(e); throw e; }
      if (!results.length) return []; // an honest empty answer: let the next tier speak
      if (coherent(results, q)) { bingFails = 0; return results; }

      // Degraded, not challenged: Bing intermittently answers with unrelated results for this IP.
      // One retry with a different request shape — never on a CAPTCHA (that cooled above already).
      try {
        const retry = await fetchResults('&form=QBRE&first=1');
        if (!retry.length || coherent(retry, q)) { bingFails = 0; return retry; }
      } catch (e) { if (wall(e.message)) cooled(e); }

      bingFails++;
      // One incoherent answer can be fluke; two in a row means the mitigation is on for this IP.
      if (bingFails >= 2 && anotherDoorOpen('bing')) bingCooldownUntil = Date.now() + COOLDOWN_MS;
      throw Object.assign(new Error(`Bing returned results unrelated to the query after a retry (bot mitigation)${bingFails >= 2 ? `; cooling down ${COOLDOWN_MS / 60000} min` : ''}`), { skip: true });
    },
  },
  brave: {
    configured: () => brave.configured(),
    search: (q, o) => brave.search(q, o),
  },
  // Bright Data Discover: results ranked by relevance to an intent ("public creator pages and accounts"), one credit each.
  brightdata: {
    configured: () => brightdata.configured(),
    search: (q, o) => brightdata.search(q, o),
  },
  // Claude with its server-side web search tool (ANTHROPIC_API_KEY): last in the default order, so it only answers when
  // every other provider failed or found nothing. Each search is one request against the setting aiDailyBudget.
  claude: {
    configured: () => claude.configured(),
    search: (q, { count = 10, site } = {}) => claude.webSearch(q, { count: Math.min(count, 20), site }),
  },
  // Keyless DuckDuckGo HTML endpoint. Datacenter IPs get CAPTCHA'd now and then; that surfaces as a provider failure
  // and the search falls through to the next provider. When the wall is up the provider cools down (fast fail)
  // instead of burning a timeout on every query; the cooldown ends by itself and health shows the reason.
  ddg: {
    configured: () => config.ddgEnabled && Date.now() >= ddgCooldownUntil,
    async search(q, { count = 20 } = {}) {
      try {
        const url = ddgHtmlUrl(q);
        const html = await ddgHttp.text(url, {
          method: 'POST', body: ddgPostBody(q), timeout: 8000, retries: 0, headers: ddgPostHeaders(ddgOrigin(url)),
        });
        const parsed = parseDdg(html);
        if (!parsed.length) throw new Error('DuckDuckGo /html/ answered without results (bot challenge)');
        return parsed.slice(0, count);
      } catch (e) {
        if (wall(e.message)) {
          const cool = anotherDoorOpen('ddg');
          if (cool) ddgCooldownUntil = Date.now() + COOLDOWN_MS;
          throw Object.assign(new Error(`DuckDuckGo /html/ is walled off from this network${cool ? ` — cooling down ${COOLDOWN_MS / 60000} min` : ' (last keyless door: staying live, failing fast)'} (${String(e.message).slice(0, 80)})`), { skip: true });
        }
        throw e;
      }
    },
  },
  // DuckDuckGo Lite: same index, simpler HTML — a second door when the /html/ endpoint is walled off.
  'ddg-lite': {
    configured: () => config.ddgEnabled && Date.now() >= ddgLiteCooldownUntil,
    async search(q, { count = 20 } = {}) {
      try {
        const url = ddgLiteUrl(q);
        const html = await ddgHttp.text(url, {
          method: 'POST', body: ddgPostBody(q), timeout: 8000, retries: 0, headers: ddgPostHeaders(ddgOrigin(url)),
        });
        const $ = cheerio.load(String(html));
        if ($('form#challenge-form, .anomaly-modal__modal').length) throw new Error('DuckDuckGo lite asked for a CAPTCHA');
        const out = [];
        $('a.result-link').each((_, el) => {
          const href = $(el).attr('href') || '';
          const m = href.match(/[?&]uddg=([^&]+)/);
          const url = m ? decodeURIComponent(m[1]) : href;
          if (/^https?:\/\//.test(url)) out.push({ url, title: strip($(el).text()), description: strip($(el).closest('tr').next('tr').text()) });
        });
        if (!out.length) throw new Error('DuckDuckGo lite returned no results');
        return out.slice(0, count);
      } catch (e) {
        if (wall(e.message)) {
          const cool = anotherDoorOpen('ddg-lite');
          if (cool) ddgLiteCooldownUntil = Date.now() + COOLDOWN_MS;
          throw Object.assign(new Error(`DuckDuckGo Lite is walled off from this network${cool ? ` — cooling down ${COOLDOWN_MS / 60000} min` : ' (last keyless door: staying live, failing fast)'}`), { skip: true });
        }
        throw e;
      }
    },
  },
  searxng: {
    configured: () => !!searxngUrl(),
    async search(q, { count = 20 } = {}) {
      if (/\.onion(?::|\/|$)/i.test(searxngUrl()) && !config.torProxy) {
        throw Object.assign(new Error('SearXNG is an .onion address but TOR_PROXY is not set (TOR_PROXY=socks5h://host:9050)'), { skip: true });
      }
      let json;
      try {
        json = await http.json(`${searxngUrl()}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0&language=all${config.searxngEngines ? `&engines=${encodeURIComponent(config.searxngEngines)}` : ''}`, { allowInternal: true, timeout: /\.onion(?::|\/|$)/i.test(searxngUrl()) ? 70000 : 20000 }); // the only caller allowed to reach INTERNAL_HOSTS
      } catch (e) {
        if (/\.onion/i.test(searxngUrl()) && /proxy|tor|socks|epoxy/i.test(String(e.message || ''))) {
          throw Object.assign(new Error(`SearXNG over Tor failed: ${e.message} (check TOR_PROXY and that the onion service is up)`), { status: e.status || 502 });
        }
        throw e;
      }
      const results = (json.results || []).slice(0, count).map((r) => ({ url: r.url, title: strip(r.title), description: strip(r.content) })).filter((r) => r.url);
      // SearXNG answers 200 with nothing when its engines are blocked (CAPTCHA / rate limits on a datacenter IP). Say which,
      // instead of a silent empty list that reads as "nothing out there".
      const failing = (json.unresponsive_engines || []).map((e) => (Array.isArray(e) ? `${e[0]} (${e[1]})` : String(e)));
      health.searxng.engines = failing;
      if (!results.length && failing.length) throw new Error(`SearXNG found nothing: its engines are failing: ${failing.join(', ')}`);
      return results;
    },
  },
};

/** Last outcome per provider, for the admin console: a search backend that quietly returns nothing looks like it works. */
const health = Object.fromEntries(['keenable', 'brave', 'brightdata', 'bing', 'ddg', 'ddg-lite', 'searxng', 'claude'].map((p) => [p, { ok: 0, empty: 0, failed: 0, lastAt: null, lastError: null, lastResults: null, engines: [] }]));
function note(name, results, err) {
  const h = health[name]; if (!h) return;
  h.lastAt = new Date().toISOString();
  // Budget exhaustion is recorded too (as the visible lastError) so the admin
  // sees "daily budget reached" instead of a silently stale healthy state.
  if (err) { h.failed++; h.lastError = String(err.message || err).slice(0, 300); h.lastResults = 0; return; }
  if (results.length) { h.ok++; h.lastError = null; } else h.empty++;
  h.lastResults = results.length;
}

const order = () => (config.searchProviders || ['keenable', 'brave', 'brightdata', 'bing', 'ddg', 'ddg-lite', 'searxng', 'claude']).filter((p) => PROVIDERS[p]);
const configured = () => order().some((p) => PROVIDERS[p].configured());

function status() {
  return {
    configured: configured(),
    providers: order().map((p) => ({ name: p, configured: PROVIDERS[p].configured(), ...health[p] })),
    working: order().some((p) => PROVIDERS[p].configured() && health[p].ok > 0 && !health[p].lastError),
    ddgCooldown: Date.now() < ddgCooldownUntil ? new Date(ddgCooldownUntil).toISOString() : null,
    ddgLiteCooldown: Date.now() < ddgLiteCooldownUntil ? new Date(ddgLiteCooldownUntil).toISOString() : null,
    bingCooldown: Date.now() < bingCooldownUntil ? new Date(bingCooldownUntil).toISOString() : null,
    brave: { configured: brave.configured(), usage: brave.usage() },
    keenable: { configured: keenable.configured(), usage: keenable.usage() },
    brightdata: { configured: brightdata.configured(), usage: brightdata.usage() },
    claude: { configured: claude.configured(), usage: claude.usage() },
  };
}

/**
 * @param {string} q
 * @param {{count?: number, budget?: number, fresh?: boolean, site?: string, preferKeyless?: boolean}} opts `budget` = metered calls per day (Brave, Keenable); `site` restricts results to one domain
 * @returns {Promise<Array<{url,title,description}> & {provider?: string}>}
 *
 * Metered providers keep first-hit semantics (spend one call, stop). The keyless tier — Bing and
 * DuckDuckGo's two endpoints — runs in parallel and its results are merged, so DDG answers show up
 * alongside Bing instead of never being reached behind it. A walled DDG fails fast (cooldown) and
 * costs the query nothing.
 */
const KEYLESS = ['bing', 'ddg', 'ddg-lite'];
const METERED = ['keenable', 'brave', 'brightdata', 'claude'];

const dedupe = (list) => {
  const seen = new Set();
  return list.filter((r) => {
    if (!r || !r.url) return false;
    const k = String(r.url).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

async function search(q, { count = 20, budget = 40, fresh = false, site, preferKeyless = false } = {}) {
  const key = `${count}|${site || ''}|${q}`;
  const hit = cache.get(key);
  if (!fresh && hit && hit.results.length && Date.now() - hit.at < CACHE_MS) return hit.results;
  const configured = order().filter((p) => PROVIDERS[p].configured());
  if (!configured.length) throw Object.assign(new Error('No web search configured: set KEENABLE_API_KEY, BRAVE_API_KEY, BRIGHTDATA_API_TOKEN, SEARXNG_URL or ANTHROPIC_API_KEY (or keep the keyless Bing/DuckDuckGo providers enabled)'), { skip: true });

  const query = (name) => PROVIDERS[name].search(site && name !== 'keenable' ? `${q} site:${site}` : q, { count, budget, site });
  const remember = (name, results) => {
    Object.defineProperty(results, 'provider', { value: name, enumerable: false });
    cache.set(key, { at: Date.now(), results });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return results;
  };
  let lastErr = null;

  /** A tier runs its providers one after another and stops at the first answer. */
  const sequential = async (names) => {
    for (const name of names) {
      try {
        const results = await query(name);
        note(name, results);
        if (results.length) return remember(name, results);
        lastErr = lastErr || Object.assign(new Error(`${name}: no results`), { status: 502 });
      } catch (e) { note(name, null, e); lastErr = e; } // each metered provider reports its own budget/state
    }
    return null;
  };

  const metered = configured.filter((p) => METERED.includes(p));
  const free = configured.filter((p) => KEYLESS.includes(p));
  // Tier 3: everything else (SearXNG and any custom provider) — free but slower / less universal.
  const rest = configured.filter((p) => !METERED.includes(p) && !KEYLESS.includes(p));

  /** Tier 1: metered providers, one paid call each at most — first answer wins. */
  const paidTier = () => sequential(metered);

  /** Tier 2: keyless Bing + DuckDuckGo endpoints in parallel, merged and deduped.
   *  DuckDuckGo's answers come first: it is the door that answers creator names exactly, while
   *  Bing intermittently answers with bot-mitigation decoys ("Christian" for "Christian Hogue").
   *  A provider whose results are incoherent with the query is dropped rather than merged. */
  const keylessTier = async () => {
    if (!free.length) return null;
    const settled = await Promise.allSettled(free.map((name) => query(name).then((r) => { note(name, r); return r; }, (e) => { note(name, null, e); throw e; })));
    // The provider list order is the configuration order; the answers are matched by name, not by
    // position, so a door that failed does not shift the labels.
    const answered = settled.map((s, i) => ({ name: free[i], results: s.status === 'fulfilled' ? s.value : [] }));
    // DuckDuckGo first, then the rest: the exact-match door leads the merge.
    answered.sort((a, b) => (b.name.startsWith('ddg') ? 1 : 0) - (a.name.startsWith('ddg') ? 1 : 0));
    const kept = [];
    const dropped = [];
    for (const a of answered) {
      if (!a.results.length) continue;
      if (!coherent(a.results, q)) { dropped.push(a.name); continue; }
      kept.push(a);
    }
    const merged = dedupe(kept.flatMap((a) => a.results));
    if (merged.length) {
      const label = kept.map((a) => a.name).join('+') || 'keyless';
      return remember(label, merged);
    }
    // Nothing coherent: keep the raw answers rather than losing them (a provider may be right and
    // the coherence check too strict for a very short query).
    const raw = dedupe(answered.flatMap((a) => a.results));
    if (raw.length) return remember(answered.filter((a) => a.results.length).map((a) => a.name).join('+') || 'keyless', raw);
    const firstFail = settled.find((s) => s.status === 'rejected');
    lastErr = lastErr || (firstFail && firstFail.reason) || lastErr;
    return null;
  };

  /** Tier 3: SearXNG and anything custom — free, last because it is the least universal. */
  const tailTier = () => sequential(rest);

  // The daily Brave counter is shared by lookup, discovery and image match. Secondary passes
  // (directory harvest, image match) pass preferKeyless so they ride the free tier and leave the
  // paid budget for identity matching and topic search — one budget, spent where it matters.
  const tiers = preferKeyless ? [keylessTier, paidTier, tailTier] : [paidTier, keylessTier, tailTier];
  for (const tier of tiers) {
    const results = await tier();
    if (results) return results;
  }

  throw lastErr || Object.assign(new Error('web search: no results'), { status: 502 }); // never cache "nothing out there"
}

function _clear() { cache.clear(); ddgCooldownUntil = 0; ddgLiteCooldownUntil = 0; bingCooldownUntil = 0; bingFails = 0; for (const h of Object.values(health)) Object.assign(h, { ok: 0, empty: 0, failed: 0, lastAt: null, lastError: null, lastResults: null, engines: [] }); }

module.exports = { search, configured, status, PROVIDERS, parseDdg, parseBing, coherent, _clear, _anotherDoorOpen: anotherDoorOpen, _cooldown: () => ({ until: ddgCooldownUntil, lite: ddgLiteCooldownUntil, bing: bingCooldownUntil, active: Date.now() < ddgCooldownUntil || Date.now() < ddgLiteCooldownUntil || Date.now() < bingCooldownUntil }), _setCooldown: (ms, which = 'ddg') => { const until = ms ? Date.now() + ms : 0; if (which === 'lite') ddgLiteCooldownUntil = until; else if (which === 'bing') bingCooldownUntil = until; else ddgCooldownUntil = until; } };
