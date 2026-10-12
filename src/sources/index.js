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

/** Curated, male-focused starting set. Admins can edit/disable/extend all of it. */
const SEED_VERSION = 4;
const SEEDS = [
  ...['gaybrosgonewild', 'boyswithabs', 'vlinesabsanddick', 'gaynsfw', 'twinks', 'massivecocks', 'hardbodies', 'gaymuscle',
    'broslikeus', 'malepubes', 'cock', 'bulges', 'jockstraps', 'gayporn', 'mangonewild', 'otters', 'bearsgonewild', 'gaybrosgonemild']
    .map((target) => ({ platform: 'reddit', kind: 'community', target, trusted: true, intervalMin: 90 })),
  ...['gay', 'twink', 'muscle', 'jock', 'otter', 'bear', 'bulge']
    .map((target) => ({ platform: 'redgifs', kind: 'search', target, trusted: false, intervalMin: 180 })),
  ...['gay muscle', 'gay jock', 'gaymuscle']
    .map((target) => ({ platform: 'x', kind: 'search', target, trusted: false, intervalMin: 240 })),
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

module.exports = { get, list, describe, parseInput, resolvers, SEEDS, SEED_VERSION };
