'use strict';
/**
 * Recover a creator the system blocked on a WRONG AUTOMATIC SCOPE BLOCK.
 *
 * What happened (Bigggwild 2026-11-17 19:22:02Z, Christian Hogue 2026-11-10 17:45:10Z, 26 followed creators in all): deep search or
 * coverage attached an account to a real man; an item from it carried female words in its profile text; the old blockFemaleCreator
 * blocked the OWNER. creators.block then removed every item, put each hash and phash on the blocklists, wiped the URLs (rows keep
 * source_key and post_key, so a re-ingest is refused), blocklisted the creator id and every feed account, and switched all feeds off.
 * POST /creators/:id/restore only sets status = active and repairs none of that.
 *
 * Refused unless ALL hold: the creator is blocked; the block was made by the SYSTEM; its reason starts with "scope"; no takedown covers
 * the creator (id, handle, paid-page handles, links, feed accounts) or any of his media; and no report exists for him or his media.
 * Female or safety evidence on his OWN profile or feed is not undone here: those are not "automatic" and need a human decision.
 *
 * Apply undoes exactly what that block did, nothing else:
 *   1. the creator is active again (audit 'recover-block');
 *   2. the blocklist entries THAT block wrote are removed: his creator-id entry, the hash and phash entries, and the feed-account
 *      entries, EXCEPT the account(s) that probably produced the evidence: automatic-origin feeds attached in the 15 minutes before
 *      the block. One such feed pins the culprit; several (or none we can name) are all kept off and said so;
 *   3. the rows that block removed are DELETED (their URLs are gone; deleting them frees source_key and post_key so the feeds can
 *      import the posts again, judged afresh by every gate). Rows removed for takedown or safety reasons are kept;
 *   4. his person-chosen feeds and his productive automatic feeds come back on (not the suspects, not feeds an admin or a sweep
 *      switched off, not dead hosts, not accounts whose name is not his), cursors cleared so each backfills from scratch, runs queued.
 *
 * The blocklist entries are found by POSITION, not by reason alone: one block writes one contiguous run of blocklist ids (hashes,
 * then the creator id, then the feed accounts) inside a single synchronous transaction, and the same reason text ("scope:female:girl
 * (profile)") sits on dozens of other creators' entries. Feed-account entries are also checked against his own feeds.
 */
const repo = require('../db/repo');
const config = require('../config');
const { AUTOMATIC_FEED_ORIGINS } = require('../lib/feed-origins');

const SUSPECT_WINDOW_MS = 15 * 60 * 1000;
const ROWS_BEFORE_MS = 60 * 1000;
const ROWS_AFTER_MS = 5 * 1000;
const SCAN_LIMIT = 50000;

const parseTime = (raw) => {
  const s = String(raw || '');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : NaN;
};
const iso = (ms) => new Date(ms).toISOString();

function blockRecord(creatorId) {
  return repo.db.prepare("SELECT actor, reason, created_at FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'block' ORDER BY id DESC LIMIT 1").get(String(creatorId)) || null;
}

/** Why this block must NOT be recovered here. Empty array = eligible. */
function refusals(creator, block) {
  const out = [];
  if (!creator) return ['creator not found'];
  if (creator.status !== 'blocked') out.push(`creator is ${creator.status}, not blocked`);
  if (!block) { out.push('no block record in the audit'); return out; }
  if (block.actor !== 'system') out.push(`the block was made by ${block.actor}, not the system`);
  if (!/^scope/i.test(String(block.reason || ''))) out.push(`the block reason is not a scope rule (${String(block.reason || '').slice(0, 40)})`);
  const db = repo.db;
  try {
    const takedowns = require('../lib/takedowns');
    const accountHandles = [creator.handle];
    for (const f of db.prepare('SELECT platform, target FROM feeds WHERE creator_id = ?').all(creator.id)) accountHandles.push(require('./deepsearch').accountHandle(f.platform, f.target));
    for (const l of db.prepare('SELECT handle FROM onlyfans_leads WHERE creator_id = ?').all(creator.id)) accountHandles.push(l.handle);
    if (db.prepare("SELECT 1 AS ok FROM takedowns WHERE kind = 'creator' AND (value = ? OR value = ?) LIMIT 1").get(creator.id, String(creator.handle || '')) ) out.push('a takedown names this creator');
    else if (accountHandles.filter(Boolean).some((h) => takedowns.checkHandle(h))) out.push('a takedown covers one of his handles or accounts');
    let links = []; try { links = JSON.parse(creator.links || '[]'); } catch { links = []; }
    const urls = links.map((l) => l && (l.url || l.target)).filter(Boolean);
    for (const f of db.prepare("SELECT target FROM feeds WHERE creator_id = ? AND platform IN ('web', 'rss', 'linkinbio')").all(creator.id)) urls.push(f.target);
    if (urls.some((u) => takedowns.checkUrl(u))) out.push('a takedown covers one of his links or pages');
  } catch { out.push('takedown check failed: refusing'); }
  if (db.prepare("SELECT 1 AS ok FROM media WHERE creator_id = ? AND review_reason LIKE '%takedown%' LIMIT 1").get(creator.id)) out.push('some of his media were removed under a takedown');
  if (db.prepare('SELECT 1 AS ok FROM reports WHERE creator_id = ? OR media_id IN (SELECT id FROM media WHERE creator_id = ?) LIMIT 1').get(creator.id, creator.id)) out.push('a report exists for him or his media');
  return out;
}

