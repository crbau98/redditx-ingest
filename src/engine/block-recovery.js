'use strict';
/**
 * Recover a creator the system blocked on a WRONG AUTOMATIC SCOPE (or image-filter) BLOCK.
 *
 * What happened (Bigggwild 2026-11-17 19:22:02Z, Christian Hogue 2026-11-10 17:45:10Z, 26 followed creators in all): a page or account
 * PRISM attached on its own carried female words in its profile text, and the old code blocked the OWNER. creators.block then removed
 * every item, put each hash and phash on the blocklists, wiped the URLs (rows keep source_key and post_key, so a re-ingest is refused),
 * blocklisted the creator id and every feed account, and switched all feeds off. POST /creators/:id/restore only sets status = active.
 *
 * Refused unless ALL hold: the creator is blocked and NOT on a safety hold; the latest block was made by the SYSTEM; its reason is a scope
 * rule ("scope...") or the image filter ("image filter: N pictures with women"), NEVER a safety rule; the creator is admin- or seed-followed
 * OR an automatic-origin feed supplied the evidence of THAT block; no takedown covers him (id, handle, paid pages, links, feed accounts) or
 * any of his media; no report exists for him or his media. Evidence on his OWN feed is never "automatic".
 *
 * Apply undoes exactly what that block did:
 *   1. status active (audit 'recover-block');
 *   2. the blocklist entries THAT block wrote (creator id, hashes, phashes, feed accounts), EXCEPT the evidence feed(s) that stay off;
 *   3. the rows that block removed are DELETED (their URLs are wiped; deleting frees source_key / post_key so the posts can be imported
 *      again, judged afresh by every gate). Rows removed for takedown, safety or an earlier female exclusion are kept;
 *   4. his person-chosen feeds and productive automatic feeds come back on (cursors cleared, runs queued).
 *
 * HOW A BLOCK'S ENTRIES ARE FOUND. After a block the rows are purged: the hash and phash values that were blocklisted exist ONLY in the
 * blocklists, with a reason text shared by dozens of other creators. So:
 *   - blocks made from v4.23.1 on write an 'entries-trace' audit row (the id ranges of the blocklist rows and phash rows the block
 *     inserted: one synchronous transaction, nobody else writes in between). Recovery reads it: EXACT, a neighbour's entries are never in range;
 *   - older blocks have no trace. Hash entries are one contiguous run of ids right before the creator-id entry (exact: a neighbour's run is
 *     separated by its own creator entries). The phash table has no ids to tie it to a block, only a millisecond timestamp, and two blocks
 *     can share a millisecond, so entries on the boundary milliseconds that another block's entries also touch are LEFT in place, and nothing
 *     is removed when the count could exceed his rows. Leaving an entry in place fails safe (a picture stays blocked); deleting a
 *     neighbour's would un-block somebody else's removed content.
 *   - when any row of his was removed earlier for a safety or female reason (kept rows), the hash and phash entries are left alone, because
 *     the block may be the only record of those pictures.
 */
const repo = require('../db/repo');
const config = require('../config');
const { isAutomaticOrigin } = require('../lib/feed-origins');

const SUSPECT_WINDOW_MS = 15 * 60 * 1000;
const ROWS_BEFORE_MS = 60 * 1000;
const ROWS_AFTER_MS = 5 * 1000;
const SCAN_LIMIT = 50000;
const CHUNK = 40; // creators per slice before candidates() yields

const parseTime = (raw) => {
  const s = String(raw || '');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : NaN;
};
const iso = (ms) => new Date(ms).toISOString();
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

function ruleOf(reason) {
  const r = String(reason || '');
  if (/^scope/i.test(r)) return 'scope';
  if (/^image filter/i.test(r)) return 'image-filter';
  if (/^safety/i.test(r)) return 'safety';
  return 'other';
}

