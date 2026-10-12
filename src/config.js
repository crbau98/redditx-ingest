'use strict';
/**
 * Central runtime configuration. Everything is read from the environment once,
 * so the rest of the code never touches process.env directly (and tests can
 * override values by setting env vars before the first require).
 */
const path = require('path');

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const list = (v, d = []) =>
  v === undefined || v === ''
    ? d
    : String(v).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

const root = path.resolve(__dirname, '..');
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';
const dbPath = env.DB_PATH || path.join(root, 'data', 'prism.db');

module.exports = {
  root,
  isProd,
  isTest,
  version: require('../package.json').version,
  port: int(env.PORT, 3141),

  dbPath,
  dataDir: path.dirname(dbPath),

  // --- access control -------------------------------------------------
  adminKey: env.ADMIN_KEY || '',
  // With no ADMIN_KEY the admin API is open only outside production, unless
  // the operator explicitly opts in.
  adminOpen: bool(env.ADMIN_OPEN, !isProd),
  // Server-enforced age gate (cookie). Turn off only for private deployments.
  ageGateEnforce: bool(env.AGE_GATE_ENFORCE, !isTest),
  trustProxy: int(env.TRUST_PROXY, 1),

  // --- scheduler ------------------------------------------------------
  schedulerEnabled: bool(env.SCHEDULER_ENABLED ?? env.CRON_ENABLED, isProd),

  // --- networking -----------------------------------------------------
  userAgent:
    env.INGEST_UA ||
    'Mozilla/5.0 (compatible; PRISM/4.0; +https://github.com/crbau98/redditx-ingest)',
  // Reddit asks API clients for a descriptive UA when using OAuth.
  redditUserAgent: env.REDDIT_USER_AGENT || 'web:prism-ingest:v4 (by /u/prism-ingest)',
  // Tests talk to localhost mock servers; production must never set this.
  allowPrivateHosts: bool(env.ALLOW_PRIVATE_HOSTS, false),
  // Egress through an HTTP CONNECT proxy for https (see lib/net). Explicit opt-in: HTTPS_PROXY is NOT picked up implicitly.
  outboundProxy: String(env.OUTBOUND_PROXY || '').trim(),
  // With a proxy, destinations are still resolved locally and private answers refused. Set this only if your proxy does the DNS
  // (names that local DNS cannot resolve are then tunnelled unvalidated).
  outboundProxyTrustDns: bool(env.OUTBOUND_PROXY_TRUST_DNS, false),
  // Tor SOCKS5 proxy (socks5h://host:9050): lets PRISM reach ONE .onion service, the SearXNG in SEARXNG_URL. All other .onion names stay blocked.
  torProxy: String(env.TOR_PROXY || '').trim(),
  // Exact hostnames that may resolve to private addresses (a SearXNG container on the compose network). Everything else stays SSRF-guarded.
  internalHosts: list(env.INTERNAL_HOSTS, []).map((h) => h.toLowerCase()),

  // --- optional credentials (all sources work in "best effort" mode without)
  creds: {
    xBearer: env.X_BEARER_TOKEN || '',
    redditClientId: env.REDDIT_CLIENT_ID || '',
    redditClientSecret: env.REDDIT_CLIENT_SECRET || '',
    bskyIdentifier: env.BSKY_IDENTIFIER || '',
    bskyPassword: env.BSKY_APP_PASSWORD || '',
    mastodonToken: env.MASTODON_ACCESS_TOKEN || '',
    misskeyToken: env.MISSKEY_ACCESS_TOKEN || '',
    // Brave Search API (web search) — powers creator discovery and cross-platform identity matching.
    braveKey: env.BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY || '',
    // Keenable web search (an AI-agent search engine, MCP over HTTP). Used by creator lookup and discovery.
    keenableKey: env.KEENABLE_API_KEY || '',
    // Telegram Bot API token (from @BotFather, "123456:ABC…"): channel metadata and existence checks.
    telegramBot: env.TELEGRAM_API_KEY || env.TELEGRAM_BOT_TOKEN || '',
  },

  // Web search backends (discovery + creator lookup), tried in this order. SearXNG needs no key: point it at any instance with the JSON format enabled.
  searxngUrl: String(env.SEARXNG_URL || '').trim(),
  searchProviders: list(env.SEARCH_PROVIDERS, ['keenable', 'brave', 'searxng']),

  // Federated sources: instances that adapters may talk to by default. Every hashtag/keyword feed is queried
  // on EACH instance below, so a longer list means more surface (and more requests): override from the
  // environment to narrow or widen it. The first Mastodon instance is the one MASTODON_ACCESS_TOKEN applies to.
  // Only well-established servers are listed; an unreachable one is reported in the feed's notes, never fatal.
  mastodonInstances: list(env.MASTODON_INSTANCES, [
    'mastodon.social', 'pawoo.net', 'mstdn.jp', 'fedibird.com', 'mastodon.online', 'mas.to', 'mstdn.social', 'mastodon.world', 'lgbt.io',
  ]),
  lemmyInstances: list(env.LEMMY_INSTANCES, [
    'lemmynsfw.com', 'lemmy.world', 'sh.itjust.works', 'lemmy.ml', 'lemm.ee', 'lemmy.dbzer0.com', 'reddthat.com',
  ]),
  misskeyInstances: list(env.MISSKEY_INSTANCES, [
    'misskey.io', 'misskey.design', 'nijimiss.moe', 'sushi.ski', 'submarin.online',
  ]),
  // PeerTube: instances for tag feeds (`/api/v1/videos?tagsOneOf=`) and the federated search index used by
  // `search` feeds (Sepia Search by default; any PeerTube search-index compatible endpoint works).
  peertubeInstances: list(env.PEERTUBE_INSTANCES, ['tilvids.com', 'diode.zone', 'spectra.video', 'toobnix.org', 'kolektiva.media']),
  peertubeSearchUrl: String(env.PEERTUBE_SEARCH_URL || 'https://sepiasearch.org').replace(/\/+$/, ''),
  // Tumblr: reblogged posts belong to somebody else's blog, so they are skipped unless this is switched on.
  tumblrIncludeReblogs: bool(env.TUMBLR_REBLOGS, false),

  // Base-URL overrides so adapters can be pointed at a mock in tests.
  baseUrls: {
    reddit: env.REDDIT_BASE_URL || 'https://www.reddit.com',
    redditOauth: env.REDDIT_OAUTH_URL || 'https://oauth.reddit.com',
    redditArchive: env.REDDIT_ARCHIVE_URL || 'https://arctic-shift.photon-reddit.com',
    redgifs: env.REDGIFS_BASE_URL || 'https://api.redgifs.com',
    bsky: env.BSKY_BASE_URL || 'https://public.api.bsky.app',
    bskyPds: env.BSKY_PDS_URL || 'https://bsky.social',
    x: env.X_BASE_URL || 'https://api.x.com',
    fxtwitter: env.FXTWITTER_BASE_URL || 'https://api.fxtwitter.com',
    xSyndication: env.X_SYNDICATION_URL || 'https://syndication.twitter.com',
    brave: env.BRAVE_BASE_URL || 'https://api.search.brave.com',
    telegramBot: env.TELEGRAM_BOT_BASE_URL || 'https://api.telegram.org',
    keenable: env.KEENABLE_BASE_URL || 'https://api.keenable.ai/mcp',
    // Tumblr's global tag feeds (blog feeds live on <blog>.tumblr.com or the blog's own domain).
    tumblr: String(env.TUMBLR_BASE_URL || 'https://www.tumblr.com').replace(/\/+$/, ''),
  },

  // --- media cache for proxied images --------------------------------
  mediaCacheMb: int(env.MEDIA_CACHE_MB, 512),
};
