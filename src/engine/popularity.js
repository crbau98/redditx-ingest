'use strict';
/**
 * Creator popularity — one number per creator, from signals the library actually has.
 *
 * The rank answers one question: "who is worth opening first on this site?". It is not a claim
 * about OnlyFans subscribers or global fame; every component is measured from published media in
 * this library, and the number is labelled that way in the UI ("Popular here").
 *
 *   engagement  what people did with his posts where the source exposes it (Reddit upvotes,
 *               Bluesky likes, RedGIFs likes). Each platform is normalised by its own 95th
 *               percentile item, so a platform with big numbers cannot drown the others.
 *   breadth     how many platforms he publishes on (up to 5). A man with Reddit, Bluesky and a
 *               paid page is a better discovery than one forgotten feed.
 *   volume      log of his published items, normalised by the library's 95th percentile.
 *   freshness   exp(-days since his last post / 30). Nobody stale leads a "popular now" row.
 *
 * No signal is invented. A platform with no engagement numbers (coomer, gff, telegram) simply
 * contributes zero engagement and is carried by breadth, volume and freshness instead.
 *
 * Recomputed hourly and after a library generation change; stored on creators.popularity so
 * lists and indexes stay cheap. Each query is index-backed (see the INDEXED BY clauses), so a run
 * over the 690k-item production library takes a few seconds, not a minute.
 */
const repo = require('../db/repo');
const events = require('./events');

const { db } = repo;

const WEIGHTS = { engagement: 0.5, breadth: 0.18, volume: 0.12, freshness: 0.2 };
/** A creator at 5 platforms is "everywhere"; more does not add. */
const BREADTH_CAP = 5;
/** Engagement saturates at 8 platform-95th-percentile items' worth. */
const ENGAGEMENT_SATURATION = 8;
const FRESH_DAYS = 30;

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const daysSince = (iso, now) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : Infinity;
};

/** The 95th percentile item score on each platform (1 when a platform has no scores). */
function platformP95() {
  const out = new Map();
  // COVERING INDEX: platform, score DESC, so the counts and the rank seek never touch the table.
  const counts = db.prepare(`SELECT platform, COUNT(*) AS n FROM media INDEXED BY ix_media_platform_score
      WHERE publish_state = 'published' AND score > 0 GROUP BY platform`).all();
  const at = db.prepare(`SELECT score FROM media INDEXED BY ix_media_platform_score
      WHERE platform = ? AND publish_state = 'published' AND score > 0
      ORDER BY score DESC LIMIT 1 OFFSET ?`);
  for (const p of counts) {
    // Nearest-rank p95: the value at 95% from the bottom is 5% from the top of a DESC list.
    const row = at.get(p.platform, Math.max(0, Math.floor(p.n * 0.05)));
    if (row && row.score > 0) out.set(p.platform, row.score);
  }
  return out;
}

/**
 * One row per creator with published media that can appear on the site: post count, platform
 * breadth and last post. Counts come from the covering (creator_id, platform) index; last_media_at
 * is the maintained published counter (schema v24 reconciled it, every ingest write keeps it
 * current), which avoids a second full scan of the media table.
 */
function creatorRows() {
  // Hidden and scope-excluded creators keep their media but are never shown, so they carry no rank.
  const eligible = new Map(db.prepare(`SELECT id, last_media_at FROM creators
      WHERE media_count > 0 AND status = 'active' AND scope != 'excluded'`).all()
    .map((r) => [r.id, r.last_media_at]));
  const byId = new Map();
  for (const r of db.prepare(`SELECT creator_id AS id, platform, COUNT(*) AS n
      FROM media INDEXED BY ix_media_creator_platform
      WHERE publish_state = 'published' AND creator_id IS NOT NULL
      GROUP BY creator_id, platform`).all()) {
    if (!eligible.has(r.id)) continue;
    let row = byId.get(r.id);
    if (!row) byId.set(r.id, (row = { id: r.id, n: 0, plats: 0, last: null }));
    row.n += r.n;
    row.plats += 1;
  }
  for (const row of byId.values()) row.last = eligible.get(row.id) || null;
  return [...byId.values()];
}

/** Engagement sums per creator and platform, walked through the score index. */
function engagementByCreator() {
  const out = new Map();
  for (const r of db.prepare(`SELECT creator_id AS id, platform, SUM(score) AS s
      FROM media INDEXED BY ix_media_pub_score
      WHERE publish_state = 'published' AND creator_id IS NOT NULL AND score > 0
      GROUP BY creator_id, platform`).all()) {
    if (!out.has(r.id)) out.set(r.id, []);
    out.get(r.id).push(r);
  }
  return out;
}

