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
const SEED_VERSION = 5;
const seeds = (platform, kind, targets, extra) => targets.map((target) => ({ platform, kind, target, ...extra }));
const SEEDS = [
  ...seeds('reddit', 'community', ['gaybrosgonewild', 'vlinesabsanddick', 'gaynsfw', 'twinks', 'massivecocks', 'gaymuscle',
    'broslikeus', 'malepubes', 'cock', 'bulges', 'jockstraps', 'gayporn', 'mangonewild', 'otters', 'bearsgonewild', 'gaybrosgonemild', 'ratemycock'],
  { trusted: true, intervalMin: 90 }),
  ...seeds('redgifs', 'search', ['gay', 'twink', 'muscle', 'jock', 'otter', 'bear', 'bulge',
    'gay muscle', 'gay daddy', 'gay bear', 'gay hairy', 'gay couple', 'gay amateur', 'gay hunk', 'gay jock', 'gay bulge', 'gay big cock', 'gay jerking off'],
  { trusted: false, intervalMin: 180 }),
  ...seeds('x', 'search', ['gay muscle', 'gay jock', 'gaymuscle'], { trusted: false, intervalMin: 240 }),
  ...seeds('mastodon', 'tag', ['gay', 'gaymuscle', 'gaybear', 'gayotter', 'gaydaddy', 'gaynsfw', 'malenude', 'gaycock'], { trusted: false, intervalMin: 180 }),
  ...seeds('misskey', 'tag', ['ゲイ', 'ガチムチ', '筋肉', 'gay', 'gaymuscle'], { trusted: false, intervalMin: 180 }),
  ...seeds('tumblr', 'tag', ['gay', 'gay muscle', 'gay bear', 'gay daddy', 'gay amateur', 'hairy men', 'muscle men', 'gay jock'], { trusted: false, intervalMin: 180 }),
  ...seeds('peertube', 'search', ['gay', 'gay muscle', 'gay amateur', 'gay bear'], { trusted: false, intervalMin: 240 }),
  ...seeds('peertube', 'tag', ['gay'], { trusted: false, intervalMin: 240 }),
  ...seeds('bluesky', 'search', ['gaymuscle', 'gaybear', 'gaydaddy', 'gayotter', 'gaynsfw', 'malenude'], { trusted: false, intervalMin: 180 }),
];

/** Seeds from earlier versions that are not clearly male-only. Existing databases switch them off (origin 'seed' only). */
const RETIRED_SEEDS = [
  { platform: 'reddit', kind: 'community', target: 'hardbodies' },   // mixed / women-heavy fitness community
  { platform: 'reddit', kind: 'community', target: 'boyswithabs' },  // "boys" wording: youth-adjacent, never worth the risk
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
