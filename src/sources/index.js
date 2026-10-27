'use strict';
/** Adapter registry + the default feed seeds. */
const { parseProfile } = require('../lib/links');
const { webAdapter, linkInBioAdapter } = require('./web');

const adapters = [
  require('./reddit'),
  require('./redgifs'),
  require('./bluesky'),
  require('./mastodon'),
  require('./misskey'),
  require('./lemmy'),
  require('./peertube'),
  require('./tumblr'),
  require('./x'),
  require('./telegram'),
  require('./youtube'),
  require('./rss'),
  webAdapter,
  linkInBioAdapter,
];
const byPlatform = new Map(adapters.map((a) => [a.platform, a]));

/** Items found inside posts (e.g. a RedGIFs link in a Reddit post) are resolved here. */
const resolvers = [
  { name: 'redgifs', adapter: byPlatform.get('redgifs') },
  { name: 'x', adapter: byPlatform.get('x') },
];

/**
 * Curated, male-focused starting set. Admins can edit/disable/extend all of it.
 * Only communities known to exist are seeded by name; breadth comes from hashtag / keyword feeds (which cannot
 * 404) on many instances, and from discovery (Admin → Discovery), which searches for real communities itself.
 * Every untrusted (tag / search) seed carries unmistakable male wording: items must read male-focused to publish.
 */
const SEED_VERSION = 8;
const seeds = (platform, kind, targets, extra) => targets.map((target) => ({ platform, kind, target, ...extra }));
const SEEDS = [
  ...seeds('reddit', 'community', ['gaybrosgonewild', 'vlinesabsanddick', 'gaynsfw', 'twinks', 'massivecocks', 'gaymuscle',
    'broslikeus', 'malepubes', 'cock', 'bulges', 'jockstraps', 'gayporn', 'mangonewild', 'otters', 'gaybrosgonemild', 'ratemycock'],
  { trusted: true, intervalMin: 90 }),
  // RedGIFs: curated niches, not free-text search. Measured live: a text search for "gay" returned ~75% female-tagged
  // results, while these niches are mostly men (and carry the Gay tag, which is what an untrusted feed needs).
  ...seeds('redgifs', 'niche', ['gay-muscle', 'gay-blowjobs', 'gay-couples', 'male-pissing', 'interracial-gay', 'gay-cock-milking', 'gay-creampie', 'male-sex-toys', 'gay-cumming'],
    { trusted: false, intervalMin: 120 }),
  ...seeds('x', 'search', ['gay muscle', 'gay jock', 'gaymuscle', 'gay hunk'], { trusted: false, intervalMin: 240 }),
  ...seeds('mastodon', 'tag', ['gay', 'gaymuscle', 'gayotter', 'gayjock', 'gaynsfw', 'malenude', 'gaycock'], { trusted: false, intervalMin: 180 }),
  ...seeds('misskey', 'tag', ['ゲイ', '筋肉', 'gay', 'gaymuscle', 'gaynsfw'], { trusted: false, intervalMin: 180 }),
  // Lemmy communities verified live on lemmynsfw.com (names, activity and the posts API). The directory community
  // "nsfwgaycommunities" and the daily NSFW community listing in discovery find more by themselves.
  ...seeds('lemmy', 'community', ['gayporn@lemmynsfw.com', 'gaybrosgonewild@lemmynsfw.com', 'gayporngifs@lemmynsfw.com'], { trusted: true, intervalMin: 120 }),
  ...seeds('lemmy', 'community', ['bulge@lemmynsfw.com', 'cocks@lemmynsfw.com', 'iwanttosuckcock@lemmynsfw.com'], { trusted: false, intervalMin: 120 }),
  // Verified live on lemmynsfw.com (community API, not removed, posts > 0): male communities, same shape as gayporn@.
  ...seeds('lemmy', 'community', ['gayvideos@lemmynsfw.com', 'gaylockerroom@lemmynsfw.com', 'gayrimming@lemmynsfw.com', 'gayanal@lemmynsfw.com'], { trusted: true, intervalMin: 120 }),
  ...seeds('peertube', 'search', ['gay', 'gay muscle', 'gay amateur', 'gay jock', 'gay hunk'], { trusted: false, intervalMin: 240 }),
  ...seeds('peertube', 'tag', ['gay'], { trusted: false, intervalMin: 240 }),
  ...seeds('bluesky', 'search', ['gaymuscle', 'gayjock', 'gayotter', 'gaynsfw', 'malenude'], { trusted: false, intervalMin: 180 }),
  // Telegram — public channels via web preview (t.me/s/<channel>, no login or key required)
  ...seeds('telegram', 'user', ['gaymusclemen', 'malephysique', 'gayjocksdaily', 'gayhunksdaily', 'mensfitnesshub', 'gayotters'], { trusted: true, intervalMin: 240 }),
];

