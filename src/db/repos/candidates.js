'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildCandidates: discovery candidates, discovery state, leads and the target lists discovery reads. Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildCandidates = function buildCandidates({ db, uuid, hosts }) {
/* ------------------------------------------------------------- discovery */
const parseSignals = (row) => { if (!row) return null; let sig = {}; try { sig = JSON.parse(row.signals || '{}'); } catch { sig = {}; } return { ...row, signals: sig }; };
const candidates = {
  get(id) { return parseSignals(db.prepare('SELECT * FROM candidates WHERE id = ?').get(id)); },
  find(platform, kind, target) { return parseSignals(db.prepare('SELECT * FROM candidates WHERE platform = ? AND kind = ? AND target = ? COLLATE NOCASE').get(platform, kind, String(target))); },
  insert(row) {
    const id = uuid();
    db.prepare(`INSERT INTO candidates (id, platform, kind, target, label, url, display_name, avatar_url, bio, score, signals, scope, status, reason, creator_id)
      VALUES (@id, @platform, @kind, @target, @label, @url, @display_name, @avatar_url, @bio, @score, @signals, @scope, @status, @reason, @creator_id)`).run({
      id, label: null, url: null, display_name: null, avatar_url: null, bio: null, score: 0, scope: 'uncertain', status: 'pending', reason: null, creator_id: null,
      ...row, signals: JSON.stringify(row.signals || {}),
    });
    hosts.add(row.avatar_url);
    return candidates.get(id);
  },
  update(id, patch) {
    const cols = ['label', 'url', 'display_name', 'avatar_url', 'bio', 'score', 'scope', 'status', 'reason', 'creator_id', 'decided_at'];
    const sets = []; const params = { id };
    for (const c of cols) if (patch[c] !== undefined) { sets.push(`${c} = @${c}`); params[c] = patch[c]; }
    if (patch.signals !== undefined) { sets.push('signals = @signals'); params.signals = JSON.stringify(patch.signals); }
    sets.push(`last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
    db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (patch.avatar_url) hosts.add(patch.avatar_url);
    return candidates.get(id);
  },
  list({ status = 'pending', page = 0, limit = 50, q: query, platform, sort = 'score' } = {}) {
    const where = []; const params = [];
    if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
    if (platform) { where.push('platform = ?'); params.push(platform); }
    if (query) { where.push("(target LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')"); const l = `%${String(query).replace(/[\\%_]/g, (m) => `\\${m}`)}%`; params.push(l, l); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = sort === 'recent' ? 'last_seen DESC' : sort === 'new' ? 'first_seen DESC' : 'score DESC, last_seen DESC';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM candidates ${w}`).get(...params).n;
    const items = db.prepare(`SELECT * FROM candidates ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, page * limit).map(parseSignals);
    return { items, total, page, limit };
  },
  /** Highest-scoring undecided candidates (for auto-follow). */
  promotable(minScore, limit, offset = 0) {
    return db.prepare("SELECT * FROM candidates WHERE status = 'pending' AND score >= ? AND scope != 'excluded' AND (reason IS NULL OR reason NOT LIKE 'needs review%') ORDER BY score DESC, id LIMIT ? OFFSET ?").all(minScore, limit, offset).map(parseSignals);
  },
  /** Pending accounts (kind 'user' unless given) that still need details (bio/name) looked up. */
  needingDetails(platform, limit, kind = 'user') {
    return db.prepare("SELECT * FROM candidates WHERE status = 'pending' AND platform = ? AND kind = ? AND bio IS NULL AND (reason IS NULL OR reason != 'checked') ORDER BY score DESC LIMIT ?").all(platform, kind, limit).map(parseSignals);
  },
  counts() {
    const o = { pending: 0, followed: 0, linked: 0, rejected: 0 };
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM candidates GROUP BY status').all()) o[r.status] = r.n;
    o.followedToday = db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE status IN ('followed','linked') AND decided_at >= ?").get(new Date(Date.now() - 86400000).toISOString()).n;
    return o;
  },
  /** Drop old, low-value pending rows so the queue stays useful. */
  prune(days = 45, maxScore = 3) {
    return db.prepare("DELETE FROM candidates WHERE status = 'pending' AND score < ? AND last_seen < ?").run(maxScore, new Date(Date.now() - days * 86400000).toISOString()).changes;
  },
};

const discoveryState = {
  get(key, fallback = null) { const r = db.prepare('SELECT value FROM discovery_state WHERE key = ?').get(key); return r ? r.value : fallback; },
  set(key, value) {
    db.prepare(`INSERT INTO discovery_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value === null || value === undefined ? null : String(value));
  },
  /** ISO time a key was last written (null if never). */
  touchedAt(key) { const r = db.prepare('SELECT updated_at FROM discovery_state WHERE key = ?').get(key); return r ? r.updated_at : null; },
};

