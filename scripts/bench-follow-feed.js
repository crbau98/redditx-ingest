'use strict';
/**
 * POST /api/follow/feed on a SYNTHETIC database (scripts/seed-scale.js): the request time with the N biggest creators followed.
 *   DB_PATH=/tmp/scale.db node scripts/bench-follow-feed.js [creators ...]
 */
const { performance } = require('perf_hooks');
if (!process.env.DB_PATH) { console.error('set DB_PATH to a synthetic database'); process.exit(2); }
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) process.exit(1);
process.env.NODE_ENV = 'test'; process.env.SCHEDULER_ENABLED = 'false';
const repo = require('../src/db/repo');
(async () => {
  const server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const n of (process.argv.length > 2 ? process.argv.slice(2).map(Number) : [20, 100, 500])) {
    const follows = repo.db.prepare('SELECT id FROM creators ORDER BY media_count DESC LIMIT ?').all(n).map((r) => ({ id: r.id }));
    for (const body of [{ part: 'all', page: 0, limit: 36 }, { part: 'all', page: 5, limit: 36, nocount: true }, { part: 'earlier', page: 0, limit: 36 }, { part: 'new', page: 0, limit: 36 }]) {
      const t = performance.now();
      const r = await fetch(`${base}/api/follow/feed`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'prism_age=1' }, body: JSON.stringify({ follows: follows.map((f) => ({ ...f, since: process.env.SINCE || '2020-01-01T00:00:00Z' })), ...body }) });
      const j = await r.json();
      console.log(JSON.stringify({ follows: n, part: body.part, page: body.page, ms: Math.round(performance.now() - t), items: (j.items || []).length, total: j.total, capped: j.totalCapped || false }));
    }
  }
  process.exit(0);
})();