/** The latest block of a creator, with the audit id the trace and evidence rows are placed against. */
function blockRecord(creatorId) {
  return repo.db.prepare("SELECT id, actor, reason, created_at FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'block' ORDER BY id DESC LIMIT 1").get(String(creatorId)) || null;
}
/** The audit id of the block before this one (0 when none): rows older than it belong to an earlier block. */
function previousBlockId(creatorId, blockId) {
  const r = repo.db.prepare("SELECT id FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'block' AND id < ? ORDER BY id DESC LIMIT 1").get(String(creatorId), blockId);
  return r ? r.id : 0;
}
/** This block's 'entries-trace' (written right before it by creators.block), or null for a block made before traces existed. */
function traceOf(creatorId, block) {
  const r = repo.db.prepare("SELECT reason FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'entries-trace' AND id < ? AND id > ? ORDER BY id DESC LIMIT 1").get(String(creatorId), block.id, previousBlockId(creatorId, block.id));
  const t = r && parseJson(r.reason);
  return t && Array.isArray(t.b) && Array.isArray(t.p) ? t : null;
}
/** The feed whose evidence caused THIS block ('evidence-feed', written right after it), or null when it was not recorded. */
function recordedEvidence(creatorId, block) {
  const next = repo.db.prepare("SELECT id FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'block' AND id > ? ORDER BY id ASC LIMIT 1").get(String(creatorId), block.id);
  const r = repo.db.prepare(`SELECT reason FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'evidence-feed' AND id > ? ${next ? 'AND id < ?' : ''} ORDER BY id ASC LIMIT 1`).get(...[String(creatorId), block.id, ...(next ? [next.id] : [])]);
  const e = r && parseJson(r.reason);
  return e && e.feedId ? e : null;
}

/** Why this block must NOT be recovered here. Empty array = eligible. `ctx` carries preloaded takedowns and report owners (candidates). */
function refusals(creator, block, ctx = {}) {
  const out = [];
  if (!creator) return ['creator not found'];
  const db = repo.db;
  if (db.prepare("SELECT 1 AS ok FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'safety-hold' LIMIT 1").get(creator.id)) out.push('he is on a safety hold: it stays until a human acts, recover-block never undoes it');
  if (creator.status !== 'blocked') out.push(`creator is ${creator.status}, not blocked`);
  if (!block) { out.push('no block record in the audit'); return out; }
  if (block.actor !== 'system') out.push(`the block was made by ${block.actor}, not the system`);
  const rule = ruleOf(block.reason);
  if (rule === 'safety') out.push('a safety block is never recovered here');
  else if (rule === 'other') out.push(`the block reason is not a scope or image-filter rule (${String(block.reason || '').slice(0, 40)})`);
  else {
    const ev = evidenceOf(creator, block, ctx);
    if (!['admin', 'seed'].includes(creator.origin) && !ev.automatic.length) out.push('he is not admin- or seed-followed and no automatic feed supplied the evidence of this block: the evidence is probably his own, so a human must decide elsewhere');
  }
  try {
    const takedowns = require('../lib/takedowns');
    const list = ctx.takedowns || repo.takedowns.all();
    const accountHandles = [creator.handle];
    for (const f of db.prepare('SELECT platform, target FROM feeds WHERE creator_id = ?').all(creator.id)) accountHandles.push(require('./deepsearch').accountHandle(f.platform, f.target));
    for (const l of db.prepare('SELECT handle FROM onlyfans_leads WHERE creator_id = ?').all(creator.id)) accountHandles.push(l.handle);
    if (db.prepare("SELECT 1 AS ok FROM takedowns WHERE kind = 'creator' AND (value = ? OR value = ?) LIMIT 1").get(creator.id, String(creator.handle || ''))) out.push('a takedown names this creator');
    else if (accountHandles.filter(Boolean).some((h) => takedowns.checkHandle(h, null, list))) out.push('a takedown covers one of his handles or accounts');
    let links = []; try { links = JSON.parse(creator.links || '[]'); } catch { links = []; }
    const urls = links.map((l) => l && (l.url || l.target)).filter(Boolean);
    for (const f of db.prepare("SELECT target FROM feeds WHERE creator_id = ? AND platform IN ('web', 'rss', 'linkinbio')").all(creator.id)) urls.push(f.target);
    if (urls.some((u) => takedowns.checkUrl(u, list))) out.push('a takedown covers one of his links or pages');
  } catch { out.push('takedown check failed: refusing'); }
  if (db.prepare("SELECT 1 AS ok FROM media WHERE creator_id = ? AND review_reason LIKE '%takedown%' LIMIT 1").get(creator.id)) out.push('some of his media were removed under a takedown');
  const reported = ctx.reportOwners ? ctx.reportOwners.has(creator.id) : !!db.prepare('SELECT 1 AS ok FROM reports WHERE creator_id = ? OR media_id IN (SELECT id FROM media WHERE creator_id = ?) LIMIT 1').get(creator.id, creator.id);
  if (reported) out.push('a report exists for him or his media');
  return out;
}

