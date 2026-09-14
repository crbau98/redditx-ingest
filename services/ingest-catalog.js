/**
 * Curated public-source catalog for gay male creator media.
 * Queries stay on public indexes (Reddit, RedGIFs, X/fxtwitter, DDG site:).
 * No paywall, login, or private-site crawlers.
 */

const reddit = require('./sources/reddit');
const redgifs = require('./sources/redgifs');
const x = require('./sources/x');
const ddg = require('./sources/ddg');
const web = require('./sources/web');

const SOURCES = [
  {
    id: 'reddit',
    label: 'Reddit',
    group: 'communities',
    defaultOn: true,
    blurb: 'Public gay NSFW communities (official JSON, Arctic Shift archive if Reddit blocks). Photos and hosted videos only.',
  },
  {
    id: 'x',
    label: 'X / Twitter',
    group: 'social',
    defaultOn: true,
    blurb: 'Public tweet media via official API (if token) plus DuckDuckGo site:x.com links resolved through fxtwitter. No login scrape.',
  },
  {
    id: 'redgifs',
    label: 'RedGIFs',
    group: 'gif-hosts',
    defaultOn: true,
    blurb: 'Public RedGIFs search + optional creator usernames. Female-tagged gifs are dropped before persist.',
  },
  {
    id: 'ddg',
    label: 'Creator hosts',
    group: 'indexes',
    defaultOn: false,
    blurb: 'DuckDuckGo site: queries limited to Imgur, RedGIFs, and Reddit CDNs. Quality gate rejects stock CDNs and dead Imgur.',
  },
  {
    id: 'web',
    label: 'Open Graph pages',
    group: 'indexes',
    defaultOn: false,
    blurb: 'Public HTML pages from allowlisted hosts: keep og:image / og:video only. Not a private-site crawler.',
  },
];

const QUERY_PACKS = {
  mixed: {
    id: 'mixed',
    label: 'All types',
    hint: 'Balanced gay male creator mix',
    reddit: reddit.DEFAULT_SUBS,
    redgifs: redgifs.DEFAULT_QUERIES,
    x: x.DEFAULT_QUERIES,
    ddg: ddg.DEFAULT_QUERIES,
    web: web.DEFAULT_QUERIES,
    creators: [
      'gay male nsfw',
      'gay muscle',
      'twink gay',
      'gay otter',
      'jock gay',
    ],
  },
  muscle: {
    id: 'muscle',
    label: 'Muscle',
    hint: 'Hardbodies, gym, jocks',
    reddit: [
      'gaymuscle', 'hardbodies', 'boyswithabs', 'vlinesabsanddick',
      'gaybrosgonemild', 'bulges', 'jockstraps', 'gaybrosgonewild',
    ],
    redgifs: [
      'gay muscle', 'muscle jock gay', 'bodybuilder gay', 'gym gay nsfw', 'pecs gay',
    ],
    x: [
      'site:x.com/status gay muscle',
      'site:x.com gay jock nsfw',
      'site:twitter.com gay muscle nsfw',
    ],
    ddg: [
      'site:redgifs.com gay muscle',
      'site:imgur.com gay muscle nsfw',
    ],
    web: ['site:redgifs.com gay muscle'],
    creators: ['gay muscle', 'muscle jock', 'bodybuilder gay'],
  },
  twink: {
    id: 'twink',
    label: 'Twink',
    hint: 'Lean / twink communities',
    reddit: ['twinks', 'gaynsfw', 'gaybrosgonewild', 'gayporn', 'mangonewild'],
    redgifs: ['gay twink', 'twink cock', 'twink jock gay', 'smooth twink gay'],
    x: [
      'site:x.com/status gay twink',
      'site:twitter.com gay twink nsfw',
    ],
    ddg: ['site:redgifs.com twink gay', 'site:imgur.com gay twink'],
    web: ['site:redgifs.com gay twink'],
    creators: ['gay twink', 'twink nsfw'],
  },
  otter: {
    id: 'otter',
    label: 'Otter',
    hint: 'Otters, hair, daddies adjacent',
    reddit: ['otters', 'bearsgonewild', 'malepubes', 'gaybrosgonewild', 'gaynsfw'],
    redgifs: ['gay otter', 'hairy gay', 'otter cock', 'scruffy gay'],
    x: [
      'site:x.com gay otter nsfw',
      'site:twitter.com gay otter',
    ],
    ddg: ['site:redgifs.com gay otter'],
    web: ['site:redgifs.com gay otter'],
    creators: ['gay otter', 'hairy gay male'],
  },
  jock: {
    id: 'jock',
    label: 'Jock',
    hint: 'Jockstraps, sports, bulge',
    reddit: ['jockstraps', 'bulges', 'hardbodies', 'gaymuscle', 'broslikeus', 'totallystraight'],
    redgifs: ['gay jock', 'jockstrap gay', 'college jock gay', 'athlete gay'],
    x: [
      'site:x.com gay jock nsfw',
      'site:twitter.com jockstrap gay',
    ],
    ddg: ['site:redgifs.com gay jock', 'site:imgur.com jockstrap gay'],
    web: ['site:redgifs.com gay jock'],
    creators: ['gay jock', 'jockstrap'],
  },
};

const DEFAULT_CREATOR_QUERIES = QUERY_PACKS.mixed.creators;

function packById(id) {
  return QUERY_PACKS[id] || QUERY_PACKS.mixed;
}

function publicCatalog() {
  return {
    sources: SOURCES,
    packs: Object.values(QUERY_PACKS).map((p) => ({
      id: p.id,
      label: p.label,
      hint: p.hint,
      reddit: p.reddit,
      redgifs: p.redgifs,
      x: p.x,
      ddg: p.ddg,
      web: p.web,
      creators: p.creators,
    })),
    defaults: {
      sources: SOURCES.filter((s) => s.defaultOn).map((s) => s.id),
      subs: reddit.DEFAULT_SUBS,
      queries: ddg.DEFAULT_QUERIES,
      xQueries: x.DEFAULT_QUERIES,
      webQueries: web.DEFAULT_QUERIES,
      redgifsQueries: redgifs.DEFAULT_QUERIES,
      redgifsUsers: redgifs.DEFAULT_USERS,
      creatorQueries: DEFAULT_CREATOR_QUERIES,
    },
  };
}

module.exports = {
  SOURCES,
  QUERY_PACKS,
  DEFAULT_CREATOR_QUERIES,
  packById,
  publicCatalog,
};
