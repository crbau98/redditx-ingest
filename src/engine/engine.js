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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const repo = require('../db/repo');
const registry = require('../sources');
const { deriveFeeds } = require('../sources/seed-feeds');
const settingsStore = require('../settings');
const config = require('../config');
const breaker = require('./breaker');
const limiter = require('../lib/limiter');
const { classify } = require('./errorclass');
const events = require('./events');
const { processItem } = require('./pipeline');
const physique = require('./physique');
const { applyProfile, autoTrack } = require('./creators');
const takedowns = require('../lib/takedowns');
const backfill = require('./backfill');
const budget = require('../services/budget');
const diskguard = require('../lib/diskguard');

const MAX_DISCOVERED_FEEDS = 3;

function isCommentFeed(target) {
  try {
    const path = new URL(target).pathname.toLowerCase();
    return /\/comments?(?:\/|$)/.test(path) || /(^|\/)comments?\.(xml|rss|atom|json)$/.test(path);
  } catch { return true; }
}

/** Public RSS/Atom/JSON feeds a page advertised. Takedowns and comment feeds stay out. */
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
    if (isCommentFeed(target) || takedowns.checkUrl(target)) continue;
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
  served: new Map(),    // platform -> sequence number of its last pick (least recently served goes first)
  serveSeq: 0,
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
/** A single item never gets more than this (one network probe + hashing), and the item phase as a whole
 *  is capped so a feed with hundreds of items cannot hold its platform slot for the whole cycle. */
const ITEM_TIMEOUT_MS = 45_000;
const ITEM_PHASE_MS = 600_000;
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

/**
 * Should this run also read the creator's profile? Always on the feed's first run and on a manual run; after that every
 * `profileRefreshDays` days (0 = never), for the platforms where it is one cheap request. The time of the last read lives in the
 * feed cursor (`profiledAt`; `profileTryAt` when the adapter gave no profile, retried after a day), so it needs no column.
 * Telegram is left out: its profile read costs MTProto budget (see lib/telegram-budget).
 */
