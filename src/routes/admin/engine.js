'use strict';
const config = require('../../config');
const repo = require('../../db/repo');
const registry = require('../../sources');
const engine = require('../../engine/engine');
const events = require('../../engine/events');
const breaker = require('../../engine/breaker');
const maintenance = require('../../engine/maintenance');
const imagefilter = require('../../lib/imagefilter');
const physique = require('../../engine/physique');
const settingsStore = require('../../settings');
const expand = require('../../engine/expand');
const browser4 = require('../../lib/browser4');
const brightdata = require('../../lib/brightdata');
const identity = require('../../engine/identity');

function registerEngine(router, { int, bad, errorKind }) {
/* ---------------------------------------------------------------- overview */
router.get('/overview', (req, res) => {
  res.json({ ...repo.adminOverview(), disk: require('../../lib/diskguard').status(), engine: engine.status(), health: require('../../engine/health').stats(), imageFilter: { enabled: settingsStore.get().imageFilter, ...imagefilter.status(), sweep: maintenance.imageSweepProgress(), dedupe: maintenance.hashSweepProgress() }, physique: { ...physique.stats(settingsStore.get()), sweep: maintenance.physiqueSweepProgress() }, identity: identity.counts(), version: config.version, adminOpen: !config.adminKey });
});

router.get('/stream', (req, res) => {
  events.subscribe('admin', req, res);
  res.write(`data: ${JSON.stringify({ type: 'state', data: engine.status() })}\n\n`);
});

/* ------------------------------------------------------------------ engine */
router.get('/engine', (req, res) => res.json({ ...engine.status(), visual: require('../../engine/visual').status(), logs: events.getLogs(150) }));
// ?level=problems: only warnings and errors, from a ring that INFO chatter cannot push them out of
router.get('/logs', (req, res) => res.json(req.query.level === 'problems' ? events.getProblems(int(req.query.limit, 1, 300, 100)) : events.getLogs(int(req.query.limit, 1, 600, 300))));
router.delete('/logs', (req, res) => { events.clearLogs(); res.json({ ok: true }); });

router.post('/engine/run', (req, res) => {
  const { platforms, feedIds, force } = req.body || {};
  let queued;
  if (Array.isArray(feedIds) && feedIds.length) queued = engine.enqueue(feedIds.filter((x) => typeof x === 'string'), { force: !!force });
  else queued = engine.enqueuePlatforms(Array.isArray(platforms) ? platforms : null, { force: !!force });
  res.json({ ok: true, queued });
});
router.post('/engine/stop', (req, res) => { engine.stopAll(); res.json({ ok: true }); });
router.post('/engine/pause', (req, res) => { engine.pause(); res.json({ ok: true }); });
router.post('/engine/resume', (req, res) => { engine.resume(); res.json({ ok: true }); });
router.post('/engine/breakers/reset', (req, res) => { breaker.reset(); res.json({ ok: true }); });

// `error_kind`: why a run or feed failed (blocked / not_found / rate_limited / parse / timeout / network / server / config / other), see engine/errorclass
router.get('/runs', (req, res) => res.json(repo.runs.recent({ feedId: req.query.feedId, limit: int(req.query.limit, 1, 200, 60) }).map((r) => ({ ...r, error_kind: errorKind(r.error) }))));

/* ----------------------------------------------------------------- sources */
router.get('/sources', (req, res) => {
  const counts = Object.fromEntries(repo.feeds.counts().map((c) => [c.platform, c]));
  const breakers = breaker.snapshot();
  const score = Object.fromEntries(repo.runs.scoreboard(7).map((r) => [r.platform, r]));
  res.json(registry.describe().map((s) => ({ ...s, feeds: counts[s.platform] || { total: 0, enabled: 0, failing: 0 }, breaker: breakers[s.platform] || { state: 'closed', failures: 0 }, score: score[s.platform] || null })));
});
/** Feed-level health: failing, stale, dead (ran often, added nothing in a month) and top feeds. */
router.get('/sources/health', (req, res) => res.json({ ...require('../../engine/sourcehealth').report(), thumbnails: require('../../engine/thumbs').progress() }));
/** Feeds the app paused on its own (auto-retire) and that are still paused, newest first. The overview offers one tap to turn one back on. */
router.get('/sources/retired', (req, res) => {
  const days = int(req.query.days, 1, 90, 14);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = repo.db.prepare(`SELECT f.id, f.platform, f.kind, f.target, f.label, f.origin, f.last_error, a.created_at AS retired_at, a.reason AS why
    FROM feeds f JOIN moderation_actions a ON a.target_type = 'feed' AND a.target_id = f.id
    WHERE f.enabled = 0 AND a.action = 'auto-retire' AND a.created_at >= ?
      AND a.id = (SELECT MAX(id) FROM moderation_actions WHERE target_type = 'feed' AND target_id = f.id)
    ORDER BY a.created_at DESC`).all(since);
  res.json({ days, total: rows.length, items: rows.slice(0, 50) });
});

/* ---------------------------------------------------------------- browser4 */
router.get('/browser4', async (req, res) => {
  const cfg = settingsStore.get();
  res.json({
    ...(await browser4.status()), mode: cfg.browser4Mode, expand: expand.status(),
    render: await require('../../lib/render').status(),       // which engine reads pages (Browser4, Playwright or Chrome), and every engine's state
    strategy: require('../../engine/hoststrategy').summary(),   // what PRISM has learned about which hosts need a browser
    brightdata: {   // booleans and usage only: the token, zone and browser endpoint are never returned
      discover: { configured: brightdata.configured(), usage: brightdata.usage() },
      unlocker: { mode: cfg.brightdataUnlocker, budgetPerDay: cfg.brightdataUnlockBudget, configured: brightdata.unlockerConfigured(), browserApi: brightdata.browserConfigured(), usage: brightdata.unlockUsage() },
    },
    // The free tiers after the browser, and the optional token service. Booleans and counts only.
    jina: { mode: cfg.jinaReader, budgetPerDay: cfg.jinaDailyBudget, configured: require('../../lib/jina').configured(), usage: require('../../lib/jina').usage() },
    oxylabs: { budgetPerDay: cfg.oxylabsDailyBudget, configured: require('../../lib/oxylabs').configured(), usage: require('../../lib/oxylabs').usage() }, // never the key
    captcha: { mode: cfg.captchaSolver, budgetPerDay: cfg.captchaSolverBudget, configured: require('../../lib/captchasolver').configured(), usage: require('../../lib/captchasolver').usage() },
  });
});
/** Read a page in the browser and add the pages it links to (same site) as feeds. Runs in the background; see GET /browser4. */
router.post('/browser4/expand', async (req, res) => {
  const { url, depth, limit, trusted } = req.body || {};
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return bad(res, 'A full http(s) URL is required');
  if (!require('../../lib/render').enabled()) return bad(res, 'No browser engine is enabled on this server (set BROWSER4_ENABLED=1, PLAYWRIGHT_ENABLED=1, or CHALLENGE_BROWSER=1 with CHROME_PATH)', 409);
  try { await browser4.assertAllowed(url.trim()); } catch (e) { return bad(res, e.message, e.skip ? 400 : 502); }
  const r = expand.start(url.trim(), { depth, limit, trustSeed: !!trusted });
  return r.started ? res.status(202).json({ ok: true }) : bad(res, r.reason, 409);
});

/* ---------------------------------------------------------------------- ai */
/** Claude: configured?, model, today's usage against the budget, and what discovery planned. Never the key. */
router.get('/ai', (req, res) => {
  const cfg = settingsStore.get();
  res.json({ ...require('../../lib/llm').status(), search: cfg.aiSearch, discovery: cfg.aiDiscovery, plannedQueries: require('../../engine/ai').plannedQueries() });
});
/** Plan discovery queries now (instead of waiting for the daily plan). */
router.post('/ai/plan', async (req, res) => {
  if (!require('../../lib/llm').configured()) return bad(res, `${require('../../lib/llm').label()} is not configured on this server (set ${require('../../lib/llm').keyName()})`, 409);
  const r = await require('../../engine/ai').planQueries({ force: true });
  if (!r) return bad(res, 'The AI could not plan queries (setting off, budget spent, or the request failed: see the log)', 502);
  res.json({ ...r, plannedQueries: require('../../engine/ai').plannedQueries() });
});
/** Triage the next discovered accounts now. */
router.post('/ai/triage', async (req, res) => {
  if (!require('../../lib/llm').configured()) return bad(res, `${require('../../lib/llm').label()} is not configured on this server (set ${require('../../lib/llm').keyName()})`, 409);
  const r = await require('../../engine/ai').triage({ limit: int(req.body && req.body.limit, 1, 50, 15) });
  if (!r) return bad(res, 'The AI could not triage (setting off, budget spent, or the request failed: see the log)', 502);
  res.json(r);
});
/* --------------------------------------------------------- loop-block profiles */
// CPU profiles lib/blockwatch saved around multi-second event-loop blocks (at most two). Open one in Chrome DevTools
// (Performance) or speedscope to see the function that held the loop.
router.get('/profiles', (req, res) => res.json({ files: require('../../lib/blockwatch').profileFiles() }));
router.get('/profiles/:name', (req, res) => {
  const file = require('../../lib/blockwatch').profilePath(req.params.name);
  if (!file || !require('fs').existsSync(file)) return bad(res, 'Not found', 404);
  res.download(file, req.params.name);
});
/* ------------------------------------------------- legacy v3 endpoint aliases */
router.post('/ingest/start', (req, res) => res.json({ ok: true, queued: engine.enqueuePlatforms(req.body && req.body.sources, {}) }));
router.post('/ingest/stop', (req, res) => { engine.stopAll(); res.json({ ok: true }); });
router.post('/ingest/pause', (req, res) => { engine.pause(); res.json({ ok: true }); });
router.post('/ingest/resume', (req, res) => { engine.resume(); res.json({ ok: true }); });
router.get('/ingest/status', (req, res) => res.json({ ...engine.status(), logs: events.getLogs(80) }));
router.get('/ingest/logs', (req, res) => res.json(events.getLogs(600)));
router.post('/ingest/sweep', async (req, res) => res.json({ ok: true, ...(await maintenance.sweep({ probe: !!(req.body && req.body.probeImgur) })) }));
}

module.exports = { registerEngine };
