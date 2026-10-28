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
const config = require('../config');
const breaker = require('./breaker');
const events = require('./events');
const { processItem } = require('./pipeline');
const physique = require('./physique');
const { applyProfile, autoTrack } = require('./creators');
const leaks = require('../lib/leaks');
const takedowns = require('../lib/takedowns');
const { isPaywalledHost } = require('../lib/brave');

const MAX_DISCOVERED_FEEDS = 3;

function isCommentFeed(target) {
  try {
    const path = new URL(target).pathname.toLowerCase();
    return /\/comments?(?:\/|$)/.test(path) || /(^|\/)comments?\.(xml|rss|atom|json)$/.test(path);
  } catch { return true; }
}

/** Public RSS/Atom/JSON feeds a page advertised. Paywalled hosts, leak mirrors, takedowns and comment feeds stay out. */
function discoveredFeedSpecs(result) {
  const list = [];
  if (result && Array.isArray(result.discoveredFeeds)) list.push(...result.discoveredFeeds);
  if (result && result.discoveredFeed) list.push(result.discoveredFeed);
  const seen = new Set();
  const out = [];
  for (const d of list) {
    if (!d || d.platform !== 'rss' || d.kind !== 'feed' || !d.target) continue;
    const target = String(d.target).trim();
    if (!/^https?:\/\//i.test(target)) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isCommentFeed(target) || leaks.isLeakUrl(target) || isPaywalledHost(target) || takedowns.checkUrl(target)) continue;
    out.push({ platform: 'rss', kind: 'feed', target });
  }
  return out.slice(0, MAX_DISCOVERED_FEEDS);
}

/**
 * Turn rel=alternate feeds from a creator homepage or link hub into real RSS feeds.
 * Linked to the creator only when auto-link is on; otherwise still ingested as untrusted.
 * Returns the feeds newly created. The scheduler queue is pushed outside tests so a
 * unit test does not immediately fetch them.
 */
function adoptDiscoveredFeeds(result, feed, cfg = settingsStore.get()) {
  if (!result || result.optedOut) return { created: 0, ids: [] };
  const linkCreator = !!(feed && feed.creator_id && cfg && cfg.autoLinkProfiles);
  const ids = [];
  let created = 0;
  for (const d of discoveredFeedSpecs(result)) {
    const r = repo.feeds.upsert({
      platform: d.platform,
      kind: d.kind,
      target: d.target,
      creatorId: linkCreator ? feed.creator_id : null,
      trusted: linkCreator ? 1 : 0,
      origin: 'discovered',
      intervalMin: 180,
    });
    physique.screenFeed(r);
    if (r.created) { created++; ids.push(r.feed.id); }
  }
  if (ids.length && !config.isTest) enqueue(ids, { trigger: 'discovered-feed', front: false });
  return { created, ids };
}

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

const ITEM_CONCURRENCY = 4;

/* -------------------------------------------------------------- run a feed */
/**
 * Reposts and crossposts are ways in to more creators and more sources (v5 A6):
 *   - the original poster of a repost becomes a creator (resolveCreator) and is auto-followed like any other;
 *   - an account in an open feed that reposts known creators is a candidate source ("mention" signal per creator), so a
 *     fan account that keeps reposting followed creators is followed itself once discovery scores it high enough;
 *   - the subreddit a creator's crosspost came from is a candidate community ("hangout").
 */
function noteWaysIn(raw, r, feed, w) {
  const rp = raw.repostOf;
  // a duplicate (the original is already stored) carries no creator: find the original poster by his account
  let creatorId = r.creatorId;
  if (rp && !creatorId && rp.handle) { const c = repo.creators.byAccount(rp.platform, String(rp.handle)); if (c && c.status === 'active') creatorId = c.id; }
  if (rp && creatorId) {
    if (r.creatorId) w.originals.add(creatorId);
    const ownFeed = feed.kind === 'user' && String(feed.target).toLowerCase() === String(rp.via || '').toLowerCase();
    if (rp.via && !ownFeed) {
      const k = String(rp.via);
      if (!w.reposters.has(k)) w.reposters.set(k, new Set());
      w.reposters.get(k).add(String(rp.handle));
    }
  }
  if (raw.crosspostFrom && feed.platform === 'reddit' && feed.trusted) w.hangouts.add(String(raw.crosspostFrom).toLowerCase());
  // a Telegram post forwarded from another public channel: that channel is a lead (one signal per channel that forwards it)
  const fwd = raw.forwardFrom && raw.forwardFrom.handle && String(raw.forwardFrom.handle);
  if (fwd && feed.platform === 'telegram' && fwd.toLowerCase() !== String(feed.target).replace(/^@/, '').toLowerCase()
      && fwd.toLowerCase() !== String(raw.author || '').toLowerCase()) w.forwards.add(fwd);
}

const REPOSTER_KIND = { x: 'user', bluesky: 'user', tumblr: 'user', reddit: 'user', mastodon: 'user', misskey: 'user' };
function followWaysIn(w, feed) {
  if (!w.reposters.size && !w.hangouts.size && !w.forwards.size) return;
  let discovery;
  try { discovery = require('./discovery'); } catch { return; }
  for (const [via, originals] of w.reposters) {
    const kind = REPOSTER_KIND[feed.platform];
    if (!kind) continue;
    for (const handle of originals) {
      try { discovery.consider({ platform: feed.platform, kind, target: via, label: via, ingestable: true }, 'mention', `reposts ${handle}`); } catch { /* best effort */ }
    }
  }
  for (const handle of w.forwards) {
    // a channel the logged-in account already joined is read through MTProto: not a lead
    if (repo.feeds.find('telegram', 'channel', handle) || repo.feeds.find('telegram', 'channel', `@${handle}`)) continue;
    try { discovery.consider({ platform: 'telegram', kind: 'user', target: handle, label: `@${handle}`, ingestable: true }, 'mention', `forwarded in ${feed.label || feed.target}`); } catch { /* best effort */ }
  }
  for (const sub of w.hangouts) {
    try { discovery.consider({ platform: 'reddit', kind: 'community', target: sub, label: `r/${sub}`, ingestable: true }, 'hangout', `crosspost in ${feed.label || feed.target}`); } catch { /* best effort */ }
  }
}

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
    // A deeper read (a creator lookup pulling in "everything") may ask for more than the routine per-run cap.
    const runLimit = Math.min(Math.max(opts.limit || 0, cfg.itemsPerRun), 400);
    const ctx = {
      limit: runLimit,
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
    }).slice(0, runLimit * 4);
    stats.fetched = items.length;

    // the fetch can take a while: profile decisions read the body filter's settings as they are now (see physique.live)
    const hadCreator = !!feed.creator_id;
    if (result.profile) applyProfile(feed, result.profile, { ...cfg, liveBody: true });
    adoptDiscoveredFeeds(result, feed, cfg);
    if (result.links && feed.creator_id) applyProfile(feed, { links: result.links }, { ...cfg, liveBody: true });

    // Items are processed a few at a time: most of the wait is network (probing unknown hosts, resolving RedGIFs
    // links, downloading a picture for the image filter), and the database steps between awaits are synchronous
    // and idempotent (a duplicate hash simply loses the insert), so overlapping them is safe and much faster.
    const waysIn = { originals: new Set(), reposters: new Map(), hangouts: new Set(), forwards: new Set() };
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (ctx.aborted()) return;
        const raw = items[next++];
        if (!raw) return;
        let r;
        // the body filter's settings are re-read per item and after the model pass (a run can take minutes): see physique.live
        try { r = await processItem(raw, feed, adapter, { ...cfg, liveBody: true }); } catch (e) { r = { outcome: 'skipped', reason: `error: ${e.message}` }; }
        if (r.creatorId) touched.add(r.creatorId);
        if (r.outcome === 'added' || r.outcome === 'review' || r.outcome === 'dupe') noteWaysIn(raw, r, feed, waysIn);
        switch (r.outcome) {
          case 'added': stats.added++; break;
          case 'review': stats.review++; stats.added++; break;
          case 'dupe': stats.dupes++; break;
          case 'blocked': stats.blocked++; break;
          case 'hidden': stats.skipped++; reasons['body filter (kept, hidden)'] = (reasons['body filter (kept, hidden)'] || 0) + 1; break;
          default: stats.skipped++; reasons[r.reason || r.outcome] = (reasons[r.reason || r.outcome] || 0) + 1;
        }
        if (r.outcome === 'blocked' && /^safety:/.test(r.reason || '')) events.log('WARN', `Blocked by safety gate (${r.reason}) in ${tag}`);
        entry.added = stats.added; entry.fetched = stats.fetched;
      }
    };
    await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, items.length) }, worker));
    if (result.profile && !hadCreator && feed.creator_id) applyProfile(feed, result.profile, { ...cfg, liveBody: true });

    for (const id of touched) repo.creators.refreshStats(id);
    if (feed.creator_id) repo.creators.refreshStats(feed.creator_id);
    if (feed.kind !== 'user') autoTrack(touched, cfg);
    else if (waysIn.originals.size) autoTrack(waysIn.originals, cfg); // creators this account reposts
    followWaysIn(waysIn, feed);

    const status = stats.fetched === 0 ? 'empty' : 'ok';
    // "Why zero?": a run that adds nothing says why (nothing came back / all dupes / everything filtered).
    // It goes to the live log and the run result; last_error stays reserved for real problems.
    const reasonList = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    const zeroWhy = stats.added > 0 ? null
      : stats.fetched === 0 ? `No new items: the source returned nothing${result.via ? ` (via ${result.via})` : ''}`
        : `No new items: fetched ${stats.fetched} · ${stats.dupes} already stored${stats.blocked ? ` · ${stats.blocked} blocked` : ''}${stats.skipped ? ` · ${stats.skipped} filtered${reasonList ? ` (${reasonList})` : ''}` : ''}`;
    repo.feeds.finishRun(feed.id, {
      status, cursor: result.cursor, addedItems: stats.added, failures: 0,
      nextRunAt: computeNextRun(feed, 0, 0, tempo(feed, stats.added)),
      error: (result.notes && result.notes.length) ? `via ${result.via}: ${result.notes[0]}` : null,
    });
    breaker.success(feed.platform);
    const skipSummary = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    events.log(stats.added ? 'OK' : 'INFO', `${tag} [${result.via || 'n/a'}] fetched ${stats.fetched} · +${stats.added} · dupes ${stats.dupes} · skipped ${stats.skipped}${stats.blocked ? ` · blocked ${stats.blocked}` : ''}${skipSummary ? ` (${skipSummary})` : ''}`);
    if (zeroWhy) events.log('INFO', `${tag}: ${zeroWhy}`);
    if (result.info && result.info.length) events.log('INFO', `${tag}: ${result.info.join(' · ')}`);
    return finish(status, { via: result.via, notes: result.notes, why: zeroWhy });
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
    return { feed, trigger: job.trigger, force: job.force, limit: job.limit };
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
      runFeed(work.feed, work.trigger, { force: work.force, limit: work.limit }).catch((e) => events.log('ERR', `engine: ${e.message}`));
    }
  } finally { state.ticking = false; }
}

/* ----------------------------------------------------------------- controls */
function enqueue(feedIds, { force = false, trigger = 'manual', front = true, limit = 0 } = {}) {
  let n = 0;
  for (const feedId of feedIds) {
    if (state.running.has(feedId) || state.queue.some((q) => q.feedId === feedId)) continue;
    const job = { feedId, force, trigger, limit };
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
  // Retire seeds that were dropped from the curated set (only feeds PRISM itself seeded; an admin's own are left alone).
  for (const r of registry.RETIRED_SEEDS || []) {
    const f = repo.feeds.find(r.platform, r.kind, r.target);
    if (f && f.origin === 'seed' && f.enabled) repo.feeds.update(f.id, { enabled: false });
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

module.exports = { start, shutdown, tick, runFeed, enqueue, enqueuePlatforms, stopAll, pause, resume, status, seedDefaults, computeNextRun, tempo, adoptDiscoveredFeeds, _state: state, _waysIn: { noteWaysIn, followWaysIn } };
