'use strict';
/**
 * Library-wide aggregates: each one scans most of the media table, so none of them may run on the
 * request path. The same job functions run in two places:
 *   - the aggregate worker thread (src/lib/aggregate-worker.js), on a read-only connection, in production;
 *   - the main thread, only in tests and for ':memory:' databases (see src/lib/snapshots.js).
 */
const repo = require('../db/repo');

const JOB_FNS = {
  stats: () => repo.publicStats(),
  tags: () => repo.media.tags(120, 1),
  communities: () => repo.media.communities(100),
  platforms: () => repo.media.platforms(),
  // the raw discover payload; route-level presentation (publicMedia/publicCreator) stays on the main thread
  discover: () => repo.discover(),
  graph: () => repo.creators.graph({ limit: 160 }),
  topics: () => repo.tagIntel.topics(),
  // the creator-similarity snapshot and its index, built here so the main thread only receives them
  library: () => repo.libraryWithIndex(),
  // the query-understanding vocabulary: three library-wide queries, run on the worker (was on the main thread at boot)
  vocabulary: () => repo.tagIntel.vocabulary(),
  // Warm the home-feed total on the worker: the first COUNT on a cold volume reads the whole published index
  // (3-7 s on the 400k-row production library) and warmed the OS page cache for the main connection too.
  mediaTotal: () => repo.media.list({ sort: 'recent', limit: 1 }).total,
};

/** How long a computed value is served before a background refresh starts. */
const JOB_TTL_MS = {
  stats: 30000,
  tags: 60000,
  communities: 60000,
  platforms: 60000,
  discover: 30000,
  graph: 5 * 60000,
  topics: 10 * 60000,
  library: 60000,
  vocabulary: 60000,
  mediaTotal: 30000,
};

module.exports = { JOB_FNS, JOB_TTL_MS };
