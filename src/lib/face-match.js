'use strict';
/**
 * Local face embedding storage and similarity matching (Phase 3, opt-in).
 *
 * Runs entirely on local face descriptors produced by the existing @vladmandic/human (FaceRes)
 * worker pool. Vectors are L2-normalized and packed as [uint16LE dim][float32LE scale][int8 x D]
 * in SQLite (media_faces). No external biometric API is ever called, and all face vectors for a
 * media item or creator are purged immediately upon takedown.
 *
 * Attribution policy:
 *   - High face similarity (>= threshold, default 0.78) + corroborating text/handle evidence
 *     on the page -> 'confirmed' (attributes media / registers source).
 *   - Medium/high face similarity (>= reviewFloor) without text evidence -> 'review' (queued in
 *     creator_web_matches for human review; NEVER auto-merged or auto-attributed on face alone).
 */
const repo = require('../db/repo');
const settingsStore = require('../settings');

const MIN_CONFIDENCE = 0.45;

/** L2-normalize a numeric array/Float32Array; returns Float32Array or null. */
function normalizeVec(arr) {
  if (!arr || !arr.length) return null;
  let ss = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]) || 0;
    ss += v * v;
  }
  const n = Math.sqrt(ss);
  if (!n || !Number.isFinite(n)) return null;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = (Number(arr[i]) || 0) / n;
  return out;
}

/** Pack a normalized Float32Array into Buffer: [uint16LE dim][float32LE scale][int8 x dim]. */
function packFaceVec(arr) {
  const vec = arr instanceof Float32Array ? arr : normalizeVec(arr);
  if (!vec || !vec.length) return null;
  let max = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > max) max = a;
  }
  const scale = max / 127 || 1;
  const buf = Buffer.allocUnsafe(6 + vec.length);
  buf.writeUInt16LE(vec.length, 0);
  buf.writeFloatLE(scale, 2);
  for (let i = 0; i < vec.length; i++) {
    buf.writeInt8(Math.max(-127, Math.min(127, Math.round(vec[i] / scale))), 6 + i);
  }
  return buf;
}