/** Automatic-origin feeds attached in the 15 minutes before the block: where the evidence most likely came from. */
function suspectsOf(creatorId, blockedAtMs) {
  return repo.db.prepare('SELECT id, platform, kind, target, origin, enabled, items_total, created_at FROM feeds WHERE creator_id = ?').all(creatorId)
    .filter((f) => AUTOMATIC_FEED_ORIGINS.has(f.origin)).filter((f) => { const t = parseTime(f.created_at); return Number.isFinite(t) && t >= blockedAtMs - SUSPECT_WINDOW_MS && t <= blockedAtMs + 2000; });
}

/** Rows that block removed: removed at the block time, not for a takedown or a safety reason. */
function rowsOfBlock(creatorId, blockedAtMs) {
  const rows = repo.db.prepare("SELECT id, review_reason FROM media WHERE creator_id = ? AND publish_state = 'removed' AND updated_at >= ? AND updated_at <= ?").all(creatorId, iso(blockedAtMs - ROWS_BEFORE_MS), iso(blockedAtMs + ROWS_AFTER_MS));
  const keep = { takedown: 0, safety: 0 }; const ids = [];
  for (const r of rows) {
    const why = String(r.review_reason || '').toLowerCase();
    if (why.includes('takedown')) keep.takedown++; else if (why.startsWith('safety')) keep.safety++; else ids.push(r.id);
  }
  return { ids, keep };
}

/**
 * The blocklist entries written by this one block, found by position (see the header). Returns ids to remove and entries kept.
 * `anchor` is the creator-id entry; hash entries run immediately before it, the feed-account entries immediately after.
 */
function blocklistRun(creator, block, suspects) {
  const db = repo.db;
  const reason = block.reason;
  const anchor = db.prepare("SELECT id, reason, created_at FROM blocklist WHERE type = 'creator' AND value = ?").get(String(creator.id).toLowerCase());
  const out = { creatorEntry: null, hashIds: [], phashes: [], accountIds: [], keptAccounts: [], anchorFound: false };
  // No creator-id entry written for THIS reason: nothing can be placed, so nothing is removed (reported as anchorFound false).
  if (!anchor || anchor.reason !== reason) return out;
  out.anchorFound = true; out.creatorEntry = anchor.id;
  // before the anchor: the hash run
  let firstAt = anchor.created_at;
  for (const e of db.prepare('SELECT id, type, reason, created_at FROM blocklist WHERE id < ? ORDER BY id DESC LIMIT ?').all(anchor.id, SCAN_LIMIT)) {
    if (e.type !== 'hash' || e.reason !== reason) break;
    out.hashIds.push(e.id); firstAt = e.created_at;
  }
  // phash entries: the same block, same transaction: between the first hash entry and the creator entry, with the same reason
  out.phashes = db.prepare('SELECT phash FROM phash_blocklist WHERE reason = ? AND created_at >= ? AND created_at <= ?').all(reason, firstAt, anchor.created_at).map((r) => r.phash);
  // after the anchor: the feed accounts, only those that really are one of his feeds
  const mine = new Map(db.prepare('SELECT id, platform, target FROM feeds WHERE creator_id = ?').all(creator.id).map((f) => [`${f.platform}:${String(f.target).toLowerCase()}`, f]));
  const suspectKeys = new Set(suspects.map((f) => `${f.platform}:${String(f.target).toLowerCase()}`));
  for (const e of db.prepare('SELECT id, type, value, reason FROM blocklist WHERE id > ? ORDER BY id ASC LIMIT ?').all(anchor.id, SCAN_LIMIT)) {
    if (e.type !== 'creator' || e.reason !== reason || !mine.has(e.value)) break;
    if (suspectKeys.has(e.value)) out.keptAccounts.push(e.value); else out.accountIds.push(e.id);
  }
  return out;
}

