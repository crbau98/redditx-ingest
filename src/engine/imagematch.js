'use strict';
/**
 * AI image match: find a creator's own content wherever it appears on the web.
 *
 * Every followed creator already has his pictures in the library with a perceptual hash and a visual
 * embedding (image workers, lib/embeddings). This pass turns a web image search into leads:
 *
 *   1. reference   his most recent pictures (pHash + visual vector), rebuilt per creator
 *   2. search      image search for his name / handle / paid-page slug (Brave, or the keyless
 *                  Bing image feed — lib/brave.js `bingImages`)
 *   3. match       each result picture is read once (same on-device model pass as ingestion):
 *                    pHash within the dedupe distance  -> the very same picture = his content
 *                    visual cosine >= imageMatchSimilarity -> same look (body, setting, framing)
 *                  A text cue (the page names him) is required alongside a visual-only match,
 *                  so a look-alike page never becomes his by itself.
 *   4. act         the page is registered as a web feed owned by the creator (its items then run
 *                  through the usual safety / takedown / male-scope / picture gates), and a same
 *                  picture match also records the "also posted on ..." source.
 *
 * No face or identity model: matching is over hashes and look-features of pictures he published.
 */
const repo = require('../db/repo');
const events = require('./events');
const settingsStore = require('../settings');
const brave = require('../lib/brave');
const imagefilter = require('../lib/imagefilter');
const phash = require('../lib/phash');
const emb = require('../lib/embeddings');
const takedowns = require('../lib/takedowns');
const { hostBlocked } = require('../lib/mediaurl');
const { parseProfile } = require('../lib/links');

const db = repo.db;
const REF_PICTURES = 8;   // his own pictures used as reference
const HITS_PER_QUERY = 16; // candidate images read per query
const PAGES_PER_CREATOR = 4; // web pages registered per creator per pass
const STALE_DAYS = 14;