/** Automatic-origin feeds attached in the 15 minutes before the block (the fallback when the evidence feed was not recorded). */
function suspectsOf(creatorId, blockedAtMs) {
  return repo.db.prepare('SELECT id, platform, kind, target, origin, enabled, items_total, created_at FROM feeds WHERE creator_id = ?').all(creatorId)
    .filter((f) => isAutomaticOrigin(f.origin)).filter((f) => { const t = parseTime(f.created_at); return Number.isFinite(t) && t >= blockedAtMs - SUSPECT_WINDOW_MS && t <= blockedAtMs + 2000; });
}

/** The account keys that collected image-filter strikes (one query; candidates() builds it once and passes it in). */
function strikeAccounts() {
  return new Set(repo.db.prepare("SELECT DISTINCT target_id FROM moderation_actions WHERE target_type = 'account' AND action = 'image-female'").all().map((r) => String(r.target_id).toLowerCase()));
}

/**
 * Where the female evidence came from, for THIS block:
 *  1. recorded: the 'evidence-feed' row written when the block happened (exact). Automatic origin = a wrong match; his own feed = not;
 *  2. otherwise inferred: scope blocks = automatic feeds attached in the 15 minutes before the block; image-filter blocks = feeds whose
 *     account collected the strikes.
 */
function evidenceOf(creator, block, ctx = {}) {
  const rec = recordedEvidence(creator.id, block);
  if (rec) {
    const row = repo.db.prepare('SELECT id, platform, kind, target, origin, enabled, items_total, created_at FROM feeds WHERE id = ?').get(rec.feedId);
    const f = row || { id: rec.feedId, platform: rec.platform, kind: null, target: rec.target, origin: rec.origin, enabled: 0, items_total: 0, created_at: null };
    const automatic = isAutomaticOrigin(rec.origin || f.origin);
    return { kind: 'recorded evidence feed', source: 'recorded', feeds: [f], automatic: automatic ? [f] : [], own: automatic ? [] : [f] };
  }
  const at = parseTime(block.created_at);
  if (ruleOf(block.reason) === 'image-filter') {
    const strikes = ctx.strikes || strikeAccounts();
    const feeds = repo.db.prepare('SELECT id, platform, kind, target, origin, enabled, items_total, created_at FROM feeds WHERE creator_id = ?').all(creator.id)
      .filter((f) => strikes.has(`${f.platform}:${String(require('./deepsearch').accountHandle(f.platform, f.target)).toLowerCase()}`));
    return { kind: 'strike account', source: 'inferred', feeds, automatic: feeds.filter((f) => isAutomaticOrigin(f.origin)), own: feeds.filter((f) => !isAutomaticOrigin(f.origin)) };
  }
  const feeds = suspectsOf(creator.id, at);
  return { kind: 'attached just before the block', source: 'inferred', feeds, automatic: feeds, own: [] };
}