const PROFILE_REFRESH_PLATFORMS = new Set(['bluesky', 'mastodon', 'misskey', 'reddit', 'x', 'peertube']);
function profileDue(feed, cursor, cfg, trigger, now = Date.now()) {
  if (!feed.creator_id) return false;
  if (!feed.last_success_at || trigger === 'manual') return true;
  const days = cfg && cfg.profileRefreshDays;
  // a PeerTube creator is attached as a `channel` as often as a `user`, and its adapter reads the channel profile just as cheaply
  const profileKind = feed.kind === 'user' || (feed.platform === 'peertube' && feed.kind === 'channel');
  if (!days || !profileKind || !PROFILE_REFRESH_PLATFORMS.has(feed.platform)) return false;
  const c = cursor || {};
  const read = Date.parse(c.profiledAt); const tried = Date.parse(c.profileTryAt);
  if (Number.isFinite(tried) && now - tried < 86400000) return false;
  return !Number.isFinite(read) || now - read >= days * 86400000;
}

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
    if (/(?:_bot|bot)$/i.test(handle)) continue;
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
  const blockwatch = require('../lib/blockwatch');
  blockwatch.work(`feed ${feed.platform}`); // any stall inside this run is attributed to it
  // platforms whose feeds live on many unrelated servers: a server's gateway errors rest that server (host breaker), not the platform
  const host = ['mastodon', 'misskey', 'peertube', 'rss', 'web', 'linkinbio'].includes(feed.platform) ? breaker.feedHost(feed) : null;

  const finish = (status, extra = {}) => {
    blockwatch.work('idle');
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
    // A server that keeps answering 502/503/504 is skipped until its host breaker reopens (other servers of the platform run).
    const hostUntil = host ? breaker.hostOpenUntil(host) : 0;
    if (hostUntil) {
      breaker.release(feed.platform);
      repo.feeds.finishRun(feed.id, { status: 'skipped', error: `${host} is answering with gateway errors; retrying after ${new Date(hostUntil).toISOString()}`, failures: feed.consecutive_failures, nextRunAt: new Date(hostUntil + 1000).toISOString() });
      events.log('INFO', `${tag} skipped: ${host} host breaker open`);
      return finish('skipped', { error: `${host} host breaker open` });
    }

    const cursor = parseJson(feed.cursor);
    // A deeper read (a creator lookup pulling in "everything") may ask for more than the routine per-run cap.
    const runLimit = Math.min(Math.max(opts.limit || 0, cfg.itemsPerRun), 400);
    const ctx = {
      limit: runLimit,
      cursor,
      force: !!opts.force,
      needProfile: profileDue(feed, cursor, cfg, trigger),
      aborted: () => state.stopRequested || !!opts.aborted,
    };
    if (opts.lane !== undefined) budget.charge(feed.platform, opts.lane); // only a run that really goes to the source uses the budget
    const result = await withTimeout(adapter.fetch(feed, ctx), RUN_TIMEOUT_MS, tag);
    if (feed.platform === 'gff' && result.resolvedTarget && !repo.feeds.find(feed.platform, feed.kind, result.resolvedTarget)) {
      repo.feeds.update(feed.id, { target: result.resolvedTarget });
      feed.target = result.resolvedTarget;
    }
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
    noteBioSource(feed, result.profile);
    adoptDiscoveredFeeds(result, feed, cfg);
    if (result.links && feed.creator_id) applyProfile(feed, { links: result.links }, { ...cfg, liveBody: true });

    // Items are processed a few at a time: most of the wait is network (probing unknown hosts, resolving RedGIFs
    // links, downloading a picture for the image filter), and the database steps between awaits are synchronous
    // and idempotent (a duplicate hash simply loses the insert), so overlapping them is safe and much faster.
    const waysIn = { originals: new Set(), reposters: new Map(), hangouts: new Set(), forwards: new Set() };
    let next = 0;
    // One stuck item must not wedge the whole run. Processing an item can touch the network (probe an
    // unknown host, resolve a RedGIFs link, download a picture for the image filter) and the fetch
    // timeout below only covers `adapter.fetch`: a hung probe used to leave the feed "running" for
    // hours, holding its platform slot so every other feed on that platform waited behind it.
    const itemDeadline = Date.now() + ITEM_PHASE_MS;
    const gone = { stopped: false };
    const ownerGone = () => {
      if (!feed.creator_id || feed.kind !== 'user' || stats.blocked + stats.skipped < 3) return false;
      const c = repo.creators.get(feed.creator_id);
      return !!c && c.status !== 'active';
    };
    let handled = 0; // items finished across the workers, for the yield above
    const worker = async () => {
      for (;;) {
        if (ctx.aborted() || Date.now() > itemDeadline) return;
        // A creator's own feed whose creator was hidden/blocked mid-run (the body filter hides him after a few measured pictures)
        // would refuse every remaining item one by one: stop instead of walking the other few hundred.
        if (ownerGone()) { gone.stopped = true; return; }
        const raw = items[next++];
        if (!raw) return;
        let r;
        // the body filter's settings are re-read per item and after the model pass (a run can take minutes): see physique.live
        try {
          r = await withTimeout(processItem(raw, feed, adapter, { ...cfg, liveBody: true }), ITEM_TIMEOUT_MS, 'item');
        } catch (e) {
          // A timeout is per item: this one is skipped and the run carries on with the rest.
          r = { outcome: 'skipped', reason: e && e.status === 0 ? `timed out after ${ITEM_TIMEOUT_MS / 1000}s` : `error: ${e.message}` };
        }
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
        // Every few items, hand the event loop a turn. A run's own synchronous work (SQLite writes,
        // FTS updates, dedupe lookups, creator stats) runs back-to-back otherwise, and /api/health
        // reports the whole burst as one multi-second block — production measured 4.1 s during a
        // single coomer run. setImmediate is a macrotask, so pending HTTP requests are answered here.
        if (++handled % 3 === 0) await new Promise((res) => setImmediate(res));
      }
    };
    await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, items.length) }, worker));
    await new Promise((res) => setImmediate(res)); // breathe before the bookkeeping below
    if (result.profile && !hadCreator && feed.creator_id) applyProfile(feed, result.profile, { ...cfg, liveBody: true });

    for (const id of touched) { repo.creators.refreshStats(id); if (++handled % 10 === 0) await new Promise((res) => setImmediate(res)); }
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
    // History left to read (the adapter's cursor says so): come back after a short gap for the next slice, not after the full
    // poll interval. A flag on the result covers adapters whose cursor cannot say it (Coomer's walk).
    const prevCur = backfill.parse(feed.cursor);
    const baseCur = result.cursor || (prevCur.backfillPending ? prevCur : undefined);
    let cursorOut = result.backfillPending ? { ...(baseCur || {}), backfillPending: true } : (baseCur && baseCur.backfillPending ? { ...baseCur, backfillPending: false } : baseCur);
    // when the profile was last read (see profileDue); adapters build their cursor from scratch, so the stamps are carried over here
    const stamp = {};
    const readNow = ctx.needProfile && result.profile ? new Date().toISOString() : null;
    if (readNow || prevCur.profiledAt) stamp.profiledAt = readNow || prevCur.profiledAt;
    if (ctx.needProfile && !result.profile && PROFILE_REFRESH_PLATFORMS.has(feed.platform)) stamp.profileTryAt = new Date().toISOString();
    else if (!readNow && prevCur.profileTryAt) stamp.profileTryAt = prevCur.profileTryAt;
    if (Object.keys(stamp).length && (ctx.needProfile || prevCur.profiledAt || prevCur.profileTryAt)) cursorOut = { ...(cursorOut || prevCur), ...stamp };
    const more = backfill.pending({ cursor: cursorOut });
    repo.feeds.finishRun(feed.id, {
      status, cursor: cursorOut, addedItems: stats.added, failures: 0,
      nextRunAt: more && !ctx.aborted() ? new Date(Date.now() + cfg.backfillGapMin * 60000).toISOString() : computeNextRun(feed, 0, 0, tempo(feed, stats.added)),
      error: (result.notes && result.notes.length) ? `via ${result.via}: ${result.notes[0]}` : null,
    });
    breaker.success(feed.platform);
    breaker.hostSuccess(host);
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
    // The platform is cooling down after a 429 and the limiter refused to queue this call behind the hold (lib/limiter, maxWaitMs):
    // nothing was sent, so this is no failure of the feed. Come back when the hold is over.
    if (e.cooldown) {
      breaker.release(feed.platform);
      const wait = Math.max(e.retryAfter || 0, 60000) + Math.floor(Math.random() * 60000);
      repo.feeds.finishRun(feed.id, { status: 'skipped', error: `rate limited: ${e.message}; trying again in ${Math.ceil(wait / 60000)} min`, failures: feed.consecutive_failures, nextRunAt: new Date(Date.now() + wait).toISOString() });
      events.log('INFO', `${tag} skipped: ${e.message}`);
      return finish('skipped', { error: e.message });
    }
    const failures = (feed.consecutive_failures || 0) + 1;
    // One instance's gateway errors trip that host's breaker (after 2), not the whole platform's (after 4).
    if (host && breaker.isGateway(e)) {
      if (breaker.hostFailure(host, e)) events.log('WARN', `${tag}: ${host} keeps answering ${e.status}; skipping that host until ${new Date(breaker.hostOpenUntil(host)).toISOString()}`);
      breaker.release(feed.platform);
    } else breaker.failure(feed.platform, e);
    const cls = classify(e);
    repo.feeds.finishRun(feed.id, { status: 'error', error: e.message, failures, nextRunAt: computeNextRun(feed, failures, Math.max(e.retryAfter || 0, host ? Math.max(0, breaker.hostOpenUntil(host) - Date.now()) : 0)) });
    if (cls.permanent && failures >= 3) {
      repo.feeds.update(feed.id, { enabled: false });
      repo.feeds.finishRun(feed.id, { status: 'error', error: `${e.status === 404 || e.status === 410 ? `Not found (${e.status})` : 'Target broken'} — disabled after ${failures} tries`, failures, nextRunAt: null });
      events.log('WARN', `${tag} disabled: ${e.status === 404 || e.status === 410 ? 'target no longer exists' : e.message}`);
    } else if (failures >= 5 && !cls.transient) {
      // Only errors that say something about the feed itself end it (it answers, but never with anything readable). A rate limit,
      // a 403/challenge, a timeout, a dropped connection or a 5xx can pass: those keep backing off (up to a day) and stay visible
      // as failing in the source-health report; the auto-retire sweep pauses the app's own feeds that never recover.
      repo.feeds.update(feed.id, { enabled: false });
      repo.feeds.finishRun(feed.id, { status: 'error', error: `Chronic failure (${failures} consecutive errors: ${e.message}) — disabled`, failures, nextRunAt: null });
      events.log('WARN', `${tag} disabled: ${failures} consecutive failures`);
    }
    events.log('ERR', `${tag}: ${e.message}`);
    return finish('error', { error: e.message });
  }
}