function p95(nums) {
  if (!nums.length) return 1;
  const s = [...nums].sort((a, b) => a - b);
  return Math.max(1, s[Math.max(0, Math.floor(s.length * 0.95) - 1)]);
}

function compute(now = Date.now()) {
  const p95ByPlatform = platformP95();
  const rows = creatorRows();
  const eng = engagementByCreator();
  const volumeP95 = p95(rows.map((r) => r.n));
  const scores = [];
  for (const r of rows) {
    let units = 0;
    for (const e of eng.get(r.id) || []) {
      const base = p95ByPlatform.get(e.platform) || 1;
      units += Math.log1p(Math.max(0, e.s) / base);
    }
    const engagement = clamp(Math.log1p(units) / Math.log1p(ENGAGEMENT_SATURATION));
    const breadth = clamp(r.plats / BREADTH_CAP);
    const volume = clamp(Math.log1p(r.n) / Math.log1p(volumeP95));
    const freshness = clamp(Math.exp(-daysSince(r.last, now) / FRESH_DAYS));
    const score = 100 * (WEIGHTS.engagement * engagement + WEIGHTS.breadth * breadth + WEIGHTS.volume * volume + WEIGHTS.freshness * freshness);
    scores.push({ id: r.id, score: Math.round(score * 10) / 10, parts: { engagement, breadth, volume, freshness }, n: r.n, last: r.last, plats: r.plats });
  }
  return { scores, volumeP95, p95ByPlatform };
}

let running = null;
let lastRun = 0;
let lastResult = null;

/**
 * Recompute and persist. A run is a few index scans plus one row per ranked creator, so hourly is
 * cheap even on the production library; a concurrent call joins the run already in flight.
 */
function recompute({ force = false } = {}) {
  if (running) return running;
  if (!force && Date.now() - lastRun < 60 * 1000) return lastResult;
  running = (async () => {
    const started = Date.now();
    const { scores, volumeP95 } = compute();
    const update = db.prepare(`UPDATE creators SET popularity = ?, popularity_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`);
    const write = db.transaction((list) => { for (const s of list) update.run(s.score, s.id); });
    write(scores);
    lastRun = Date.now();
    lastResult = { updated: scores.length, ms: lastRun - started, volumeP95, at: new Date(lastRun).toISOString() };
    if (events && events.log) events.log('INFO', `Popularity: ranked ${scores.length} creators in ${lastResult.ms} ms`);
    return lastResult;
  })().finally(() => { running = null; });
  return running;
}

/** The component breakdown for one creator, for the admin console and for tests. */
function explain(id, now = Date.now()) {
  const { scores } = compute(now);
  const row = scores.find((s) => s.id === id) || null;
  if (!row) return null;
  const parts = row.parts;
  return {
    id, popularity: row.score, items: row.n, platforms: row.plats, last_media_at: row.last,
    parts: {
      engagement: Math.round(parts.engagement * 1000) / 1000,
      breadth: Math.round(parts.breadth * 1000) / 1000,
      volume: Math.round(parts.volume * 1000) / 1000,
      freshness: Math.round(parts.freshness * 1000) / 1000,
    },
    weights: WEIGHTS,
  };
}

function status() {
  const row = db.prepare('SELECT COUNT(*) AS n, MAX(popularity_at) AS at FROM creators WHERE popularity > 0').get();
  return { ranked: row.n, at: row.at, last: lastResult, weights: WEIGHTS };
}

const STALE_MAX_MS = 6 * 60 * 60 * 1000;
function start() {
  if (timer) return;
  // At boot: rank now when the last run is old (a deploy that adds the column starts at 0).
  try {
    const at = db.prepare('SELECT MAX(popularity_at) AS at FROM creators').get()?.at;
    if (!at || Date.now() - (Date.parse(at) || 0) > STALE_MAX_MS) {
      const { afterHealthy } = require('../lib/ready');
      afterHealthy(() => recompute({ force: true }).catch(() => {}));
    }
  } catch { /* the column is added by a migration; a failed check just skips the warm run */ }
  timer = setInterval(() => {
    require('../lib/blockwatch').work('popularity');
    recompute().catch(() => {}).finally(() => require('../lib/blockwatch').work('idle'));
  }, 60 * 60 * 1000);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

let timer = null;
module.exports = { recompute, compute, explain, status, start, stop, WEIGHTS, _reset() { lastRun = 0; lastResult = null; } };
