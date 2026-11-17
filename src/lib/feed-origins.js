'use strict';
/**
 * Feeds PRISM attached by itself (a probe, a search, a bio link, a crawl) as opposed to feeds an admin, a seed or the app's own
 * ingest of a creator created. Evidence against one of these accounts is evidence about THAT ACCOUNT, not about the creator it was
 * attached to, and a name match against it is not proof it is his.
 */
const AUTOMATIC_FEED_ORIGINS = new Set(['coverage', 'discovered', 'deep-search', 'search', 'linked', 'account', 'expand', 'image-match-crawl']);
module.exports = { AUTOMATIC_FEED_ORIGINS };
