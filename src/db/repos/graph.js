'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** attachCreatorGraph: creator similarity, collaborators, duplicates, activity, the constellation graph and rising creators, attached to `creators`. Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.attachCreatorGraph = function attachCreatorGraph({ db, creators, library, GENERIC_TAGS, SELECT_CREATOR_CARD, serializeCreator, cleanTag }) {
/**
 * Creators who post in a similar style: cosine similarity of tf-idf tag profiles (rare tags count
 * for more than common ones), served from an index built once per library snapshot.
 * "OnlyFans creators like him" draws from a wider pool, since only some creators have a page.
 */
creators.similar = function similar(id, limit = 12, { onlyfans: ofOnly = false } = {}) {
  const top = require('../../lib/similarity').neighbours(library(), GENERIC_TAGS, id, limit * (ofOnly ? 10 : 2)).map(([cid]) => cid);
  if (!top.length) return [];
  const found = db.prepare(`${SELECT_CREATOR_CARD} WHERE c.id IN (${top.map(() => '?').join(',')}) AND c.status = 'active' AND c.scope != 'excluded' AND c.media_count > 0${ofOnly ? " AND c.links GLOB '*onlyfans.com/[A-Za-z0-9]*'" : ''}`)
    .all(...top).map(serializeCreator);
  found.sort((a, b) => top.indexOf(a.id) - top.indexOf(b.id));
  return found.slice(0, limit);
};

/**
 * Creators who co-star or frequently collaborate with this creator.
 * Sourced from mutual post mentions (@handle, OnlyFans/Fansly links), candidate co-mentions,
 * and incoming scene tags. Bidirectional mentions receive higher ranking weights.
 */
creators.collabs = function collabs(id, limit = 12) {
  const c = creators.get(id);
  if (!c || c.status !== 'active') return [];

  const selfHandles = new Set([c.handle.toLowerCase()]);
  if (c.display_name) selfHandles.add(c.display_name.toLowerCase());
  try {
    const aliases = db.prepare('SELECT alias FROM creator_aliases WHERE creator_id = ?').all(c.id);
    for (const a of aliases) if (a.alias) selfHandles.add(a.alias.toLowerCase());
  } catch { /* best effort */ }
  try {
    const feedsRows = db.prepare('SELECT target FROM feeds WHERE creator_id = ?').all(c.id);
    for (const f of feedsRows) if (f.target) selfHandles.add(f.target.toLowerCase());
  } catch { /* best effort */ }
  if (Array.isArray(c.links)) {
    for (const l of c.links) if (l && l.handle) selfHandles.add(l.handle.toLowerCase());
  }

  // 1. Outgoing mentions in media by this creator
  const myMedia = db.prepare("SELECT title, description FROM media WHERE creator_id = ? AND publish_state = 'published' AND (title LIKE '%@%' OR description LIKE '%@%' OR title LIKE '%onlyfans.com/%' OR description LIKE '%onlyfans.com/%' OR title LIKE '%/u/%' OR description LIKE '%/u/%')").all(c.id);
  const mentionCounts = new Map();
  for (const m of myMedia) {
    const text = `${m.title || ''} ${m.description || ''}`;
    const handles = new Set();
    for (const match of text.matchAll(/@([a-zA-Z0-9_]{3,30})/g)) handles.add(match[1].toLowerCase());
    for (const match of text.matchAll(/(?:^|[^\w/])\/?u\/([a-zA-Z0-9_-]{3,30})/g)) handles.add(match[1].toLowerCase());
    for (const match of text.matchAll(/(?:onlyfans|fansly)\.com\/([a-zA-Z0-9_.-]{3,30})/gi)) handles.add(match[1].toLowerCase());
    for (const h of handles) {
      if (!selfHandles.has(h)) mentionCounts.set(h, (mentionCounts.get(h) || 0) + 1);
    }
  }

  const creatorScores = new Map();
  const targetHandles = [...mentionCounts.keys()];
  if (targetHandles.length) {
    const placeholders = targetHandles.map(() => '?').join(',');
    const matched = db.prepare(`SELECT id, lower(handle) as h FROM creators WHERE status = 'active' AND scope != 'excluded' AND lower(handle) IN (${placeholders}) AND id != ?`).all(...targetHandles, c.id);
    for (const row of matched) {
      creatorScores.set(row.id, (creatorScores.get(row.id) || 0) + (mentionCounts.get(row.h) || 1));
    }
    const matchedAliases = db.prepare(`SELECT ca.creator_id as id, lower(ca.alias) as a FROM creator_aliases ca JOIN creators c ON c.id = ca.creator_id WHERE c.status = 'active' AND c.scope != 'excluded' AND lower(ca.alias) IN (${placeholders}) AND c.id != ?`).all(...targetHandles, c.id);
    for (const row of matchedAliases) {
      creatorScores.set(row.id, (creatorScores.get(row.id) || 0) + (mentionCounts.get(row.a) || 1));
    }
  }

  // 2. Incoming mentions via FTS (other creators posting about this creator)
  try {
    const ftsTerm = c.handle.replace(/[^a-zA-Z0-9_]/g, '');
    if (ftsTerm.length >= 3) {
      const incoming = db.prepare("SELECT m.creator_id, COUNT(*) as count FROM media_fts f JOIN media m ON m.seq = f.rowid WHERE media_fts MATCH ? AND m.creator_id != ? AND m.creator_id IS NOT NULL AND m.publish_state = 'published' GROUP BY m.creator_id").all(ftsTerm, c.id);
      for (const inc of incoming) {
        const existing = creatorScores.get(inc.creator_id) || 0;
        creatorScores.set(inc.creator_id, existing + inc.count * (existing > 0 ? 3 : 1));
      }
    }
  } catch { /* best effort */ }

  // 3. Candidates discovery co-mentions
  try {
    const candidateRows = db.prepare("SELECT creator_id FROM candidates WHERE status IN ('followed', 'linked') AND creator_id IS NOT NULL AND creator_id != ? AND signals LIKE ?").all(c.id, '%"' + c.id + '"%');
    for (const row of candidateRows) {
      creatorScores.set(row.creator_id, (creatorScores.get(row.creator_id) || 0) + 2);
    }
  } catch { /* best effort */ }

  const sortedIds = [...creatorScores.entries()].sort((a, b) => b[1] - a[1]).map(([cid]) => cid).slice(0, limit);
  if (!sortedIds.length) return [];

  const found = db.prepare(`${SELECT_CREATOR_CARD} WHERE c.id IN (${sortedIds.map(() => '?').join(',')}) AND c.status = 'active' AND c.scope != 'excluded'`).all(...sortedIds).map(serializeCreator);
  found.sort((a, b) => creatorScores.get(b.id) - creatorScores.get(a.id));
  return found.map((card) => ({ ...card, collab_count: creatorScores.get(card.id) || 1 }));
};

