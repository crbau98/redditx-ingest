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
  searxngEngines: String(env.SEARXNG_ENGINES || '').trim(),
  ddgEnabled: /^(1|true|yes|on)$/i.test(String(env.DDG_SEARCH || '')),
  searchProviders: list(env.SEARCH_PROVIDERS, ['keenable', 'brave', 'ddg', 'searxng']),

  // Browser4 (https://browser4.io): a real Chrome driven through `browser4-cli`, used to read pages whose media only exists after
  // their JavaScript has run (SPAs, infinite scroll, lazy galleries). Off unless BROWSER4_ENABLED=1: it needs Chrome/Chromium and the
  // CLI on the same host (see README, "Browser4 rendering"). Whether a feed actually uses it is the `browser4Mode` setting.
  browser4: {
    enabled: bool(env.BROWSER4_ENABLED, false),
    bin: String(env.BROWSER4_CLI || 'browser4-cli').trim(),
    session: String(env.BROWSER4_SESSION || 'prism-ingest').trim(),
    // A visible window (demos, or a human solving a challenge). Without a display Browser4 itself falls back to headless.
    headed: bool(env.BROWSER4_HEADED, false),
    // Abort browser requests (redirect hops, sub-resources, XHR) to literal private / loopback / link-local addresses and local names.
    // On whenever PRISM itself refuses private hosts (the production default); there is no point when ALLOW_PRIVATE_HOSTS is set.
    blockPrivate: bool(env.BROWSER4_BLOCK_PRIVATE, !bool(env.ALLOW_PRIVATE_HOSTS, false)),
    timeoutMs: int(env.BROWSER4_TIMEOUT_MS, 60000),   // one CLI call
    // Worst case for one feed run = plain download (~20 s) + waiting for the shared browser + the render itself, and the
    // engine cuts a feed run off at 150 s: 20 + 40 + 80 stays under it.
    renderBudgetMs: int(env.BROWSER4_RENDER_BUDGET_MS, 80000),        // everything one render may spend
    maxQueueWaitMs: int(env.BROWSER4_MAX_QUEUE_WAIT_MS, 40000),       // how long a render may wait for the browser before the page is read without it
  },

  // Federated sources: instances that adapters may talk to by default. Every hashtag/keyword feed is queried
  // on EACH instance below, so a longer list means more surface (and more requests): override from the
  // environment to narrow or widen it. The first Mastodon instance is the one MASTODON_ACCESS_TOKEN applies to.
  // Only well-established servers are listed; an unreachable one is reported in the feed's notes, never fatal.
  mastodonInstances: list(env.MASTODON_INSTANCES, [
    'mastodon.social', 'pawoo.net', 'mstdn.jp', 'fedibird.com', 'mastodon.online', 'mas.to', 'mastodon.world',
    'pixelfed.social', 'pixelfed.de',
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
    // X's own embed API for single posts (keyless): the fallback when fxtwitter cannot read a post.
    xEmbed: env.X_EMBED_URL || 'https://cdn.syndication.twimg.com',
    brave: env.BRAVE_BASE_URL || 'https://api.search.brave.com',
    telegramBot: env.TELEGRAM_BOT_BASE_URL || 'https://api.telegram.org',
    telegramWeb: String(env.TELEGRAM_WEB_BASE_URL || 'https://t.me').replace(/\/+$/, ''),
    keenable: env.KEENABLE_BASE_URL || 'https://api.keenable.ai/mcp',
    // Tumblr's global tag feeds (blog feeds live on <blog>.tumblr.com or the blog's own domain).
    tumblr: String(env.TUMBLR_BASE_URL || 'https://www.tumblr.com').replace(/\/+$/, ''),
  },

  // Reserved host name under which stored media is addressed inside PRISM (.invalid never resolves).
  storeHost: 'media.prism.invalid',

  // --- Telegram as a logged-in user (MTProto): reads every channel the account has joined, including private ones.
  // api_id / api_hash come from https://my.telegram.org -> API development tools. The login session is created once with
  // `node scripts/telegram-login.js` and kept in the data volume (or TELEGRAM_SESSION).
  telegram: {
    apiId: int(env.TELEGRAM_API_ID, 0),
    apiHash: String(env.TELEGRAM_API_HASH || '').trim(),
    session: String(env.TELEGRAM_SESSION || '').trim(),
    maxMb: int(env.TELEGRAM_MAX_MB, 200),            // larger videos are skipped
    syncHours: int(env.TELEGRAM_SYNC_HOURS, 12),     // how often the joined-channel list is re-read
    autoFollow: bool(env.TELEGRAM_AUTO_FOLLOW, true), // new joined channels become feeds automatically
    trustJoined: bool(env.TELEGRAM_TRUST_JOINED, true), // joined channels are curated by you: unlabeled posts are accepted (the picture filter still applies)
    backfillMax: int(env.TELEGRAM_BACKFILL_MAX, 1000), // older media read per channel beyond the newest posts (0 = only new posts)
  },
  // --- object store for media PRISM must keep itself (Telegram files cannot be hotlinked). S3-compatible: Cloudflare R2,
  // Backblaze B2, MinIO, AWS. Without these it falls back to a folder in the data volume (MEDIA_STORE=disk).
  store: {
    kind: String(env.MEDIA_STORE || '').toLowerCase(),   // '' = auto (s3 when endpoint+bucket+keys are set, else disk), 's3' or 'disk'
    endpoint: String(env.MEDIA_STORE_ENDPOINT || '').trim().replace(/\/+$/, ''),
    bucket: String(env.MEDIA_STORE_BUCKET || '').trim(),
    region: String(env.MEDIA_STORE_REGION || 'auto').trim(),
    accessKeyId: String(env.MEDIA_STORE_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.MEDIA_STORE_SECRET_ACCESS_KEY || '').trim(),
    prefix: String(env.MEDIA_STORE_PREFIX || 'media/').replace(/^\/+/, '').replace(/([^/])$/, '$1/'),
  },

  // --- media cache for proxied images --------------------------------
  mediaCacheMb: int(env.MEDIA_CACHE_MB, 512),
};
