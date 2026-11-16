'use strict';
/**
 * The worst shapes for POST /api/follow/feed on a SYNTHETIC library: 200 creators x 5,000 rows (1M), planner statistics gathered
 * (ANALYZE), so the planner prefers ix_media_state to the per-creator index, as it does in production.
 *
 *   DB_PATH=/tmp/follow.db node scripts/bench-follow-worst.js
 *
 * Builds the database when it is empty, then times the request for: the 'new' and 'earlier' parts with a far-future and a recent
 * `since`, 20 and 200 follows, and the 'all' part. Writes only to DB_PATH.
 */
const { performance } = require('perf_hooks');
if (!process.env.DB_PATH) { console.error('set DB_PATH to a scratch database file'); process.exit(2); }
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) process.exit(1);
process.env.NODE_ENV = 'test'; process.env.SCHEDULER_ENABLED = 'false'; process.env.AGE_GATE_ENFORCE = '0';
const repo = require('../src/db/repo'); const db = repo.db;
const NC = 200; const PER = 5000;
if (!db.prepare('SELECT 1 FROM creators LIMIT 1').get()) {
  const ids = []; for (let i = 0; i < NC; i++) ids.push(repo.creators.create({ handle: `fc${i}`, displayName: `F${i}`, scope: 'in' }).id);
  db.exec('CREATE TEMP TABLE cid(rn INTEGER PRIMARY KEY, id TEXT)'); const ci = db.prepare('INSERT INTO cid VALUES (?,?)'); ids.forEach((id, i) => ci.run(i + 1, id));
  const N = NC * PER;
  for (let off = 0; off < N; off += 100000) {
    db.prepare(`WITH RECURSIVE s(i) AS (SELECT ? UNION ALL SELECT i+1 FROM s WHERE i < ?)
      INSERT INTO media (id,creator_id,platform,source_key,source_url,author,title,description,media_type,media_url,preview_url,hash,posted_at,ingested_at,publish_state)
      SELECT printf('a0000000-0000-4000-8000-%012d',i),cid.id,'bluesky','sk'||i,'https://b/'||i,'a','t'||i,'d'||i,CASE WHEN i%7=0 THEN 'video' ELSE 'image' END,'https://cdn.example/'||i||'.jpg','https://cdn.example/p/'||i||'.jpg','h'||i,
        strftime('%Y-%m-%dT%H:%M:%fZ',1700000000+i*30,'unixepoch'),strftime('%Y-%m-%dT%H:%M:%fZ',1700000000+i*30,'unixepoch'),'published' FROM s JOIN cid ON cid.rn=((i-1)%${NC})+1`).run(off + 1, Math.min(off + 100000, N));
  }
  db.exec("UPDATE creators SET media_count=(SELECT count(*) FROM media WHERE creator_id=creators.id), video_count=(SELECT count(*) FROM media WHERE creator_id=creators.id AND media_type='video'), last_media_at=(SELECT max(posted_at) FROM media WHERE creator_id=creators.id)");
  db.exec('ANALYZE');
}
(async () => {
  const server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const all = db.prepare('SELECT id FROM creators ORDER BY media_count DESC LIMIT 500').all().map((r) => r.id);
  const far = '2099-01-01T00:00:00.000Z'; const recent = '2023-11-15T00:00:00.000Z';
  const cases = [['all', 20, recent, 0], ['new', 20, far, 0], ['earlier', 20, far, 0], ['new', 20, recent, 0], ['earlier', 200, far, 0], ['new', 200, far, 0], ['earlier', 200, recent, 0], ['new', 200, recent, 0], ['all', 200, recent, 3]];
  for (const [part, n, since, page] of cases) {
    const follows = all.slice(0, n).map((id) => ({ id, since }));
    const t = performance.now();
    const r = await fetch(`${base}/api/follow/feed`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'prism_age=1' }, body: JSON.stringify({ follows, part, page, limit: 36 }) });
    const j = await r.json();
    console.log(JSON.stringify({ part, follows: n, since: since === far ? 'far-future' : 'recent', page, ms: Math.round(performance.now() - t), items: (j.items || []).length, total: j.total, capped: j.totalCapped || false }));
  }
  process.exit(0);
})();