/**
 * Probable duplicate creators (the same person added twice, usually from different platforms).
 * Evidence, strongest first: the same link-in-bio / profile link, the same profile picture, handles
 * that collapse to the same string once punctuation and filler suffixes (_xo, _fit, official…) go,
 * handles one typo apart, and the same display name with a similar posting style. Each group lists
 * the creator to keep first (most posts); every other member carries `match`: why it was grouped.
 */
creators.duplicates = function duplicates() {
  const core = (h) => String(h || '').toLowerCase().replace(/@.*$/, '').replace(/\.(bsky\.social|social)$/, '').replace(/[^a-z0-9]/g, '').replace(/(official|xo|fit|real|the|xxx|tv|vip)+$/g, '').replace(/^(the|real|its|im)/, '');
  const nameKey = (n) => String(n || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  const linkKey = (u) => {
    try {
      const x = new URL(u);
      const path = x.pathname.replace(/\/+$/, '').toLowerCase();
      if (path.length < 3) return null; // a bare site says nothing about who
      return `${x.hostname.replace(/^www\./, '').toLowerCase()}${path}`;
    } catch { return null; }
  };
  const rows = db.prepare("SELECT id, handle, display_name, avatar_url, links, media_count, status FROM creators WHERE status != 'blocked'").all();
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const why = new Map(); // id -> Set(reason)
  const join = (a, b, reason) => {
    if (a === b) return;
    for (const id of [a, b]) { if (!why.has(id)) why.set(id, new Set()); why.get(id).add(reason); }
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const bucket = (keyFn, reason, minLen = 1) => {
    const first = new Map();
    for (const r of rows) {
      for (const k of [].concat(keyFn(r) || [])) {
        if (!k || k.length < minLen) continue;
        if (first.has(k)) join(first.get(k), r.id, typeof reason === 'function' ? reason(k) : reason); else first.set(k, r.id);
      }
    }
  };
  bucket((r) => { try { return JSON.parse(r.links || '[]').map((l) => linkKey(l && l.url)).filter(Boolean); } catch { return []; } }, (k) => `same link (${k})`, 6);
  // A picture alone is weak evidence (instances hand out shared default avatars): only a URL no more
  // than two creators use, that doesn't look like a placeholder, and only with a matching name or style.
  const avatarUses = new Map();
  for (const r of rows) if (r.avatar_url) avatarUses.set(r.avatar_url, (avatarUses.get(r.avatar_url) || 0) + 1);
  const firstPic = new Map(); const lib0 = library(); const sim0 = require('../../lib/similarity');
  for (const r of rows) {
    const u = r.avatar_url;
    if (!u || u.length < 10 || avatarUses.get(u) > 2 || /(default|missing|placeholder|anonymous|no[-_]?avatar|blank)/i.test(u)) continue;
    const o = firstPic.get(u);
    if (!o) { firstPic.set(u, r); continue; }
    const sameName = nameKey(o.display_name).length >= 4 && nameKey(o.display_name) === nameKey(r.display_name);
    if (sameName || sim0.between(lib0, GENERIC_TAGS, o.id, r.id) >= 0.2) join(o.id, r.id, 'same profile picture');
  }
  bucket((r) => core(r.handle), 'same handle', 4);
  // One typo apart: every handle's single-character deletions meet in a shared key.
  const del = new Map();
  for (const r of rows) {
    const c = core(r.handle);
    if (c.length < 6) continue;
    const keys = new Set([c]);
    for (let i = 0; i < c.length; i++) keys.add(c.slice(0, i) + c.slice(i + 1));
    for (const k of keys) { if (!del.has(k)) del.set(k, []); del.get(k).push(r.id); }
  }
  const coreOf = new Map(rows.map((r) => [r.id, core(r.handle)]));
  const digits = (id) => coreOf.get(id).replace(/\D/g, '');
  for (const ids of del.values()) {
    if (ids.length < 2 || ids.length > 4) continue;
    // Numbered handles (jake1, jake2) are as often different people as backups: a typo must be in the letters.
    for (const other of ids.slice(1)) if (find(other) !== find(ids[0]) && digits(other) === digits(ids[0])) join(ids[0], other, 'nearly the same handle');
  }
  // Same display name: only with a similar style too, since first names repeat.
  const lib = library(); const similarity = require('../../lib/similarity');
  const byName = new Map();
  for (const r of rows) { const k = nameKey(r.display_name); if (k.length >= 5) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r.id); } }
  for (const ids of byName.values()) {
    if (ids.length < 2 || ids.length > 6) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      if (similarity.between(lib, GENERIC_TAGS, ids[i], ids[j]) >= 0.3) join(ids[i], ids[j], 'same name, similar posts');
    }
  }
  const groups = new Map();
  for (const r of rows) {
    const root = find(r.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => b.media_count - a.media_count).map(({ links, ...c }, i) => (i === 0 ? c : { ...c, match: [...(why.get(c.id) || [])] })))
    .sort((a, b) => b.reduce((n, c) => n + c.media_count, 0) - a.reduce((n, c) => n + c.media_count, 0));
};