const STAY_OFF = require('./feed-revive').STAY_OFF;
/** Feeds to switch back on, and the ones left off with the reason. */
function feedPlan(creator, suspects) {
  const rev = require('./feed-revive'); const { femaleCheck } = require('../lib/scope'); const { checkText } = require('../lib/safety');
  const suspectIds = new Set(suspects.map((f) => f.id));
  const on = []; const off = [];
  const rows = repo.db.prepare('SELECT f.*, c.handle AS creator_handle, c.display_name AS creator_name, c.bio AS creator_bio FROM feeds f JOIN creators c ON c.id = f.creator_id WHERE f.creator_id = ?').all(creator.id);
  for (const f of rows) {
    const label = { id: f.id, platform: f.platform, target: f.target, origin: f.origin };
    if (f.enabled) continue;
    let why = null;
    if (suspectIds.has(f.id)) why = 'suspect: an automatic feed attached just before the block';
    else if (f.platform === 'lemmy') why = 'retired platform';
    else if (f.platform === 'telegram') why = 'telegram (joined-channel state decides)';
    else if (STAY_OFF.has((rev.lastFeedAction(f.id) || {}).action) && (rev.lastFeedAction(f.id) || {}).action !== 'creator-block-off') why = `last action: ${(rev.lastFeedAction(f.id) || {}).action}`;
    else if (require('../lib/deadhosts').deadReason(f.platform, f.target)) why = 'dead or wrong-platform host';
    else if (femaleCheck(f.target, f.label).level === 'hard' || checkText(f.target, f.label).level === 'block') why = 'name reads female or fails the safety gate';
    else if (AUTOMATIC_FEED_ORIGINS.has(f.origin)) {
      if (!(Number(f.items_total) > 0)) why = 'automatic feed that never produced';
      else if (f.platform !== 'web' && f.platform !== 'rss' && !rev.accountIsCreator(f)) why = 'account name does not match creator';
    }
    (why ? off : on).push(why ? { ...label, why } : label);
  }
  return { on, off };
}

/** The whole plan for one creator. Read-only. */
function plan(creatorId) {
  const creator = repo.db.prepare('SELECT id, handle, display_name, status, origin, links FROM creators WHERE id = ?').get(String(creatorId));
  const block = creator ? blockRecord(creator.id) : null;
  const refused = refusals(creator, block);
  const out = { creatorId: creator && creator.id, name: creator && (creator.display_name || creator.handle), status: creator && creator.status, origin: creator && creator.origin, blockedBy: block, eligible: refused.length === 0, refusals: refused };
  if (!creator || !block) return out;
  const at = parseTime(block.created_at);
  const suspects = suspectsOf(creator.id, at);
  const rows = rowsOfBlock(creator.id, at);
  const entries = blocklistRun(creator, block, suspects);
  const feeds = feedPlan(creator, suspects);
  out.evidence = {
    suspects: suspects.map((f) => ({ id: f.id, platform: f.platform, target: f.target, origin: f.origin, attachedAt: f.created_at })),
    pinned: suspects.length === 1,
    note: suspects.length === 1 ? 'one automatic feed was attached in the 15 minutes before the block: it is the likely source and stays off and blocklisted'
      : suspects.length > 1 ? 'several automatic feeds were attached in the 15 minutes before the block: all stay off and blocklisted; the culprit cannot be pinned down'
        : 'no automatic feed was attached just before the block: the evidence probably came from his own profile or feed; a human must confirm this was a wrong block',
  };
  out.plan = {
    rowsToDelete: rows.ids.length, rowsKept: rows.keep,
    blocklist: { creatorEntry: entries.creatorEntry ? 1 : 0, hashEntries: entries.hashIds.length, phashEntries: entries.phashes.length, feedAccountEntries: entries.accountIds.length, keptAccountEntries: entries.keptAccounts, anchorFound: entries.anchorFound },
    feedsToReenable: feeds.on, feedsLeftOff: feeds.off,
  };
  out._internal = { rows, entries, feeds, suspects };
  return out;
}

/** Dry run: the plan without internals. */
function dryRun(creatorId) { const p = plan(creatorId); delete p._internal; return p; }