/** Recently ingested text from active creators — raw material for mention mining. */
function mentionSource(afterIso, limit = 2000) {
  return db.prepare(`SELECT m.platform, m.title, m.description, m.creator_id, m.ingested_at FROM media m JOIN creators c ON c.id = m.creator_id
    WHERE m.ingested_at > ? AND m.publish_state = 'published' AND c.status = 'active' AND (m.title IS NOT NULL OR m.description IS NOT NULL)
    ORDER BY m.ingested_at ASC LIMIT ?`).all(afterIso || '', limit);
}

/** Creators worth investigating, least recently checked first (by a discovery_state key prefix). */
/**
 * Communities where several followed creators post but that are not followed themselves
 * ("where your creators hang out"). Pure SQL over what is already ingested.
 */
function communityHangouts({ minCreators = 2, limit = 60 } = {}) {
  return db.prepare(`SELECT m.platform, m.community, COUNT(DISTINCT m.creator_id) AS creators, group_concat(DISTINCT m.creator_id) AS ids
    FROM media m JOIN creators c ON c.id = m.creator_id
    WHERE m.community IS NOT NULL AND m.community != '' AND m.platform IN ('reddit', 'lemmy', 'redgifs')
      AND m.publish_state = 'published' AND m.scope != 'excluded' AND c.status = 'active' AND c.scope != 'excluded'
      AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.platform = m.platform AND f.kind IN ('community', 'niche') AND f.target = m.community COLLATE NOCASE)
    GROUP BY m.platform, m.community COLLATE NOCASE HAVING creators >= ? ORDER BY creators DESC LIMIT ?`).all(minCreators, limit)
    .map((r) => ({ ...r, ids: String(r.ids || '').split(',').filter(Boolean) }));
}

function discoveryTargets({ platform, prefix, staleDays, limit, minMedia = 1, maxAccounts = 99 }) {
  const since = new Date(Date.now() - staleDays * 86400000).toISOString();
  const platformJoin = platform ? 'JOIN feeds f ON f.creator_id = c.id AND f.platform = @platform AND f.kind = \'user\' AND f.enabled = 1' : '';
  return db.prepare(`SELECT c.id, c.handle, c.display_name, c.media_count, ${platform ? 'f.target AS target' : 'NULL AS target'},
      (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) AS accounts,
      ds.updated_at AS checked
    FROM creators c ${platformJoin}
    LEFT JOIN discovery_state ds ON ds.key = @prefix || c.id
    WHERE c.status = 'active' AND c.scope != 'excluded' AND c.media_count >= @minMedia AND (ds.updated_at IS NULL OR ds.updated_at < @since)
    GROUP BY c.id HAVING accounts <= @maxAccounts
    ORDER BY ds.updated_at IS NOT NULL, ds.updated_at ASC, c.media_count DESC LIMIT @limit`).all({ platform: platform || null, prefix, since, limit, minMedia, maxAccounts });
}

/** Insert or refresh a firehose/stream lead. Keeps first_seen_at, bumps last_seen_at. */
function upsertDiscoveryLead({ platform, externalId, handle = null, payload = null }) {
  if (!platform || !externalId) throw new Error('upsertDiscoveryLead: platform and externalId required');
  const now = Date.now();
  db.prepare(`INSERT INTO discovery_leads (platform, external_id, handle, payload, first_seen_at, last_seen_at)
    VALUES (@platform, @externalId, @handle, @payload, @now, @now)
    ON CONFLICT(platform, external_id) DO UPDATE SET
      handle = COALESCE(excluded.handle, discovery_leads.handle),
      payload = COALESCE(excluded.payload, discovery_leads.payload),
      last_seen_at = excluded.last_seen_at`)
    .run({ platform, externalId: String(externalId), handle, payload: payload == null ? null : JSON.stringify(payload), now });
  return { platform, externalId: String(externalId) };
}

function getDiscoveryLead(platform, externalId) {
  return db.prepare('SELECT * FROM discovery_leads WHERE platform = ? AND external_id = ?').get(platform, String(externalId)) || null;
}
  return { candidates, discoveryState, mentionSource, communityHangouts, discoveryTargets, upsertDiscoveryLead, getDiscoveryLead };
};
