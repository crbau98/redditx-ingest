#!/usr/bin/env node
'use strict';
/**
 * Per-creator depth probe: boots a throwaway DB with the curated seed, runs N seeded creator feeds once and prints
 * how many published media each creator has before and after one ingest cycle. Network required; writes nothing real.
 *   node scripts/measure-depth.js [--n 5] [--platform coomer]
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-depth-'));
process.env.DB_PATH = path.join(tmp, 'depth.db');
process.env.SCHEDULER_ENABLED = 'false';
const repo = require('../src/db/repo');
const engine = require('../src/engine/engine');

(async () => {
  engine.seedDefaults();
  const n = parseInt(opt('n', '5'), 10); const platform = opt('platform', 'coomer');
  // N creators (those with a feed on --platform), and EVERY enabled feed each of them has: that is one real ingest cycle.
  const ids = repo.db.prepare("SELECT DISTINCT creator_id FROM feeds WHERE platform = ? AND creator_id IS NOT NULL AND enabled = 1 ORDER BY creator_id LIMIT ?").all(platform, n).map((r) => r.creator_id);
  const feeds = ids.flatMap((id) => repo.db.prepare("SELECT * FROM feeds WHERE creator_id = ? AND enabled = 1 AND platform IN ('coomer','bluesky','redgifs','gff','linkinbio','web') ORDER BY platform").all(id));
  const count = (cid) => repo.db.prepare("SELECT COUNT(*) n FROM media WHERE creator_id = ? AND publish_state = 'published'").get(cid).n;
  const rows = [];
  for (const f of feeds) {
    const before = count(f.creator_id); const t = Date.now();
    const r = await engine.runFeed(f.id, 'manual').catch((e) => ({ status: 'error', error: e.message }));
    rows.push({ id: f.creator_id, feed: f.platform, target: f.target, before, after: count(f.creator_id), added: r.added, fetched: r.fetched, dupes: r.dupes, skipped: r.skipped, blocked: r.blocked, review: r.review, status: r.status, error: r.error || null, why: r.why, creator: repo.db.prepare('select status from creators where id = ?').get(f.creator_id).status, sec: Math.round((Date.now() - t) / 1000) });
  }
  console.table(rows.map(({why, id, ...r}) => r)); for (const r of rows) if (r.why) console.log(r.target, '=>', r.why);
  const per = ids.map((id) => {
    const c = repo.db.prepare('select handle, status from creators where id = ?').get(id);
    const st = Object.fromEntries(repo.db.prepare('select publish_state s, count(*) n from media where creator_id = ? group by publish_state').all(id).map((r) => [r.s, r.n]));
    return { creator: c.handle, status: c.status, published: st.published || 0, hidden: st.hidden || 0, review: st.review || 0, seededBefore: rows.find((r) => r.id === id).before };
  });
  console.table(per);
  const avg = per.reduce((a, r) => a + r.published, 0) / Math.max(1, per.length);
  console.log(`DB ${process.env.DB_PATH}\naverage published media per creator after one cycle: ${avg.toFixed(1)} (n=${per.length}; ${per.filter((p) => p.status === 'hidden').length} creator(s) hidden by the body filter)`);
  process.exit(0);
})();