/** Apply. Refuses (returns { applied: false, refusals }) when the plan is not eligible. */
function apply(creatorId, { actor = 'admin' } = {}) {
  const p = plan(creatorId);
  if (!p.eligible) { delete p._internal; return { applied: false, ...p }; }
  const { rows, entries, feeds } = p._internal; const db = repo.db;
  const counts = { rowsDeleted: 0, creatorEntry: 0, hashEntries: 0, phashEntries: 0, feedAccountEntries: 0, feedsReenabled: 0 };
  db.transaction(() => {
    for (let i = 0; i < rows.ids.length; i += 500) {
      const chunk = rows.ids.slice(i, i + 500); const ph = chunk.map(() => '?').join(',');
      counts.rowsDeleted += db.prepare(`DELETE FROM media WHERE id IN (${ph}) AND publish_state = 'removed'`).run(...chunk).changes;
    }
    if (entries.creatorEntry) counts.creatorEntry = db.prepare('DELETE FROM blocklist WHERE id = ?').run(entries.creatorEntry).changes;
    for (let i = 0; i < entries.hashIds.length; i += 500) { const c = entries.hashIds.slice(i, i + 500); counts.hashEntries += db.prepare(`DELETE FROM blocklist WHERE id IN (${c.map(() => '?').join(',')})`).run(...c).changes; }
    for (let i = 0; i < entries.phashes.length; i += 500) { const c = entries.phashes.slice(i, i + 500); counts.phashEntries += db.prepare(`DELETE FROM phash_blocklist WHERE phash IN (${c.map(() => '?').join(',')})`).run(...c).changes; }
    for (let i = 0; i < entries.accountIds.length; i += 500) { const c = entries.accountIds.slice(i, i + 500); counts.feedAccountEntries += db.prepare(`DELETE FROM blocklist WHERE id IN (${c.map(() => '?').join(',')})`).run(...c).changes; }
    repo.creators.update(creatorId, { status: 'active' });
    const clear = db.prepare('UPDATE feeds SET cursor = NULL, consecutive_failures = 0, last_error = NULL WHERE id = ?');
    feeds.on.forEach((f, i) => {
      repo.feeds.update(f.id, { enabled: true, nextRunAt: new Date(Date.now() + (i % 60) * 60000).toISOString() });
      clear.run(f.id); counts.feedsReenabled++;
      try { repo.logAction('feed', f.id, 'enable', 'recover-block: wrong automatic scope block undone', actor); } catch { /* an old audit table */ }
    });
    repo.logAction('creator', creatorId, 'recover-block', `undid ${p.blockedBy.reason}: ${JSON.stringify(counts)}; ${p.evidence.note}`.slice(0, 480), actor);
    repo.creators.refreshStats(creatorId);
  })();
  if (!config.isTest && feeds.on.length) {
    try { require('./engine').enqueue(feeds.on.map((f) => f.id), { force: true, trigger: 'recover-block' }); } catch { /* the scheduler picks them up */ }
  }
  delete p._internal;
  return { applied: true, ...p, counts };
}

/**
 * Library-wide, read-only: creators the SYSTEM blocked with a scope reason. `likelyFalse` = an automatic-origin feed was attached in the
 * 15 minutes before the block (the signature of a namesake or wrong match); otherwise the evidence probably came from his own profile
 * or feed, which is likely genuine: never recovered automatically. Nothing here applies anything.
 */
function candidates({ limit = 500 } = {}) {
  const rows = repo.db.prepare("SELECT id, handle, display_name, status, origin, links FROM creators WHERE status = 'blocked'").all();
  const out = [];
  for (const c of rows) {
    const block = blockRecord(c.id);
    if (!block || block.actor !== 'system' || !/^scope/i.test(String(block.reason || ''))) continue;
    const at = parseTime(block.created_at);
    const suspects = suspectsOf(c.id, at);
    const removed = rowsOfBlock(c.id, at);
    const stats = repo.db.prepare('SELECT COUNT(*) AS feeds, COALESCE(SUM(items_total), 0) AS items FROM feeds WHERE creator_id = ? AND COALESCE(items_total, 0) > 0').get(c.id);
    const refused = refusals(c, block).filter((r) => !/not blocked/.test(r));
    out.push({
      creatorId: c.id, name: c.display_name || c.handle, origin: c.origin, blockedAt: block.created_at, reason: block.reason,
      evidenceFrom: suspects.length ? 'automatic feed' : 'own profile or feed', likelyFalse: suspects.length > 0, suspects: suspects.map((f) => ({ id: f.id, platform: f.platform, target: f.target, origin: f.origin })),
      rowsRemovedByBlock: removed.ids.length, productiveFeeds: stats.feeds, itemsEverIngested: stats.items, refusals: refused, recoverable: refused.length === 0,
      call: refused.length === 0 ? `GET /api/admin/creators/${c.id}/recover-block` : null,
    });
  }
  out.sort((a, b) => (b.likelyFalse - a.likelyFalse) || (b.itemsEverIngested - a.itemsEverIngested));
  return { total: out.length, likelyFalse: out.filter((x) => x.likelyFalse).length, items: out.slice(0, Math.max(1, Math.min(2000, Number(limit) || 500))) };
}

module.exports = { plan, dryRun, apply, candidates, refusals, suspectsOf, rowsOfBlock, blocklistRun };
