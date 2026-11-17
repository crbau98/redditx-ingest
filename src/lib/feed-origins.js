'use strict';
/**
 * Feeds PRISM attached by itself (a probe, a search, a bio link, a crawl) as opposed to feeds an admin, a seed or the app's own
 * ingest of a creator created. Evidence against one of these accounts is evidence about THAT ACCOUNT, not about the creator it was
 * attached to, and a name match against it is not proof it is his.
 */
const AUTOMATIC_FEED_ORIGINS = new Set(['coverage', 'discovered', 'deep-search', 'search', 'linked', 'account', 'expand', 'image-match-crawl',
  'cbir', 'paid-page', 'paid-mirror', 'face-match-confirm', 'search-paid', 'post']);
/**
 * The origins a person chose (an admin, a seed list, an import, the account's own joined Telegram channels) or the app's own ingest
 * of a creator's primary account. Anything else, including an origin added later and not listed anywhere, is treated as automatic:
 * evidence against such a feed quarantines the feed, never the creator (Crucible v4.23 gate: cbir / paid-page / face-match-confirm /
 * search-paid feeds were missing from the list above and still blocked and purged the creator). A feed with no recorded origin
 * predates the column and was created by hand.
 */
const OWN_FEED_ORIGINS = new Set(['admin', 'seed', 'ingest', 'import', 'telegram-sync']);
const isAutomaticOrigin = (origin) => !!origin && !OWN_FEED_ORIGINS.has(origin);
module.exports = { AUTOMATIC_FEED_ORIGINS, OWN_FEED_ORIGINS, isAutomaticOrigin };