/**
 * Posting rhythm for a profile: posts per day for the last year (for a heatmap), which sources they
 * come from, and the hours of the day they usually post (UTC).
 */
creators.activity = function activity(id, days = 371) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const pub = "creator_id = ? AND publish_state = 'published' AND scope != 'excluded'";
  return {
    days: db.prepare(`SELECT substr(posted_at, 1, 10) AS day, COUNT(*) AS n FROM media WHERE ${pub} AND posted_at >= ? GROUP BY day ORDER BY day`).all(id, since),
    platforms: db.prepare(`SELECT platform, COUNT(*) AS n FROM media WHERE ${pub} GROUP BY platform ORDER BY n DESC`).all(id),
    hours: db.prepare(`SELECT CAST(substr(posted_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS n FROM media WHERE ${pub} GROUP BY hour ORDER BY hour`).all(id),
    range: db.prepare(`SELECT MIN(posted_at) AS first, MAX(posted_at) AS last FROM media WHERE ${pub}`).get(id),
  };
};

/**
 * Creators gaining momentum: lots of well-received posts this week compared with their usual pace
 * over the previous three weeks. New arrivals (no history) count as rising too.
 */
/**
 * The creator constellation: the most active public creators as nodes, linked to the creators
 * whose posts they most resemble (tf-idf weighted tag vectors, cosine similarity, each node
 * keeping its strongest few links). Each node carries its dominant tag as a "group" for colour.
 */
