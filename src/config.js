'use strict';
/**
 * Central runtime configuration. Everything is read from the environment once,
 * so the rest of the code never touches process.env directly (and tests can
 * override values by setting env vars before the first require).
 */
const path = require('path');
if (process.env.NODE_ENV !== 'test') {
  try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch { /* optional */ }
}

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
// Running on a hosting platform (Railway sets these) counts as production for safety defaults even when NODE_ENV was forgotten.
const isHosted = !isTest && !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
const dbPath = env.DB_PATH || path.join(root, 'data', 'prism.db');

/** Read a secret from a file OUTSIDE the workspace (e.g. the OpenBot key vault). The value never
 * appears in the repo, in .env, or in logs; a missing/unreadable file is just "not configured". */
function readKeyFile(file) {
  if (!file) return '';
  try {
    // eslint-disable-next-line global-require
    return require('fs').readFileSync(file, 'utf8').trim();
  } catch { return ''; }
}

module.exports = {
  // Read when asked, not at load (the same moment the callers used to read process.env themselves):
  // DEMO_ART=1 mounts /demo outside production; PRISM_DB_READONLY=1 is set by the aggregate worker thread just before
  // it opens the database; PRISM_AGGREGATE_WORKER=0 keeps library aggregates on the main thread.
  get demoArt() { return env.DEMO_ART === '1'; },
  get dbReadonly() { return env.PRISM_DB_READONLY === '1'; },
  get aggregateWorker() { return env.PRISM_AGGREGATE_WORKER !== '0'; },
  // lib/blockwatch: keep a CPU profile around a loop block over 3 s (2 files at most, in <dataDir>/profiles).
  // On by default outside tests; PRISM_BLOCK_PROFILE=0 turns it off, =1 turns it on in tests.
  get blockProfile() { const v = env.PRISM_BLOCK_PROFILE; return v === undefined || v === '' ? env.NODE_ENV !== 'test' : v !== '0'; },
  root,
  isProd,
  isTest,
  isHosted,
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
    // BRAVE_API_KEY_FILE points at a key file outside the workspace (the OpenBot vault), so the
    // secret itself never lands in the repo or in any file the repo ships.
    braveKey: env.BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY || readKeyFile(env.BRAVE_API_KEY_FILE),
    // Scrapfly (paid unblock/render tier, lib/scrapfly.js). The key file lives outside the repo, like BRAVE_API_KEY_FILE.
    scrapflyKey: env.SCRAPFLY_API_KEY || readKeyFile(env.SCRAPFLY_API_KEY_FILE),
    // Oxylabs Web API (lib/oxylabs.js): page reads through its unblocking network and web search. Bearer key from
    // OXYLABS_WEB_API_KEY (or a key file outside the repo); never logged.
    oxylabsKey: env.OXYLABS_WEB_API_KEY || readKeyFile(env.OXYLABS_WEB_API_KEY_FILE),
    // Keenable web search (an AI-agent search engine, MCP over HTTP). Used by creator lookup and discovery.
    keenableKey: env.KEENABLE_API_KEY || '',
    // Bright Data (https://brightdata.com) Discover API: intent-ranked web search. BRIGHTDATA_API_KEY is accepted too (same token).
    brightdataKey: env.BRIGHTDATA_API_TOKEN || env.BRIGHTDATA_API_KEY || '',
    // Anthropic API key: Claude reads searches, plans discovery queries, triages discovered accounts and (as a last-resort
    // search provider) searches the web. Everything AI is inert without it.
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    // OpenAI API key (the default AI provider, see `ai` below). OPENAI_API_KEY_FILE points at a key file outside the
    // workspace, like BRAVE_API_KEY_FILE, so the secret never lands in the repo.
    openaiKey: env.OPENAI_API_KEY || readKeyFile(env.OPENAI_API_KEY_FILE),
    // Telegram Bot API token (from @BotFather, "123456:ABC…"): channel metadata and existence checks.
    telegramBot: env.TELEGRAM_API_KEY || env.TELEGRAM_BOT_TOKEN || '',
    // Captcha token service (CapSolver). Inert without it; see lib/captchasolver.js and setting captchaSolver.
    capsolverKey: env.CAPSOLVER_API_KEY || readKeyFile(env.CAPSOLVER_API_KEY_FILE),
  },

  // Web search backends (discovery + creator lookup), tried in this order. SearXNG needs no key: point it at any instance with the JSON format enabled.
  searxngUrl: String(env.SEARXNG_URL || '').trim(),
  searxngEngines: String(env.SEARXNG_ENGINES || '').trim(),
  // DuckDuckGo's HTML endpoint (keyless). On by default outside tests; it fails fast when the network
  // is walled off (see the cooldown in websearch.js) and answers as soon as the wall drops.
  ddgEnabled: isTest ? !!env.DDG_BASE_URL : !/^(0|false|no|off)$/i.test(String(env.DDG_SEARCH ?? '1')),
  // Keyless Bing HTML search (default on: it is the provider that works without any API key). BING_SEARCH=0 turns it off.
  // Never on under test: unit tests must not reach the live web.
  bingEnabled: !isTest && !/^(0|false|no|off)$/i.test(String(env.BING_SEARCH ?? '1')),
  // Yandex Images keyword search (lib/yandex.js). Default ON; YANDEX_IMAGES=0 switches it off. YANDEX_BASE_URL is for tests.
  yandexImages: !isTest && !/^(0|false|no|off)$/i.test(String(env.YANDEX_IMAGES ?? '1')),
  yandexBase: String(env.YANDEX_BASE_URL || 'https://yandex.com').trim(),
  searchProviders: list(env.SEARCH_PROVIDERS, ['keenable', 'brave', 'brightdata', 'bing', 'ddg', 'ddg-lite', 'searxng', 'claude']),
  // What Discover ranks results against: the intent steers it toward public creator pages and personal galleries.
  // Which model provider does the AI work (search reading, discovery queries, triage, profile reading): 'openai' (default)
  // or 'anthropic'. Anything else falls back to the default. Text only: PRISM never sends pictures or videos to either.
  ai: { provider: /^(anthropic|claude)$/i.test(String(env.AI_PROVIDER || '').trim()) ? 'anthropic' : 'openai' },
  // OpenAI (Responses API). Model default gpt-6.1-sol.
  openai: {
    model: String(env.OPENAI_MODEL || 'gpt-6.1-sol').trim(),
    timeoutMs: int(env.OPENAI_TIMEOUT_MS, 90000),
    retryMs: int(env.OPENAI_RETRY_MS, 400), // base wait before a retry of a 429 / 5xx / network error (two retries)
    retryAfterCapMs: int(env.OPENAI_RETRY_AFTER_CAP_MS, 15000), // longest Retry-After waited for; a longer one is not retried into, the provider cools down for this long
  },
  // Claude (Anthropic API), selectable with AI_PROVIDER=anthropic and always the web-search provider when its key is set.
  anthropic: {
    model: String(env.ANTHROPIC_MODEL || 'claude-haiku-5-5').trim(),
    timeoutMs: int(env.ANTHROPIC_TIMEOUT_MS, 60000),
    // Ask the API to retry a request a safety classifier declined on a fallback model (server-side, beta; Claude API only).
    fallbacks: !/^(0|false|no|off)$/i.test(String(env.ANTHROPIC_FALLBACKS || '1')),
  },
  scrapfly: {
    // Scrape API endpoint. The key is sent as the 'key' query parameter by lib/scrapfly.js and is never logged.
    baseUrl: String(env.SCRAPFLY_BASE_URL || 'https://api.scrapfly.io/scrape').trim(),
    country: String(env.SCRAPFLY_COUNTRY || '').trim(),
    proxyPool: String(env.SCRAPFLY_PROXY_POOL || 'public_datacenter_pool').trim(),
    costBudget: int(env.SCRAPFLY_COST_BUDGET, 30),                 // first attempt: a clean read is 1 credit
    escalateCostBudget: int(env.SCRAPFLY_ESCALATE_COST_BUDGET, 80), // retried once at this ceiling on COST_BUDGET_LIMIT
    timeoutMs: int(env.SCRAPFLY_TIMEOUT_MS, 90000),
    renderWaitMs: int(env.SCRAPFLY_RENDER_WAIT_MS, 3000),
  },

  brightdata: {
    intent: String(env.BRIGHTDATA_DISCOVER_INTENT || 'Public creator profiles, portfolios, galleries and link-in-bio pages, and the creator\'s own public social accounts. Public paid-subscription pages are read like any other public page.').trim(),
    minRelevance: parseFloat(env.BRIGHTDATA_MIN_RELEVANCE) || 0,   // drop results scored below this (0 = keep all, ranked)
    pollMs: int(env.BRIGHTDATA_POLL_MS, 2000),
    timeoutMs: int(env.BRIGHTDATA_TIMEOUT_MS, 60000),
    // Web Unlocker: fetches a page through Bright Data's unblocking network. The ZONE is the name of the Web Unlocker zone in the
    // Bright Data control panel. Browser API: a remote browser that unblocks as it loads; the value is the full
    // wss://brd-customer-...:password@brd.superproxy.io:9222 endpoint (a secret: never logged).
    unlockerZone: String(env.BRIGHTDATA_UNLOCKER_ZONE || '').trim(),
    browserWss: String(env.BRIGHTDATA_BROWSER_WSS || '').trim(),
  },

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
  // Playwright: the second rendering engine (lib/playwright.js), in-process Chromium. Every request the browser makes goes
  // through PRISM's own guard proxy (lib/guardproxy.js), which applies the same DNS-validated private-address check as
  // plain downloads plus the content policy, to redirect hops, sub-resources, XHR, workers and WebSockets alike.
  playwright: {
    enabled: bool(env.PLAYWRIGHT_ENABLED, false),
    headed: bool(env.PLAYWRIGHT_HEADED, false),
    executablePath: String(env.PLAYWRIGHT_CHROMIUM_PATH || '').trim(),   // empty = Playwright's own Chromium
    timeoutMs: int(env.PLAYWRIGHT_TIMEOUT_MS, 45000),                    // one navigation
    renderBudgetMs: int(env.PLAYWRIGHT_RENDER_BUDGET_MS, 80000),
    maxQueueWaitMs: int(env.PLAYWRIGHT_MAX_QUEUE_WAIT_MS, 40000),
  },
  // Chrome over plain CDP (lib/chrome.js): the stealth renderer. It speaks to a system Chrome / Chromium directly, with no
  // Playwright or driver in front of it, which is the shape anti-bot gates stopped flagging (see the module header).
  // Enabled when CHALLENGE_BROWSER=1 or when CHROME_PATH names a browser; whether a feed uses it is CHALLENGE_BROWSER_MODE /
  // RENDER_ENGINE=chrome, and the paid tiers still come after it.
  chrome: {
    enabled: bool(env.CHALLENGE_BROWSER, !!String(env.CHROME_PATH || '').trim()),
    path: String(env.CHROME_PATH || '').trim(),          // empty = find Chrome/Chromium in its usual place
    headed: bool(env.CHROME_HEADED, false),              // needs a display; useful to watch a challenge
    timeoutMs: int(env.CHROME_TIMEOUT_MS, 45000),        // one navigation
    challengeWaitMs: int(env.CHROME_CHALLENGE_WAIT_MS, 15000), // how long a bot challenge gets to clear itself
    idleMs: int(env.CHROME_IDLE_MS, 240000),             // close the browser after this long unused
  },
  // Jina Reader: a free third-party reader (lib/jina.js) that renders a page in its own browser. Last free tier before
  // the paid unblockers; capped by setting jinaDailyBudget.
  jina: {
    base: String(env.JINA_READER_BASE_URL || 'https://r.jina.ai/').replace(/\/?$/, '/'),
    key: String(env.JINA_API_KEY || '').trim(),
    timeoutMs: int(env.JINA_TIMEOUT_MS, 60000),
  },
  // Captcha tokens (lib/captchasolver.js): set CAPSOLVER_API_KEY, then setting captchaSolver=fallback.
  captcha: {
    timeoutMs: int(env.CAPTCHA_TIMEOUT_MS, 120000),
    pollMs: int(env.CAPTCHA_POLL_MS, 3000),
  },
  // Which engine reads JavaScript-built pages: browser4, playwright, chrome, or auto (Browser4 when enabled, else
  // Playwright, else Chrome).
  renderEngine: ['auto', 'browser4', 'playwright', 'chrome'].includes(String(env.RENDER_ENGINE || '').trim()) ? String(env.RENDER_ENGINE).trim() : 'auto',

  // Federated sources: instances that adapters may talk to by default. Every hashtag/keyword feed is queried
  // on EACH instance below, so a longer list means more surface (and more requests): override from the
  // environment to narrow or widen it. The first Mastodon instance is the one MASTODON_ACCESS_TOKEN applies to.
  // Only well-established servers are listed; an unreachable one is reported in the feed's notes, never fatal.
  mastodonInstances: list(env.MASTODON_INSTANCES, [
    'mastodon.social', 'pawoo.net', 'mstdn.jp', 'fedibird.com', 'mastodon.online', 'mas.to', 'mastodon.world',
    'pixelfed.social', 'pixelfed.de',
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
    // Oxylabs Web API (POST /v1/search, POST /v1/scrape). Overridable so tests reach a local mock.
    oxylabs: String(env.OXYLABS_BASE_URL || 'https://webapi.oxylabs.io').replace(/\/+$/, ''),
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
    brightdata: String(env.BRIGHTDATA_BASE_URL || 'https://api.brightdata.com').replace(/\/+$/, ''),
    // Jina Reader: a free third-party page reader (html/markdown of a rendered page). See lib/jina.js.
    jina: String(env.JINA_READER_BASE_URL || 'https://r.jina.ai/').replace(/\/?$/, '/'),
    // CapSolver: captcha tokens (Turnstile, hCaptcha, reCAPTCHA). See lib/captchasolver.js.
    capsolver: String(env.CAPSOLVER_BASE_URL || 'https://api.capsolver.com').replace(/\/+$/, ''),
    anthropic: String(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    openai: String(env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, ''),
    // Tumblr's global tag feeds (blog feeds live on <blog>.tumblr.com or the blog's own domain).
    tumblr: String(env.TUMBLR_BASE_URL || 'https://www.tumblr.com').replace(/\/+$/, ''),
    // The public mirror index (posts API + creator index + thumbnail CDN).
    coomer: String(env.COOMER_BASE_URL || 'https://coomer.st').replace(/\/+$/, ''),
    coomerImg: String(env.COOMER_IMG_URL || (env.COOMER_BASE_URL ? env.COOMER_BASE_URL : 'https://img.coomer.st')).replace(/\/+$/, ''),
  },

  // Reserved host name under which stored media is addressed inside PRISM (.invalid never resolves).
  storeHost: 'media.prism.invalid',

  // --- Telegram as a logged-in user (MTProto): reads every channel the account has joined, including private ones.
  // api_id / api_hash come from https://my.telegram.org -> API development tools. The login session is created once with
  // `node scripts/telegram-login.js` and kept in the data volume (or TELEGRAM_SESSION).
  telegram: {
    apiId: int(String(env.TELEGRAM_API_ID || '').replace(/[<>]/g, ''), 0),
    apiHash: String(env.TELEGRAM_API_HASH || '').trim().replace(/^[<"']|[>"']$/g, ''),
    session: String(env.TELEGRAM_SESSION || '').trim(),
    maxMb: int(env.TELEGRAM_MAX_MB, 50),             // larger videos are skipped (was 200: 541 joined channels filled a 50 GB volume in five hours)
    syncHours: int(env.TELEGRAM_SYNC_HOURS, 12),     // how often the joined-channel list is re-read
    autoFollow: bool(env.TELEGRAM_AUTO_FOLLOW, true), // new joined channels become feeds automatically
    trustJoined: bool(env.TELEGRAM_TRUST_JOINED, true), // joined channels are curated by you: unlabeled posts are accepted (the picture filter still applies)
    backfillMax: int(env.TELEGRAM_BACKFILL_MAX, 60), // older media read per channel beyond the newest posts (0 = only new posts); 200 grew the library faster than it was watched
    followMax: int(env.TELEGRAM_FOLLOW_MAX, 50),     // new channels followed per sync (0 = no limit); the rest wait for the next sync
  },
  // --- object store for media PRISM must keep itself (Telegram files cannot be hotlinked). S3-compatible: Cloudflare R2,
  // Backblaze B2, MinIO, AWS. Without these, development and tests use a folder in the data volume; production never does
  // unless MEDIA_STORE=disk says so on purpose (a missing bucket used to turn the database volume into a media store).
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

  // --- web push alerts (lib/webpush, engine/push) -----------------------------------------------------------------------
  // The VAPID key pair is generated once and kept in the data volume (vapid.json, mode 600), so no secrets belong in the
  // environment. PUSH_ENABLED=0 turns alerts off completely.
  pushEnabled: bool(env.PUSH_ENABLED, true),
  vapidSubject: String(env.VAPID_SUBJECT || 'mailto:alerts@prism.app').trim(),

  // --- data volume watchdog (lib/diskguard) -----------------------------------------------------------------------------
  // At pauseAtPct (or when less than minFreeMb is free) everything that writes bulk data to the volume stops; it resumes under
  // resumeAtPct. DISK_BUDGET_GB caps what PRISM may use below the volume's real size (0 = the whole volume).
  disk: {
    warnAtPct: int(env.DISK_WARN_PCT, 70),
    pauseAtPct: int(env.DISK_PAUSE_PCT, 80),
    resumeAtPct: int(env.DISK_RESUME_PCT, 75),
    minFreeMb: int(env.DISK_MIN_FREE_MB, 3072),
    budgetGb: int(env.DISK_BUDGET_GB, 0),
  },
};
