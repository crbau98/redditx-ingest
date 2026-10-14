'use strict';
/**
 * Following: the creators a device follows, and what they posted. PRISM has no accounts, so the
 * follow list lives on the device and arrives in each request body; nothing here is stored.
 * POST (not GET) because a few hundred creator ids do not fit in a URL.
 *
 *   POST /api/follow/summary  { follows: [{ id, seen }], cards? }
 *     -> { creators: [{ ...card, new_count }], gone: [id], total_new }   cards: full creator cards (previews, platforms)
 *   POST /api/follow/feed     { follows: [{ id, since }], part: 'new' | 'earlier' | 'all', type?, page, limit }
 *     -> { items, total, page, limit }   newest first; 'new' = arrived after that creator's `since`
 */
const express = require('express');
const repo = require('../db/repo');
const age = require('../middleware/age');
const { publicMedia, publicCreator } = require('./public');

const router = express.Router();
router.use('/follow', age.requireAge);

const MAX_FOLLOWS = 500;
const NEW_CAP = 99; // "99+" is all a badge needs, and capping keeps each count cheap (100 means "more than 99")
const UUID = /^[0-9a-f-]{36}$/i;
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

const VISIBLE = "m.publish_state = 'published' AND m.scope != 'excluded'";
const cardSql = (marks) => `SELECT id, handle, display_name, avatar_url, media_count, video_count, last_media_at, verified
  FROM creators WHERE id IN (${marks}) AND status = 'active' AND scope != 'excluded'`;
const newSql = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM media m WHERE m.creator_id = ? AND ${VISIBLE} AND m.ingested_at > ? LIMIT ${NEW_CAP + 1})`;
let newStmt = null;

router.post('/follow/summary', (req, res) => {
  const raw = Array.isArray(req.body && req.body.follows) ? req.body.follows.slice(0, MAX_FOLLOWS) : [];
  const seen = new Map();
  for (const f of raw) if (f && typeof f.id === 'string' && UUID.test(f.id)) seen.set(f.id, iso(f.seen));
  const list = [...seen.keys()];
  if (!list.length) return res.json({ creators: [], gone: [], total_new: 0 });
  const marks = Array(list.length).fill('?').join(',');
  const rows = req.body.cards
    ? repo.db.prepare(`${repo.SELECT_CREATOR_CARD} WHERE c.id IN (${marks}) AND c.status = 'active' AND c.scope != 'excluded'`).all(...list).map((r) => publicCreator(repo.serializeCreator(r)))
    : repo.db.prepare(cardSql(marks)).all(...list);
  newStmt = newStmt || repo.db.prepare(newSql);
  const found = new Set(rows.map((r) => r.id));
  let total = 0;
  const creators = rows.map((c) => {
    const since = seen.get(c.id);
    const n = since ? Math.min(newStmt.get(c.id, since).n, NEW_CAP + 1) : 0;
    total += n;
    return { ...c, verified: !!c.verified, new_count: n };
  });
  // most to catch up on first, then whoever posted last
  creators.sort((a, b) => (b.new_count - a.new_count) || String(b.last_media_at || '').localeCompare(String(a.last_media_at || '')));
  // creators removed or opted out since they were followed: the device can drop them
  res.json({ creators, gone: list.filter((id) => !found.has(id)), total_new: total });
});

router.post('/follow/feed', (req, res) => {
  const b = req.body || {};
  const limit = repo.clampInt(b.limit, 1, 120, 36);
  const page = repo.clampInt(b.page, 0, 10000, 0);
  // each creator carries its own "seen" time: one followed yesterday has no backlog of "new"
  const split = b.part === 'new' || b.part === 'earlier';
  const follows = new Map();
  for (const f of (Array.isArray(b.follows) ? b.follows : []).slice(0, MAX_FOLLOWS)) {
    if (f && typeof f.id === 'string' && UUID.test(f.id)) follows.set(f.id, iso(f.since) || '1970-01-01T00:00:00.000Z');
  }
  if (!follows.size) return res.json({ items: [], total: 0, page, limit });
  const params = [];
  for (const [id, since] of follows) params.push(id, since);
  const where = [VISIBLE, "c.status = 'active'", "c.scope != 'excluded'"];
  if (b.type === 'image' || b.type === 'video') { where.push('m.media_type = ?'); params.push(b.type); }
  if (split) where.push(b.part === 'new' ? 'm.ingested_at > f.since' : 'm.ingested_at <= f.since');
  const withF = `WITH f(id, since) AS (VALUES ${Array(follows.size).fill('(?, ?)').join(', ')})`;
  const from = `FROM f JOIN media m ON m.creator_id = f.id JOIN creators c ON c.id = m.creator_id WHERE ${where.join(' AND ')}`;
  const total = page === 0 || !b.nocount ? repo.db.prepare(`${withF} SELECT COUNT(*) AS n ${from}`).get(...params).n : null;
  const rows = repo.db.prepare(`${withF} SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar ${from}
    ORDER BY m.posted_at DESC, m.seq DESC LIMIT ? OFFSET ?`).all(...params, limit, page * limit);
  res.json({ items: rows.map((r) => publicMedia(repo.serializeMedia(r))), total, page, limit });
});

module.exports = router;