/** Unpack Buffer -> Float32Array (unit length), or null when malformed. */
function unpackFaceVec(buf) {
  if (!buf || buf.length < 10) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const dim = b.readUInt16LE(0);
  if (dim <= 0 || b.length !== 6 + dim) return null;
  const scale = b.readFloatLE(2);
  const out = new Float32Array(dim);
  let ss = 0;
  for (let i = 0; i < dim; i++) {
    const v = b.readInt8(6 + i) * scale;
    out[i] = v;
    ss += v * v;
  }
  const n = Math.sqrt(ss) || 1;
  for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

/** Cosine similarity between two numeric vectors or packed Buffers (0..1). */
function cosine(a, b) {
  const va = Buffer.isBuffer(a) ? unpackFaceVec(a) : (a instanceof Float32Array ? a : normalizeVec(a));
  const vb = Buffer.isBuffer(b) ? unpackFaceVec(b) : (b instanceof Float32Array ? b : normalizeVec(b));
  if (!va || !vb || va.length !== vb.length) return 0;
  let dot = 0;
  for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
  return Math.max(0, Math.min(1, Math.round(dot * 10000) / 10000));
}

/** Save male face embeddings for a published media item when faceMatch is enabled (or force=true). */
function saveMediaFaces(mediaId, faceList, { force = false } = {}) {
  if (!mediaId || !Array.isArray(faceList) || !faceList.length) return 0;
  if (!force && !settingsStore.get().faceMatch) return 0;
  const db = repo.db;
  const stmt = db.prepare(`INSERT INTO media_faces (media_id, face_idx, gender, confidence, box, vec)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_id, face_idx) DO UPDATE SET
      gender = excluded.gender, confidence = excluded.confidence, box = excluded.box, vec = excluded.vec`);
  let saved = 0;
  faceList.forEach((f, idx) => {
    if (!f || (f.confidence != null && f.confidence < MIN_CONFIDENCE)) return;
    if (f.gender === 'female' && (f.score || 0) >= 0.5) return; // never store excluded female faces
    const packed = Buffer.isBuffer(f.vec) ? f.vec : packFaceVec(f.embedding);
    if (!packed) return;
    stmt.run(mediaId, idx, f.gender || 'male', Number(f.confidence) || 0.8, f.box ? JSON.stringify(f.box) : null, packed);
    saved++;
  });
  return saved;
}

/** Reference face vectors for a creator from their recent published media. */
function creatorReferenceFaces(creatorId, limit = 16) {
  if (!creatorId) return [];
  const rows = repo.db.prepare(`SELECT mf.media_id, mf.face_idx, mf.vec, mf.confidence, mf.box
    FROM media_faces mf
    JOIN media m ON m.id = mf.media_id
    WHERE m.creator_id = ? AND m.publish_state = 'published' AND m.scope != 'excluded'
    ORDER BY COALESCE(m.posted_at, m.ingested_at) DESC
    LIMIT ?`).all(creatorId, limit);
  return rows.map((r) => ({
    mediaId: r.media_id,
    faceIdx: r.face_idx,
    confidence: r.confidence,
    box: r.box ? JSON.parse(r.box) : null,
    vec: unpackFaceVec(r.vec),
  })).filter((r) => !!r.vec);
}

/** Compare candidate faces against a creator's reference face set. */
function scoreFaceHit(candidateFaces, refFaces) {
  if (!Array.isArray(candidateFaces) || !candidateFaces.length || !Array.isArray(refFaces) || !refFaces.length) {
    return { similarity: 0, refMediaId: null, box: null };
  }
  let best = { similarity: 0, refMediaId: null, box: null };
  for (const cf of candidateFaces) {
    if (!cf || (cf.confidence != null && cf.confidence < MIN_CONFIDENCE)) continue;
    if (cf.gender === 'female' && (cf.score || 0) >= 0.5) continue;
    const cVec = cf.vec ? (Buffer.isBuffer(cf.vec) ? unpackFaceVec(cf.vec) : cf.vec) : normalizeVec(cf.embedding);
    if (!cVec) continue;
    for (const rf of refFaces) {
      if (!rf.vec || rf.vec.length !== cVec.length) continue;
      const sim = cosine(cVec, rf.vec);
      if (sim > best.similarity) {
        best = { similarity: sim, refMediaId: rf.mediaId, box: cf.box || null };
      }
    }
  }
  return best;
}

/**
 * Evaluate candidate faces against a creator's reference faces with explainable verdict.
 * Never confirms a match on face alone: named (text/handle/link evidence) is required for 'confirmed'.
 */
function evaluateCreatorFaceMatch(candidateFaces, creatorId, { named = false, threshold = null, refs = null } = {}) {
  const s = settingsStore.get();
  const hi = threshold != null ? threshold : (Number(s.faceMatchThreshold) || 78) / 100;
  const reviewFloor = Math.max(0.55, Math.round((hi - 0.08) * 100) / 100);
  const refList = refs || creatorReferenceFaces(creatorId);
  if (!refList.length) return { verdict: 'none', similarity: 0, score: 0, refMediaId: null, reason: null };
  const hit = scoreFaceHit(candidateFaces, refList);
  if (hit.similarity >= hi && named) {
    return {
      verdict: 'confirmed',
      similarity: hit.similarity,
      score: hit.similarity,
      refMediaId: hit.refMediaId,
      box: hit.box,
      reason: `face match (${Math.round(hit.similarity * 100)}% similarity) + page names creator`,
    };
  }
  if (hit.similarity >= reviewFloor) {
    return {
      verdict: 'review',
      similarity: hit.similarity,
      score: hit.similarity,
      refMediaId: hit.refMediaId,
      box: hit.box,
      reason: named
        ? `borderline face similarity (${Math.round(hit.similarity * 100)}%) with name match — queued for review`
        : `face similarity (${Math.round(hit.similarity * 100)}%) without text/handle proof — queued for review`,
    };
  }
  return { verdict: 'none', similarity: hit.similarity, score: hit.similarity, refMediaId: hit.refMediaId, reason: null };
}

/** Record a web/visual/face match row in creator_web_matches. */
function recordWebMatch({ creatorId, mediaId = null, pageUrl, imageUrl = null, title = null, platform = 'web', matchKind = 'phash', similarity = null, score = null, phashDistance = null, evidence = null, status = 'confirmed' }) {
  if (similarity == null && score != null) similarity = score;
  if (!creatorId || !pageUrl) return null;
  repo.db.prepare(`INSERT INTO creator_web_matches
    (creator_id, media_id, page_url, image_url, title, platform, match_kind, similarity, phash_distance, evidence, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(creator_id, page_url) DO UPDATE SET
      media_id = COALESCE(excluded.media_id, creator_web_matches.media_id),
      image_url = COALESCE(excluded.image_url, creator_web_matches.image_url),
      title = COALESCE(excluded.title, creator_web_matches.title),
      match_kind = excluded.match_kind,
      similarity = COALESCE(excluded.similarity, creator_web_matches.similarity),
      phash_distance = COALESCE(excluded.phash_distance, creator_web_matches.phash_distance),
      evidence = COALESCE(excluded.evidence, creator_web_matches.evidence),
      status = CASE WHEN creator_web_matches.status = 'rejected' THEN 'rejected' ELSE excluded.status END`)
    .run(creatorId, mediaId, String(pageUrl).slice(0, 500), imageUrl ? String(imageUrl).slice(0, 500) : null, title ? String(title).slice(0, 240) : null, platform || 'web', matchKind, similarity, phashDistance, evidence ? String(evidence).slice(0, 400) : null, status);
  return repo.db.prepare('SELECT * FROM creator_web_matches WHERE creator_id = ? AND page_url = ?').get(creatorId, String(pageUrl).slice(0, 500));
}

/** List matches for a creator or across all creators (for Admin review). */
function listWebMatches({ creatorId = null, status = 'confirmed', limit = 24 } = {}) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 24));
  if (creatorId) {
    return repo.db.prepare(`SELECT wm.*, c.handle AS creator_handle, c.display_name AS creator_name
      FROM creator_web_matches wm
      JOIN creators c ON c.id = wm.creator_id
      WHERE wm.creator_id = ? AND (? = 'all' OR wm.status = ?)
      ORDER BY wm.created_at DESC LIMIT ?`).all(creatorId, status, status, lim);
  }
  return repo.db.prepare(`SELECT wm.*, c.handle AS creator_handle, c.display_name AS creator_name
    FROM creator_web_matches wm
    JOIN creators c ON c.id = wm.creator_id
    WHERE (? = 'all' OR wm.status = ?)
    ORDER BY wm.created_at DESC LIMIT ?`).all(status, status, lim);
}