/** Seeds from earlier versions that are not clearly male-only. Existing databases switch them off (origin 'seed' only). */
const RETIRED_SEEDS = [
  { platform: 'reddit', kind: 'community', target: 'hardbodies' },   // mixed / women-heavy fitness community
  { platform: 'reddit', kind: 'community', target: 'boyswithabs' },
  // bear / stocky communities: only fit, athletic men are wanted (v5 body filter)
  { platform: 'reddit', kind: 'community', target: 'bearsgonewild' },
  { platform: 'mastodon', kind: 'tag', target: 'gaybear' },
  { platform: 'misskey', kind: 'tag', target: 'ガチムチ' },
  { platform: 'peertube', kind: 'search', target: 'gay bear' },
  { platform: 'bluesky', kind: 'search', target: 'gaybear' },
  { platform: 'tumblr', kind: 'tag', target: 'gay' },   // Tumblr removed site-wide tag feeds (404)
  { platform: 'tumblr', kind: 'tag', target: 'gay muscle' },   // Tumblr removed site-wide tag feeds (404)
  { platform: 'tumblr', kind: 'tag', target: 'gay bear' },   // Tumblr removed site-wide tag feeds (404)
  { platform: 'tumblr', kind: 'tag', target: 'gay daddy' },   // Tumblr removed site-wide tag feeds (404)
  { platform: 'tumblr', kind: 'tag', target: 'gay amateur' },   // Tumblr removed site-wide tag feeds (404)
  { platform: 'tumblr', kind: 'tag', target: 'hairy men' },   // Tumblr removed site-wide tag feeds (404)
  { platform: 'tumblr', kind: 'tag', target: 'muscle men' },   // Tumblr removed site-wide tag feeds (404)
  { platform: 'tumblr', kind: 'tag', target: 'gay jock' },   // Tumblr removed site-wide tag feeds (404)  // "boys" wording: youth-adjacent, never worth the risk
  { platform: 'redgifs', kind: 'search', target: 'gay' },
  { platform: 'redgifs', kind: 'search', target: 'twink' },
  { platform: 'redgifs', kind: 'search', target: 'muscle' },
  { platform: 'redgifs', kind: 'search', target: 'jock' },
  { platform: 'redgifs', kind: 'search', target: 'otter' },
  { platform: 'redgifs', kind: 'search', target: 'bear' },
  { platform: 'redgifs', kind: 'search', target: 'bulge' },
  { platform: 'redgifs', kind: 'search', target: 'gay muscle' },
  { platform: 'redgifs', kind: 'search', target: 'gay daddy' },
  { platform: 'redgifs', kind: 'search', target: 'gay bear' },
  { platform: 'redgifs', kind: 'search', target: 'gay hairy' },
  { platform: 'redgifs', kind: 'search', target: 'gay couple' },
  { platform: 'redgifs', kind: 'search', target: 'gay amateur' },
  { platform: 'redgifs', kind: 'search', target: 'gay hunk' },
  { platform: 'redgifs', kind: 'search', target: 'gay jock' },
  { platform: 'redgifs', kind: 'search', target: 'gay bulge' },
  { platform: 'redgifs', kind: 'search', target: 'gay big cock' },
  { platform: 'redgifs', kind: 'search', target: 'gay jerking off' },
];

function get(platform) { return byPlatform.get(platform) || null; }
function list() { return adapters; }

/** Public-safe description for the admin UI. */
function describe() {
  return adapters.map((a) => ({
    platform: a.platform, label: a.label, color: a.color, kinds: a.kinds,
    config: Object.fromEntries(a.kinds.map((k) => [k, a.isConfigured(k)])),
  }));
}

/** Turn pasted text into a feed spec or null. */
function parseInput(input, hint) {
  const p = parseProfile(input, hint);
  if (!p) return null;
  if (p.external) return p;
  const a = get(p.platform);
  if (!a || !a.kinds.includes(p.kind)) return null;
  return p;
}

module.exports = { get, list, describe, parseInput, resolvers, SEEDS, SEED_VERSION, RETIRED_SEEDS };