/** Rows that block removed: removed at the block time, not for a takedown, a safety reason or an earlier female exclusion. */
function rowsOfBlock(creatorId, blockedAtMs) {
  const rows = repo.db.prepare("SELECT id, review_reason FROM media WHERE creator_id = ? AND publish_state = 'removed' AND updated_at >= ? AND updated_at <= ?").all(creatorId, iso(blockedAtMs - ROWS_BEFORE_MS), iso(blockedAtMs + ROWS_AFTER_MS));
  const keep = { takedown: 0, safety: 0, femaleExclusion: 0 }; const ids = [];
  for (const r of rows) {
    const why = String(r.review_reason || '').toLowerCase();
    if (why.includes('takedown')) keep.takedown++;
    else if (why.startsWith('safety')) keep.safety++;
    else if (/^(image|scope|female)/.test(why)) keep.femaleExclusion++;
    else ids.push(r.id);
  }
  return { ids, keep, total: rows.length };
}

/**
 * The blocklist entries written by this one block. Exact from a trace; otherwise positional for hashes and conservative for phashes (see
 * the header). `rows` is rowsOfBlock(): it bounds how many entries one block can have written and decides whether kept rows make them unsafe.
 */
function blocklistRun(creator, block, suspects, rows) {
  const db = repo.db;
  const reason = block.reason;
  const idKey = String(creator.id).toLowerCase();
  const mine = new Map(db.prepare('SELECT id, platform, target FROM feeds WHERE creator_id = ?').all(creator.id).map((f) => [`${f.platform}:${String(f.target).toLowerCase()}`, f]));
  const suspectKeys = new Set(suspects.map((f) => `${f.platform}:${String(f.target).toLowerCase()}`));
  const out = { method: 'none', creatorEntry: null, hashIds: [], phashes: [], accountIds: [], keptAccounts: [], anchorFound: false, note: null };
  const trace = traceOf(creator.id, block);
  if (trace) {
    out.method = 'trace';
    const inRange = db.prepare('SELECT id, type, value, reason FROM blocklist WHERE id > ? AND id <= ?').all(trace.b[0], trace.b[1]);
    for (const e of inRange) {
      if (e.reason !== reason) continue;
      if (e.type === 'hash') out.hashIds.push(e.id);
      else if (e.type === 'creator' && e.value === idKey) { out.creatorEntry = e.id; out.anchorFound = true; }
      else if (e.type === 'creator' && mine.has(e.value)) { if (suspectKeys.has(e.value)) out.keptAccounts.push(e.value); else out.accountIds.push(e.id); }
    }
    out.phashes = db.prepare('SELECT phash FROM phash_blocklist WHERE rowid > ? AND rowid <= ? AND reason = ?').all(trace.p[0], trace.p[1], reason).map((r) => r.phash);
    if (!out.creatorEntry) { const e = db.prepare("SELECT id, reason FROM blocklist WHERE type = 'creator' AND value = ?").get(idKey); if (e && e.reason === reason) out.creatorEntry = e.id; }
  } else {
    const anchor = db.prepare("SELECT id, reason, created_at FROM blocklist WHERE type = 'creator' AND value = ?").get(idKey);
    if (anchor && anchor.reason === reason) {
      out.method = 'position'; out.anchorFound = true; out.creatorEntry = anchor.id;
      let firstAt = anchor.created_at;
      for (const e of db.prepare('SELECT id, type, reason, created_at FROM blocklist WHERE id < ? ORDER BY id DESC LIMIT ?').all(anchor.id, SCAN_LIMIT)) {
        if (e.type !== 'hash' || e.reason !== reason) break;
        out.hashIds.push(e.id); firstAt = e.created_at;
      }
      const keptIds = [];
      for (const e of db.prepare('SELECT id, type, value, reason FROM blocklist WHERE id > ? ORDER BY id ASC LIMIT ?').all(anchor.id, SCAN_LIMIT)) {
        if (e.type !== 'creator' || e.reason !== reason || !mine.has(e.value)) break;
        if (suspectKeys.has(e.value)) { out.keptAccounts.push(e.value); keptIds.push(e.id); } else out.accountIds.push(e.id);
      }
      // phash: timestamp only. Entries on a boundary millisecond that ANOTHER block's blocklist rows also touch could belong to the
      // neighbour, so they stay; the same when the total could exceed what his rows can have produced.
      const cand = db.prepare('SELECT phash, created_at FROM phash_blocklist WHERE reason = ? AND created_at >= ? AND created_at <= ? ORDER BY rowid').all(reason, firstAt, anchor.created_at);
      const ours = new Set([...out.hashIds, anchor.id, ...out.accountIds, ...keptIds]);
      const sharedAt = (ms) => db.prepare('SELECT id FROM blocklist WHERE created_at = ?').all(ms).some((r) => !ours.has(r.id));
      const loShared = sharedAt(firstAt); const hiShared = sharedAt(anchor.created_at);
      out.phashes = cand.filter((r) => !(r.created_at === firstAt && loShared) && !(r.created_at === anchor.created_at && hiShared)).map((r) => r.phash);
      const ambiguous = cand.length - out.phashes.length;
      if (ambiguous) out.note = `${ambiguous} phash entr${ambiguous === 1 ? 'y' : 'ies'} share a millisecond with another block and were left in place (this block has no entries-trace)`;
    }
  }
  // bounds and policy
  const maxEntries = rows.total;
  if (out.hashIds.length > maxEntries || out.phashes.length > maxEntries) {
    out.note = `${out.hashIds.length} hash and ${out.phashes.length} phash entries exceed the ${maxEntries} rows this block removed: none removed (ambiguous)`;
    out.hashIds = []; out.phashes = [];
  }
  if (rows.keep.safety + rows.keep.femaleExclusion > 0 && (out.hashIds.length || out.phashes.length)) {
    out.note = `${rows.keep.safety + rows.keep.femaleExclusion} of his rows were removed earlier for a safety or female reason: the hash and phash entries stay (the block may be their only record)`;
    out.hashIds = []; out.phashes = [];
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
    const last = (rev.lastFeedAction(f.id) || {}).action;
    if (suspectIds.has(f.id)) why = 'suspect: the evidence feed of this block';
    else if (f.platform === 'lemmy') why = 'retired platform';
    else if (f.platform === 'telegram') why = 'telegram (joined-channel state decides)';
    else if (STAY_OFF.has(last) && last !== 'creator-block-off') why = `last action: ${last}`;
    else if (require('../lib/deadhosts').deadReason(f.platform, f.target)) why = 'dead or wrong-platform host';
    else if (femaleCheck(f.target, f.label).level === 'hard' || checkText(f.target, f.label).level === 'block') why = 'name reads female or fails the safety gate';
    else if (isAutomaticOrigin(f.origin)) {
      if (!(Number(f.items_total) > 0)) why = 'automatic feed that never produced';
      else if (f.platform !== 'web' && f.platform !== 'rss' && !rev.accountIsCreator(f)) why = 'account name does not match creator';
    }
    (why ? off : on).push(why ? { ...label, why } : label);
  }
  return { on, off };
}