/* --------------------------------------------------------------- scheduler */
/** Remember which platform a stored creator bio came from (the AI guard refuses Telegram-derived text, also after a restart). */
function noteBioSource(feed, profile) {
  try {
    if (!feed.creator_id || !profile || !profile.bio) return;
    const c = repo.creators.get(feed.creator_id);
    if (!c || !c.bio || !String(c.bio).includes(String(profile.bio).slice(0, 20))) return;
    repo.db.prepare('UPDATE creators SET bio_source = ? WHERE id = ?').run(feed.platform === 'telegram' ? 'telegram' : feed.platform, c.id);
  } catch { /* provenance is best effort; the text table still guards */ }
}

/** Feeds that may run at once per platform. Each adapter's HTTP calls still go through the per-platform limiter
 * (lib/limiter: spaced requests, 429 cool-downs), so more slots overlap the slow part (probing, image checks, writes) without
 * hitting a host harder. Override with the `platformSlots` setting. */
const DEFAULT_SLOTS = { coomer: 2, bluesky: 4, x: 2, telegram: 1, reddit: 2, redgifs: 1, tumblr: 2, gff: 2, mastodon: 3, misskey: 2, peertube: 2, rss: 4, web: 3, linkinbio: 3 };
function slotsFor(platform, cfg = settingsStore.get()) {
  const custom = budget.parseCaps(cfg.platformSlots)[platform];
  return Math.max(1, custom !== undefined ? custom : (DEFAULT_SLOTS[platform] || 2));
}
function runningOn(platform) {
  let n = 0;
  for (const r of state.running.values()) if (r.platform === platform) n++;
  return n;
}
const platformFull = (platform, cfg) => runningOn(platform) >= slotsFor(platform, cfg);
/** The key a platform's HTTP calls are limited under (lib/limiter): the link-in-bio adapter reads through the shared `web` client. */
const limiterKeyOf = (platform) => (platform === 'linkinbio' ? 'web' : platform);