const packed = (buf) => { const u = emb.unpack(buf); if (!u) return null; return { scale: u.scale, q: u.q }; };
const cos = (a, b) => {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.q.length; i++) {
    const x = a.scale * a.q[i];
    const y = b.scale * b.q[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

/** His reference pictures: recent published ones with a hash and, where stored, a visual vector. */
function reference(creatorId) {
  // Vectors first: a visual match only exists when the reference has one (the backfill may not have
  // reached his newest picture yet), phash-only references still catch exact reposts.
  const rows = db.prepare(`SELECT m.id, m.phash, m.media_type, m.width, m.height,
      (SELECT COUNT(*) FROM media_embeddings e WHERE e.media_id = m.id) AS has_vec
    FROM media m
    WHERE m.creator_id = ? AND m.phash IS NOT NULL AND m.publish_state = 'published'
    ORDER BY has_vec DESC, COALESCE(m.posted_at, m.ingested_at) DESC LIMIT ?`).all(creatorId, REF_PICTURES);
  if (!rows.length) return [];
  const vecs = new Map(db.prepare('SELECT media_id, vec FROM media_embeddings WHERE media_id IN (' + rows.map(() => '?').join(',') + ')')
    .all(...rows.map((r) => r.id)).map((r) => [r.media_id, packed(r.vec)]));
  return rows.map((r) => ({ mediaId: r.id, phash: r.phash, vec: vecs.get(r.id) || null, aspect: r.width > 0 && r.height > 0 ? r.width / r.height : 0 }));
}

/** How close one web picture is to the creator's own: {same: bool, score: 0..1, mediaId?} */
function scoreHit(hit, refs, { distance, similarity }) {
  let bestSame = null;
  let bestCos = 0;
  for (const r of refs) {
    if (hit.phash && r.phash) {
      const d = phash.hamming(hit.phash, r.phash);
      if (d <= distance && (!bestSame || d < bestSame.d)) bestSame = { d, mediaId: r.mediaId };
    }
    if (hit.vec && r.vec) {
      const c = cos(hit.vec, r.vec);
      if (c > bestCos) bestCos = c;
    }
  }
  return { same: !!bestSame, mediaId: bestSame ? bestSame.mediaId : null, distance: bestSame ? bestSame.d : null, cosine: bestCos, score: bestSame ? 1 : bestCos };
}

/** Does the result page itself name him? (text alongside a visual-only match) */
function namesCreator(hit, creator, ...handles) {
  const blob = `${hit.title || ''} ${hit.description || ''} ${(hit.url || '').replace(/[-_/]+/g, ' ')}`;
  const texts = [creator.display_name, creator.handle, ...handles].filter(Boolean);
  if (texts.some((t) => t && blob.toLowerCase().includes(String(t).toLowerCase()))) return true;
  return false;
}

/**
 * One creator: search, read the candidate pictures, register the pages his content appears on.
 * @returns {Promise<{checked:number, matched:number, pages:number, pictures:number}>}
 */
async function matchCreator(creator, { budget = 40, aborted = () => false, service = null, paidHandle = null } = {}) {
  const out = { checked: 0, matched: 0, pages: 0, pictures: 0 };
  const refs = reference(creator.id);
  if (!refs.length) return out; // nothing of his to match against yet

  const s = settingsStore.get();
  const distance = s.dedupeDistance == null ? 6 : s.dedupeDistance;
  const similarity = (s.imageMatchSimilarity || 62) / 100;
  const name = creator.display_name || creator.handle;
  const queries = [`"${name}" onlyfans`];
  if (paidHandle && paidHandle !== name) queries.push(`"${paidHandle}" ${service || 'onlyfans'}`);
  if (creator.handle && creator.handle !== name) queries.push(`"${creator.handle}" onlyfans`);

  const existing = new Set(repo.feeds.list({ platform: 'web', creatorId: creator.id, limit: 500 }).items.map((f) => String(f.target).toLowerCase()));
  const seenPages = new Set();

  for (const q of [...new Set(queries)].slice(0, 3)) {
    if (aborted() || out.pages >= PAGES_PER_CREATOR) break;
    let hits = [];
    try {
      // Image match is a secondary pass: free feeds first, so the shared daily Brave budget is
      // left for identity matching and topic search.
      hits = await brave.images(q, { count: HITS_PER_QUERY, budget, preferKeyless: true });
    } catch (e) {
      if (e && (e.skip || e.budget)) break;
      events.log('WARN', `Image match: "${q}" — ${e.message}`);
      continue;
    }
    for (const hit of hits) {
      if (aborted() || out.checked >= HITS_PER_QUERY || out.pages >= PAGES_PER_CREATOR) break;
      const pageUrl = hit.pageUrl || hit.url;
      const img = hit.imageUrl || (hit.mediaUrl && /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i.test(hit.mediaUrl) ? hit.mediaUrl : null);
      if (!img || !pageUrl) continue;
      if (takedowns.checkUrl(pageUrl) || takedowns.checkUrl(img)) continue;
      if (hostBlocked(new URL(pageUrl).hostname)) continue;
      const key = String(pageUrl).toLowerCase();
      if (seenPages.has(key) || existing.has(key)) continue;
      seenPages.add(key);
      out.checked++;

      const res = await imagefilter.analyze(img, { faces: false, hash: true, timeout: 10000 });
      let vec = null;
      if (res && res.status === 'ok' && res.phash) {
        // Same picture: no embedding needed. A look-only match reads the vector too.
        if (!refs.some((r) => r.phash && phash.hamming(res.phash, r.phash) <= distance)) {
          const e = await imagefilter.embedUrl(img, { timeout: 10000 });
          if (e && e.status === 'ok') vec = packed(e.vec);
        }
      }
      if (!res || res.status !== 'ok' || !res.phash) continue;
      const verdict = scoreHit({ phash: res.phash, vec }, refs, { distance, similarity });
      const named = namesCreator(hit, creator, paidHandle);
      const isHis = verdict.same || (verdict.cosine >= similarity && named);
      if (!isHis) continue;

      // Same picture elsewhere: remember it on the picture it belongs to.
      if (verdict.same && verdict.mediaId) {
        try { repo.media.addAltSource(verdict.mediaId, { platform: 'web', source_url: pageUrl, author: creator.handle || null }); out.pictures++; } catch { /* best effort */ }
      }
      const spec = parseProfile(pageUrl) || { platform: 'web', kind: 'page', target: pageUrl, ingestable: true, label: new URL(pageUrl).host };
      if (spec.external) continue;
      // Respect robots.txt before registering: a page that refuses crawlers would only produce a
      // skipped feed on the next run (Pinterest, X and friends).
      if (spec.platform === 'web') {
        try { if (!(await require('../sources/web').robotsAllows(pageUrl))) continue; } catch { continue; }
      }
      const r = require('../services/targets').addSpec(spec, { creatorId: creator.id, origin: 'discovered', trusted: true });
      if (r.status === 'created') {
        out.pages++;
        repo.logAction('creator', creator.id, 'image-match',
          `${verdict.same ? `same picture (${verdict.distance} bits)` : `look-alike (${Math.round(verdict.cosine * 100)}%)`} → ${pageUrl}`, 'discovery');
      }
      out.matched++;
    }
  }
  return out;
}

/** Creators whose pictures exist and who have not been matched recently (newest first).
 * A creator with a traced paid page or stored links has a searchable identity — his content exists
 * elsewhere on the web — so those come first; plain ingest handles (bot-style Reddit names) rarely
 * resolve to anything a search engine knows. */
function pickCreators(limit) {
  const stale = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  return db.prepare(`SELECT c.id FROM creators c
    WHERE c.status = 'active' AND c.scope IN ('in','uncertain')
      AND (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.phash IS NOT NULL AND m.publish_state = 'published') >= 2
      AND COALESCE((SELECT updated_at FROM discovery_state WHERE key = 'imgmatch.' || c.id), '') < ?
    GROUP BY c.id
    ORDER BY
      CASE WHEN EXISTS (SELECT 1 FROM onlyfans_leads l WHERE l.creator_id = c.id AND l.status = 'claimed') THEN 0
           WHEN c.links IS NOT NULL AND c.links != '[]' AND c.links != '' THEN 1
           WHEN c.origin != 'ingest' THEN 2 ELSE 3 END,
      (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.phash IS NOT NULL AND m.publish_state = 'published') DESC
    LIMIT ?`).all(stale, limit)
    .map((r) => repo.creators.get(r.id)).filter(Boolean);
}

/**
 * The discovery pass. Registers `limit` creators (imageMatchPerRun).
 * @returns {Promise<{creators:number, matched:number, pages:number, pictures:number, error?:string}>}
 */
async function run({ limit, aborted = () => false, budget = 40 } = {}) {
  const s = settingsStore.get();
  const max = limit == null ? (s.imageMatchPerRun || 4) : limit;
  const out = { creators: 0, matched: 0, pages: 0, pictures: 0 };
  if (!s.imageMatch || max <= 0) return out;
  if (!imagefilter.available()) return { ...out, error: 'image model unavailable' };
  for (const creator of pickCreators(Math.max(1, max))) {
    if (aborted() || out.creators >= max) break;
    const of = require('../lib/onlyfans').creatorOnlyFans(creator);
    let service = null; let paidHandle = null;
    if (of) { service = 'onlyfans'; paidHandle = of.handle; }
    else {
      const p = require('../lib/paid').creatorPaid(creator)[0];
      if (p) { service = p.service; paidHandle = p.handle; }
    }
    try {
      const r = await matchCreator(creator, { budget, aborted, service, paidHandle });
      out.creators++;
      out.matched += r.matched;
      out.pages += r.pages;
      out.pictures += r.pictures;
      if (r.pages) events.log('OK', `Image match: ${creator.display_name || creator.handle} — ${r.pages} page(s) of his registered${r.pictures ? `, ${r.pictures} picture(s) already stored found elsewhere` : ''}`);
    } catch (e) {
      events.log('WARN', `Image match: ${creator.display_name || creator.handle} — ${e.message}`);
    }
    repo.discoveryState.set(`imgmatch.${creator.id}`, new Date().toISOString());
  }
  return out;
}

module.exports = { run, matchCreator, reference, scoreHit, pickCreators, _test: { packed, cos } };