/** The whole plan for one creator. Read-only. */
function plan(creatorId, ctx = {}) {
  const creator = repo.db.prepare('SELECT id, handle, display_name, status, origin, links FROM creators WHERE id = ?').get(String(creatorId));
  const block = creator ? blockRecord(creator.id) : null;
  const refused = refusals(creator, block, ctx);
  const out = { creatorId: creator && creator.id, name: creator && (creator.display_name || creator.handle), status: creator && creator.status, origin: creator && creator.origin, blockedBy: block && { actor: block.actor, reason: block.reason, created_at: block.created_at }, eligible: refused.length === 0, refusals: refused };
  if (!creator || !block) return out;
  const at = parseTime(block.created_at);
  const ev = evidenceOf(creator, block, ctx);
  const suspects = ev.automatic;
  const rows = rowsOfBlock(creator.id, at);
  const entries = blocklistRun(creator, block, suspects, rows);
  const feeds = feedPlan(creator, suspects);
  const what = ev.kind === 'strike account' ? 'automatic feed(s) whose account collected the image strikes' : ev.source === 'recorded' ? 'automatic feed that supplied the evidence' : 'automatic feed(s) attached in the 15 minutes before the block';
  out.evidence = {
    kind: ev.kind, source: ev.source,
    suspects: suspects.map((f) => ({ id: f.id, platform: f.platform, target: f.target, origin: f.origin, attachedAt: f.created_at })),
    ownFeedsWithEvidence: ev.own.map((f) => ({ id: f.id, platform: f.platform, target: f.target, origin: f.origin })),
    pinned: suspects.length === 1,
    note: suspects.length === 1 ? `one ${what}: it stays off and blocklisted`
      : suspects.length > 1 ? `several ${what}: all stay off and blocklisted; the culprit cannot be pinned down`
        : ev.own.length ? 'the evidence comes from one of his OWN feeds: recovering him is a human decision (he is admin- or seed-followed)'
          : 'no automatic feed supplied the evidence: the evidence probably came from his own profile; a human must confirm this was a wrong block',
  };
  out.plan = {
    rowsToDelete: rows.ids.length, rowsKept: rows.keep,
    blocklist: { method: entries.method, creatorEntry: entries.creatorEntry ? 1 : 0, hashEntries: entries.hashIds.length, phashEntries: entries.phashes.length, feedAccountEntries: entries.accountIds.length, keptAccountEntries: entries.keptAccounts, anchorFound: entries.anchorFound, note: entries.note },
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
  const del = (sql, list, key) => { for (let i = 0; i < list.length; i += 500) { const c = list.slice(i, i + 500); counts[key] += db.prepare(sql.replace('?', c.map(() => '?').join(','))).run(...c).changes; } };
  db.transaction(() => {
    del("DELETE FROM media WHERE id IN (?) AND publish_state = 'removed'", rows.ids, 'rowsDeleted');
    if (entries.creatorEntry) counts.creatorEntry = db.prepare('DELETE FROM blocklist WHERE id = ?').run(entries.creatorEntry).changes;
    del('DELETE FROM blocklist WHERE id IN (?)', entries.hashIds, 'hashEntries');
    del('DELETE FROM phash_blocklist WHERE phash IN (?)', entries.phashes, 'phashEntries');
    del('DELETE FROM blocklist WHERE id IN (?)', entries.accountIds, 'feedAccountEntries');
    repo.creators.update(creatorId, { status: 'active' });
    const clear = db.prepare('UPDATE feeds SET cursor = NULL, consecutive_failures = 0, last_error = NULL WHERE id = ?');
    feeds.on.forEach((f, i) => {
      repo.feeds.update(f.id, { enabled: true, nextRunAt: new Date(Date.now() + (i % 60) * 60000).toISOString() });
      clear.run(f.id); counts.feedsReenabled++;
      try { repo.logAction('feed', f.id, 'enable', 'recover-block: wrong automatic scope block undone', actor); } catch { /* an old audit table */ }
    });
    repo.logAction('creator', creatorId, 'recover-block', `undid ${p.blockedBy.reason} (${entries.method}): ${JSON.stringify(counts)}; ${p.evidence.note}`.slice(0, 480), actor);
    repo.creators.refreshStats(creatorId);
  })();
  if (!config.isTest && feeds.on.length) {
    try { require('./engine').enqueue(feeds.on.map((f) => f.id), { force: true, trigger: 'recover-block' }); } catch { /* the scheduler picks them up */ }
  }
  delete p._internal;
  return { applied: true, ...p, counts };
}

/**
 * Library-wide, read-only: every blocked creator that has at least one feed, with the rule that blocked him, who blocked him, when, the
 * evidence feed (if found) and a recommendation:
 *   recover: the system blocked him on a scope or image-filter rule and an AUTOMATIC feed supplied the evidence of that block.
 *   review:  the system blocked him on such a rule but only because he is admin- or seed-followed: the evidence is none or on his own
 *            feed, so he may genuinely be a woman. A person decides.
 *   keep:    a safety block or hold, an admin block, any other reason, a takedown or report, or a creator nobody chose whose evidence is his own.
 * Nothing here applies anything; there is no apply-all. It aggregates the strikes, takedowns and report owners ONCE and yields to the event
 * loop every CHUNK creators, so a library of thousands of blocked creators does not stall requests.
 */
async function candidates({ limit = 1000, withFeeds = true } = {}) {
  const rows = repo.db.prepare("SELECT id, handle, display_name, status, origin, links FROM creators WHERE status = 'blocked'").all();
  const ctx = { strikes: strikeAccounts(), takedowns: null, reportOwners: new Set(repo.db.prepare('SELECT DISTINCT COALESCE(r.creator_id, m.creator_id) AS id FROM reports r LEFT JOIN media m ON m.id = r.media_id').all().map((r) => r.id).filter(Boolean)) };
  try { ctx.takedowns = repo.takedowns.all(); } catch { ctx.takedowns = null; }
  const feedStats = new Map(repo.db.prepare('SELECT creator_id, COUNT(*) AS feeds, COALESCE(SUM(items_total), 0) AS items FROM feeds WHERE creator_id IS NOT NULL GROUP BY creator_id').all().map((r) => [r.creator_id, r]));
  const out = []; let i = 0;
  for (const c of rows) {
    if (++i % CHUNK === 0) await new Promise((r) => setImmediate(r));
    const stats = feedStats.get(c.id) || { feeds: 0, items: 0 };
    if (withFeeds && !stats.feeds) continue;
    const block = blockRecord(c.id);
    const refused = refusals(c, block, ctx).filter((r) => !/not blocked/.test(r));
    const rule = block ? (block.actor !== 'system' ? 'admin' : ruleOf(block.reason)) : 'unknown';
    const ev = block && ['scope', 'image-filter'].includes(ruleOf(block.reason)) ? evidenceOf(c, block, ctx) : { kind: null, source: null, feeds: [], automatic: [], own: [] };
    let recommendation = 'keep'; let why = refused[0] || '';
    if (!refused.length) {
      if (ev.automatic.length) { recommendation = 'recover'; why = `evidence came from ${ev.automatic.length} automatic feed(s): likely a wrong match`; }
      else { recommendation = 'review'; why = 'admin- or seed-followed, but the evidence is none or on his own feed: he may genuinely be a woman'; }
    }
    const at = block ? parseTime(block.created_at) : NaN;
    const removed = block && Number.isFinite(at) ? rowsOfBlock(c.id, at) : { ids: [] };
    out.push({
      creatorId: c.id, name: c.display_name || c.handle, origin: c.origin, rule, blockedBy: block ? block.actor : null, reason: block ? block.reason : null, blockedAt: block ? block.created_at : null,
      evidence: { kind: ev.kind, source: ev.source, automaticFeeds: ev.automatic.map((f) => ({ id: f.id, platform: f.platform, target: f.target, origin: f.origin })), ownFeeds: ev.own.map((f) => ({ id: f.id, platform: f.platform, target: f.target, origin: f.origin })) },
      rowsRemovedByBlock: removed.ids.length, feeds: stats.feeds, itemsEverIngested: stats.items, refusals: refused,
      recommendation, why, call: recommendation === 'keep' ? null : `GET /api/admin/creators/${c.id}/recover-block`,
    });
  }
  const order = { recover: 0, review: 1, keep: 2 };
  out.sort((a, b) => (order[a.recommendation] - order[b.recommendation]) || (b.itemsEverIngested - a.itemsEverIngested));
  const count = (k) => out.reduce((m, x) => { m[x[k]] = (m[x[k]] || 0) + 1; return m; }, {});
  return { total: out.length, byRecommendation: count('recommendation'), byRule: count('rule'), byOrigin: count('origin'), items: out.slice(0, Math.max(1, Math.min(5000, Number(limit) || 1000))) };
}

module.exports = { plan, dryRun, apply, candidates, refusals, evidenceOf, ruleOf, suspectsOf, rowsOfBlock, blocklistRun, traceOf, recordedEvidence };
