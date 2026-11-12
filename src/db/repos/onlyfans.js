'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildOnlyfans: paid-page leads (OnlyFans and the other traced services). Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildOnlyfans = function buildOnlyfans({ db }) {
/* ------------------------------------------------------- OnlyFans leads (v7) */
const parseLead = (r) => {
  if (!r) return null;
  const out = { ...r, free: !!r.free };
  try { out.sources = JSON.parse(r.sources || '[]'); } catch { out.sources = []; }
  try { out.accounts = JSON.parse(r.accounts || '[]'); } catch { out.accounts = []; }
  return out;
};
const OF = 'OnlyFans';
/** Canonical paid-page host per traced service, for owner matching and lead search queries. */
const PAID_HOSTS = { 'OnlyFans': 'onlyfans.com', 'Fansly': 'fansly.com', 'JustFor.Fans': 'justfor.fans',
  'ManyVids': 'manyvids.com', 'LoyalFans': 'loyalfans.com', 'Fanvue': 'fanvue.com',
  'FanCentro': 'fancentro.com', 'Clips4Sale': 'clips4sale.com', 'Patreon': 'patreon.com' };
const onlyfans = {
  get(handle, service = OF) { return parseLead(db.prepare('SELECT * FROM onlyfans_leads WHERE service = ? AND handle = ?').get(service, String(handle))); },
  /**
   * Someone named this paid page. `sourceId` is the creator whose post/bio named it (null for web search).
   * Counts one mention per distinct source, so a promo channel reposting the same creator does not inflate it.
   */
  note(handle, { service = OF, sourceId = null, origin = 'post', displayName = null, bio = null, free = false } = {}) {
    const h = String(handle).toLowerCase();
    const cur = onlyfans.get(h, service);
    if (!cur) {
      db.prepare(`INSERT INTO onlyfans_leads (service, handle, mentions, sources, origin, display_name, bio, free) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(service, h, JSON.stringify(sourceId ? [sourceId] : []), origin, displayName, bio, free ? 1 : 0);
      return onlyfans.get(h, service);
    }
    const sources = new Set(cur.sources);
    const fresh = sourceId ? !sources.has(sourceId) : origin !== cur.origin;
    if (sourceId) sources.add(sourceId);
    db.prepare(`UPDATE onlyfans_leads SET mentions = mentions + ?, sources = ?, display_name = COALESCE(display_name, ?), bio = COALESCE(bio, ?),
        free = MAX(free, ?), last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE service = ? AND handle = ?`)
      .run(fresh ? 1 : 0, JSON.stringify([...sources].slice(-25)), displayName, bio, free ? 1 : 0, service, h);
    return onlyfans.get(h, service);
  },
  /** A followed creator links to this page: it is theirs. */
  claim(handle, creatorId, service = OF) {
    const h = String(handle).toLowerCase();
    db.prepare(`INSERT INTO onlyfans_leads (service, handle, creator_id, status, origin, checked_at) VALUES (?, ?, ?, 'claimed', 'profile', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(service, handle) DO UPDATE SET creator_id = excluded.creator_id, status = 'claimed', last_seen = excluded.last_seen`).run(service, h, creatorId);
  },
  update(handle, patch, service = OF) {
    if (typeof service === 'object' && service !== null) { patch = { ...service, ...patch }; service = OF; } // update(handle, {service, ...}) also works
    if (patch.service !== undefined) service = patch.service;
    const cols = ['status', 'reason', 'display_name', 'bio', 'creator_id', 'checked_at', 'attempts'];
    const sets = []; const params = { service, handle: String(handle).toLowerCase() };
    for (const c of cols) if (patch[c] !== undefined) { sets.push(`${c} = @${c}`); params[c] = patch[c]; }
    if (patch.accounts !== undefined) { sets.push('accounts = @accounts'); params.accounts = JSON.stringify(patch.accounts.slice(0, 12)); }
    if (patch.free !== undefined) { sets.push('free = @free'); params.free = patch.free ? 1 : 0; }
    if (!sets.length) return onlyfans.get(handle, service);
    db.prepare(`UPDATE onlyfans_leads SET ${sets.join(', ')} WHERE service = @service AND handle = @handle`).run(params);
    return onlyfans.get(handle, service);
  },
  /** Leads to look for next: never-checked first, then the most-mentioned whose last look is older than `staleDays`. */
  workable(limit = 10, staleDays = 14) {
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT * FROM onlyfans_leads WHERE (status = 'pending') OR (status = 'searching' AND attempts < 4 AND (checked_at IS NULL OR checked_at < ?))
      ORDER BY status = 'pending' DESC, mentions DESC, last_seen DESC LIMIT ?`).all(since, limit).map(parseLead);
  },
  list({ status, service, page = 0, limit = 50, q: query } = {}) {
    const where = []; const params = [];
    if (status && status !== 'all') { where.push('l.status = ?'); params.push(status); }
    if (service && service !== 'all') { where.push('l.service = ?'); params.push(service); }
    if (query) { where.push("l.handle LIKE ? ESCAPE '\\'"); params.push(`%${String(query).replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM onlyfans_leads l ${w}`).get(...params).n;
    const items = db.prepare(`SELECT l.*, c.handle AS creator_handle, c.display_name AS creator_name, c.media_count AS creator_media
      FROM onlyfans_leads l LEFT JOIN creators c ON c.id = l.creator_id ${w} ORDER BY l.mentions DESC, l.last_seen DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, page * limit).map(parseLead);
    return { items, total, page, limit };
  },
  /** The active creator whose stored links point at this paid page, if any. */
  ownerOf(handle, service = OF) {
    const host = PAID_HOSTS[service] || PAID_HOSTS[OF];
    const h = String(handle).toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
    // The handle may sit behind a section segment (clips4sale.com/store/<handle>), so any path
    // ending in the handle counts, on that host only.
    return db.prepare(`SELECT id, handle FROM creators WHERE status = 'active' AND links LIKE ? ESCAPE '\\' LIMIT 1`).get(`%${host}/%${h}"%`) || null;
  },
  /** Creators with a paid page but few known accounts elsewhere, least recently searched first. */
  reachTargets(limit = 4, staleDays = 30, maxAccounts = 4, service = OF, keyPrefix = null) {
    const host = PAID_HOSTS[service] || PAID_HOSTS[OF];
    const key = keyPrefix || 'of.reach.';
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT c.id, c.handle, c.display_name, c.links,
        (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) AS accounts
      FROM creators c LEFT JOIN discovery_state ds ON ds.key = ? || c.id
      WHERE c.status = 'active' AND c.scope != 'excluded' AND c.links GLOB ? AND (ds.updated_at IS NULL OR ds.updated_at < ?)
        AND (SELECT COUNT(*) FROM feeds x WHERE x.creator_id = c.id AND x.kind IN ('user','page')) <= ?
      ORDER BY ds.updated_at IS NOT NULL, ds.updated_at ASC, c.media_count DESC LIMIT ?`).all(key, `*${host}/[A-Za-z0-9]*`, since, maxAccounts, limit);
  },
  /**
   * Creators already followed here that have no mirrored page yet, most media first: the input for
   * matching a creator *by his name* against coomer's public creator index. A paid link is not
   * required — a popular creator whose OnlyFans handle differs from the name he uses everywhere
   * else is exactly who the handle-based pass cannot find.
   */
  nameTargets(limit = 60, staleDays = 45, keyPrefix = 'coomer.name.') {
    const since = new Date(Date.now() - staleDays * 86400000).toISOString();
    return db.prepare(`SELECT c.id, c.handle, c.display_name, c.media_count
      FROM creators c LEFT JOIN discovery_state ds ON ds.key = ? || c.id
      WHERE c.status = 'active' AND c.scope != 'excluded'
        AND c.display_name IS NOT NULL AND length(trim(c.display_name)) >= 4
        AND (ds.updated_at IS NULL OR ds.updated_at < ?)
        AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.creator_id = c.id AND f.platform = 'coomer')
      ORDER BY ds.updated_at IS NOT NULL, ds.updated_at ASC, c.media_count DESC LIMIT ?`).all(keyPrefix, since, limit);
  },
  counts() {
    const out = { pending: 0, searching: 0, found: 0, claimed: 0, rejected: 0, byService: {} };
    for (const r of db.prepare('SELECT service, status, COUNT(*) AS n FROM onlyfans_leads GROUP BY service, status').all()) {
      out[r.status] = (out[r.status] || 0) + r.n;
      (out.byService[r.service] = out.byService[r.service] || {})[r.status] = r.n;
    }
    out.creators = db.prepare("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND links GLOB '*onlyfans.com/[A-Za-z0-9]*'").get().n;
    return out;
  },
};
  return { onlyfans };
};
