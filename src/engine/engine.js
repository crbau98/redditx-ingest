'use strict';
/**
 * Ingestion engine: schedules feed syncs, runs them with bounded concurrency,
 * and keeps going when individual sources misbehave.
 *
 * Reliability model
 *   - Each feed has its own interval and exponential backoff on failure.
 *   - Each platform has a circuit breaker and a politeness limiter, so a
 *     blocked/throttled origin is rested instead of hammered.
 *   - A platform that is simply not configured is "skipped", not "failed".
 *   - Everything an adapter returns passes the same pipeline (safety first).
 */
const repo = require('../db/repo');
const registry = require('../sources');
const settingsStore = require('../settings');
const breaker = require('./breaker');
const events = require('./events');
const { processItem } = require('./pipeline');
const { applyProfile, autoTrack } = require('./creators');

const state = {
  running: new Map(),   // feedId -> live entry
  queue: [],            // manual/priority work: {feedId, force, trigger}
  paused: false,
  stopRequested: false,
  timer: null,
  hotTimer: null,
  ticking: false,
  session: { startedAt: null, runs: 0, added: 0, errors: 0 },
};

const RUN_TIMEOUT_MS = 150_000;
const parseJson = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label} timed out after ${ms / 1000}s`), { status: 0 })), ms).unref())]);

/**
 * Adaptive tempo: a feed that keeps producing is checked sooner (down to half its interval),
 * one that keeps coming back empty is checked less often (up to 3x, never beyond a day).
 */
function tempo(feed, added) {
  if (!settingsStore.get().adaptiveScheduling) return 1;
  if (added >= 10) return 0.5;
  if (added >= 3) return 0.75;
  if (added > 0) return 1;
  const prev = repo.runs.recentAdded(feed.id, 3);
  let streak = 1;
  for (const a of prev) { if (a > 0) break; streak++; }
  return Math.min(3, 1 + 0.5 * (streak - 1));
}

/** next_run_at after a run: jittered interval on success, exponential backoff on failure. */
function computeNextRun(feed, failures, retryAfterMs = 0, factor = 1) {
  const base = Math.min(Math.max(5, feed.interval_min) * 60000 * factor, Math.max(24 * 3600000, feed.interval_min * 60000));
  const jitter = 0.9 + Math.random() * 0.2;
  const delay = failures > 0 ? Math.min(base * 2 ** (failures - 1), 24 * 3600000) * jitter : base * jitter;
  return new Date(Date.now() + Math.max(delay, retryAfterMs)).toISOString();
}

/* -------------------------------------------------------------- run a feed */
async function runFeed(feedOrId, trigger = 'schedule', opts = {}) {
  const feed = typeof feedOrId === 'string' ? repo.feeds.get(feedOrId) : feedOrId;
  if (!feed) return { status: 'error', error: 'feed not found' };
  const adapter = registry.get(feed.platform);
  const cfg = settingsStore.get();
  const started = Date.now();
  const stats = { fetched: 0, added: 0, dupes: 0, skipped: 0, blocked: 0, review: 0 };
  const reasons = {};
  const touched = new Set();
  const entry = { feedId: feed.id, platform: feed.platform, kind: feed.kind, target: feed.target, label: feed.label, startedAt: new Date().toISOString(), trigger, ...stats };
  state.running.set(feed.id, entry);
  events.admin('run:start', entry);
  const runId = repo.runs.start(feed.id, trigger);
  const tag = `${feed.platform}/${feed.kind}:${feed.target}`;

  const finish = (status, extra = {}) => {
    repo.runs.finish(runId, { status, ...stats, via: extra.via, error: extra.error, durationMs: Date.now() - started });
    state.running.delete(feed.id);
    state.session.runs++;
    state.session.added += stats.added;
    if (status === 'error') state.session.errors++;
    events.admin('run:finish', { ...entry, ...stats, status, error: extra.error || null, via: extra.via || null, durationMs: Date.now() - started });
    return { status, ...stats, ...extra };
  };

  try {
    if (!adapter || !adapter.kinds.includes(feed.kind)) {
      throw Object.assign(new Error(`No adapter for ${feed.platform}/${feed.kind}`), { skip: true });
    }
    const conf = adapter.isConfigured(feed.kind);
    if (!conf.ok) throw Object.assign(new Error(conf.note || 'not configured'), { skip: true });

    const cursor = parseJson(feed.cursor);
    const ctx = {
      limit: cfg.itemsPerRun,
      cursor,
      force: !!opts.force,
      needProfile: !!feed.creator_id && (!feed.last_success_at || trigger === 'manual'),
      aborted: () => state.stopRequested || !!opts.aborted,
    };
    const result = await withTimeout(adapter.fetch(feed, ctx), RUN_TIMEOUT_MS, tag);
    // Passes overlap (e.g. top + hot): process each post/position once per run.
    const seenKeys = new Set();
    const items = (result.items || []).filter((it) => {
      const k = `${it.sourceId}:${it.position || 0}`;
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    }).slice(0, cfg.itemsPerRun * 4);
    stats.fetched = items.length;

    if (result.profile) applyProfile(feed, result.profile, cfg);
    if (result.discoveredFeed && feed.creator_id && cfg.autoLinkProfiles) {
      const d = result.discoveredFeed;
      repo.feeds.upsert({ platform: d.platform, kind: d.kind, target: d.target, creatorId: feed.creator_id, trusted: 1, origin: 'linked', intervalMin: 180 });
    }
    if (result.links && feed.creator_id) applyProfile(feed, { links: result.links }, cfg);

    for (const raw of items) {
      if (ctx.aborted()) break;
      let r;
      try { r = await processItem(raw, feed, adapter, cfg); } catch (e) { r = { outcome: 'skipped', reason: `error: ${e.message}` }; }
      if (r.creatorId) touched.add(r.creatorId);
      switch (r.outcome) {
        case 'added': stats.added++; break;
        case 'review': stats.review++; stats.added++; break;
        case 'dupe': stats.dupes++; break;
        case 'blocked': stats.blocked++; break;
        default: stats.skipped++; reasons[r.reason || r.outcome] = (reasons[r.reason || r.outcome] || 0) + 1;
      }
      if (r.outcome === 'blocked' && /^safety:/.test(r.reason || '')) events.log('WARN', `Blocked by safety gate (${r.reason}) in ${tag}`);
      entry.added = stats.added; entry.fetched = stats.fetched;
    }

    for (const id of touched) repo.creators.refreshStats(id);
    if (feed.creator_id) repo.creators.refreshStats(feed.creator_id);
    if (feed.kind !== 'user') autoTrack(touched, cfg);

    const status = stats.fetched === 0 ? 'empty' : 'ok';
    repo.feeds.finishRun(feed.id, {
      status, cursor: result.cursor, addedItems: stats.added, failures: 0,
      nextRunAt: computeNextRun(feed, 0, 0, tempo(feed, stats.added)), error: (result.notes && result.notes.length) ? `via ${result.via}: ${result.notes[0]}` : null,
    });
    breaker.success(feed.platform);
    const skipSummary = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    events.log(stats.added ? 'OK' : 'INFO', `${tag} [${result.via || 'n/a'}] fetched ${stats.fetched} · +${stats.added} · dupes ${stats.dupes} · skipped ${stats.skipped}${stats.blocked ? ` · blocked ${stats.blocked}` : ''}${skipSummary ? ` (${skipSummary})` : ''}`);
    return finish(status, { via: result.via, notes: result.notes });
  } catch (e) {
    if (e.skip) {
      breaker.release(feed.platform);
      repo.feeds.finishRun(feed.id, { status: 'skipped', error: e.message, failures: feed.consecutive_failures, nextRunAt: new Date(Date.now() + 6 * 3600000).toISOString() });
      events.log('INFO', `${tag} skipped: ${e.message}`);
      return finish('skipped', { error: e.message });
    }
    const failures = (feed.consecutive_failures || 0) + 1;
    breaker.failure(feed.platform, e);
    const gone = e.status === 404 || e.status === 410;
    repo.feeds.finishRun(feed.id, { status: 'error', error: e.message, failures, nextRunAt: computeNextRun(feed, failures, e.retryAfter || 0) });
    if (gone && failures >= 3) {
      repo.feeds.update(feed.id, { enabled: false });
      repo.feeds.finishRun(feed.id, { status: 'error', error: `Not found (${e.status}) — disabled after ${failures} tries`, failures, nextRunAt: null });
      events.log('WARN', `${tag} disabled: target no longer exists`);
    }
    events.log('ERR', `${tag}: ${e.message}`);
    return finish('error', { error: e.message });
  }
}

/* --------------------------------------------------------------- scheduler */
function platformBusy(platform) {
  for (const r of state.running.values()) if (r.platform === platform) return true;
  return false;
}

function nextWork(cfg) {
  // 1. manual queue (works even when the scheduler is paused)
  for (let i = 0; i < state.queue.length; i++) {
    const job = state.queue[i];
    if (state.running.has(job.feedId)) { state.queue.splice(i, 1); i--; continue; }
    const feed = repo.feeds.get(job.feedId);
    if (!feed) { state.queue.splice(i, 1); i--; continue; }
    if (platformBusy(feed.platform) || !breaker.canRun(feed.platform)) continue;
    state.queue.splice(i, 1);
    return { feed, trigger: job.trigger, force: job.force };
  }
  // 2. scheduled work
  if (state.paused || !cfg.schedulerEnabled) return null;
  const open = Object.entries(breaker.snapshot()).filter(([, s]) => s.state === 'open').map(([p]) => p);
  for (const feed of repo.feeds.due(200, open)) {
    if (state.running.has(feed.id) || platformBusy(feed.platform)) continue;
    if (!breaker.canRun(feed.platform)) continue;
    return { feed, trigger: 'schedule', force: false };
  }
  return null;
}

async function tick() {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const cfg = settingsStore.get();
    if (!state.running.size) state.stopRequested = false;
    while (state.running.size < cfg.maxConcurrentFeeds && !state.stopRequested) {
      const work = nextWork(cfg);
      if (!work) break;
      // fire and forget — runFeed never throws
      runFeed(work.feed, work.trigger, { force: work.force }).catch((e) => events.log('ERR', `engine: ${e.message}`));
    }
  } finally { state.ticking = false; }
}

/* ----------------------------------------------------------------- controls */
function enqueue(feedIds, { force = false, trigger = 'manual', front = true } = {}) {
  let n = 0;
  for (const feedId of feedIds) {
    if (state.running.has(feedId) || state.queue.some((q) => q.feedId === feedId)) continue;
    const job = { feedId, force, trigger };
    if (front) state.queue.unshift(job); else state.queue.push(job);
    n++;
  }
  state.stopRequested = false;
  setImmediate(tick);
  return n;
}

function enqueuePlatforms(platforms, opts = {}) {
  const ids = [];
  for (const p of platforms && platforms.length ? platforms : registry.list().map((a) => a.platform)) {
    for (const f of repo.feeds.list({ platform: p, enabled: true, limit: 1000 }).items) ids.push(f.id);
  }
  return enqueue(ids, { ...opts, front: false, trigger: opts.trigger || 'manual' });
}

function stopAll() { state.stopRequested = true; state.queue.length = 0; events.log('WARN', 'Stop requested — finishing in-flight feeds'); }
function pause() { state.paused = true; events.admin('state', status()); }
function resume() { state.paused = false; setImmediate(tick); events.admin('state', status()); }

function status() {
  const cfg = settingsStore.get();
  return {
    schedulerEnabled: cfg.schedulerEnabled, paused: state.paused, stopRequested: state.stopRequested,
    running: [...state.running.values()], queued: state.queue.length, session: state.session,
    breakers: breaker.snapshot(), sse: events.counts(),
  };
}

/* ---------------------------------------------------------------- lifecycle */
function seedDefaults() {
  const seen = parseInt(repo.settings.get('seed_version') || '0', 10);
  if (seen >= registry.SEED_VERSION) return 0;
  let created = 0;
  for (const s of registry.SEEDS) {
    const adapter = registry.get(s.platform);
    const r = repo.feeds.upsert({ ...s, origin: 'seed', intervalMin: s.intervalMin || (adapter.intervalMin && adapter.intervalMin[s.kind]) || 180 });
    if (r.created) created++;
  }
  repo.settings.set('seed_version', String(registry.SEED_VERSION));
  return created;
}

function start() {
  if (state.timer) return;
  state.session.startedAt = new Date().toISOString();
  repo.runs.abandonRunning();
  const seeded = seedDefaults();
  if (seeded) events.log('INFO', `Seeded ${seeded} default feeds`);
  const cfg = settingsStore.get();
  state.timer = setInterval(tick, cfg.tickSeconds * 1000);
  state.timer.unref();
  state.hotTimer = setInterval(() => {
    try { repo.media.recomputeHot(); repo.runs.prune(settingsStore.get().keepRunHistoryDays); } catch (e) { events.log('ERR', `maintenance: ${e.message}`); }
  }, 10 * 60000);
  state.hotTimer.unref();
  setTimeout(() => { try { repo.media.recomputeHot(); } catch { /* ignore */ } tick(); }, 2000).unref();
}

function shutdown() {
  clearInterval(state.timer); clearInterval(state.hotTimer);
  state.timer = null; state.hotTimer = null; state.stopRequested = true;
}

module.exports = { start, shutdown, tick, runFeed, enqueue, enqueuePlatforms, stopAll, pause, resume, status, seedDefaults, computeNextRun, tempo, _state: state };
