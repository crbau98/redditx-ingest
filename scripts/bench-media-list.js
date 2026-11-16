'use strict';
/**
 * Timings for the public /api/media list shapes on a SYNTHETIC database (scripts/seed-scale.js).
 *
 *   DB_PATH=/tmp/scale.db node scripts/bench-media-list.js
 *
 * Each shape runs through the same path the route uses (routes/public mediaList), cold then warm.
 * The first number is the synchronous time one request holds the event loop.
 */
const { performance } = require('perf_hooks');
if (!process.env.DB_PATH) { console.error('set DB_PATH to a synthetic database'); process.exit(2); }
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) process.exit(1);
process.env.NODE_ENV = 'test'; process.env.SCHEDULER_ENABLED = 'false';
const { mediaList } = require('../src/routes/public');
const shapes = {
  'tag=bear&type=image&since=year&limit=48&sort=top': { tag: 'bear', type: 'image', since: 'year', limit: '48', sort: 'top' },
  'page=48123&limit=117&sort=trending&tag=muscle': { page: '48123', limit: '117', sort: 'trending', tag: 'muscle' },
  'page=100000&limit=120': { page: '100000', limit: '120' },
  'sort=recent (first page)': { sort: 'recent' },
  'sort=recent&page=40&limit=48': { sort: 'recent', page: '40', limit: '48' },
  'sort=top&since=year': { sort: 'top', since: 'year' },
  'sort=trending&type=video': { sort: 'trending', type: 'video' },
  'tag=gym&sort=recent&page=3': { tag: 'gym', sort: 'recent', page: '3' },
};
const t = (q) => { const s = performance.now(); const r = mediaList(q); return { ms: Math.round(performance.now() - s), n: r.items.length, total: r.total }; };
for (const [name, q] of Object.entries(shapes)) {
  const a = t(q); const b = t(q);
  console.log(JSON.stringify({ shape: name, coldMs: a.ms, warmMs: b.ms, items: a.n, total: a.total }));
}
process.exit(0);