/** Platforms that still have a free slot and an open breaker. */
function openPlatforms(cfg) {
  const open = new Set(Object.entries(breaker.snapshot()).filter(([, s]) => s.state === 'open').map(([p]) => p));
  // A platform the limiter is holding after a 429 gets no new run either: the call would only be refused (lib/limiter, maxWaitMs).
  return { open, free: registry.list().map((a) => a.platform).filter((p) => !open.has(p) && !platformFull(p, cfg) && !limiter.coolingDown(limiterKeyOf(p))) };
}

function nextWork(cfg) {
  // The data volume is nearly full (lib/diskguard): start nothing, not even a manual run, until it has room again.
  if (diskguard.paused()) return null;
  // 1. manual queue (lane 0, works even when the scheduler is paused)
  for (let i = 0; i < state.queue.length; i++) {
    const job = state.queue[i];
    if (state.running.has(job.feedId)) { state.queue.splice(i, 1); i--; continue; }
    const feed = repo.feeds.get(job.feedId);
    if (!feed) { state.queue.splice(i, 1); i--; continue; }
    if (platformFull(feed.platform, cfg) || limiter.coolingDown(limiterKeyOf(feed.platform)) || !breaker.canRun(feed.platform)) continue;
    state.queue.splice(i, 1);
    return { feed, trigger: job.trigger, force: job.force, limit: job.limit, lane: 0 };
  }
  // 2. scheduled work. Lanes are global (every lane-0 feed of any platform beats every lane-1 feed, which beats every lane-2
  //    feed); inside a lane the platform served LEAST RECENTLY goes first, so registry order never decides who runs.
  if (state.paused || !cfg.schedulerEnabled) return null;
  const { free } = openPlatforms(cfg);
  if (!free.length) return null;
  // Asked per platform AND per kind (refresh vs backfill): a long backlog of overdue backfill feeds cannot push a refresh feed out
  // of the page, and one platform with hundreds of due feeds cannot hide the others behind a single LIMIT.
  const byPlatform = new Map();
  for (const platform of free) {
    const rows = [...repo.feeds.due(40, [], [platform], { backfill: false }), ...repo.feeds.due(40, [], [platform], { backfill: true })]
      .map((feed) => ({ feed, lane: backfill.laneOf(feed, cfg) }));
    rows.sort((x, y) => x.lane - y.lane);
    byPlatform.set(platform, rows);
  }
  for (const lane of [0, 1, 2]) {
    const order = free.filter((p) => (byPlatform.get(p) || []).some((c) => c.lane === lane))
      .sort((p, q) => (state.served.get(p) || 0) - (state.served.get(q) || 0));
    for (const platform of order) {
      if (platformFull(platform, cfg) || !breaker.canRun(platform)) continue;
      const pick = byPlatform.get(platform).find((c) => c.lane === lane && !state.running.has(c.feed.id) && budget.allow(platform, lane, cfg));
      if (pick) { state.served.set(platform, ++state.serveSeq); return { feed: pick.feed, trigger: 'schedule', force: false, lane }; }
    }
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
      runFeed(work.feed, work.trigger, { force: work.force, limit: work.limit, lane: work.lane })
        .catch((e) => events.log('ERR', `engine: ${e.message}`))
        .finally(() => { if (!state.stopRequested && state.timer) setImmediate(tick); }); // a free slot is refilled at once, not at the next 30 s tick
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
    breakers: breaker.snapshot(), hostBreakers: breaker.hostSnapshot ? breaker.hostSnapshot() : {}, sse: events.counts(),
    slots: Object.fromEntries(registry.list().map((a) => [a.platform, { running: runningOn(a.platform), max: slotsFor(a.platform, cfg) }])),
    budget: budget.status(), disk: diskguard.status(),
  };
}