/** Decide on a queued web/face match in Admin ('confirm' | 'reject'). */
function decideWebMatch(id, action, actor = 'admin') {
  const row = repo.db.prepare('SELECT * FROM creator_web_matches WHERE id = ?').get(Number(id));
  if (!row) return null;
  if (action === 'reject') {
    repo.db.prepare("UPDATE creator_web_matches SET status = 'rejected' WHERE id = ?").run(row.id);
    repo.logAction('creator', row.creator_id, 'web-match-reject', `${row.match_kind} → ${row.page_url}`, actor);
    return { ...row, status: 'rejected' };
  }
  if (action === 'confirm') {
    repo.db.prepare("UPDATE creator_web_matches SET status = 'confirmed' WHERE id = ?").run(row.id);
    try {
      const { parseProfile } = require('./links');
      const spec = parseProfile(row.page_url) || { platform: 'web', kind: 'page', target: row.page_url, ingestable: true, label: new URL(row.page_url).host };
      if (!spec.external) require('../services/targets').addSpec(spec, { creatorId: row.creator_id, origin: 'discovered', trusted: true });
    } catch { /* best effort */ }
    repo.logAction('creator', row.creator_id, 'web-match-confirm', `${row.match_kind} → ${row.page_url}`, actor);
    return { ...row, status: 'confirmed' };
  }
  return row;
}

/** Purge face embeddings and web matches on takedown or deletion. */
function purgeForMedia(mediaId) {
  if (!mediaId) return;
  try {
    repo.db.prepare('DELETE FROM media_faces WHERE media_id = ?').run(mediaId);
    repo.db.prepare('DELETE FROM creator_web_matches WHERE media_id = ?').run(mediaId);
  } catch { /* ignore */ }
}

function purgeForCreator(creatorId) {
  if (!creatorId) return;
  try {
    repo.db.prepare('DELETE FROM media_faces WHERE media_id IN (SELECT id FROM media WHERE creator_id = ?)').run(creatorId);
    repo.db.prepare('DELETE FROM creator_web_matches WHERE creator_id = ?').run(creatorId);
  } catch { /* ignore */ }
}

module.exports = {
  normalizeVec,
  packFaceVec,
  unpackFaceVec,
  cosine,
  saveMediaFaces,
  creatorReferenceFaces,
  scoreFaceHit,
  evaluateCreatorFaceMatch,
  recordWebMatch,
  listWebMatches,
  decideWebMatch,
  purgeForMedia,
  purgeForCreator,
};
