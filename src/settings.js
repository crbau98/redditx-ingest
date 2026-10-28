'use strict';
/**
 * Typed, validated runtime settings (stored in the `settings` table, editable
 * from the admin console). Secrets are never stored here — those are env vars.
 */
const config = require('./config');
const repo = require('./db/repo');

const SCHEMA = {
  schedulerEnabled: { type: 'bool', default: config.schedulerEnabled, label: 'Run the scheduler automatically' },
  tickSeconds: { type: 'int', default: 30, min: 5, max: 600, label: 'Scheduler tick (seconds)' },
  maxConcurrentFeeds: { type: 'int', default: 4, min: 1, max: 12, label: 'Feeds synced at once' },
  itemsPerRun: { type: 'int', default: 100, min: 10, max: 300, label: 'Max items per feed run' },
  scopeMode: { type: 'enum', values: ['strict', 'open'], default: 'strict', label: 'Unclear male-focus items: strict = review queue, open = publish' },
  untrustedUnclear: { type: 'enum', values: ['drop', 'review'], default: 'drop', label: 'Items from open searches/tags with no male wording at all: drop = discard, review = queue for a human' },
  autoTrack: { type: 'bool', default: true, label: 'Auto-follow creators discovered in communities' },
  autoTrackMinItems: { type: 'int', default: 2, min: 1, max: 20, label: 'Posts before a creator is auto-followed' },
  autoLinkProfiles: { type: 'bool', default: true, label: 'Follow creators’ other public accounts found in their bios' },
  identityAutoMerge: { type: 'bool', default: true, label: 'Merge a creator’s accounts on their own when his profiles link to each other (or to the same OnlyFans / link page) and he uses the same name on both. Anything less certain waits in Creators → Same person?' },
  adaptiveScheduling: { type: 'bool', default: true, label: 'Adaptive scheduling: check busy feeds sooner, quiet ones less often' },
  maxFeeds: { type: 'int', default: 600, min: 10, max: 5000, label: 'Cap on enabled feeds' },
  hostReachability: { type: 'bool', default: true, label: 'Skip items from media hosts that refuse this server (Cloudflare challenge, hotlink blocks)' },
  probeUnknownHosts: { type: 'bool', default: true, label: 'Verify media from unknown hosts before publishing' },
  backupEnabled: { type: 'bool', default: config.isProd, label: 'Back up the database nightly' },
  backupKeep: { type: 'int', default: 3, min: 1, max: 30, label: 'Backups to keep' },
  keepRunHistoryDays: { type: 'int', default: 30, min: 1, max: 365, label: 'Run history retention (days)' },
  xMonthlyReadBudget: { type: 'int', default: 10000, min: 0, max: 10000000, label: 'X API: max posts read per month (match your plan)' },
  xKeylessSearchesPerDay: { type: 'int', default: 150, min: 0, max: 5000, label: 'X without a token: web searches per day used to find X posts (keeps the search engines from blocking this server)' },
  // --- image filter (v4.10) ---
  imageFilter: { type: 'bool', default: true, label: 'Image filter: exclude pictures that show a woman (on-device face + gender model)', group: 'safety' },
  imageFilterThreshold: { type: 'int', default: 50, min: 25, max: 95, label: 'Image filter: confidence (%) needed to call a face female — lower = stricter', group: 'safety' },
  dedupe: { type: 'bool', default: true, label: 'Collapse the same picture posted again (perceptual hash): one item, with "also posted on" sources', group: 'safety' },
  dedupeDistance: { type: 'int', default: 6, min: 0, max: 7, label: 'Duplicate sensitivity: bits of difference still counted as the same picture (0 = identical only, 7 = loosest)', group: 'safety' },
  imageSweep: { type: 'bool', default: true, label: 'Re-check the existing library (women in pictures, duplicate pictures) in the background', group: 'safety' },
  imageSweepPerTick: { type: 'int', default: 12, min: 0, max: 200, label: 'Items re-checked per minute by the image sweep', group: 'safety' },
  // --- body filter (v4.14) ---
  physiqueFilter: { type: 'bool', default: true, label: 'Body filter: show only fit / athletic bodies — hides heavy or very large builds (on-device pose + silhouette, and words like "chubby", "gainer", "dad bod")', group: 'safety' },
  physiqueThreshold: { type: 'int', default: 45, min: 20, max: 95, label: 'Body filter: heaviness score (0 = lean … 100 = very large) at which a picture is hidden — lower = stricter. Hidden, not deleted: moving it re-applies to the whole library', group: 'safety' },
  physiqueCreatorShare: { type: 'int', default: 30, min: 0, max: 100, label: 'Body filter: hide a creator (and pause their feeds) when this % of their measured pictures are hidden (at least 3 measured; 0 = never)', group: 'safety' },
  // --- discovery (v4.3) ---
  autoDiscover: { type: 'bool', default: true, label: 'Discover new creators automatically (mentions, follow graphs, web search)', group: 'discovery' },
  discoveryIntervalMin: { type: 'int', default: 60, min: 15, max: 1440, label: 'Discovery runs every (minutes)', group: 'discovery' },
  discoveryAutoFollowScore: { type: 'int', default: 8, min: 3, max: 60, label: 'Auto-follow a candidate at this score', group: 'discovery' },
  discoveryMaxFollowsPerRun: { type: 'int', default: 10, min: 0, max: 100, label: 'Max creators auto-followed per run', group: 'discovery' },
  discoveryGraph: { type: 'bool', default: true, label: 'Read who followed Bluesky creators follow', group: 'discovery' },
  braveDailyBudget: { type: 'int', default: 40, min: 0, max: 2000, label: 'Metered web searches per day (Brave + Keenable + Bright Data budget; 0 = free SearXNG only)', group: 'discovery' },
  discoveryQueries: {
    type: 'text', group: 'discovery', label: 'Web-search topics (one per line; rotated, one per run)',
    default: ['gay male model bluesky', 'male fitness model onlyfans x.com', 'gay creator linktree 18+', 'muscle model telegram channel', 'gay twink creator redgifs', 'muscle daddy creator onlyfans bluesky', 'gay amateur couple onlyfans twitter', 'male model throne wishlist',
      'gay bodybuilder creator linktree', 'hairy gay creator onlyfans', 'gay jock creator link in bio', 'gay otter creator bluesky 18+', 'gay daddy creator mastodon nsfw', 'gay content creator tumblr nsfw', 'gay muscle videos peertube',
      'gay porn star official links', 'gay amateur creator allmylinks', 'gay athlete creator beacons.ai', 'gay fitness creator beacons.ai', 'ゲイ 筋肉 クリエイター', 'ゲイ 細マッチョ リンク', 'gay cam model linktree', 'male nude model portfolio',
      // OnlyFans / Fansly / JustFor.Fans pages in search results become leads (their snippet is the public bio); fit / athletic first
      'site:onlyfans.com gay muscle', 'site:onlyfans.com male fitness model', 'site:onlyfans.com gay athlete', 'site:onlyfans.com gay jock', 'site:onlyfans.com free gay',
      'site:fansly.com gay muscle', 'site:fansly.com male fitness model', 'site:justfor.fans gay muscle', 'site:justfor.fans gay jock',
      'free gay onlyfans telegram', 'gay onlyfans promo twitter muscle', 'male onlyfans creator redgifs fit',
      'gay creator fansly linktree 18+', 'gay muscle creator justfor.fans links', 'gay fansly creator twitter bluesky',
      'gay justfor.fans creator telegram', 'gay fitness creator youtube channel', 'gay model pixelfed portfolio'].join('\n'),
  },
  // --- discovery reach (v4.6) ---
  discoveryCommunities: { type: 'bool', default: true, label: 'Search Reddit, Lemmy and Bluesky for communities and custom feeds', group: 'discovery' },
  // --- link health (v4.8) ---
  linkHealth: { type: 'bool', default: true, label: 'Check media at the source and hide what has been removed there', group: 'maintenance' },
  linkHealthPerSweep: { type: 'int', default: 40, min: 0, max: 500, label: 'Items re-checked every 10 minutes', group: 'maintenance' },
  creatorSeeds: {
    type: 'text', group: 'discovery', label: 'Creators to find by name (one per line: a name, @handle or profile link). Each is looked up across every platform PRISM reads and his verified public accounts are followed; re-checked monthly',
    // empty under test: a lookup reaches every platform, which tests must not do by accident
    default: config.isTest ? '' : ['Christian Hogue', 'Jakipz', 'Michael Yerger', 'Chase Stobbe', 'HotAlex'].join('\n'),
  },
  discoveryOnlyFans: { type: 'bool', default: true, label: 'Trace OnlyFans creators: find the free public accounts (RedGIFs, Bluesky, X, Telegram, link pages) behind OnlyFans pages that creators promote. onlyfans.com itself is never read', group: 'discovery' },
  discoveryExpand: { type: 'bool', default: true, label: 'Find lookalike creators (Bluesky) and search Bluesky and RedGIFs for new people', group: 'discovery' },
  discoveryAutoCommunities: { type: 'bool', default: true, label: 'Auto-follow strong communities and feeds (their posts are still checked one by one)', group: 'discovery' },
  // --- sources and playback (v5) ---
  keepVideos: { type: 'enum', values: ['expiring', 'all', 'off'], default: 'expiring', label: 'Keep a copy of videos in the media store: expiring = only videos whose links expire and cannot be refreshed, all = every direct video, off = never', group: 'sources' },
  keepVideoMaxMb: { type: 'int', default: 80, min: 5, max: 1024, label: 'Largest video copied into the media store (MB)', group: 'sources' },
  reposts: { type: 'bool', default: true, label: 'Keep reposts (Tumblr reblogs, X reposts and quotes, Bluesky reposts, Reddit crossposts), credited to the original poster', group: 'sources' },
  thumbnails: { type: 'bool', default: true, label: 'Make small thumbnails (kept in the media store) and a colour tint for every picture, so grids load fast', group: 'sources' },
  thumbnailsPerMinute: { type: 'int', default: 30, min: 0, max: 600, label: 'Thumbnails made per minute in the background', group: 'sources' },
  // --- Browser4 rendering (needs BROWSER4_ENABLED=1 on the host; see README) ---
  browser4Mode: { type: 'enum', values: ['off', 'fallback', 'always'], default: 'fallback', label: 'Browser4: read web pages in a real browser — off, fallback = only when the plain download shows no media (JavaScript-built pages), always = every web page. Needs BROWSER4_ENABLED=1', group: 'sources' },
  browser4Scrolls: { type: 'int', default: 8, min: 0, max: 40, label: 'Browser4: times a page is scrolled to the bottom to load more (infinite scroll, lazy galleries)', group: 'sources' },
  browser4Pages: { type: 'int', default: 3, min: 1, max: 10, label: 'Browser4: pages followed through "next page" links in one run (same site only, robots.txt honoured)', group: 'sources' },
  browser4AutoExpand: { type: 'bool', default: false, label: 'Browser4: follow a page’s same-site links as new web feeds (untrusted: every item still passes the safety, male-only and picture gates). Feeds made this way never expand further', group: 'sources' },
  browser4ExpandPerRun: { type: 'int', default: 5, min: 0, max: 50, label: 'Browser4: new feeds one run may add through auto-expand (also bounded by "Cap on enabled feeds")', group: 'sources' },
  brightdataUnlocker: { type: 'enum', values: ['off', 'fallback'], default: 'off', label: 'Bright Data Unlocker: when a site REFUSES PRISM (HTTP 403 / 429 / 503 on the plain read, or a bot-challenge page in Browser4), fetch the public page through Bright Data\'s unblocking network (Web Unlocker; the Browser API too when BRIGHTDATA_BROWSER_WSS is set). Costs credits per request. Never used for paywalled or leak hosts, takedowns, robots.txt disallows or login walls. Needs BRIGHTDATA_API_TOKEN + BRIGHTDATA_UNLOCKER_ZONE', group: 'sources' },
  brightdataUnlockBudget: { type: 'int', default: 100, min: 0, max: 100000, label: 'Bright Data Unlocker: most unlocked requests per day (each one costs credit; 0 = none)', group: 'sources' },
  leakDomains: { type: 'text', default: '', label: 'Extra leak domains to block (one per line). GayForFans, its sister sites, OnlyFans leak mirrors and file lockers are always blocked', group: 'sources' },
  discoveryKeywords: {
    type: 'text', group: 'discovery', label: 'Community keywords (one per line; two are searched per run, in rotation)',
    default: ['gay', 'gaybros', 'gay muscle', 'fit gay', 'twinks', 'gay swimmers', 'jocks', 'bulge', 'gay amateur', 'hairy men', 'male nude', 'gay nsfw',
      'gay otters', 'gay jock', 'gay athletes', 'gay couples', 'gay gifs', 'gay videos', 'gay outdoors', 'gay selfies', 'gay big cock', 'jockstrap', 'gay hunks', 'gay runners', 'gay bodybuilder', 'ゲイ', 'ゲイ 筋肉'].join('\n'),
  },
};

function coerce(def, raw) {
  if (raw === undefined || raw === null || raw === '') return def.default;
  if (def.type === 'bool') return raw === true || /^(1|true|yes|on)$/i.test(String(raw));
  if (def.type === 'int') {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, def.min), def.max) : def.default;
  }
  if (def.type === 'enum') return def.values.includes(raw) ? raw : def.default;
  if (def.type === 'text') return String(raw).replace(/\r/g, '').split('\n').map((l) => l.trim().slice(0, 160)).filter(Boolean).slice(0, 60).join('\n');
  return raw;
}

function get() {
  const stored = repo.settings.all();
  const out = {};
  for (const [k, def] of Object.entries(SCHEMA)) out[k] = coerce(def, stored[k]);
  return out;
}

function update(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    const def = SCHEMA[k];
    if (!def) continue; // unknown keys are ignored, never stored
    repo.settings.set(k, String(coerce(def, v)));
  }
  return get();
}

function describe() {
  return Object.entries(SCHEMA).map(([key, d]) => ({ key, type: d.type, label: d.label, min: d.min, max: d.max, values: d.values, default: d.default, group: d.group || 'ingestion' }));
}

module.exports = { get, update, describe, SCHEMA };