/* ---------------------------------------------------------------- lifecycle */
function seedCuratedCreators(db) {
  const seedPath = path.join(__dirname, "../sources/creators-seed.json");
  if (!fs.existsSync(seedPath)) return 0;
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  } catch (err) {
    events.log("ERR", `Failed to parse creators-seed.json: ${err.message}`);
    return 0;
  }
  if (!seed || !Array.isArray(seed.creators) || !seed.creators.length) return 0;

  const insertCreator = db.prepare(`
    INSERT INTO creators (id, handle, display_name, bio, avatar_url, banner_url, links, verified, scope, status, origin)
    VALUES (@id, @handle, @display_name, @bio, @avatar_url, @banner_url, @links, @verified, 'in', 'active', 'seed')
    ON CONFLICT(id) DO UPDATE SET
      links = excluded.links,
      avatar_url = COALESCE(creators.avatar_url, excluded.avatar_url),
      banner_url = COALESCE(creators.banner_url, excluded.banner_url)
  `);

  const insertFeed = db.prepare(`
    INSERT INTO feeds (id, platform, kind, target, label, creator_id, enabled, trusted, origin, interval_min)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'seed', ?)
    ON CONFLICT(platform, kind, target) DO NOTHING
  `);

  const insertMedia = db.prepare(`
    INSERT INTO media (
      id, creator_id, feed_id, platform, source_id, source_key, post_key, position,
      source_url, author, title, description, media_type, media_url, preview_url,
      thumbnail_url, hls_url, has_audio, width, height, duration, score, likes,
      views, hot, hash, nsfw_level, scope, publish_state, tags_text, posted_at, thumb_url, tint
    ) VALUES (
      @id, @creator_id, NULL, @platform, @source_id, @source_key, @post_key, @position,
      @source_url, @author, @title, @description, @media_type, @media_url, @preview_url,
      @thumbnail_url, @hls_url, @has_audio, @width, @height, @duration, @score, @likes,
      @views, @hot, @hash, @nsfw_level, @scope, @publish_state, @tags_text, @posted_at, @thumb_url, @tint
    )
    ON CONFLICT(hash) DO NOTHING
    ON CONFLICT(source_key) DO NOTHING
  `);

  const insertLead = db.prepare(`
    INSERT INTO onlyfans_leads (service, handle, creator_id, status, origin, checked_at)
    VALUES ('OnlyFans', ?, ?, 'claimed', 'seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(service, handle) DO UPDATE SET creator_id = excluded.creator_id, status = 'claimed'
  `);

  const tx = db.transaction(() => {
    for (const c of seed.creators) {
      insertCreator.run(c);
      try {
        const parsedLinks = JSON.parse(c.links || "[]");
        for (const l of parsedLinks) {
          if (l.service === "OnlyFans" && l.handle) {
            insertLead.run(l.handle.toLowerCase(), c.id);
          }
        }
      } catch { /* ignore invalid JSON in links */ }
    }
    // One feed per account the seed knows about (Coomer page, Bluesky, RedGIFs, GayForFans, link-in-bio, own site), not only
    // Coomer: see sources/seed-feeds. Targets that were a Bluesky handle in an OnlyFans slot are repaired there.
    const derived = deriveFeeds(seed);
    for (const f of derived) {
      if (require('../lib/deadhosts').deadReason(f.platform, f.target)) continue; // a dead or wrong-platform host is never seeded on
      const id = `seed-${f.platform}-${f.kind}-${crypto.createHash('md5').update(f.target.toLowerCase()).digest('hex').slice(0, 10)}`;
      insertFeed.run(id, f.platform, f.kind, f.target, f.label, f.creator_id, f.interval_min || 240);
    }
    // Databases seeded by an older version carry the broken Coomer targets: switch those off (only feeds PRISM itself seeded).
    const good = new Set(derived.filter((f) => f.platform === 'coomer').map((f) => f.target.toLowerCase()));
    for (const f of seed.feeds || []) {
      if (f.platform === 'coomer' && !good.has(String(f.target).toLowerCase())) {
        db.prepare("UPDATE feeds SET enabled = 0 WHERE platform = 'coomer' AND kind = 'user' AND target = ? AND origin = 'seed'").run(f.target);
      }
    }
    for (const m of seed.media || []) {
      insertMedia.run(m);
    }
    // Only the curated creators: the counts are per creator, and a correlated UPDATE over every creator in
    // the library (14k on prod) cost ~16 s inside this transaction, on the main thread, at boot.
    // (repo.creators.recount is the one definition of the counters: published items only.)
    for (const c of seed.creators) repo.creators.recount(c.id);
  });

  tx();
  events.log("INFO", `Seeded ${seed.creators.length} curated creators, ${deriveFeeds(seed).length} feeds, and ${(seed.media || []).length} media items`);
  return seed.creators.length;
}

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
  seedCuratedCreators(repo.db);
  repo.settings.set('seed_version', String(registry.SEED_VERSION));
  backfillCreatorStats(repo.db);
  return created;
}

