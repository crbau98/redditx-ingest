'use strict';
/**
 * Feeds that were switched off by a side effect and left off after the cause was gone.
 *
 * Found on Bigggwild (2026-11-17): his coomer, gff, justthegays, gaysdream, tiktok and fapello feeds had produced items and were
 * all DISABLED. They sat on a fragment creator that a scope sweep blocked (its profile text matched a female-name rule); a block
 * switches off every feed of the creator. The feeds were later moved to his real, active creator, and nothing switched them back on.
 *
 * A feed is a revive candidate when it is off, its creator is active, it has produced items before, and nothing says the feed ITSELF
 * should stay off: an admin switch, the failure sweeps, the body filter, a takedown, a dead host, a blocklisted account, a name the
 * male-only gates refuse, a permanent or chronic error, an app-seeded feed, or a Telegram channel (switched by the join state).
 */
const repo = require('../db/repo');
const { classify } = require('./errorclass');

// Last feed action that means "this feed should stay off". 'creator-block-off' and 'reassign-media' do not.
const STAY_OFF = new Set(['disable', 'sweep-disable', 'auto-retire', 'physique-feed-off', 'takedown', 'takedown-off']);
const audit = (...a) => { try { repo.logAction(...a); } catch { /* an old audit table cannot take feed rows; the revive itself stands */ } };
const STAGGER_MIN = 360; // revived feeds start spread over six hours, not all at once

function lastFeedAction(id) {
  return repo.db.prepare("SELECT action FROM moderation_actions WHERE target_type = 'feed' AND target_id = ? AND action != 'reassign-media' ORDER BY id DESC LIMIT 1").get(id);
}

// Blocking a creator also blocklists every account its feeds read (creators.block). Only an AUTOMATIC SCOPE block (a profile or sweep
// rule on the creator's text) is undone when the feed moves to an active creator; safety blocks, reports and admin blocks stay.
const blockEntry = (f) => repo.db.prepare("SELECT id, reason FROM blocklist WHERE type = 'creator' AND value = ?").get(`${f.platform}:${String(f.target).toLowerCase()}`);
const scopeBlock = (entry) => /^scope(?::| sweep)/i.test(String(entry.reason || ''));

/** Why a disabled feed on an active creator should stay off, or null when it should be revived. */
function stayOffReason(f) {
  if (f.origin === 'seed') return 'seed feed';
  if (f.platform === 'telegram') return 'telegram (switched by the joined-channel state)';
  const last = lastFeedAction(f.id);
  if (last && STAY_OFF.has(last.action)) return `last action: ${last.action}`;
  if (require('../lib/deadhosts').deadReason(f.platform, f.target)) return 'dead or wrong-platform host';
  const entry = blockEntry(f);
  if (entry && !scopeBlock(entry)) return 'account is on the blocklist';
  const { femaleCheck } = require('../lib/scope'); const { checkText } = require('../lib/safety');
  if (femaleCheck(f.target, f.label).level === 'hard') return 'name reads female (male-only scope)';
  if (checkText(f.target, f.label).level === 'block') return 'safety gate';
  if (require('../settings').get().physiqueFilter && require('../lib/physique').textCheck(f.target, f.label).heavy) return 'body filter';
  if (f.consecutive_failures >= 3) {
    const c = classify(f.last_error || '');
    if (c.permanent || !c.transient) return `broken (${c.kind}, ${f.consecutive_failures} failures)`;
  }
  return null;
}

const CANDIDATES = `SELECT f.id, f.platform, f.kind, f.target, f.label, f.origin, f.creator_id, f.items_total, f.consecutive_failures, f.last_error,
    c.handle AS creator_handle, c.display_name AS creator_name
  FROM feeds f JOIN creators c ON c.id = f.creator_id
  WHERE f.enabled = 0 AND c.status = 'active' AND COALESCE(f.items_total, 0) > 0`;

/**
 * @param {{apply?: boolean, limit?: number, creatorId?: string}} opts apply=false (default) only reports.
 * @returns {{dryRun: boolean, scanned: number, candidates: number, revived: number, byPlatform: object, skipped: object, examples: object[]}}
 */
function reviveFeeds({ apply = false, limit = 500, creatorId = null } = {}) {
  const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
  const rows = creatorId ? repo.db.prepare(`${CANDIDATES} AND f.creator_id = ? ORDER BY f.items_total DESC`).all(creatorId) : repo.db.prepare(`${CANDIDATES} ORDER BY f.items_total DESC`).all();
  const out = { dryRun: !apply, scanned: rows.length, candidates: 0, revived: 0, byPlatform: {}, skipped: {}, examples: [] };
  const todo = [];
  for (const f of rows) {
    const why = stayOffReason(f);
    if (why) { const k = why.replace(/\(.*\)|:.*/g, '').trim(); out.skipped[k] = (out.skipped[k] || 0) + 1; continue; }
    out.candidates++;
    out.byPlatform[f.platform] = (out.byPlatform[f.platform] || 0) + 1;
    if (out.examples.length < 50) out.examples.push({ id: f.id, platform: f.platform, target: f.target, creator: f.creator_name || f.creator_handle, creatorId: f.creator_id, itemsTotal: f.items_total });
    todo.push(f);
  }
  if (!apply) return out;
  const clear = repo.db.prepare('UPDATE feeds SET consecutive_failures = 0, last_error = NULL WHERE id = ?');
  todo.slice(0, cap).forEach((f, i) => {
    clearScopeBlock(f);
    repo.feeds.update(f.id, { enabled: true, nextRunAt: new Date(Date.now() + (i % STAGGER_MIN) * 60000).toISOString() });
    clear.run(f.id);
    audit('feed', f.id, 'enable', `revived: productive feed on active creator (${f.items_total} items before)`, 'system');
    out.revived++;
  });
  return out;
}

function clearScopeBlock(f) { const e = blockEntry(f); if (e && scopeBlock(e)) repo.blocklist.remove(e.id); }

/** Called when a feed or a whole creator's feeds land on an active creator: revive what the same rules allow. */
function reviveFor({ feedId = null, creatorId = null } = {}) {
  try {
    if (creatorId) return reviveFeeds({ apply: true, creatorId, limit: 200 }).revived;
    if (feedId) {
      const f = repo.db.prepare(`${CANDIDATES} AND f.id = ?`).get(feedId);
      if (!f || stayOffReason(f)) return 0;
      clearScopeBlock(f);
      repo.feeds.update(feedId, { enabled: true, runNow: true });
      audit('feed', feedId, 'enable', 'revived: moved to an active creator', 'system');
      return 1;
    }
  } catch { /* a revive never fails the caller's move */ }
  return 0;
}

/** A feed that has produced items before and belongs to an active creator: a run of non-permanent errors must back it off, not end it. */
function producedOnActiveCreator(feed) {
  if (!feed || !(Number(feed.items_total) > 0) || !feed.creator_id) return false;
  const c = repo.db.prepare('SELECT status FROM creators WHERE id = ?').get(feed.creator_id);
  return !!c && c.status === 'active';
}

module.exports = { producedOnActiveCreator, reviveFeeds, reviveFor, stayOffReason, STAY_OFF };
