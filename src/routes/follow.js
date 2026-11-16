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
const MAX_FEED_ROWS = 10000; // the deepest offset the feed answers (see /api/media)
const COUNT_CAP = 1000; // per creator, for the 'new' / 'earlier' parts
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
  // The old query joined every followed creator to ALL of their media and sorted the lot: 130-210 ms for 20-100 big creators on a 1M-row
  // test database, and the list comes from the request body, so anyone could send 500 of the biggest ids. Now: each creator's newest
  // `need` rows come from the (creator, state, posted_at) index in order (no sort, no scan past the page), the newest `need` overall
  // are picked in memory, and only the page's rows are read in full. Pages deeper than MAX_FEED_ROWS answer empty, as /api/media does.
  const need = (page + 1) * limit;
  if (need - limit >= MAX_FEED_ROWS) return res.json({ items: [], total: null, page, limit });
  const ids = [...follows.keys()];
  const creators = repo.db.prepare(`SELECT id, media_count, video_count FROM creators WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'active' AND scope != 'excluded'`).all(...ids);
  const type = b.type === 'image' || b.type === 'video' ? b.type : null;
  const sql = `SELECT m.seq, m.id, m.posted_at FROM media m WHERE m.creator_id = ? AND ${VISIBLE}${type ? ' AND m.media_type = ?' : ''}${split ? (b.part === 'new' ? ' AND m.ingested_at > ?' : ' AND m.ingested_at <= ?') : ''}
    ORDER BY m.posted_at DESC, m.seq DESC LIMIT ?`;
  const stmt = repo.db.prepare(sql);
  const cap = repo.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM media m WHERE m.creator_id = ? AND ${VISIBLE}${type ? ' AND m.media_type = ?' : ''}${split ? (b.part === 'new' ? ' AND m.ingested_at > ?' : ' AND m.ingested_at <= ?') : ''} LIMIT ${COUNT_CAP + 1})`);
  const picked = []; let total = 0; let capped = false;
  for (const c of creators) {
    const args = [c.id]; if (type) args.push(type); if (split) args.push(follows.get(c.id));
    picked.push(...stmt.all(...args, Math.min(need, Math.max(c.media_count, 0) || need)));
    if (!split) total += type === 'video' ? c.video_count : type === 'image' ? Math.max(c.media_count - c.video_count, 0) : c.media_count; // the maintained counters: exact, no scan
    else if (page === 0 || !b.nocount) { const n = cap.get(...args).n; if (n > COUNT_CAP) capped = true; total += Math.min(n, COUNT_CAP); }
  }
  picked.sort((x, y) => (x.posted_at < y.posted_at ? 1 : x.posted_at > y.posted_at ? -1 : y.seq - x.seq));
  const pageIds = picked.slice(page * limit, page * limit + limit).map((r) => r.id);
  const byId = new Map();
  if (pageIds.length) {
    for (const r of repo.db.prepare(`SELECT m.*, c.handle AS creator_handle, c.display_name AS creator_name, c.avatar_url AS creator_avatar FROM media m JOIN creators c ON c.id = m.creator_id WHERE m.id IN (${pageIds.map(() => '?').join(',')})`).all(...pageIds)) byId.set(r.id, r);
  }
  const items = pageIds.map((id) => byId.get(id)).filter(Boolean).map((r) => publicMedia(repo.serializeMedia(r), { brief: true }));
  const showTotal = page === 0 || !b.nocount;
  res.json({ items, total: showTotal ? total : null, ...(showTotal && capped ? { totalCapped: true } : {}), page, limit });
});

module.exports = router;