/**
 * The seed used to refresh the counts of every creator in one transaction (14k on prod: ~16 s on the main thread).
 * This does the same for every creator, a few at a time, so the event loop answers between the chunks.
 */
function backfillCreatorStats(db, chunk = 5) { // a few creators per tick: 25 blocked the loop for ~0.5 s each on a cold file
  const pick = db.prepare('SELECT id FROM creators WHERE id > ? ORDER BY id LIMIT ?');
  return new Promise((resolve) => {
    let after = ''; let done = 0;
    const step = () => {
      const ids = pick.all(after, chunk).map((r) => r.id);
      if (!ids.length) { if (done) events.log('INFO', `Refreshed media counts for ${done} creators`); return resolve(done); }
      db.transaction(() => { for (const id of ids) repo.creators.recount(id); })();
      done += ids.length; after = ids[ids.length - 1];
      setImmediate(step);
    };
    setImmediate(step);
  });
}

/**
 * Refresh the trending scores. In production the rewrite runs on the maintenance worker thread: it is
 * thousands of row updates every ten minutes and used to be one of the loop stalls /api/health reported.
 * Tests and `:memory:` databases keep the inline path so they stay deterministic.
 */
function refreshHot() {
  if (config.isTest || config.dbPath === ':memory:' || process.env.PRISM_BACKUP_INLINE === '1') return repo.media.recomputeHotChunked();
  return require('./backup').hotScore().then((r) => (r && r.updated) || 0)
    .catch((e) => { events.log('WARN', `hot refresh on worker failed (${e.message}); retrying inline`); return repo.media.recomputeHotChunked(); });
}