creators.graph = function graph({ limit = 150, perNode = 4, minSim = 0.12 } = {}) {
  const nodes = db.prepare(`SELECT c.id, c.handle, c.display_name, c.avatar_url, c.media_count, c.last_media_at,
      (SELECT COALESCE(m.preview_url, m.thumbnail_url, CASE WHEN m.media_type = 'image' THEN m.media_url END) FROM media m
        WHERE m.creator_id = c.id AND m.publish_state = 'published' AND m.scope != 'excluded' ORDER BY m.score DESC LIMIT 1) AS preview
    FROM creators c WHERE c.status = 'active' AND c.scope != 'excluded' AND c.media_count >= 2
      AND (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.publish_state = 'published' AND m.scope != 'excluded') >= 2
    ORDER BY c.media_count DESC, c.total_score DESC LIMIT ?`).all(limit);
  if (nodes.length < 2) return { nodes, links: [] };
  const ids = nodes.map((n) => n.id);
  const rows = db.prepare(`SELECT m.creator_id AS cid, t.name AS tag, COUNT(*) AS n FROM media m
      JOIN media_tags mt ON mt.media_id = m.id JOIN tags t ON t.id = mt.tag_id
      WHERE m.creator_id IN (${ids.map(() => '?').join(',')}) AND m.publish_state = 'published' AND m.scope != 'excluded'
      GROUP BY m.creator_id, t.id`).all(...ids).filter((r) => !GENERIC_TAGS.has(r.tag));
  const df = new Map();
  for (const r of rows) df.set(r.tag, (df.get(r.tag) || 0) + 1);
  const vec = new Map(ids.map((id) => [id, new Map()]));
  for (const r of rows) vec.get(r.cid).set(r.tag, (1 + Math.log(r.n)) * Math.log(1 + nodes.length / df.get(r.tag)));
  const norm = new Map(ids.map((id) => [id, Math.sqrt([...vec.get(id).values()].reduce((a, w) => a + w * w, 0)) || 1]));
  // Community names are tagged too ("mastodon-social"); they say where, not what — prefer real style tags for the group.
  const communities = new Set(db.prepare(`SELECT DISTINCT community FROM media WHERE community IS NOT NULL AND creator_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => cleanTag(r.community)));
  for (const n of nodes) {
    let best = null; let bw = 0; let anyBest = null; let aw = 0;
    for (const [tag, w] of vec.get(n.id)) {
      if (w > aw) { aw = w; anyBest = tag; }
      if (!communities.has(tag) && w > bw) { bw = w; best = tag; }
    }
    n.group = best || anyBest;
  }
  // cosine similarity for every pair (n ≤ a few hundred, so O(n²) is fine), keep each node's strongest links
  const cand = new Map(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i++) {
    const a = vec.get(ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      const b = vec.get(ids[j]);
      const [small, big] = a.size < b.size ? [a, b] : [b, a];
      let dot = 0;
      for (const [tag, w] of small) { const o = big.get(tag); if (o) dot += w * o; }
      if (!dot) continue;
      const sim = dot / (norm.get(ids[i]) * norm.get(ids[j]));
      if (sim < minSim) continue;
      cand.get(ids[i]).push([ids[j], sim]); cand.get(ids[j]).push([ids[i], sim]);
    }
  }
  const seen = new Set(); const links = [];
  for (const [id, list] of cand) {
    list.sort((x, y) => y[1] - x[1]);
    for (const [other, sim] of list.slice(0, perNode)) {
      const key = id < other ? `${id}|${other}` : `${other}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: id, target: other, weight: Math.round(sim * 1000) / 1000 });
    }
  }
  return { nodes, links };
};

// INDEXED BY: only the last 28 days of posts are read; the planner would scan every published row (~0.8 s on 260k rows, a few ms this way)
creators.rising = function rising(limit = 12) {
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400000).toISOString();
  const d28 = new Date(now - 28 * 86400000).toISOString();
  const rows = db.prepare(`SELECT m.creator_id AS id,
      SUM(CASE WHEN m.posted_at >= @d7 THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN m.posted_at < @d7 THEN 1 ELSE 0 END) AS before,
      SUM(CASE WHEN m.posted_at >= @d7 THEN m.score + m.likes * 5 ELSE 0 END) AS heat
    FROM media m INDEXED BY ix_media_pub_posted JOIN creators c ON c.id = m.creator_id
    WHERE m.posted_at >= @d28 AND m.publish_state = 'published' AND m.scope != 'excluded' AND c.status = 'active' AND c.scope != 'excluded'
    GROUP BY m.creator_id HAVING week >= 2`).all({ d7, d28 });
  const scored = rows.map((r) => ({ id: r.id, week: r.week, score: (r.week / (r.before / 3 + 1)) * Math.log2(r.heat + 4) }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
  if (!scored.length) return [];
  const byId = new Map(db.prepare(`${SELECT_CREATOR_CARD} WHERE c.id IN (${scored.map(() => '?').join(',')})`).all(...scored.map((r) => r.id)).map((c) => [c.id, serializeCreator(c)]));
  return scored.map((r) => byId.get(r.id) && { ...byId.get(r.id), week_count: r.week }).filter(Boolean);
};
  return { creators };
};
