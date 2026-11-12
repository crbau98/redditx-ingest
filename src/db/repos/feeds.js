'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildFeeds: feeds: create, update, schedule and list. Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildFeeds = function buildFeeds({ db, uuid, nowIso, clampInt }) {
/* --------------------------------------------------------------------- feeds */
const feedQ = {
  get: db.prepare('SELECT * FROM feeds WHERE id = ?'),
  find: db.prepare('SELECT * FROM feeds WHERE platform = ? AND kind = ? AND target = ? COLLATE NOCASE'),
  insert: db.prepare(`INSERT INTO feeds (id, platform, kind, target, label, creator_id, enabled, trusted, origin, interval_min, priority, next_run_at)
                      VALUES (@id, @platform, @kind, @target, @label, @creator_id, @enabled, @trusted, @origin, @interval_min, @priority, @next_run_at)`),
  del: db.prepare('DELETE FROM feeds WHERE id = ?'),
};

const feeds = {
  get(id) { return feedQ.get.get(id) || null; },
  find(platform, kind, target) { return feedQ.find.get(platform, kind, target) || null; },

  /** Idempotent create. Returns {feed, created}. */
  upsert({ platform, kind, target, label, creatorId = null, enabled = 1, trusted = 1, origin = 'admin', intervalMin = 180, priority = 0, runNow = true }) {
    const existing = feedQ.find.get(platform, kind, target);
    if (existing) {
      if (creatorId && !existing.creator_id) db.prepare('UPDATE feeds SET creator_id = ? WHERE id = ?').run(creatorId, existing.id);
      return { feed: feedQ.get.get(existing.id), created: false };
    }
    const id = uuid();
    // A feed on a host that is gone or is the wrong platform is created disabled, so no seed can switch it on.
    const dead = require('../../lib/deadhosts').deadReason(platform, target);
    if (dead) enabled = 0;
    feedQ.insert.run({
      id, platform, kind, target, label: label || target, creator_id: creatorId, enabled: enabled ? 1 : 0,
      trusted: trusted ? 1 : 0, origin, interval_min: intervalMin, priority, next_run_at: runNow ? null : new Date(Date.now() + intervalMin * 60000).toISOString(),
    });
    return { feed: feedQ.get.get(id), created: true };
  },

  update(id, patch) {
    // Every path that turns a feed on or points it at a new target comes through here (admin PATCH, follow, re-enable,
    // physique, stagger, import). A feed on a dead or wrong-platform host stays off, whatever the caller asked for.
    const current = feedQ.get.get(id);
    if (current && patch && (patch.enabled !== undefined || patch.target !== undefined)) {
      const wantOn = patch.enabled !== undefined ? !!patch.enabled : !!current.enabled;
      const target = patch.target !== undefined ? patch.target : current.target;
      if (wantOn && require('../../lib/deadhosts').deadReason(current.platform, target)) patch = { ...patch, enabled: false };
    }
    const cols = { target: 'target', label: 'label', enabled: 'enabled', trusted: 'trusted', interval_min: 'intervalMin', priority: 'priority', creator_id: 'creatorId' };
    const sets = []; const params = { id };
    for (const [col, key] of Object.entries(cols)) {
      let v = patch[key] !== undefined ? patch[key] : patch[col];
      if (v === undefined) continue;
      if (col === 'enabled' || col === 'trusted') v = v ? 1 : 0;
      if (col === 'interval_min') v = clampInt(v, 5, 60 * 24 * 14, 180);
      if (col === 'priority') v = clampInt(v, -10, 10, 0);
      sets.push(`${col} = @${col}`); params[col] = v;
    }
    if (patch.resetErrors) { sets.push('consecutive_failures = 0', 'last_error = NULL', 'next_run_at = NULL'); }
    if (patch.runNow) sets.push('next_run_at = NULL');
    if (patch.nextRunAt) { sets.push('next_run_at = @next_run_at'); params.next_run_at = patch.nextRunAt; }
    if (!sets.length) return feedQ.get.get(id);
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    db.prepare(`UPDATE feeds SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return feedQ.get.get(id);
  },

  remove(id) { return feedQ.del.run(id).changes > 0; },
  /**
   * Enabled feeds whose time has come, skipping platforms whose breaker is open. When more are due than can run (one
   * feed per platform at a time), the most overdue goes first, where an hour late counts double for a followed creator's
   * own account and half for a feed that has been failing. New and "run now" feeds (no next_run_at) go before all of them.
   * Weighting lateness, not sorting by kind, means nothing waits forever: an open feed late long enough still wins.
   */
  due(limit = 20, excludePlatforms = [], onlyPlatforms = [], { backfill } = {}) {
    const ex = (excludePlatforms.length ? `AND platform NOT IN (${excludePlatforms.map(() => '?').join(',')})` : '')
      + (onlyPlatforms.length ? ` AND platform IN (${onlyPlatforms.map(() => '?').join(',')})` : '')
      + (backfill === true ? ` AND ${require('../../engine/backfill').PENDING_SQL}` : backfill === false ? ` AND NOT ${require('../../engine/backfill').PENDING_SQL}` : '');
    const now = nowIso();
    return db.prepare(`SELECT * FROM feeds WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ${ex}
                       ORDER BY priority DESC,
                         CASE WHEN next_run_at IS NULL THEN 1e9 ELSE (julianday(?) - julianday(next_run_at))
                           * (CASE WHEN creator_id IS NOT NULL AND kind IN ('user', 'channel', 'page', 'feed') THEN 2.0 ELSE 1.0 END)
                           * (CASE WHEN consecutive_failures > 0 THEN 0.5 ELSE 1.0 END) END DESC,
                         COALESCE(next_run_at, '') ASC LIMIT ?`).all(now, ...excludePlatforms, ...onlyPlatforms, now, limit);
  },

  finishRun(id, { status, error = null, cursor, nextRunAt, addedItems = 0, failures }) {
    db.prepare(`UPDATE feeds SET last_run_at = @now,
        last_success_at = CASE WHEN @ok = 1 THEN @now ELSE last_success_at END,
        last_status = @status, last_error = @error,
        consecutive_failures = @failures, next_run_at = @next,
        cursor = COALESCE(@cursor, cursor), items_total = items_total + @added,
        updated_at = @now WHERE id = @id`).run({
      id, now: nowIso(), ok: status === 'ok' || status === 'empty' ? 1 : 0, status, error: error ? String(error).slice(0, 400) : null,
      failures, next: nextRunAt, cursor: cursor ? JSON.stringify(cursor) : null, added: addedItems,
    });
  },

  list({ platform, kind, status, q: query, creatorId, enabled, page = 0, limit = 100 } = {}) {
    const where = []; const params = [];
    if (platform) { where.push('f.platform = ?'); params.push(platform); }
    if (kind) { where.push('f.kind = ?'); params.push(kind); }
    if (creatorId) { where.push('f.creator_id = ?'); params.push(creatorId); }
    if (enabled !== undefined && enabled !== '') { where.push('f.enabled = ?'); params.push(enabled === true || enabled === '1' || enabled === 1 || enabled === 'true' ? 1 : 0); }
    if (status === 'error') where.push("f.last_status = 'error'");
    else if (status === 'ok') where.push("f.last_status IN ('ok','empty')");
    else if (status === 'never') where.push('f.last_run_at IS NULL');
    if (query) { where.push('(f.target LIKE ? OR f.label LIKE ?)'); params.push(`%${query}%`, `%${query}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM feeds f ${whereSql}`).get(...params).n;
    const items = db.prepare(`SELECT f.*, c.handle AS creator_handle, c.display_name AS creator_name FROM feeds f
      LEFT JOIN creators c ON c.id = f.creator_id ${whereSql}
      ORDER BY f.enabled DESC, f.platform, f.kind, f.target COLLATE NOCASE LIMIT ? OFFSET ?`).all(...params, limit, page * limit);
    return { items, total, page, limit };
  },

  counts() {
    return db.prepare(`SELECT platform, COUNT(*) AS total, SUM(enabled) AS enabled,
      SUM(CASE WHEN last_status = 'error' THEN 1 ELSE 0 END) AS failing FROM feeds GROUP BY platform`).all();
  },
  countEnabled() { return db.prepare('SELECT COUNT(*) AS n FROM feeds WHERE enabled = 1').get().n; },
};
  return { feeds };
};