function start() {
  if (state.timer) return;
  state.session.startedAt = new Date().toISOString();
  repo.runs.abandonRunning();
  const cfg = settingsStore.get();
  // Let the health probe answer (Railway gives ~10s) before the feed engine starts firing:
  // on a 5000-feed box the first tick schedules many concurrent requests that can stall the event loop.
  setTimeout(() => {
    state.timer = setInterval(tick, cfg.tickSeconds * 1000);
    state.timer.unref();
  state.hotTimer = setInterval(() => {
    // Chunked: the refresh rewrites every published row whose score drifted, and one statement
    // for the whole library blocks the event loop for minutes on a large one.
    refreshHot().then(() => { try { repo.settings.set('hot_recomputed_at', new Date().toISOString()); } catch { /* ignore */ } }).catch((e) => events.log('ERR', `maintenance: ${e.message}`));
    try { repo.runs.prune(settingsStore.get().keepRunHistoryDays); } catch (e) { events.log('ERR', `maintenance: ${e.message}`); }
  }, 10 * 60000);
  state.hotTimer.unref();
  setTimeout(() => {
    // Seeding is a transaction on the main thread: it runs after the first health answer, never before the listener is up.
    try { seedDefaults(); } catch (e) { events.log('ERR', `seed: ${e.message}`); }
    tick();
  }, 2000).unref();
  }); // end setTimeout delay for engine start
  // The first hot-score pass after a restart reads every published row, cold on a fresh container. It used to run at
  // 2 s, on top of the seed and the warm-up: a 12 s run of main-thread work. It now runs after the warm-up (30 s); the
  // 10-minute timer above keeps the scores current in between. Skip it when the scores were already refreshed in the
  // last 30 minutes (a deploy restart does not need a second full pass).
  setTimeout(() => {
    let last = 0;
    try { last = Date.parse(repo.settings.get('hot_recomputed_at') || '') || 0; } catch { last = 0; }
    if (Date.now() - last < 30 * 60 * 1000) return;
    refreshHot().then(() => { try { repo.settings.set('hot_recomputed_at', new Date().toISOString()); } catch { /* ignore */ } }).catch(() => { /* ignore */ });
  }, 30000).unref();
}

function shutdown() {
  clearInterval(state.timer); clearInterval(state.hotTimer);
  state.timer = null; state.hotTimer = null; state.stopRequested = true;
}

module.exports = { _nextWork: nextWork, slotsFor, runningOn, start, shutdown, tick, runFeed, enqueue, enqueuePlatforms, stopAll, pause, resume, status, seedDefaults, seedCuratedCreators, backfillCreatorStats, computeNextRun, tempo, adoptDiscoveredFeeds, _profileDue: profileDue, _state: state, _waysIn: { noteWaysIn, followWaysIn } };
