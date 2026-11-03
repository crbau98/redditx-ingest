'use strict';
/**
 * Image match: find a creator's own content wherever it appears on the web, by the SAME PICTURE.
 *
 * Every followed creator already has his pictures in the library with a perceptual hash (pHash, the same one the duplicate
 * filter uses). This pass turns a web image search into leads:
 *
 *   1. reference   his most recent pictures (pHash), rebuilt per creator
 *   2. search      image search for his name / handle / paid-page slug (Brave, or the keyless
 *                  Bing image feed - lib/brave.js `bingImages`)
 *   3. match       each result picture is hashed once (same on-device pass as ingestion):
 *                    pHash within the dedupe distance -> the very same picture (a repost or a copy of his file)
 *                  Nothing else counts. A picture that merely LOOKS like his (same build, setting, framing) is not his:
 *                  there is no visual-similarity path here and none may be added (tests/no-lookalike-attribution.test.js).
 *   4. act         a same-picture match records the "also posted on ..." source on the picture it belongs to. The page is
 *                  registered as a web feed owned by the creator only if it ALSO names him (his name, handle or paid-page
 *                  slug in its title, description or address), so a gallery that happens to host one of his files does not
 *                  become his. Registered feeds run through the usual safety / takedown / male-scope / picture gates.
 *
 * No face, body or identity model: matching is over hashes of pictures he published.
 */
const repo = require('../db/repo');
const events = require('./events');
const settingsStore = require('../settings');
const brave = require('../lib/brave');
const imagefilter = require('../lib/imagefilter');
const phash = require('../lib/phash');
const takedowns = require('../lib/takedowns');
const { hostBlocked } = require('../lib/mediaurl');
const { parseProfile } = require('../lib/links');

const db = repo.db;
const REF_PICTURES = 8;   // his own pictures used as reference
const HITS_PER_QUERY = 16; // candidate images read per query
const PAGES_PER_CREATOR = 4; // web pages registered per creator per pass
const STALE_DAYS = 14;

/** His reference pictures: recent published ones with a hash. */
function reference(creatorId) {
  const rows = db.prepare(`SELECT m.id, m.phash FROM media m
    WHERE m.creator_id = ? AND m.phash IS NOT NULL AND m.publish_state = 'published'
    ORDER BY COALESCE(m.posted_at, m.ingested_at) DESC LIMIT ?`).all(creatorId, REF_PICTURES);
  return rows.map((r) => ({ mediaId: r.id, phash: r.phash }));
}

/** Is one web picture the very same picture as one of his? {same: bool, mediaId?, distance?} (pHash within the dedupe distance) */
function scoreHit(hit, refs, { distance }) {
  let bestSame = null;
  for (const r of refs) {
    if (hit.phash && r.phash) {
      const d = phash.hamming(hit.phash, r.phash);
      if (d <= distance && (!bestSame || d < bestSame.d)) bestSame = { d, mediaId: r.mediaId };
    }
  }
  return { same: !!bestSame, mediaId: bestSame ? bestSame.mediaId : null, distance: bestSame ? bestSame.d : null };
}

/** Does the result page itself name him? (required before a page becomes his feed) */
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
      if (!res || res.status !== 'ok' || !res.phash) continue;
      const verdict = scoreHit({ phash: res.phash }, refs, { distance });
      if (!verdict.same) continue; // not the same picture: whatever it looks like, it is not his
      const named = namesCreator(hit, creator, paidHandle);

      // Same picture elsewhere: remember it on the picture it belongs to.
      if (verdict.mediaId) {
        try { repo.media.addAltSource(verdict.mediaId, { platform: 'web', source_url: pageUrl, author: creator.handle || null }); out.pictures++; } catch { /* best effort */ }
      }
      if (!named) continue; // a page that merely hosts one of his files is not thereby his
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
          `same picture (${verdict.distance} bits), page names him → ${pageUrl}`, 'discovery');
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

module.exports = { run, matchCreator, reference, scoreHit, namesCreator, pickCreators };
